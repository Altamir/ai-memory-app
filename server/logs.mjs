import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.mjs';
import { isEnvServerActive } from './servers.mjs';

// Logs do ai-memory no lado local, para a aba "Logs" do painel.
//
// Duas fontes, com donos diferentes:
// - **cliente**: `<dataDir>/logs/` do perfil ativo — a CLI grava aqui
//   (`ai-memory.log.<data>`, `backfill.log`, `hook-drain.log`), então segue a
//   troca de servidor.
// - **servidor**: `<storeDir>/logs/` — o volume do ai-memory LOCAL. Só descreve
//   algo quando o servidor ativo é o do ambiente; com o painel apontado para
//   outro ai-memory, os logs dele ficam na outra máquina e a fonte vira uma
//   nota explicativa em vez de dado errado.
//
// Segurança de leitura no padrão de bundle.mjs: nome validado, realpath do
// diretório-base E do arquivo + prefix check. O dir de logs é vizinho do
// auth-token no data-dir, então escape por symlink/traversal não é teórico.

const MAX_READ_BYTES = 512 * 1024;
const MAX_TAIL = 5000;

// mesmo regex de jobs.mjs: logs da CLI vêm com cores ANSI
const ANSI = /\x1B\[[0-9;]*[A-Za-z]|\x1B\][^\x07]*\x07/g;

function logDirFor(source) {
  if (source === 'client') return path.join(config.dataDir, 'logs');
  if (source === 'server') return path.join(config.storeDir, 'logs');
  return null;
}

/** true quando a fonte server faz sentido para o servidor conectado. */
export function serverLogsAvailable() {
  return isEnvServerActive();
}

function noteFor(source) {
  if (source === 'client') return null;
  if (!isEnvServerActive()) {
    return `o servidor ativo é ${config.serverUrl} (remoto) — os logs dele ficam na outra máquina; este card só cobre o ai-memory local (${config.storeDir})`;
  }
  return null;
}

