import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Reescrita do MCP dos harnesses: o painel aponta a entrada `ai-memory` das
// configs das ferramentas para o servidor conectado. A escrita é delegada ao
// `ai-memory install-mcp --apply` — aqui o que se testa é a leitura do estado e
// o repasse correto do servidor/token do perfil ativo.
//
// O HOME é isolado: nenhum teste toca as configs reais da máquina.

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-harness-home-'));
const realHome = os.homedir();
process.env.HOME = home;
process.env.AIM_APP_SERVERS_FILE = path.join(home, '.servers.json');
process.env.AI_MEMORY_DATA_DIR = path.join(home, 'data');
fs.mkdirSync(process.env.AI_MEMORY_DATA_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.AI_MEMORY_DATA_DIR, 'auth-token'), 'token-local\n');

process.env.AIM_HARNESS_HOME = home;
// Os testes de APLICAÇÃO precisam do `install-mcp --apply` real (é a integração
// que se testa). Sem a CLI nesta máquina, eles são pulados — os de detecção
// (leitura do estado das configs) rodam sempre, pois não spawnam nada.
const REAL_BIN = process.env.AI_TEST_BIN || path.join(realHome, '.local', 'bin', 'ai-memory');
const CLI_AVAILABLE = (() => {
  try {
    fs.accessSync(REAL_BIN, fs.constants.X_OK);
    return fs.statSync(REAL_BIN).isFile();
  } catch {
    return false;
  }
})();
process.env.AI_MEMORY_BIN = REAL_BIN;

const { config } = await import('../server/config.mjs');
const { activateServer, saveServer } = await import('../server/servers.mjs');
const { listHarnessMcp, applyHarnessMcp, previewHarnessMcp } = await import('../server/harness-mcp.mjs');

const zcodeFile = path.join(home, '.zcode', 'cli', 'config.json');
const grokFile = path.join(home, '.grok', 'config.toml');

function writeZcode(extra = {}) {
  fs.mkdirSync(path.dirname(zcodeFile), { recursive: true });
  fs.writeFileSync(zcodeFile, JSON.stringify({
    mcp: { servers: { ...extra, 'ai-memory': { type: 'http', url: 'http://antigo.local:49374/mcp' } } },
  }, null, 2));
}

test.after(() => {
  process.env.HOME = realHome;
});

test('lista os clientes e marca em dia / divergente / sem config', async () => {
  // config do zcode apontando para outro lugar; nada mais existe
  writeZcode();
  const list = await listHarnessMcp();
  assert.ok(list.length >= 20, `só ${list.length} clientes`);

  const zcode = list.find((h) => h.id === 'zcode');
  assert.equal(zcode.registered, true);
  assert.equal(zcode.currentUrl, 'http://antigo.local:49374/mcp');
  assert.equal(zcode.aligned, false, 'apontar para outro servidor não é "em dia"');

  const grok = list.find((h) => h.id === 'grok');
  assert.equal(grok.configExists, false);
  assert.equal(grok.registered, false);

  for (const h of list) {
    assert.equal(typeof h.label, 'string');
    assert.ok(h.id);
  }
});

test('a URL reportada é a da entrada ai-memory, não a de outro servidor', async () => {
  // o mesmo arquivo com um context7 antes do ai-memory: uma busca genérica por
  // "url" acharia o context7 e o painel mentiria sobre o destino do harness
  const f = path.join(home, '.zcode', 'cli', 'config.json');
  fs.writeFileSync(f, JSON.stringify({
    mcp: {
      servers: {
        context7: { type: 'http', url: 'https://mcp.context7.com/mcp' },
        'ai-memory': { type: 'http', url: 'http://alvo.local:49374/mcp' },
      },
    },
  }, null, 2));
  const list = await listHarnessMcp();
  const zcode = list.find((h) => h.id === 'zcode');
  assert.equal(zcode.currentUrl, 'http://alvo.local:49374/mcp');
});

test('aplicar aponta o harness para o servidor conectado e põe o token', { skip: !CLI_AVAILABLE && 'cli do ai-memory não instalada nesta máquina' }, async () => {
  writeZcode();
  const out = await applyHarnessMcp('zcode');
  assert.equal(out.ok, true, out.error);

  const written = JSON.parse(fs.readFileSync(zcodeFile, 'utf8'));
  const entry = written.mcp.servers['ai-memory'];
  assert.equal(entry.url, `${config.serverUrl}/mcp`);
  assert.equal(entry.headers.Authorization, `Bearer ${config.token || 'token-local'}`);
  assert.equal(out.now, `${config.serverUrl}/mcp`);

  // em dia depois de aplicar
  const list = await listHarnessMcp();
  assert.equal(list.find((h) => h.id === 'zcode').aligned, true);
});

