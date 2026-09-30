import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createTarGz } from '../server/tar.mjs';

// Importação de bundle: MCP do servidor local, MCP de OUTRO servidor (URL +
// token informados na tela) e a regra que importa aqui — o token local nunca
// pode vazar para um servidor remoto.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-bundle-write-'));
const exportsDir = path.join(tmp, 'exports');
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(exportsDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'auth-token'), 'token-local-do-painel\n');

// fake da CLI: registra env e stdin (fallback quando o MCP cai)
const envCapture = path.join(tmp, 'env.txt');
const stdinCapture = path.join(tmp, 'stdin.txt');
const fakeBin = path.join(tmp, 'fake-ai-memory');
fs.writeFileSync(fakeBin, `#!/bin/sh\nenv | grep '^AI_MEMORY' > ${JSON.stringify(envCapture)}\ncat > ${JSON.stringify(stdinCapture)}\nexit 0\n`);
fs.chmodSync(fakeBin, 0o755);

/** fake MCP: registra as chamadas (com o Authorization recebido) por porta. */
function startFakeMcp({ respond = () => ({ structuredContent: { ok: true } }) } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const msg = JSON.parse(body || '{}');
      if (msg.method === 'initialize') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'mcp-session-id': 's1' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18' } }));
        return;
      }
      if (msg.method === 'notifications/initialized') {
        res.writeHead(202).end();
        return;
      }
      if (msg.method === 'tools/call') {
        calls.push({ name: msg.params.name, args: msg.params.arguments, auth: req.headers.authorization || null });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: respond(msg.params) }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, port: server.address().port })));
}

const local = await startFakeMcp();
const remote = await startFakeMcp();

process.env.AIM_APP_EXPORT_DIR = exportsDir;
process.env.AI_MEMORY_DATA_DIR = dataDir;
process.env.AI_MEMORY_BIN = fakeBin;
process.env.AI_MEMORY_SERVER_URL = `http://127.0.0.1:${local.port}`;
process.env.AIM_APP_IMPORT_FILE = path.join(tmp, 'import-state.json');

const { applyBundleImport, scanImportSource } = await import('../server/import.mjs');

const BUNDLE = 'meu-bundle.tar.gz';

function writeBundle(name = BUNDLE) {
  const manifest = {
    format: 'ai-memory-bundle',
    version: 1,
    exportedAt: '2026-01-01T00:00:00Z',
    origin: { storeDir: '/store-de-origem' },
    totals: { pages: 4, scopes: 2 },
    scopes: [
      { workspace: 'default', project: 'proj-a', pages: 3 },
      { workspace: 'default', project: '_global', pages: 1 },
    ],
    pages: [
      { scope: 'default/proj-a', path: '_rules/sempre-testar.md', title: 'Sempre testar', kind: 'rule', tier: 'procedural', tags: ['testes'], pinned: true, raw: false },
      { scope: 'default/proj-a', path: 'notes/deploy.md', title: 'Deploy', kind: 'note', tier: 'semantic', tags: ['deploy', 'docker'], pinned: false, raw: false },
      { scope: 'default/proj-a', path: 'sessions/2026-01-02.md', title: 'Sessao', kind: 'note', tier: 'episodic', tags: [], pinned: false, raw: true },
      { scope: 'default/_global', path: 'notes/estilo.md', title: 'Estilo', kind: 'note', tier: 'semantic', tags: ['ui'], pinned: false, raw: false },
    ],
  };
  fs.writeFileSync(path.join(exportsDir, name), createTarGz([
    { name: 'manifest.json', data: `${JSON.stringify(manifest)}\n` },
    { name: 'README.md', data: '# Bundle\n' },
    { name: 'scopes/default/proj-a/_meta.md', data: '---\nworkspace: default\nproject: proj-a\ntype: Scope Manifest\n---\n' },
    { name: 'scopes/default/_global/_meta.md', data: '---\nworkspace: default\nproject: _global\ntype: Scope Manifest\n---\n' },
    { name: 'scopes/default/proj-a/_rules/sempre-testar.md', data: '---\nkind: rule\ntitle: Sempre testar\ntier: procedural\npinned: true\ntags:\n- testes\n---\n# Sempre testar\n\nRodar os testes.\n' },
    { name: 'scopes/default/proj-a/notes/deploy.md', data: '---\nkind: note\ntitle: Deploy\ntags: [deploy, docker]\n---\n# Deploy\n\nVolume em ~/.ai-memory-data.\n' },
    { name: 'scopes/default/proj-a/sessions/2026-01-02.md', data: '---\nkind: note\ntitle: Sessao\ntier: episodic\n---\n# Sessao\n\nTranscricao crua.\n' },
    { name: 'scopes/default/_global/notes/estilo.md', data: '---\nkind: note\ntitle: Estilo\ntags: [ui]\n---\n# Estilo\n\nTokens do zzportal.\n' },
  ]));
}

