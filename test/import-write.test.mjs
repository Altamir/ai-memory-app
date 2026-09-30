import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// writePage: caminho MCP (payload completo — o corpo É o conteúdo da página) e
// fallback CLI com o corpo no stdin. Um bug real nasceu aqui: o apply passava
// itens leves (sem body) e o MCP recusava, gravando página vazia pela CLI.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-write-'));
const capture = path.join(tmp, 'stdin.txt');
const fakeBin = path.join(tmp, 'fake-ai-memory');
fs.writeFileSync(fakeBin, `#!/bin/sh\ncat > ${JSON.stringify(capture)}\nexit 0\n`);
fs.chmodSync(fakeBin, 0o755);

// fake MCP: initialize + tools/call, registrando os argumentos recebidos
const received = [];
const mcp = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const msg = JSON.parse(body || '{}');
    if (msg.method === 'initialize') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'mcp-session-id': 'fake-session' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18' } }));
      return;
    }
    if (msg.method === 'notifications/initialized') {
      res.writeHead(202).end();
      return;
    }
    if (msg.method === 'tools/call') {
      received.push(msg.params);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { structuredContent: { page_id: 'p1', path: msg.params.arguments.path } } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
  });
});
await new Promise((r) => mcp.listen(0, '127.0.0.1', r));
const mcpPort = mcp.address().port;

process.env.AI_MEMORY_SERVER_URL = `http://127.0.0.1:${mcpPort}`;
process.env.AI_MEMORY_BIN = fakeBin;
process.env.AI_MEMORY_DATA_DIR = tmp;
process.env.AIM_APP_IMPORT_FILE = path.join(tmp, 'state.json');

const { writePage } = await import('../server/import.mjs');

test.after(() => {
  mcp.close();
});

test('via MCP: envia path, body, kind, tier, tags e scope global', async () => {
  const out = await writePage({
    pagePath: '_rules/regra-de-teste.md',
    body: '# Regra de teste\n\nSempre rodar os testes.\n',
    title: 'Regra de teste',
    kind: 'rule',
    tier: 'procedural',
    tags: ['grok', 'grok-v2'],
    pinned: true,
    target: { global: true },
  });
  assert.equal(out.via, 'mcp');
  const call = received.at(-1);
  assert.equal(call.name, 'memory_write_page');
  assert.equal(call.arguments.path, '_rules/regra-de-teste.md');
  assert.equal(call.arguments.body, '# Regra de teste\n\nSempre rodar os testes.\n');
  assert.equal(call.arguments.kind, 'rule');
  assert.equal(call.arguments.tier, 'procedural');
  assert.equal(call.arguments.pinned, true);
  assert.deepEqual(call.arguments.tags, ['grok', 'grok-v2']);
  assert.equal(call.arguments.scope, 'global');
  assert.equal(call.arguments.workspace, undefined);
});

test('via MCP: projeto vinculado manda workspace e project (sem scope)', async () => {
  await writePage({
    pagePath: 'notes/nota.md',
    body: '# Nota\n\nx\n',
    tier: 'episodic',
    tags: [],
    pinned: false,
    target: { workspace: 'default', project: 'proj-a' },
  });
  const call = received.at(-1);
  assert.equal(call.arguments.workspace, 'default');
  assert.equal(call.arguments.project, 'proj-a');
  assert.equal(call.arguments.scope, undefined);
});

test('MCP fora do ar: cai para a CLI com o corpo no stdin', async () => {
  await new Promise((r) => mcp.close(r));
  fs.rmSync(capture, { force: true });
  const out = await writePage({
    pagePath: 'notes/fallback.md',
    body: '# Fallback\n\ncorpo pelo stdin.\n',
    title: 'Fallback',
    kind: 'fact',
    tier: 'semantic',
    tags: ['x'],
    pinned: false,
    target: { workspace: 'default', project: 'proj-a' },
  });
  assert.equal(out.via, 'cli');
  assert.match(String(out.note), /ECONNREFUSED|fetch failed|MCP/i);
  assert.equal(fs.readFileSync(capture, 'utf8'), '# Fallback\n\ncorpo pelo stdin.\n');
});
