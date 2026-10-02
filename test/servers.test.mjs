import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Troca de servidor: o painel inteiro (leitura MCP, jobs da CLI, run) passa a
// falar com o destino escolhido, o perfil do ambiente volta com os valores
// originais e nenhum token vaza para um alvo que não é o dono dele.

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-servers-'));
const localData = path.join(base, 'data-local');
const remoteData = path.join(base, 'data-remote');
fs.mkdirSync(localData, { recursive: true });
fs.mkdirSync(remoteData, { recursive: true });
fs.writeFileSync(path.join(localData, 'auth-token'), 'token-local\n');
fs.writeFileSync(path.join(remoteData, 'auth-token'), 'token-da-vps\n');

const serversFile = path.join(base, '.servers.json');

// config.mjs e servers.mjs congelam no import: env precisa vir antes
process.env.AIM_APP_SERVERS_FILE = serversFile;
// porta fechada de propósito: nenhuma chamada real sai daqui, e o fallback de
// disco (que é o que o teste do store exercita) é justamente o caminho do MCP fora
process.env.AI_MEMORY_SERVER_URL = 'http://127.0.0.1:1';
process.env.AI_MEMORY_DATA_DIR = localData;
process.env.AI_MEMORY_BIN = '/caminho/ai-memory-do-ambiente';
delete process.env.AI_MEMORY_AUTH_TOKEN;

const { config } = await import('../server/config.mjs');
const { listServers, saveServer, activateServer, deleteServer, restoreEnvServer, initActiveServer, isEnvServerActive } = await import('../server/servers.mjs');
const { cliEnv } = await import('../server/cli.mjs');
const { tryTool } = await import('../server/mcp.mjs');
const http = await import('node:http');

const BOOT = { url: config.serverUrl, bin: config.bin, dataDir: config.dataDir };

// servidor MCP falso que grava o Authorization de cada chamada — é o que prova
// para onde o token do processo ESTAVA indo
const seenAuth = [];
const fakeMcp = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seenAuth.push(req.headers.authorization || null);
    const msg = JSON.parse(body || '{}');
    if (msg.method === 'initialize') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'mcp-session-id': 'sess-issue1' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {} } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { structuredContent: { ok: true } } }));
  });
});
await new Promise((r) => fakeMcp.listen(0, '127.0.0.1', r));
const fakeMcpUrl = `http://127.0.0.1:${fakeMcp.address().port}`;

test.after(() => { fakeMcp.close(); });

test('sem cadastro, o perfil do ambiente é o ativo e sai do próprio ambiente', () => {
  const out = listServers();
  assert.equal(out.active.url, BOOT.url);
  assert.equal(out.active.bin, BOOT.bin);
  assert.equal(out.active.dataDir, BOOT.dataDir);
  assert.equal(out.active.builtin, true);
  assert.equal(out.servers.length, 1);
  assert.equal(out.servers[0].id, 'local');
});

test('a lista nunca devolve o token, só se existe', () => {
  const out = listServers();
  const local = out.servers[0];
  assert.equal(local.hasToken, true); // veio do <data-dir>/auth-token
  assert.equal('token' in local, false);
  assert.equal(JSON.stringify(out).includes('token-local'), false);
});

test('salvar cria o perfil e ativa move bin, data-dir e url juntos', () => {
  const saved = saveServer({ name: 'VPS', url: 'http://vps.local:49374/', dataDir: remoteData, bin: '/opt/ai-memory' });
  const vps = saved.servers.find((s) => s.name === 'VPS');
  assert.ok(vps, 'perfil não apareceu na lista');
  assert.equal(vps.url, 'http://vps.local:49374'); // barra final removida
  assert.equal(vps.hasToken, true); // token do data-dir da vps

  const out = activateServer(vps.id);
  assert.equal(out.active.id, vps.id);
  assert.equal(config.serverUrl, 'http://vps.local:49374');
  assert.equal(config.dataDir, remoteData);
  assert.equal(config.bin, '/opt/ai-memory');
});

test('com o perfil ativo, a CLI fala com aquele servidor e leva o token dele', () => {
  const env = cliEnv();
  assert.equal(env.AI_MEMORY_SERVER_URL, 'http://vps.local:49374');
  assert.equal(env.AI_MEMORY_AUTH_TOKEN, 'token-da-vps'); // do data-dir da vps
  // o token do servidor anterior não pode ter sobrado no env do processo
  assert.notEqual(env.AI_MEMORY_AUTH_TOKEN, 'token-local');
});

