import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A aba Logs lê a cauda dos arquivos de `<dataDir>/logs/` (cliente) e
// `<storeDir>/logs/` (servidor local). O que está em jogo aqui: a leitura tem
// que aceitar só o que está DENTRO da pasta de logs — o dir é vizinho do
// auth-token no data-dir, então traversal/symlink não é teoria.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-logs-'));
const realHome = os.homedir();
process.env.HOME = home;
process.env.AIM_APP_SERVERS_FILE = path.join(home, '.servers.json');
process.env.AI_MEMORY_DATA_DIR = path.join(home, 'data');
process.env.AIM_STORE_DIR = path.join(home, 'store');
process.env.AI_MEMORY_SERVER_URL = 'http://127.0.0.1:1';
process.env.AI_MEMORY_BIN = '/bin/echo';

const clientLogs = path.join(process.env.AI_MEMORY_DATA_DIR, 'logs');
const storeLogs = path.join(process.env.AIM_STORE_DIR, 'logs');
const today = new Date().toISOString().slice(0, 10);

fs.mkdirSync(clientLogs, { recursive: true });
fs.mkdirSync(storeLogs, { recursive: true });
fs.writeFileSync(path.join(clientLogs, `ai-memory.log.${today}`), [
  '2026-10-02T17:00:00.000000Z  INFO ai_memory_cli: ai-memory starting version="2.5.2"',
  '2026-10-02T17:00:01.000000Z  WARN ai_memory_cli::spool: servidor inacessível',
  '2026-10-02T17:00:02.000000Z ERROR ai_memory_cli::hook: falha ao entregar evento',
  '2026-10-02T17:00:03.000000Z  INFO ai_memory_cli::hook: 5 evento(s) entregues',
  '',
].join('\n'));
fs.writeFileSync(path.join(clientLogs, 'hook-drain.log'), 'ai-memory hook-drain warning: 93 ack, 23 queued\n');
fs.writeFileSync(path.join(process.env.AI_MEMORY_DATA_DIR, 'auth-token'), 'token-secreto\n');
fs.writeFileSync(path.join(storeLogs, 'server.log'), '2026-10-02T17:00:00Z  INFO server: started\n');

const { listLogs, readLog } = await import('../server/logs.mjs');
const { serverLogsAvailable } = await import('../server/logs.mjs');

test.after(() => {
  process.env.HOME = realHome;
});

test('lista as duas fontes com os arquivos do fixture', () => {
  const out = listLogs();
  assert.equal(out.client.available, true);
  assert.ok(out.client.files.some((f) => f.name === `ai-memory.log.${today}`));
  assert.ok(out.client.files.some((f) => f.name === 'hook-drain.log'));
  // o servidor ativo é o do ambiente (não há perfil): fonte server disponível
  assert.equal(serverLogsAvailable(), true);
  assert.equal(out.server.available, true);
  assert.ok(out.server.files.some((f) => f.name === 'server.log'));
});

test('lê a cauda e filtra por substring', async () => {
  const full = await readLog({ source: 'client', file: `ai-memory.log.${today}`, tail: 50 });
  assert.equal(full.ok, true, full.error);
  assert.equal(full.lines.length, 4);
  assert.match(full.lines[0], /ai-memory starting/);

  const errs = await readLog({ source: 'client', file: `ai-memory.log.${today}`, tail: 50, filter: 'error' });
  assert.equal(errs.lines.length, 1);
  assert.match(errs.lines[0], /ERROR/);
  assert.equal(errs.filter, 'error');
});

test('tail pequeno devolve só o fim', async () => {
  const out = await readLog({ source: 'client', file: `ai-memory.log.${today}`, tail: 2 });
  assert.equal(out.lines.length, 2);
  assert.match(out.lines[1], /entregues/);
});

test('recusa traversal e leitura fora da pasta de logs', async () => {
  // o auth-token está em dataDir, um nível acima de logs/
  for (const bad of ['../../auth-token', '../auth-token', 'auth-token', 'sub/dir/x.log']) {
    const out = await readLog({ source: 'client', file: bad });
    assert.equal(out.ok, false, `${bad} deveria ser recusado`);
    assert.ok(out.error, 'recusa sem motivo');
  }
});

