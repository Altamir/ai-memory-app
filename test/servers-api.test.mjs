import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// O painel precisa trocar de servidor sem reiniciar: as rotas /api/servers
// mudam o destino e o resto da API (/api/maintenance, que expõe o runtime)
// passa a refletir o servidor ativo. Este teste sobe o painel de verdade e
// troca o perfil em cima, com dois ai-memory falsos para conferir que as
// leituras realmente vão para o destino escolhido — cada um exigindo o seu
// próprio token.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4794;
const BASE = `http://127.0.0.1:${PORT}`;

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-servers-api-'));
const localData = path.join(base, 'data-local');
const remoteData = path.join(base, 'data-remote');
fs.mkdirSync(localData, { recursive: true });
fs.mkdirSync(remoteData, { recursive: true });
fs.writeFileSync(path.join(localData, 'auth-token'), 'token-local\n');
fs.writeFileSync(path.join(remoteData, 'auth-token'), 'token-remoto\n');

/** ai-memory falso: exige Bearer X e devolve uma versão só dele. */
function fakeServer(token, version) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization || null });
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      const msg = JSON.parse(body || '{}');
      if (msg.method === 'initialize') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'mcp-session-id': `sess-${version}` });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: version, version } } }));
        return;
      }
      // tools/call: cada servidor responde com uma página que só ele conhece
      const name = msg.params?.name;
      const structured = name === 'memory_status'
        // o memory_status do MCP traz counts e scope — e nenhum version, que é
        // exatamente por isso que o probe busca a versão na CLI
        ? { counts: { pages_latest: 7, sessions: 3 }, scope: { workspace: 'default', project: version } }
        : { hits: [{ path: `${version}/pagina.md`, title: version, updated_at: 1 }] };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { structuredContent: structured } }));
    });
  });
  return { srv, seen };
}

let panel;
// binário falso da CLI: devolve o JSON de `status --json` que o painel consome
const fakeCli = path.join(base, 'ai-memory-fake');
fs.writeFileSync(fakeCli, `#!/bin/sh
echo '{"version":"9.9.9-fake","data_dir":"/data"}'
`, { mode: 0o755 });
const local = fakeServer('token-local', 'local-1.0');
const remote = fakeServer('token-remoto', 'remoto-2.0');

async function listen(srv) {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${srv.address().port}`;
}

const localUrl = await listen(local.srv);
const remoteUrl = await listen(remote.srv);

async function waitHealth() {
  const deadline = Date.now() + 15_000;
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

const api = async (p, opts = {}) => {
  const res = await fetch(`${BASE}${p}`, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};

test.before(async () => {
  panel = spawn('node', ['server/index.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      AIM_APP_PORT: String(PORT),
      AI_MEMORY_BIN: '/bin/echo',
      AI_MEMORY_SERVER_URL: localUrl,
      AI_MEMORY_DATA_DIR: localData,
      AIM_APP_SERVERS_FILE: path.join(base, '.servers.json'),
      AIM_APP_STATE_FILE: path.join(base, '.sessions.json'),
    },
    stdio: 'ignore',
  });
  assert.ok(await waitHealth(), 'painel de teste não subiu');
});

test.after(() => {
  if (panel) panel.kill('SIGTERM');
  local.srv.close();
  remote.srv.close();
});

test('sem cadastro, o runtime da manutenção é o servidor do ambiente', async () => {
  const { data } = await api('/api/maintenance');
  assert.equal(data.runtime.serverUrl, localUrl);
  assert.equal(data.runtime.dataDir, localData);
});

test('GET /api/servers devolve o perfil do ambiente sem vazar token', async () => {
  const { data } = await api('/api/servers');
  assert.equal(data.active.url, localUrl);
  assert.equal(data.servers.length, 1);
  assert.equal(data.servers[0].hasToken, true);
  assert.equal(JSON.stringify(data).includes('token-local'), false);
});

test('POST /api/servers cadastra e POST /api/servers/activate troca o destino', async () => {
  const created = await api('/api/servers', {
    method: 'POST',
    body: { name: 'VPS', url: remoteUrl, dataDir: remoteData },
  });
  assert.equal(created.status, 200);
  const vps = created.data.servers.find((s) => s.name === 'VPS');
  assert.ok(vps);
  assert.equal(vps.hasToken, true); // token vem do data-dir da vps

  const on = await api('/api/servers/activate', { method: 'POST', body: { id: vps.id } });
  assert.equal(on.data.active.id, vps.id);
  assert.equal(on.data.active.url, remoteUrl);

  // o runtime da manutenção acompanha a troca, sem reiniciar o painel
  const rt = await api('/api/maintenance');
  assert.equal(rt.data.runtime.serverUrl, remoteUrl);
  assert.equal(rt.data.runtime.dataDir, remoteData);
});

test('após a troca, a leitura MCP vai para o servidor novo com o token dele', async () => {
  remote.seen.length = 0;
  // /api/recent é leitura MCP pura (memory_recent): prova que o destino trocou
  const res = await api('/api/recent');
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.source, 'mcp', JSON.stringify(res.data));
  // a página veio do servidor remoto, não do store local em disco
  assert.equal(res.data.items[0]?.path, 'remoto-2.0/pagina.md', JSON.stringify(res.data));
  assert.ok(remote.seen.length >= 2, 'não negociou sessão com o servidor remoto');
  assert.ok(remote.seen.every((s) => s.auth === 'Bearer token-remoto'), JSON.stringify(remote.seen));
  // e o token do servidor antigo não foi junto
  assert.ok(remote.seen.every((s) => !String(s.auth).includes('token-local')));

  // e o servidor antigo parou de receber
  local.seen.length = 0;
  await api('/api/recent');
  assert.equal(local.seen.length, 0, JSON.stringify(local.seen));
});

test('DELETE /api/servers/<id> remove; o ambiente sai da lista mas segue conectado', async () => {
  const list = await api('/api/servers');
  const vps = list.data.servers.find((s) => s.name === 'VPS');
  const del = await api(`/api/servers/${encodeURIComponent(vps.id)}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  // remover o perfil ativo devolve o painel para o ambiente
  assert.equal(del.data.active.id, 'local');
  const rt = await api('/api/maintenance');
  assert.equal(rt.data.runtime.serverUrl, localUrl);
  assert.equal(rt.data.runtime.dataDir, localData);

  // e as leituras voltam ao servidor do ambiente, com o token dele
  local.seen.length = 0;
  const back = await api('/api/recent');
  assert.ok(local.seen.length >= 1, JSON.stringify(local.seen));
  assert.ok(local.seen.every((s) => s.auth === 'Bearer token-local'), JSON.stringify(local.seen));
  assert.equal(back.data.items[0]?.path, 'local-1.0/pagina.md', JSON.stringify(back.data));
});