test('os outros servidores do usuário são preservados', { skip: !CLI_AVAILABLE && 'cli do ai-memory não instalada nesta máquina' }, async () => {
  writeZcode({ context7: { type: 'http', url: 'https://mcp.context7.com/mcp' } });
  await applyHarnessMcp('zcode');
  const written = JSON.parse(fs.readFileSync(zcodeFile, 'utf8'));
  assert.equal(written.mcp.servers.context7.url, 'https://mcp.context7.com/mcp');
});

test('aplicar de novo não duplica a entrada (idempotente)', { skip: !CLI_AVAILABLE && 'cli do ai-memory não instalada nesta máquina' }, async () => {
  writeZcode();
  await applyHarnessMcp('zcode');
  const first = fs.readFileSync(zcodeFile, 'utf8');
  await applyHarnessMcp('zcode');
  const second = fs.readFileSync(zcodeFile, 'utf8');
  const servers = JSON.parse(second).mcp.servers;
  assert.equal(Object.keys(servers).filter((k) => k === 'ai-memory').length, 1);
  assert.equal(JSON.parse(first).mcp.servers['ai-memory'].url, servers['ai-memory'].url);
});

test('a CLI grava um backup antes de mexer no arquivo', { skip: !CLI_AVAILABLE && 'cli do ai-memory não instalada nesta máquina' }, async () => {
  writeZcode();
  await applyHarnessMcp('zcode');
  const dir = path.dirname(zcodeFile);
  const backups = fs.readdirSync(dir).filter((f) => f.startsWith('config.json.bak-'));
  assert.ok(backups.length >= 1, 'nenhum backup escrito');
});

test('o destino segue o perfil ativo, não o do ambiente', { skip: !CLI_AVAILABLE && 'cli do ai-memory não instalada nesta máquina' }, async () => {
  const saved = saveServer({ name: 'VPS', url: 'https://vps.local', dataDir: process.env.AI_MEMORY_DATA_DIR });
  const id = saved.servers.find((s) => s.name === 'VPS').id;
  activateServer(id);
  assert.equal(config.serverUrl, 'https://vps.local');

  writeZcode();
  const out = await applyHarnessMcp('zcode');
  assert.equal(out.ok, true, out.error);
  const entry = JSON.parse(fs.readFileSync(zcodeFile, 'utf8')).mcp.servers['ai-memory'];
  assert.equal(entry.url, 'https://vps.local/mcp', 'a config do harness não seguiu o servidor escolhido');

  // e a lista reflete a divergência quando o servidor volta
  activateServer('local');
});

test('TOML (grok) também é lido e reescrito', { skip: !CLI_AVAILABLE && 'cli do ai-memory não instalada nesta máquina' }, async () => {
  fs.mkdirSync(path.dirname(grokFile), { recursive: true });
  fs.writeFileSync(grokFile, '[mcp_servers.ai-memory]\nurl = "http://antigo.local:49374/mcp"\nenabled = true\n\n[mcp_servers.outro]\nurl = "http://outro.local/mcp"\n');
  const list = await listHarnessMcp();
  const before = list.find((h) => h.id === 'grok');
  assert.equal(before.registered, true);
  assert.equal(before.currentUrl, 'http://antigo.local:49374/mcp');

  const out = await applyHarnessMcp('grok');
  assert.equal(out.ok, true, out.error);
  const raw = fs.readFileSync(grokFile, 'utf8');
  assert.ok(raw.includes(`${config.serverUrl}/mcp`), raw);
  assert.ok(raw.includes('outro.local'), 'o outro servidor do toml foi perdido');
});

test('harness desconhecido é recusado, não aplicado em arquivo qualquer', async () => {
  await assert.rejects(() => applyHarnessMcp('nao-existe'), /harness desconhecido/);
  await assert.rejects(() => previewHarnessMcp('nao-existe'), /harness desconhecido/);
});

test('o preview mostra o snippet com a URL do servidor e sinaliza o auth', { skip: !CLI_AVAILABLE && 'cli do ai-memory não instalada nesta máquina' }, async () => {
  const p = await previewHarnessMcp('zcode');
  assert.equal(p.id, 'zcode');
  assert.ok(p.snippet.includes(`${config.serverUrl}/mcp`), p.snippet);
  assert.equal(p.hasAuth, true);
  assert.equal(p.configFile, zcodeFile);
});
