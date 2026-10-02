import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Regressão do 401 do painel: o resolveTarget era chamado duas vezes
// (initialize resolvia e post re-resolvia), marcava remote=true e a chamada
// LOCAL saía sem o Authorization. O servidor fake exige o header em toda
// requisição; o cliente deve anexar o token do arquivo/env no alvo local e
// nunca anexar o token local em alvo remoto.

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-mcp-'));
const dataDir = path.join(base, 'data');
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'auth-token'), 'token-do-arquivo\n');

const seen = []; // { auth, sessionId } de cada requisição
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seen.push({ auth: req.headers.authorization || null, sessionId: req.headers['mcp-session-id'] || null });
    if (!req.headers.authorization) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    const msg = JSON.parse(body);
    if (msg.method === 'initialize') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'mcp-session-id': 'sess-teste' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake', version: '0' } } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ pong: true }) }] } }));
  });
});

// config.mjs congela serverUrl/dataDir no import: env precisa vir antes
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.AI_MEMORY_SERVER_URL = `http://127.0.0.1:${server.address().port}`;
process.env.AI_MEMORY_DATA_DIR = dataDir;
delete process.env.AI_MEMORY_AUTH_TOKEN; // cenário base: só o arquivo

const { tryTool } = await import('../server/mcp.mjs');

test.after(() => server.close());

test('chamada local anexa o token do arquivo em todas as requisições', async () => {
  seen.length = 0;
  const res = await tryTool('memory_status', {});
  assert.equal(res.ok, true, res.error);
  assert.ok(seen.length >= 2, JSON.stringify(seen)); // initialize + tools/call
  assert.ok(seen.every((s) => s.auth === 'Bearer token-do-arquivo'), JSON.stringify(seen));
});

test('env AI_MEMORY_AUTH_TOKEN vence o arquivo (mesma precedência da CLI)', async () => {
  process.env.AI_MEMORY_AUTH_TOKEN = 'token-do-env';
  seen.length = 0;
  const res = await tryTool('memory_status', {});
  assert.equal(res.ok, true, res.error);
  assert.ok(seen.every((s) => s.auth === 'Bearer token-do-env'), JSON.stringify(seen));
  delete process.env.AI_MEMORY_AUTH_TOKEN;
});

test('alvo remoto sem token NÃO leva o token local', async () => {
  seen.length = 0;
  const res = await tryTool('memory_status', {}, { target: { url: `http://127.0.0.1:${server.address().port}` } });
  assert.equal(res.ok, false);
  assert.match(res.error, /401/);
  assert.ok(seen.length >= 1);
  assert.ok(seen.every((s) => s.auth === null), JSON.stringify(seen));
});
