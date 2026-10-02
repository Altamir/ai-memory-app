import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { readTarGz } from '../server/tar.mjs';
import { makeBundleFixture } from './bundle-fixtures.mjs';

// Rotas de exportação no servidor real, com um store de fixtures: o bundle é
// montado do SQLite + wiki e depois importado de volta pela fonte "bundle".

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// porta própria: api.test.mjs usa 4799/4798 e import-api.test.mjs, 4797
const PORT = 4796;
const BASE = `http://127.0.0.1:${PORT}`;

const fx = makeBundleFixture();
let child;
let bundleName = null;

// fake MCP (servidor de destino remoto do import)
const remoteCalls = [];
const remote = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const msg = JSON.parse(body || '{}');
    if (msg.method === 'initialize') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'mcp-session-id': 'r1' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18' } }));
      return;
    }
    if (msg.method === 'notifications/initialized') {
      res.writeHead(202).end();
      return;
    }
    if (msg.method === 'tools/call') {
      remoteCalls.push({ args: msg.params.arguments, auth: req.headers.authorization || null });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { structuredContent: { ok: true } } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
  });
});
await new Promise((r) => remote.listen(0, '127.0.0.1', r));
const remotePort = remote.address().port;

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

async function postJson(route, body) {
  const res = await fetch(`${BASE}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function collectJobLog(id, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/api/jobs/${id}/stream`, { signal: controller.signal });
    const text = await res.text();
    const lines = [];
    for (const raw of text.split('\n')) {
      if (!raw.startsWith('data:')) continue;
      try {
        lines.push(JSON.parse(raw.slice(5).trim()));
      } catch {
        // fragmento inválido
      }
    }
    return lines;
  } finally {
    clearTimeout(timer);
  }
}

test.before(async () => {
  if (!fx.hasSqlite) return;
  child = spawn('node', ['server/index.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      AIM_APP_PORT: String(PORT),
      AIM_APP_STATE_FILE: path.join(fx.tmp, 'sessions.json'),
      AIM_APP_IMPORT_FILE: fx.stateFile,
      AIM_APP_EXPORT_DIR: fx.exportsDir,
      AIM_STORE_DIR: fx.storeDir,
      // perfil de servidor isolado: sem isto, um .servers.json no root do repo
      // (com o perfil ativo gravado) sobrepõe o data-dir deste fixture
      AIM_APP_SERVERS_FILE: path.join(fx.tmp, 'servers.json'),
      AI_MEMORY_DATA_DIR: fx.dataDir,
      AI_MEMORY_BIN: '/bin/echo', // fallback da CLI não toca em store nenhum
      AI_MEMORY_SERVER_URL: 'http://127.0.0.1:1',
    },
    stdio: 'ignore',
  });
  assert.ok(await waitHealth(), 'servidor de teste não subiu');
});

test.after(() => {
  if (child) child.kill('SIGTERM');
  remote.close();
});

test('GET /api/export/sources: store, escopos e contagens', { skip: fx.hasSqlite ? false : 'sqlite3 ausente' }, async () => {
  const res = await fetch(`${BASE}/api/export/sources`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.store.dir, fx.storeDir);
  assert.equal(data.store.available, true);
  assert.equal(data.store.sqlite, true);
  assert.deepEqual(data.scopes.map((s) => `${s.workspace}/${s.project}`).sort(), ['default/_global', 'default/proj-a']);
  assert.equal(data.totals.pages, fx.expected.all);
  assert.equal(data.totals.raw, fx.expected.raw);
  assert.equal(data.exportsDir, fx.exportsDir);
  assert.deepEqual(data.bundles, []);
  assert.equal(data.runtime.dataDir, fx.dataDir);
});

test('POST /api/export/plan: dry-run sem escrever nada', { skip: fx.hasSqlite ? false : 'sqlite3 ausente' }, async () => {
  const { status, body } = await postJson('/api/export/plan', { scopes: [{ workspace: 'default', project: 'proj-a' }] });
  assert.equal(status, 200);
  assert.equal(body.pages, fx.expected.projCurated);
  assert.equal(body.rawSkipped, 1);
  assert.match(body.file, /\.tar\.gz$/);
  assert.ok(body.preview.length > 0);
  // o plano não cria a pasta de exports nem escreve nada nela
  assert.equal(fs.existsSync(fx.exportsDir) ? fs.readdirSync(fx.exportsDir).length : 0, 0);

  const bad = await postJson('/api/export/plan', { scopes: [{ workspace: 'default', project: 'inexistente' }] });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /nenhuma página/);
});

