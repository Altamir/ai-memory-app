import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import pty from 'node-pty';
import { config } from './config.mjs';
import { cliEnv } from './cli.mjs';
import { saveSessions, loadSessions } from './session-store.mjs';

// Sessões interativas: node-pty rodando `ai-memory run <harness>`.
// O frontend conecta via WebSocket /api/pty/<id> para I/O e resize.

const sessions = new Map();
const HARNESS = new Set(['opencode', 'grok', 'claude']);

export function listSessions() {
  // sessões hidden = tentativas do retomar que ainda não conquistaram o workstream
  return [...sessions.values()]
    .filter((s) => !s.hidden)
    .map((s) => ({
      id: s.id,
      harness: s.harness,
      cwd: s.cwd,
      workstream: s.workstream || null,
      pid: s.pid,
      status: s.status,
      exitCode: s.exitCode,
      createdAt: s.createdAt,
      lostIo: Boolean(s.lostIo),
      endedNote: s.endedNote || null,
    }));
}

/** Pids de todas as sessões rodando (inclusive hidden) — para não vazar como "externas". */
export function runningSessionPids() {
  return [...sessions.values()]
    .filter((s) => s.status === 'running' && s.pid)
    .map((s) => s.pid);
}

/** Torna visível (card de verdade) uma sessão criada hidden pelo retomar. */
export function revealSession(id) {
  const s = sessions.get(id);
  if (!s) return false;
  s.hidden = false;
  persist();
  return true;
}

function persist() {
  saveSessions(listSessions());
}

// Ao subir, recupera os cards das sessões anteriores. Os PTYs morreram com o
// processo antigo, então voltam como encerradas com I/O não recuperável.
function restorePersisted() {
  const previous = loadSessions();
  for (const s of previous) {
    if (!s?.id || !s?.pid || !s?.harness || !s?.cwd) continue;
    let alive = false;
    try {
      process.kill(s.pid, 0);
      alive = true;
    } catch {
      // processo não existe mais
    }
    sessions.set(s.id, {
      id: s.id,
      harness: s.harness,
      cwd: s.cwd,
      workstream: s.workstream || null,
      pid: s.pid,
      status: 'ended',
      exitCode: null,
      createdAt: s.createdAt || Date.now(),
      lostIo: true,
      endedNote: alive
        ? 'processo sobreviveu à reinicialização do painel, mas fora dele (I/O perdido)'
        : 'encerrada pela reinicialização do painel (I/O perdido)',
      buffer: [],
      bufferSize: 0,
      sockets: new Set(),
      proc: null,
    });
  }
  if (sessions.size) persist();
}
restorePersisted();

export function getSession(id) {
  return sessions.get(id) || null;
}

export function validateCwd(dir) {
  const resolved = fs.realpathSync.native(dir); // lança se não existir
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) throw new Error('caminho não é um diretório');
  return resolved;
}

export function createSession({ harness, cwd, newWorkstream, workstream, yolo, fresh, hidden }) {
  if (!HARNESS.has(harness)) throw new Error(`harness inválido: use ${[...HARNESS].join(', ')}`);
  const resolvedCwd = validateCwd(cwd);

  const args = ['--data-dir', config.dataDir, 'run', harness];
  if (newWorkstream) args.push('--new', String(newWorkstream));
  if (workstream) args.push('--workstream', String(workstream));
  if (yolo) args.push('--yolo');
  if (fresh) args.push('--fresh');

  const proc = pty.spawn(config.bin, args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 32,
    cwd: resolvedCwd,
    env: cliEnv(),
  });

  const session = {
    id: randomUUID(),
    harness,
    cwd: resolvedCwd,
    workstream: newWorkstream || workstream || null,
    pid: proc.pid,
    status: 'running',
    exitCode: null,
    createdAt: Date.now(),
    hidden: Boolean(hidden),
    buffer: [],
    bufferSize: 0,
    sockets: new Set(),
    proc,
  };

  proc.onData((data) => {
    session.buffer.push(data);
    session.bufferSize += data.length;
    while (session.bufferSize > config.sessionBufferLimit && session.buffer.length > 1) {
      session.bufferSize -= session.buffer[0].length;
      session.buffer.shift();
    }
    for (const ws of session.sockets) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'data', data }));
    }
  });

  proc.onExit(({ exitCode }) => {
    session.status = 'ended';
    session.exitCode = exitCode;
    for (const ws of session.sockets) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'exit', exitCode }));
    }
    persist();
  });

  sessions.set(session.id, session);
  persist();
  return session;
}

export function attachSocket(session, ws) {
  session.sockets.add(ws);

  // sessão recuperada de restart: sem processo e sem buffer, só explica
  if (session.lostIo || !session.proc) {
    ws.send(JSON.stringify({
      type: 'data',
      data: `\r\n\x1b[38;5;245m— ${session.endedNote || 'sessão sem processo anexado'}; I/O não é recuperável —\x1b[0m\r\n`,
    }));
    ws.send(JSON.stringify({ type: 'exit', exitCode: session.exitCode }));
    return;
  }

  if (session.buffer.length) {
    ws.send(JSON.stringify({ type: 'data', data: session.buffer.join('') }));
  }
  if (session.status !== 'running') {
    ws.send(JSON.stringify({ type: 'exit', exitCode: session.exitCode }));
  }
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    try {
      if (msg.type === 'input' && typeof msg.data === 'string') {
        session.proc.write(msg.data);
      } else if (msg.type === 'resize') {
        const cols = Math.min(Math.max(Number(msg.cols) || 120, 20), 500);
        const rows = Math.min(Math.max(Number(msg.rows) || 32, 5), 200);
        session.proc.resize(cols, rows);
      }
    } catch {
      // processo pode já ter saído
    }
  });
  ws.on('close', () => session.sockets.delete(ws));
}

export function killSession(id) {
  const session = sessions.get(id);
  if (!session) return false;
  if (session.status === 'running') {
    try {
      if (session.proc) session.proc.kill();
      else process.kill(session.pid, 'SIGTERM');
    } catch {
      // já saiu
    }
    persist();
  }
  return true;
}

/** Remove a sessão da lista do painel. Só faz sentido para sessões encerradas. */
export function removeSession(id) {
  const session = sessions.get(id);
  if (!session) return false;
  if (session.status === 'running') return false;
  const removed = sessions.delete(id);
  if (removed) persist();
  return removed;
}
