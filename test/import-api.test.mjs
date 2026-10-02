import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeImportFixture } from './import-fixtures.mjs';

// Rotas de importação no servidor real, com fixtures: o MCP aponta para uma
// porta morta (força o fallback da CLI) e AI_MEMORY_BIN=/bin/echo faz o
// "write-page" não tocar em nenhum store.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// porta própria: api.test.mjs usa 4799 e 4798 (os arquivos rodam em paralelo)
const PORT = 4797;
const BASE = `http://127.0.0.1:${PORT}`;

const fx = makeImportFixture();
let child;

async function waitHealth(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch {
      // ainda não subiu
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** Consome o SSE do job até o fim (backfill + end) e devolve as linhas. */
async function collectJobLog(id, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/api/jobs/${id}/stream`, { signal: controller.signal });
    const text = await res.text();
    const lines = [];
    for (const raw of text.split('\n')) {
      if (!raw.startsWith('data:')) continue;
      const payload = raw.slice(5).trim();
      if (!payload) continue;
      try {
        lines.push(JSON.parse(payload));
      } catch {
        // fragmento inválido
      }
    }
    return lines;
  } finally {
    clearTimeout(timer);
  }
}

async function jobStatus(id) {
  const res = await fetch(`${BASE}/api/jobs/${id}`);
  assert.equal(res.ok, true, `job ${id} não encontrado`);
  return res.json();
}

async function applyImport(payload) {
  const res = await fetch(`${BASE}/api/import/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

test.before(async () => {
  child = spawn('node', ['server/index.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      AIM_APP_PORT: String(PORT),
      AIM_APP_STATE_FILE: path.join(fx.tmp, 'sessions.json'),
      // perfil de servidor isolado: sem isto, um .servers.json no root do repo
      // (com o perfil ativo gravado) sobrepõe o data-dir deste fixture
      AIM_APP_SERVERS_FILE: path.join(fx.tmp, 'servers.json'),
      AI_MEMORY_BIN: '/bin/echo',
      AI_MEMORY_SERVER_URL: 'http://127.0.0.1:1', // MCP morto: exercita o fallback CLI
      AI_MEMORY_DATA_DIR: fx.dataDir,
      AIM_IMPORT_GROK_DIR: fx.grokDir,
      AIM_IMPORT_KIRO_DIR: fx.kiroDir,
      AIM_APP_IMPORT_FILE: fx.stateFile,
    },
    stdio: 'ignore',
  });
  assert.ok(await waitHealth(), 'servidor de teste não subiu');
});

test.after(() => {
  if (child) child.kill('SIGTERM');
});

test('GET /api/import/sources lista as fontes com contagens e runtime', async () => {
  const res = await fetch(`${BASE}/api/import/sources`);
  assert.equal(res.status, 200);
  const data = await res.json();
  const v1 = data.sources.find((s) => s.id === 'grok-v1');
  assert.equal(v1.available, true);
  assert.ok(v1.counts.curated >= 3);
  assert.ok(v1.counts.raw >= 1);
  const kiro = data.sources.find((s) => s.id === 'kiro');
  assert.ok(kiro.warnings.some((w) => /sqlite3|memory\.db/.test(w)) || kiro.counts.curated >= 2);
  assert.ok(data.runtime.dataDir && data.runtime.bin);
  assert.equal(data.runtime.links, 2);
});

test('POST /api/import/scan devolve itens leves com destino e status', async () => {
  const res = await fetch(`${BASE}/api/import/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'grok-v1' }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.source, 'grok-v1');
  assert.ok(data.items.length >= 4);
  const item = data.items.find((i) => i.title === 'Estilo de codigo');
  assert.equal(item.suggested.path, '_rules/estilo-de-codigo.md');
  assert.deepEqual(item.target, { global: true });
  assert.equal(item.status, 'new');
  assert.equal(item.body, undefined); // scan não carrega o corpo
  assert.ok(item.chars > 0 && item.preview.length > 0);
  assert.ok(data.summary.new >= 4);

  const bad = await fetch(`${BASE}/api/import/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'inexistente' }),
  });
  assert.equal(bad.status, 400);
});