test('POST /api/export/run: job grava o bundle e verifica o conteúdo', { skip: fx.hasSqlite ? false : 'sqlite3 ausente' }, async () => {
  const { status, body } = await postJson('/api/export/run', {
    scopes: [{ workspace: 'default', project: 'proj-a' }, { workspace: 'default', project: '_global' }],
    name: 'bundle-do-teste',
  });
  assert.equal(status, 201);
  assert.ok(body.id);
  const log = (await collectJobLog(body.id)).map((l) => l.text).join('');
  assert.match(log, /escopo default\/proj-a: \d+ página\(s\), 1 crua\(s\) fora/);
  assert.match(log, /verificação ok/);
  assert.match(log, /importe na aba Importar/);
  const job = await (await fetch(`${BASE}/api/jobs/${body.id}`)).json();
  assert.equal(job.status, 'ok');

  const list = await (await fetch(`${BASE}/api/export/sources`)).json();
  assert.equal(list.bundles.length, 1);
  bundleName = list.bundles[0].file;
  assert.equal(bundleName, 'bundle-do-teste.tar.gz');
  assert.equal(list.bundles[0].pages, fx.expected.curated);
  assert.deepEqual(list.bundles[0].scopes.sort(), ['default/_global', 'default/proj-a']);
  assert.equal(list.bundles[0].origin, fx.storeDir);
});

test('GET /api/export/download: entrega o .tar.gz e recusa o que está fora', { skip: fx.hasSqlite ? false : 'sqlite3 ausente' }, async () => {
  const res = await fetch(`${BASE}/api/export/download?file=${encodeURIComponent(bundleName)}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/gzip');
  assert.match(res.headers.get('content-disposition'), /attachment; filename="bundle-do-teste\.tar\.gz"/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf[0], 0x1f); // gzip
  assert.equal(buf[1], 0x8b);
  const names = readTarGz(buf).entries.map((e) => e.name);
  assert.ok(names.includes('manifest.json'));
  assert.ok(names.includes('scopes/default/proj-a/notes/deploy.md'));
  assert.ok(!names.some((n) => n.includes('log-2026-01.md')));

  const traversal = await fetch(`${BASE}/api/export/download?file=${encodeURIComponent('../../etc/hosts')}`);
  assert.equal(traversal.status, 400);
  const notFound = await fetch(`${BASE}/api/export/download?file=nao-existe.tar.gz`);
  assert.equal(notFound.status, 400);
});

test('POST /api/import/scan com source bundle: itens com destino de origem', { skip: fx.hasSqlite ? false : 'sqlite3 ausente' }, async () => {
  // o bundle foi exportado sem as cruas: elas não existem mais dentro dele
  const { status, body } = await postJson('/api/import/scan', { source: 'bundle', bundleFile: bundleName, includeRaw: true });
  assert.equal(status, 200);
  assert.equal(body.available, true);
  assert.equal(body.items.length, fx.expected.curated);
  assert.equal(body.summary.raw, 0);
  const rule = body.items.find((i) => i.suggested.path === '_rules/sempre-testar.md');
  assert.deepEqual(rule.target, { workspace: 'default', project: 'proj-a' });
  assert.match(rule.targetReason, /vinculado aqui a/);
  const globalItem = body.items.find((i) => i.suggested.path === 'notes/estilo-zzportal.md');
  assert.deepEqual(globalItem.target, { global: true });

  const { status: itemStatus, body: item } = await postJson('/api/import/item', { source: 'bundle', bundleFile: bundleName, key: rule.key });
  assert.equal(itemStatus, 200);
  assert.match(item.body, /Rodar os testes/);
  assert.ok(item.fingerprint);
});

test('POST /api/import/apply com bundle: grava item a item e registra o run', { skip: fx.hasSqlite ? false : 'sqlite3 ausente' }, async () => {
  const scan = await (await fetch(`${BASE}/api/import/scan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'bundle', bundleFile: bundleName, includeRaw: false }) })).json();
  const keys = scan.items.filter((i) => i.suggested.path !== 'notes/so-no-db.md').map((i) => i.key);

  const { status, body } = await postJson('/api/import/apply', { source: 'bundle', bundleFile: bundleName, keys, includeRaw: false, dryRun: false });
  assert.equal(status, 201);
  const log = (await collectJobLog(body.id)).map((l) => l.text).join('');
  assert.match(log, /bundle: bundle-do-teste\.tar\.gz/);
  assert.match(log, /import bundle bundle-do-teste\.tar\.gz: \d+ selecionado\(s\)/);
  assert.match(log, /default\/proj-a · _rules\/sempre-testar\.md/);
  assert.match(log, /resumo: \d+ importada\(s\), 0 falha\(s\), 0 ignorada\(s\)/);

  const state = await (await fetch(`${BASE}/api/import/state`)).json();
  assert.equal(state.runs[0].source, 'bundle');
  assert.equal(state.runs[0].failed, 0);
  assert.equal(state.runs[0].skipped, 0);
});