test('token explícito do perfil tem precedência sobre o do data-dir', () => {
  // mesmo id: isto é uma edição do perfil da vps, não um cadastro novo
  const current = listServers().servers.find((s) => s.name === 'VPS');
  const saved = saveServer({ id: current.id, name: 'VPS', url: 'http://vps.local:49374', dataDir: remoteData, bin: '/opt/ai-memory', token: 'token-digitado' });
  const vps = saved.servers.find((s) => s.name === 'VPS');
  assert.equal(saved.servers.filter((s) => s.name === 'VPS').length, 1, 'a edição criou um perfil duplicado');
  activateServer(vps.id);
  assert.equal(cliEnv().AI_MEMORY_AUTH_TOKEN, 'token-digitado');

  // sem token no perfil, a resolução cai no <data-dir>/auth-token
  saveServer({ id: vps.id, name: 'VPS', url: 'http://vps.local:49374', dataDir: remoteData, bin: '/opt/ai-memory', token: null });
  assert.equal(cliEnv().AI_MEMORY_AUTH_TOKEN, 'token-da-vps');
});

test('voltar ao ambiente restaura url, bin e data-dir originais', () => {
  const out = activateServer('local');
  assert.equal(out.active.id, 'local');
  assert.equal(config.serverUrl, BOOT.url);
  assert.equal(config.bin, BOOT.bin);
  assert.equal(config.dataDir, BOOT.dataDir);
  assert.equal(cliEnv().AI_MEMORY_AUTH_TOKEN, 'token-local');
});

test('remover o perfil ativo devolve o painel para o ambiente', () => {
  const saved = saveServer({ name: 'Temporario', url: 'http://tmp.local:49374', dataDir: remoteData });
  const id = saved.servers.find((s) => s.name === 'Temporario').id;
  activateServer(id);
  assert.equal(config.serverUrl, 'http://tmp.local:49374');

  const out = deleteServer(id);
  assert.equal(out.active.id, 'local');
  assert.equal(config.serverUrl, BOOT.url);
  assert.equal(out.servers.some((s) => s.id === id), false);
  assert.throws(() => deleteServer(id), /não encontrado/);
});

test('o ambiente pode ser removido da lista, mas segue como destino', () => {
  const saved = saveServer({ name: 'VPS', url: 'http://vps.local:49374', dataDir: remoteData });
  const id = saved.servers.find((s) => s.name === 'VPS').id;
  activateServer(id);

  const out = deleteServer('local');
  assert.equal(out.servers.some((s) => s.id === 'local'), false, 'o ambiente deveria ter saído da lista');
  // removê-lo da lista não desconecta: o destino ativo é o VPS
  assert.equal(out.active.id, id);
  assert.equal(config.serverUrl, 'http://vps.local:49374');
  assert.equal(isEnvServerActive(), false);
});

test('remover o ambiente que estava ativo mantém o destino nele', () => {
  activateServer('local');
  assert.equal(isEnvServerActive(), true);
  const out = deleteServer('local');
  assert.equal(out.servers.some((s) => s.id === 'local'), false);
  // sem servidor nenhum na lista, o painel não fica sem destino: o ambiente
  // continua respondendo, marcado como removido da lista
  assert.equal(out.active.id, 'local');
  assert.equal(out.active.hidden, true);
  assert.equal(config.serverUrl, BOOT.url);
  assert.equal(cliEnv().AI_MEMORY_AUTH_TOKEN, 'token-local');
});

test('remover todos deixa o painel no ambiente, e restaurar o traz de volta', () => {
  // começa limpo: os testes anteriores deixam perfis no mesmo arquivo
  for (const s of listServers().servers) deleteServer(s.id);
  deleteServer('local');

  let out = listServers();
  assert.equal(out.servers.length, 0, 'a lista deveria estar vazia');
  assert.equal(out.active.id, 'local');
  assert.equal(out.active.hidden, true);

  out = restoreEnvServer();
  assert.equal(out.servers.length, 1);
  assert.equal(out.servers[0].id, 'local');
  assert.equal(out.servers[0].name, 'Servidor do ambiente');
  assert.equal(out.active.hidden, false);
});

test('remover o ambiente sobrevive a restart do painel', () => {
  deleteServer('local');
  assert.equal(JSON.parse(fs.readFileSync(serversFile, 'utf8')).hideEnv, true);
  // simula o boot de outro processo: recarrega do arquivo e reaplica
  const out = initActiveServer();
  assert.equal(out.id, 'local');
  assert.equal(config.serverUrl, BOOT.url, 'o destino implícito não é o do arquivo');
  assert.equal(listServers().servers.some((s) => s.id === 'local'), false, 'voltou a aparecer na lista');
  assert.equal(listServers().active.hidden, true);
  restoreEnvServer();
});

test('o ambiente continua editável não: editar o id local é recusado', () => {
  // continua sendo derivado do env — não há entrada para editar
  assert.throws(() => saveServer({ id: 'local', url: 'http://outro:1234' }), /não pode ser editado/);
});