test('o ambiente pode ser removido da lista e restaurado pela API', async () => {
  const removed = await api('/api/servers/local', { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.equal(removed.data.servers.some((s) => s.id === 'local'), false, 'o ambiente deveria ter saído da lista');
  // o painel continua funcionando: o ambiente segue como destino implícito
  const rt = await api('/api/maintenance');
  assert.equal(rt.data.runtime.serverUrl, localUrl);

  const restored = await api('/api/servers/env', { method: 'POST' });
  assert.equal(restored.status, 200);
  assert.equal(restored.data.servers.some((s) => s.id === 'local'), true, 'o ambiente deveria ter voltado');
});

test('POST /api/servers/probe testa o destino sem trocar o servidor ativo', async () => {
  const before = await api('/api/servers');
  const probe = await api('/api/servers/probe', { method: 'POST', body: { url: remoteUrl, dataDir: remoteData, bin: fakeCli } });
  assert.equal(probe.status, 200);
  assert.equal(probe.data.ok, true, JSON.stringify(probe.data));
  // o MCP respondeu: é isso que prova que o destino serve
  assert.ok(probe.data.counts, 'o probe não devolveu o que o MCP respondeu');
  // e a versão veio inteira da CLI, sem o '?' que a tela mostrava
  assert.equal(probe.data.version, '9.9.9-fake', JSON.stringify(probe.data));
  assert.equal(probe.data.versionNote, null);
  const after = await api('/api/servers');
  assert.equal(after.data.active.id, before.data.active.id, 'o probe não pode trocar o ativo');
});

test('probe com a CLI real traz a versão, sem trocar o servidor ativo', async () => {
  const before = await api('/api/servers');
  // binário falso que fala JSON como a CLI: prova que a versão é lida da CLI,
  // e não do MCP (que não a traz)
  const probe = await api('/api/servers/probe', {
    method: 'POST',
    body: { url: remoteUrl, dataDir: remoteData, bin: fakeCli },
  });
  assert.equal(probe.status, 200);
  assert.equal(probe.data.ok, true, JSON.stringify(probe.data));
  assert.equal(probe.data.version, '9.9.9-fake', JSON.stringify(probe.data));
  assert.equal(probe.data.versionNote, null);
  const after = await api('/api/servers');
  assert.equal(after.data.active.id, before.data.active.id);
});

test('probe sem versão na saída da CLI continua válido e explica', async () => {
  // /bin/echo sai com 0 mas não traz `version`: o probe segue válido e diz o motivo
  const probe = await api('/api/servers/probe', {
    method: 'POST',
    body: { url: remoteUrl, dataDir: remoteData, bin: '/bin/echo' },
  });
  assert.equal(probe.status, 200);
  assert.equal(probe.data.ok, true, JSON.stringify(probe.data));
  assert.equal(probe.data.version, null);
  assert.ok(probe.data.versionNote, 'sem versão e sem explicação na tela');
});

test('probe com CLI ausente não derruba o teste da conexão', async () => {
  const probe = await api('/api/servers/probe', {
    method: 'POST',
    body: { url: remoteUrl, dataDir: remoteData, bin: '/caminho/que/nao/existe' },
  });
  assert.equal(probe.status, 200);
  assert.equal(probe.data.ok, true, JSON.stringify(probe.data)); // o MCP respondeu
  assert.equal(probe.data.version, null);
  assert.match(probe.data.versionNote, /não deu para ler a versão/);
});

test('probe de URL inválida ou caída responde erro em vez de estourar', async () => {
  const bad = await api('/api/servers/probe', { method: 'POST', body: { url: 'nao-e-url' } });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /url de servidor inválida/);

  const dead = await api('/api/servers/probe', { method: 'POST', body: { url: 'http://127.0.0.1:1' } });
  assert.equal(dead.status, 200);
  assert.equal(dead.data.ok, false);
  assert.ok(dead.data.error);
});