test('POST /api/import/apply com servidor remoto: grava no outro ai-memory', { skip: fx.hasSqlite ? false : 'sqlite3 ausente' }, async () => {
  const scan = await (await fetch(`${BASE}/api/import/scan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'bundle', bundleFile: bundleName, includeRaw: false }) })).json();
  const target = scan.items.find((i) => i.suggested.path === 'notes/deploy.md');
  const { status, body } = await postJson('/api/import/apply', {
    source: 'bundle',
    bundleFile: bundleName,
    keys: [target.key],
    includeRaw: false,
    server: { url: `http://127.0.0.1:${remotePort}`, token: 'token-remoto' },
  });
  assert.equal(status, 201);
  const log = (await collectJobLog(body.id)).map((l) => l.text).join('');
  assert.match(log, /destino: http:\/\/127\.0\.0\.1:\d+ \(remoto, com token\)/);
  assert.match(log, /✓ \(mcp \(remoto\)\)/);

  const call = remoteCalls.at(-1);
  assert.equal(call.args.path, 'notes/deploy.md');
  assert.equal(call.args.project, 'proj-a');
  assert.equal(call.auth, 'Bearer token-remoto');
  assert.ok(!remoteCalls.some((c) => c.auth === `Bearer ${fx.localToken}`), 'token local não pode ir para o servidor remoto');
});

test('POST /api/import/apply com bundle: valida arquivo e seleção', async () => {
  const withoutFile = await postJson('/api/import/apply', { source: 'bundle', keys: ['bundle|default/proj-a|notes/deploy.md'] });
  assert.equal(withoutFile.status, 400);
  assert.match(withoutFile.body.error, /arquivo do bundle/);
  const empty = await postJson('/api/import/apply', { source: 'bundle', bundleFile: bundleName, keys: [] });
  assert.equal(empty.status, 400);
  const badSource = await postJson('/api/import/apply', { source: 'nope', keys: ['x'] });
  assert.equal(badSource.status, 400);
});

test('POST /api/export/delete: exige o nome digitado e remove o arquivo', { skip: fx.hasSqlite ? false : 'sqlite3 ausente' }, async () => {
  const noConfirm = await postJson('/api/export/delete', { file: bundleName });
  assert.equal(noConfirm.status, 409);
  assert.equal(noConfirm.body.needsConfirm, true);
  assert.equal(noConfirm.body.file, bundleName);
  const wrong = await postJson('/api/export/delete', { file: bundleName, confirm: 'outro.tar.gz' });
  assert.equal(wrong.status, 409);
  assert.match(wrong.body.error, /digite o nome/);
  assert.equal(fs.existsSync(path.join(fx.exportsDir, bundleName)), true);

  const ok = await postJson('/api/export/delete', { file: bundleName, confirm: bundleName });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { file: bundleName, deleted: true });
  assert.equal(fs.existsSync(path.join(fx.exportsDir, bundleName)), false);
  const list = await (await fetch(`${BASE}/api/export/sources`)).json();
  assert.deepEqual(list.bundles, []);
});

test('GET /api/import/sources mostra a fonte bundle com os arquivos da pasta', { skip: fx.hasSqlite ? false : 'sqlite3 ausente' }, async () => {
  // um bundle novo (não gzip) só para a listagem: aparece com erro, sem derrubar a resposta
  fs.writeFileSync(path.join(fx.exportsDir, 'solto.tar.gz'), zlib.gzipSync(Buffer.alloc(512, 0x41)));
  const data = await (await fetch(`${BASE}/api/import/sources`)).json();
  const source = data.sources.find((s) => s.id === 'bundle');
  assert.equal(source.needsFile, true);
  assert.equal(source.root, fx.exportsDir);
  assert.equal(source.counts.bundles, 1);
  assert.equal(source.bundles[0].file, 'solto.tar.gz');
  assert.ok(source.bundles[0].error);
  assert.equal(data.runtime.sqlite, true);
});
