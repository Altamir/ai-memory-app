import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';

// Detecta sessões `ai-memory run/show/continue/resume` vivas na máquina,
// iniciadas fora do painel (o painel não tem o I/O delas, mas pode listá-las
// e encerrá-las). Fonte: tabela de processos via ps.

const RUN_KINDS = new Set(['run', 'show', 'continue', 'resume']);
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** Pids intocáveis: arquivo .protected-pids.json (array) + env AIM_APP_PROTECTED_PIDS. */
export function parseProtectedPids(rawValue) {
  return String(rawValue || '')
    .split(/[,\s]+/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

function protectedPids() {
  const pids = new Set(parseProtectedPids(process.env.AIM_APP_PROTECTED_PIDS));
  try {
    const file = path.join(config.root, '.protected-pids.json');
    for (const pid of JSON.parse(fs.readFileSync(file, 'utf8'))) {
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
  } catch {
    // arquivo ausente: só o env vale
  }
  return pids;
}

export function isProtectedPid(pid) {
  return protectedPids().has(Number(pid));
}

/** Parser puro do output de `ps -eo pid,tty,lstart,command` — testável. */
export function parsePsOutput(text) {
  const items = [];
  for (const line of text.split('\n')) {
    const tokens = line.trim().split(/\s+/);
    // pid tty dow mon day time year command...
    if (tokens.length < 8 || !/^\d+$/.test(tokens[0])) continue;
    const command = tokens.slice(7).join(' ');
    const match = command.match(/(?:^|\/)ai-memory (run|show|continue|resume)(?: |$)/);
    if (!match) continue;
    const [, kind] = match;
    const [, mon, day, time, year] = tokens.slice(2, 7);
    let started = null;
    const monthIdx = MONTHS[mon];
    if (monthIdx !== undefined) {
      const [hh, mm, ss] = time.split(':').map(Number);
      started = new Date(Number(year), monthIdx, Number(day), hh, mm, ss).getTime();
    }
    // harness só é confiável quando o comando começa com o binário: "ai-memory run <harness>"
    const argv = command.split(/\s+/);
    const startsRun = /(^|\/)ai-memory$/.test(argv[0]) && argv[1] === 'run';
    items.push({
      pid: Number(tokens[0]),
      tty: tokens[1] === '??' ? null : tokens[1],
      kind,
      harness: kind === 'run' && startsRun ? (argv[2] || null) : null,
      started,
      command,
    });
  }
  return items;
}

function psScan() {
  return new Promise((resolve, reject) => {
    execFile('ps', ['-eo', 'pid,tty,lstart,command'], { timeout: 10_000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });
}

export function parseLsofCwd(stdout) {
  const line = String(stdout).split('\n').find((l) => l.startsWith('n/'));
  return line ? line.slice(1) : null;
}

function lsofCwd(pid) {
  return new Promise((resolve) => {
    execFile('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 10_000 }, (err, stdout) => {
      resolve(err ? null : parseLsofCwd(String(stdout)));
    });
  });
}

/**
 * Sessões de run vivas que o painel NÃO gerencia (managedPids = pids dos cards).
 * Inclui o cwd do processo (via lsof) para permitir "retomar no painel".
 */
export async function listHostSessions(managedPids = new Set()) {
  const raw = await psScan();
  const managed = managedPids instanceof Set ? managedPids : new Set(managedPids);
  const guarded = protectedPids();
  const items = parsePsOutput(raw).filter((p) => !managed.has(p.pid));
  for (const item of items) {
    item.cwd = await lsofCwd(item.pid);
    item.isRepo = Boolean(item.cwd && fs.existsSync(`${item.cwd}/.git`));
    item.protected = guarded.has(item.pid);
  }
  return items;
}

export async function isHostRunProcess(pid) {
  const raw = await psScan();
  return parsePsOutput(raw).some((p) => p.pid === Number(pid));
}