writeBundle();

const collect = (log) => {
  const lines = [];
  const fn = (kind, text) => lines.push(`${kind}:${text}`);
  if (log) log.push(lines);
  return fn;
};

test.after(() => {
  local.server.close();
  remote.server.close();
});

test('scan de bundle: itens com destino do escopo de origem e cru desmarcável', async () => {
  const scan = await scanImportSource('bundle', { bundleFile: BUNDLE, includeRaw: true });
  assert.equal(scan.available, true);
  assert.equal(scan.items.length, 4);
  assert.equal(scan.bundle.origin, '/store-de-origem');
  assert.deepEqual(scan.bundle.scopes.sort(), ['default/_global', 'default/proj-a']);
  const rule = scan.items.find((i) => i.suggested.path === '_rules/sempre-testar.md');
  assert.deepEqual(rule.target, { workspace: 'default', project: 'proj-a' });
  assert.match(rule.targetReason, /escopo do bundle \(default\/proj-a\)/);
  assert.equal(rule.status, 'new');
  assert.equal(rule.body, undefined); // scan é leve
  const globalItem = scan.items.find((i) => i.suggested.path === 'notes/estilo.md');
  assert.deepEqual(globalItem.target, { global: true });
  const rawItem = scan.items.find((i) => i.suggested.path.startsWith('sessions/'));
  assert.equal(rawItem.raw, true);

  const curated = await scanImportSource('bundle', { bundleFile: BUNDLE, includeRaw: false });
  assert.equal(curated.items.length, 3);

  const missing = await scanImportSource('bundle', { bundleFile: 'nao-existe.tar.gz' });
  assert.equal(missing.available, false);
  assert.match(missing.warnings.join(' '), /não encontrado/);
});

test('apply grava no MCP do servidor do painel, com kind/tier/tags/pinned do bundle', async () => {
  const scan = await scanImportSource('bundle', { bundleFile: BUNDLE, includeRaw: false });
  const keys = scan.items.map((i) => i.key);
  const result = await applyBundleImport({ keys, bundleFile: BUNDLE, includeRaw: false, log: collect() });
  assert.equal(result.imported.length, 3);
  assert.equal(result.failed.length, 0);

  const rule = local.calls.find((c) => c.args.path === '_rules/sempre-testar.md');
  assert.equal(rule.name, 'memory_write_page');
  assert.equal(rule.args.kind, 'rule');
  assert.equal(rule.args.tier, 'procedural');
  assert.equal(rule.args.pinned, true);
  assert.deepEqual(rule.args.tags, ['testes']);
  assert.equal(rule.args.workspace, 'default');
  assert.equal(rule.args.project, 'proj-a');
  assert.match(rule.args.body, /Rodar os testes/);
  assert.ok(!rule.args.body.includes('kind: rule'), 'corpo vai sem frontmatter');

  const deploy = local.calls.find((c) => c.args.path === 'notes/deploy.md');
  assert.equal(deploy.args.kind, 'fact');
  assert.deepEqual(deploy.args.tags, ['deploy', 'docker']);

  const globalCall = local.calls.find((c) => c.args.path === 'notes/estilo.md');
  assert.equal(globalCall.args.scope, 'global');
  assert.equal(globalCall.args.workspace, undefined);

  // o token local SEMPRE acompanha o servidor do painel
  assert.equal(rule.auth, 'Bearer token-local-do-painel');

  // re-scan: o que foi gravado aparece como já importado
  const again = await scanImportSource('bundle', { bundleFile: BUNDLE, includeRaw: false });
  assert.equal(again.items.find((i) => i.suggested.path === 'notes/deploy.md').status, 'same');
  const state = JSON.parse(fs.readFileSync(process.env.AIM_APP_IMPORT_FILE, 'utf8'));
  assert.equal(state.runs[0].source, 'bundle');
  assert.equal(state.runs[0].imported, 3);
});