function listDirSafe(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { available: false, files: [] };
  }
  const files = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    try {
      const st = fs.statSync(path.join(dir, e.name));
      files.push({ name: e.name, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      // arquivo sumiu entre readdir e stat: ignora
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { available: files.length > 0, files };
}

/** Fontes de log com seus arquivos (mais recente primeiro). */
export function listLogs() {
  const build = (source) => {
    const dir = logDirFor(source);
    const note = noteFor(source);
    const exists = dir && fs.existsSync(dir) && fs.statSync(dir).isDirectory();
    const listed = exists ? listDirSafe(dir) : { available: false, files: [] };
    return {
      source,
      dir,
      available: listed.available,
      note: note || (!exists ? `pasta de logs não encontrada em ${dir}` : (listed.available ? null : 'nenhum arquivo de log ainda')),
      files: listed.files,
    };
  };
  return { client: build('client'), server: build('server') };
}

/**
 * Lê a cauda de um arquivo de log. Retorna { ok, lines, ... } ou { ok: false, error }.
 * `filter` é substring case-insensitive aplicado depois do tail (o que aparece
 * é o que casou dentro da janela lida).
 */
export async function readLog({ source, file, tail = 400, filter = '' } = {}) {
  const dir = logDirFor(source);
  if (!dir) return { ok: false, error: `fonte inválida: ${source}` };
  if (source === 'server' && !isEnvServerActive()) {
    return { ok: false, error: noteFor('server') };
  }

  // nome simples: sem caminho, sem traversal (o realpath abaixo fecha symlink)
  const name = String(file || '');
  if (!/^[\w][\w.-]{0,120}$/.test(name) || name.includes('..')) {
    return { ok: false, error: `nome de arquivo inválido: ${name.slice(0, 80)}` };
  }

  let base;
  let target;
  try {
    base = await fsp.realpath(dir); // lança se o dir não existe
    target = await fsp.realpath(path.join(base, name));
  } catch {
    return { ok: false, error: `arquivo de log não encontrado: ${name}` };
  }
  if (target !== base && !target.startsWith(base + path.sep)) {
    return { ok: false, error: 'arquivo fora da pasta de logs' };
  }
  let st;
  try {
    st = await fsp.stat(target);
    if (!st.isFile()) return { ok: false, error: 'não é um arquivo' };
  } catch {
    return { ok: false, error: `arquivo de log não encontrado: ${name}` };
  }

  const start = Math.max(0, st.size - MAX_READ_BYTES);
  let chunk;
  try {
    const fh = await fsp.open(target, 'r');
    try {
      const len = st.size - start;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);
      chunk = buf.toString('utf8');
    } finally {
      await fh.close();
    }
  } catch (err) {
    return { ok: false, error: `falha ao ler: ${err.message}` };
  }

  // pedaço inicial sem \n é sobra de uma linha anterior: descarta parcial
  const rawLines = chunk.split('\n');
  if (start > 0 && rawLines.length) rawLines.shift();
  const lines = rawLines
    .filter((l) => l !== '')
    .map((l) => l.replace(ANSI, ''))
    .slice(-tail);
  const needle = String(filter || '').trim().toLowerCase();
  const filtered = needle ? lines.filter((l) => l.toLowerCase().includes(needle)) : lines;

  return {
    ok: true,
    file: name,
    sizeBytes: st.size,
    mtimeMs: st.mtimeMs,
    truncated: start > 0,
    readBytes: st.size - start,
    filter: needle || null,
    total: lines.length,
    lines: filtered,
  };
}

/**
 * SSE da cauda + novas linhas (poll no próprio arquivo — sem fs.watch, que
 * varia por plataforma). Resync pelo tail quando o arquivo encolhe (rotação).
 */
export async function streamLog({ source, file, filter = '' }, res) {
  const first = await readLog({ source, file, tail: MAX_TAIL, filter });
  if (!first.ok) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ kind: 'err', text: `${first.error}\n` })}\n\n`);
    res.write('event: end\ndata: {}\n\n');
    res.end();
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write('retry: 2000\n\n');

  let cursor = first.sizeBytes; // posição real no arquivo
  // devolve a cauda já alinhada ao fim
  for (const line of first.lines.slice(-400)) res.write(`data: ${JSON.stringify({ kind: lineKind(line), text: `${line}\n` })}\n\n`);

  const poll = async () => {
    let st;
    try {
      st = fs.statSync(targetPath(source, file));
    } catch {
      return; // arquivo sumiu (rotação): espera o próximo tick
    }
    if (st.size < cursor) {
      // rotacionou/truncou: recomeça do fim atual
      cursor = st.size;
      return;
    }
    if (st.size === cursor) return;
    if (st.size - cursor > MAX_READ_BYTES) {
      // cresceu demais entre ticks: resync pela cauda
      const tail = await readLog({ source, file, tail: 400, filter });
      if (tail.ok) {
        cursor = tail.sizeBytes;
        for (const line of tail.lines) res.write(`data: ${JSON.stringify({ kind: lineKind(line), text: `${line}\n` })}\n\n`);
      }
      return;
    }
    let chunk;
    try {
      const fh = await fsp.open(targetPath(source, file), 'r');
      try {
        const len = st.size - cursor;
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, cursor);
        chunk = buf.toString('utf8');
      } finally {
        await fh.close();
      }
    } catch {
      return;
    }
    cursor = st.size;
    const needle = String(filter || '').trim().toLowerCase();
    for (const raw of chunk.split('\n')) {
      if (raw === '') continue;
      const line = raw.replace(ANSI, '');
      if (needle && !line.toLowerCase().includes(needle)) continue;
      res.write(`data: ${JSON.stringify({ kind: lineKind(line), text: `${line}\n` })}\n\n`);
    }
  };

  const timer = setInterval(() => { poll().catch(() => {}); }, 2_000);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
  res.on('close', () => {
    clearInterval(timer);
    clearInterval(heartbeat);
  });
}

function targetPath(source, file) {
  return path.join(logDirFor(source), String(file));
}

function lineKind(line) {
  if (/\bERROR\b/.test(line)) return 'err';
  if (/\bWARN\b/.test(line)) return 'out';
  if (/^INFO\b/.test(line) || /^\d{4}-\d{2}-\d{2}T/.test(line)) return 'out';
  return 'sys';
}