test('symlink dentro de logs/ apontando para fora é recusado (realpath)', async () => {
  const link = path.join(clientLogs, 'escapando.log');
  try {
    fs.symlinkSync(path.join(process.env.AI_MEMORY_DATA_DIR, 'auth-token'), link);
    const out = await readLog({ source: 'client', file: 'escapando.log' });
    assert.equal(out.ok, false, 'symlink para fora deveria ser recusado');
    assert.match(out.error, /fora da pasta de logs|não encontrado/);
  } finally {
    fs.rmSync(link, { force: true });
  }
});

test('fonte server aponta para o volume local e lê dele', async () => {
  const out = await readLog({ source: 'server', file: 'server.log' });
  assert.equal(out.ok, true, out.error);
  assert.match(out.lines[0], /server: started/);
});

test('arquivo inexistente devolve erro limpo, não exceção', async () => {
  const out = await readLog({ source: 'client', file: 'nao-existe.log' });
  assert.equal(out.ok, false);
  assert.match(out.error, /não encontrado/);
  const badSource = await readLog({ source: 'outro', file: 'x.log' });
  assert.equal(badSource.ok, false);
  assert.match(badSource.error, /fonte inválida/);
});

// ---------- via HTTP ----------

const PORT = 4793;
const BASE = `http://127.0.0.1:${PORT}`;
let panel;

async function waitHealth() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch { /* ainda não subiu */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

test.before(async () => {
  panel = spawn('node', ['server/index.mjs'], {
    cwd: root,
    env: { ...process.env, AIM_APP_PORT: String(PORT) },
    stdio: 'ignore',
  });
  assert.ok(await waitHealth(), 'painel de teste não subiu');
});

test.after(() => {
  if (panel) panel.kill('SIGTERM');
});

test('GET /api/logs lista as fontes pelo HTTP', async () => {
  const res = await fetch(`${BASE}/api/logs`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.client.available, true);
  assert.equal(data.client.dir, clientLogs);
});

test('GET /api/logs/content devolve linhas e respeita filtro', async () => {
  const url = `${BASE}/api/logs/content?source=client&file=${encodeURIComponent(`ai-memory.log.${today}`)}&tail=50&filter=warn`;
  const res = await fetch(url);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.lines.length, 1);
  assert.match(data.lines[0], /WARN/);
});

test('GET /api/logs/content recusa traversal com 200+ok:false (erro estruturado)', async () => {
  const res = await fetch(`${BASE}/api/logs/content?source=client&file=${encodeURIComponent('../../auth-token')}`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, false);
  assert.ok(data.error);
  // o conteúdo do token NÃO pode ter vazado em nenhum campo
  assert.equal(JSON.stringify(data).includes('token-secreto'), false);
});

test('GET /api/logs/stream abre SSE e entrega a cauda inicial', async () => {
  const url = `${BASE}/api/logs/stream?source=client&file=${encodeURIComponent(`ai-memory.log.${today}`)}`;
  const controller = new AbortController();
  const res = await fetch(url, { signal: controller.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
  const reader = res.body.getReader();
  const { value } = await reader.read();
  const text = Buffer.from(value).toString('utf8');
  assert.ok(text.startsWith('retry:'), text.slice(0, 60));
  assert.ok(text.includes('ai-memory starting'), text.slice(0, 120));
  controller.abort();
});

test('stream de arquivo inexistente entrega erro e encerra', async () => {
  const res = await fetch(`${BASE}/api/logs/stream?source=client&file=${encodeURIComponent('nao-existe.log')}`);
  const text = await res.text();
  assert.match(text, /não encontrado/);
  assert.match(text, /event: end/);
});

test('fonte server com store ausente vira nota, não erro', async () => {
  // simula volume ausente: fonte aponta para dir que não existe
  const fake = path.join(home, 'sem-store', 'logs');
  assert.equal(fs.existsSync(fake), false);
  // via módulo: a nota só muda quando o dir sumir — aqui o dir existe, então
  // valida o caminho inverso: apagar e reler
  fs.rmSync(storeLogs, { recursive: true, force: true });
  const out = listLogs();
  assert.equal(out.server.available, false);
  assert.match(out.server.note, /não encontrada/);
  const read = await readLog({ source: 'server', file: 'server.log' });
  assert.equal(read.ok, false);
});