test('remover um id que não existe é erro, e o ambiente some sem quebrar', () => {
  assert.throws(() => deleteServer('inexistente'), /não encontrado/);
  deleteServer('local');
  deleteServer('local'); // idempotente: remover de novo não quebra
  assert.equal(listServers().active.id, 'local');
  restoreEnvServer();
});

test('url inválida é recusada antes de gravar', () => {
  assert.throws(() => saveServer({ url: 'nao-e-url' }), /url de servidor inválida/);
  assert.throws(() => saveServer({ url: '' }), /url do servidor é obrigatória/);
  assert.throws(() => saveServer({ name: 'x', url: 'javascript:alert(1)' }), /url de servidor inválida/);
});

test('o arquivo de servidores fica com permissão 0600', () => {
  const out = listServers();
  assert.ok(out.servers.length >= 1);
  const mode = fs.statSync(serversFile).mode & 0o777;
  assert.equal(mode, 0o600, `modo ${mode.toString(8)}`);
});

test('o perfil ativo sobrevive a um restart do painel', () => {
  restoreEnvServer();
  // o perfil é recriado aqui: testes anteriores removem o que existia
  const saved = saveServer({ name: 'VPS', url: 'http://persiste.local:49374', dataDir: remoteData });
  const id = saved.servers.find((s) => s.name === 'VPS').id;
  activateServer(id);
  // o arquivo é a fonte da verdade; reinitActiveServer simula o boot
  const onDisk = JSON.parse(fs.readFileSync(serversFile, 'utf8'));
  assert.equal(onDisk.active, id);
  const active = initActiveServer();
  assert.equal(active.id, id);
  assert.equal(config.serverUrl, 'http://persiste.local:49374');
});

test('o store em disco só é fallback quando o servidor ativo é o do ambiente', async () => {
  const { recentPages } = await import('../server/reads.mjs');
  restoreEnvServer();
  activateServer('local');
  assert.equal(isEnvServerActive(), true);
  const local = await recentPages(5);
  // sem MCP no ambiente falso, o fallback de disco é permitido e se anuncia
  assert.ok(['fs', 'mcp'].includes(local.source), JSON.stringify(local.source));

  const current = listServers().servers.find((s) => s.name === 'VPS')
    || saveServer({ name: 'VPS', url: 'http://127.0.0.1:1', dataDir: remoteData }).servers.find((s) => s.name === 'VPS');
  // 127.0.0.1 numa porta fechada: conexão recusada na hora, sem esperar DNS
  saveServer({ id: current.id, name: 'VPS', url: 'http://127.0.0.1:1', dataDir: remoteData, bin: '/opt/ai-memory', token: null });
  activateServer(current.id);
  assert.equal(isEnvServerActive(), false);
  const remoto = await recentPages(5);
  // apontado para outra máquina, o volume local NÃO pode virar resposta:
  // isso listaria páginas do servidor errado como se fossem do destino
  assert.equal(remoto.source, 'none', JSON.stringify(remoto));
  assert.match(remoto.note, /store local/);
  assert.deepEqual(remoto.items, []);
  activateServer('local');
});

test('regressão: env token não vaza para perfil remoto ativo (MCP usa o data-dir dele)', async () => {
  // cenário do review: o painel subiu com AI_MEMORY_AUTH_TOKEN do ambiente, e o
  // usuário ativa um perfil que NÃO tem token explícito — o MCP não pode
  // continuar mandando o token do boot para o destino novo
  process.env.AI_MEMORY_AUTH_TOKEN = 'token-do-boot';
  const saved = saveServer({ name: 'VPS issue1', url: fakeMcpUrl, dataDir: remoteData });
  const id = saved.servers.find((s) => s.name === 'VPS issue1').id;
  activateServer(id);
  assert.equal(config.activeIsEnv, false);
  assert.equal(config.token, null); // sem token explícito: resolve no data-dir

  seenAuth.length = 0;
  const res = await tryTool('memory_status', {});
  assert.equal(res.ok, true, res.error);
  assert.ok(seenAuth.length >= 2, seenAuth);
  assert.ok(seenAuth.every((a) => a === 'Bearer token-da-vps'), seenAuth);
  assert.ok(seenAuth.every((a) => a !== 'Bearer token-do-boot'), 'token do boot vazou para o perfil remoto');

  // de volta ao ambiente, o env volta a valer (comportamento do mcp-auth.test)
  activateServer('local');
  seenAuth.length = 0;
  process.env.AI_MEMORY_SERVER_URL = fakeMcpUrl;
  await tryTool('memory_status', {});
  assert.ok(seenAuth.every((a) => a === 'Bearer token-do-boot'), seenAuth);
  delete process.env.AI_MEMORY_AUTH_TOKEN;
  process.env.AI_MEMORY_SERVER_URL = 'http://127.0.0.1:1';
  delete process.env.AI_MEMORY_AUTH_TOKEN;
});