test('POST /api/import/item devolve o markdown completo', async () => {
  const scan = await (await fetch(`${BASE}/api/import/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'grok-v1' }),
  })).json();
  const item = scan.items.find((i) => i.title === 'Decisoes de arquitetura');
  const res = await fetch(`${BASE}/api/import/item`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'grok-v1', key: item.key }),
  });
  assert.equal(res.status, 200);
  const full = await res.json();
  assert.match(full.body, /Usamos SQLite/);
  assert.ok(full.fingerprint);
});

test('POST /api/import/apply valida a seleção', async () => {
  const empty = await applyImport({ source: 'grok-v1', keys: [] });
  assert.equal(empty.status, 400);
  const badSource = await applyImport({ source: 'nope', keys: ['x'] });
  assert.equal(badSource.status, 400);
  assert.match(badSource.body.error, /fonte desconhecida/);
});

test('apply importa item a item (fallback CLI), registra estado e o run no histórico', { timeout: 30_000 }, async () => {
  const scan = await (await fetch(`${BASE}/api/import/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'grok-v1' }),
  })).json();
  const target = scan.items.find((i) => i.title === 'Estilo de codigo');

  const started = await applyImport({ source: 'grok-v1', keys: [target.key] });
  assert.equal(started.status, 201);
  assert.ok(started.body.id);

  const lines = await collectJobLog(started.body.id);
  const log = lines.map((l) => l.text).join('');
  assert.match(log, /_rules\/estilo-de-codigo\.md/);
  assert.match(log, /✓/);
  assert.match(log, /resumo: 1 importada\(s\)/);
  assert.equal((await jobStatus(started.body.id)).status, 'ok');

  const state = await (await fetch(`${BASE}/api/import/state`)).json();
  assert.equal(state.imported, 1);
  assert.equal(state.runs[0].source, 'grok-v1');
  assert.equal(state.runs[0].imported, 1);
  assert.equal(state.runs[0].failed, 0);
  assert.equal(state.runs[0].jobId, started.body.id);

  // re-scan: o item agora aparece como "já importado"
  const again = await (await fetch(`${BASE}/api/import/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'grok-v1' }),
  })).json();
  assert.equal(again.items.find((i) => i.title === 'Estilo de codigo').status, 'same');
});

test('apply com dry-run não grava nem registra itens', { timeout: 30_000 }, async () => {
  const scan = await (await fetch(`${BASE}/api/import/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'grok-v1' }),
  })).json();
  const target = scan.items.find((i) => i.title === 'Contexto do produto');

  const started = await applyImport({ source: 'grok-v1', keys: [target.key], dryRun: true });
  const log = (await collectJobLog(started.body.id)).map((l) => l.text).join('');
  assert.match(log, /dry-run: nada será gravado/);
  assert.match(log, /\(dry-run\)/);

  const state = await (await fetch(`${BASE}/api/import/state`)).json();
  assert.equal(state.imported, 1); // só o item do teste anterior
  assert.equal(state.runs[0].dryRun, true);
});

test('apply honra overrides de destino e de path/kind/tier/pinned', { timeout: 30_000 }, async () => {
  const scan = await (await fetch(`${BASE}/api/import/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'grok-v1' }),
  })).json();
  const target = scan.items.find((i) => i.title === 'Notas do desconhecido');
  assert.equal(target.target, null); // sem vínculo na fixture

  const started = await applyImport({
    source: 'grok-v1',
    keys: [target.key],
    overrides: { [target.key]: { workspace: 'default', project: 'proj-a', path: 'notes/destino-ajustado.md', kind: 'decision', pinned: false } },
  });
  const log = (await collectJobLog(started.body.id)).map((l) => l.text).join('');
  assert.match(log, /default\/proj-a · notes\/destino-ajustado\.md/);
  assert.match(log, /resumo: 1 importada\(s\), 0 falha\(s\), 0 ignorada\(s\)/);
});

test('item sem destino é ignorado no lote, com motivo no resumo', { timeout: 30_000 }, async () => {
  const v2 = await (await fetch(`${BASE}/api/import/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'grok-v2' }),
  })).json();
  const orfao = v2.items.find((i) => i.title === 'Sem projeto');
  assert.equal(orfao.target, null);

  const started = await applyImport({ source: 'grok-v2', keys: [orfao.key] });
  const log = (await collectJobLog(started.body.id)).map((l) => l.text).join('');
  assert.match(log, /1 ignorada\(s\)/);
});