test('apply em OUTRO servidor: usa a URL da tela e não vaza o token local', async () => {
  const scan = await scanImportSource('bundle', { bundleFile: BUNDLE, includeRaw: false });
  const target = scan.items.find((i) => i.suggested.path === 'notes/deploy.md');
  const result = await applyBundleImport({
    keys: [target.key],
    bundleFile: BUNDLE,
    includeRaw: false,
    server: { url: `http://127.0.0.1:${remote.port}`, token: 'token-do-outro-servidor' },
    log: collect(),
  });
  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0].via, 'mcp (remoto)');
  const call = remote.calls.at(-1);
  assert.equal(call.args.path, 'notes/deploy.md');
  assert.equal(call.args.project, 'proj-a');
  assert.equal(call.auth, 'Bearer token-do-outro-servidor');
  assert.ok(!remote.calls.some((c) => c.auth === 'Bearer token-local-do-painel'));
  assert.equal(local.calls.filter((c) => c.args.path === 'notes/deploy.md').length, 1, 'o servidor do painel não recebe a página do destino remoto');
});

test('servidor remoto sem token: nenhum Authorization é enviado', async () => {
  const scan = await scanImportSource('bundle', { bundleFile: BUNDLE, includeRaw: false });
  const target = scan.items.find((i) => i.suggested.path.startsWith('_rules/'));
  await applyBundleImport({
    keys: [target.key],
    bundleFile: BUNDLE,
    includeRaw: false,
    server: { url: `http://127.0.0.1:${remote.port}` },
    log: collect(),
  });
  const call = remote.calls.at(-1);
  assert.equal(call.args.path, '_rules/sempre-testar.md');
  assert.equal(call.auth, null);
});

test('overrides da tela mudam destino e opções do item', async () => {
  const scan = await scanImportSource('bundle', { bundleFile: BUNDLE, includeRaw: true });
  const target = scan.items.find((i) => i.suggested.path.startsWith('sessions/'));
  const log = [];
  const result = await applyBundleImport({
    keys: [target.key],
    bundleFile: BUNDLE,
    includeRaw: true,
    overrides: { [target.key]: { workspace: 'default', project: 'proj-b', path: 'notes/historico/sessao.md', kind: 'decision', tier: 'semantic', pinned: true } },
    log: collect(log),
  });
  assert.equal(result.imported.length, 1);
  const call = local.calls.at(-1);
  assert.equal(call.args.path, 'notes/historico/sessao.md');
  assert.equal(call.args.project, 'proj-b');
  assert.equal(call.args.kind, 'decision');
  assert.equal(call.args.tier, 'semantic');
  assert.equal(call.args.pinned, true);
  assert.match(log.join('\n'), /default\/proj-b · notes\/historico\/sessao\.md/);
});

test('dry-run não grava página nem marca item como importado', async () => {
  writeBundle('outro-bundle.tar.gz');
  const scan = await scanImportSource('bundle', { bundleFile: 'outro-bundle.tar.gz', includeRaw: false });
  const keys = scan.items.map((i) => i.key);
  const before = local.calls.length;
  const log = [];
  const result = await applyBundleImport({ keys, bundleFile: 'outro-bundle.tar.gz', includeRaw: false, dryRun: true, log: collect(log) });
  assert.equal(result.imported.length, 0);
  assert.equal(local.calls.length, before);
  assert.match(log.join(''), /dry-run: nada será gravado/);
  assert.match(log.join(''), /\(dry-run\)/);
  const state = JSON.parse(fs.readFileSync(process.env.AIM_APP_IMPORT_FILE, 'utf8'));
  assert.ok(!Object.keys(state.items).some((k) => k.includes('outro')), 'dry-run não registra itens');
});

test('MCP morto: cai para a CLI apontando o servidor remoto, sem o token local', async () => {
  const scan = await scanImportSource('bundle', { bundleFile: BUNDLE, includeRaw: false });
  const target = scan.items.find((i) => i.suggested.path === 'notes/estilo.md');
  fs.rmSync(stdinCapture, { force: true });
  const result = await applyBundleImport({
    keys: [target.key],
    bundleFile: BUNDLE,
    includeRaw: false,
    server: { url: 'http://127.0.0.1:1', token: 'token-do-outro-servidor' },
    log: collect(),
  });
  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0].via, 'cli (remoto)');
  const env = fs.readFileSync(envCapture, 'utf8');
  assert.match(env, /AI_MEMORY_SERVER_URL=http:\/\/127\.0\.0\.1:1/);
  assert.match(env, /AI_MEMORY_AUTH_TOKEN=token-do-outro-servidor/);
  assert.ok(!env.includes('token-local-do-painel'), 'o token local não pode ir para o servidor remoto');
  assert.equal(fs.readFileSync(stdinCapture, 'utf8'), '# Estilo\n\nTokens do zzportal.\n');
});
