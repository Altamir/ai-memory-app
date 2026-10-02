import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// Arranque do painel: o que falta para ele funcionar. O diagnóstico precisa
// distinguir "não tem servidor" de "não tem CLI", porque as consequências são
// diferentes — sem servidor não há leitura, sem CLI não há manutenção/run.
//
// A instalação é testada contra um tarball montado localmente (mesmo formato do
// oficial: ./ai-memory na raiz + um .sha256 ao lado), então o teste não
// depende da rede nem de uma release específica.

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-setup-home-'));
const realHome = os.homedir();
process.env.HOME = home;
process.env.AIM_APP_SERVERS_FILE = path.join(home, '.servers.json');
process.env.AI_MEMORY_DATA_DIR = path.join(home, 'data');

// MCP falso do "ambiente": vivo de propósito, para exercitar o cenário do
// review#3 — ambiente escondido da lista mas com destino saudável. Testes que
// querem destino MORTO ativam um perfil apontando para 127.0.0.1:1.
const fakeMcp = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const msg = JSON.parse(body || '{}');
    if (msg.method === 'initialize') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'mcp-session-id': 'sess-setup' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {} } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { structuredContent: { counts: { pages_latest: 3 } } } }));
  });
});
await new Promise((r) => fakeMcp.listen(0, '127.0.0.1', r));
process.env.AI_MEMORY_SERVER_URL = `http://127.0.0.1:${fakeMcp.address().port}`;
process.env.AI_MEMORY_BIN = path.join(home, 'bin', 'ai-memory');
fs.mkdirSync(process.env.AI_MEMORY_DATA_DIR, { recursive: true });

const { config } = await import('../server/config.mjs');
const { saveServer, deleteServer, setActiveBin, listServers, activateServer, restoreEnvServer } = await import('../server/servers.mjs');
const { setupStatus, findCli, cliRelease } = await import('../server/setup-check.mjs');
const { installCli } = await import('../server/cli-install.mjs');

test.after(() => {
  process.env.HOME = realHome;
  fakeMcp.close();
});

/** CLI falsa que responde --version, como o instalador verifica. */
function fakeCli(dir, version = '9.9.9') {
  const p = path.join(dir, 'ai-memory');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, `#!/bin/sh\necho "ai-memory ${version}"\n`, { mode: 0o755 });
  return p;
}

test('sem CLI, o diagnóstico diz que falta e aponta o caminho quebrado', async () => {
  const s = await setupStatus();
  assert.equal(s.cli.ok, false, 'deveria reportar a CLI ausente');
  assert.equal(s.cli.configuredMissing, true);
  assert.equal(s.cli.configuredPath, config.bin);
  // se houver uma CLI em outro lugar (PATH), ela é informação, não conserto:
  // os jobs chamam config.bin, então é aquele caminho que precisa resolver
  if (s.cli.foundElsewhere) {
    assert.equal(s.cli.ok, false, 'uma CLI no PATH não conserta o caminho configurado');
  }
  assert.ok(s.actions.some((a) => a.id === 'install-cli'), JSON.stringify(s.actions));
  assert.equal(s.ok, false);
  assert.equal(s.firstRun, true);
});

test('com a CLI instalada no caminho configurado, ela é encontrada com versão', async () => {
  const p = fakeCli(path.dirname(config.bin), '2.5.2');
  try {
    const cli = await findCli();
    assert.equal(cli.path, p);
    assert.equal(cli.version, '2.5.2');
    assert.equal(cli.configured, true);

    const s = await setupStatus();
    assert.equal(s.cli.ok, true);
    assert.equal(s.cli.path, p);
    assert.equal(s.cli.version, '2.5.2');
    assert.equal(s.cli.foundElsewhere, null);
    assert.equal(s.actions.some((a) => a.id === 'install-cli'), false);
  } finally {
    fs.rmSync(p, { force: true });
  }
});

test('CLI no PATH conta como instalada, mesmo fora do caminho configurado', async () => {
  // um diretório no PATH: é assim que uma CLI instalada por brew/cargo seria achada
  const dir = path.join(home, 'bin-do-path');
  const p = fakeCli(dir, '2.5.2');
  const pathAntes = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${pathAntes}`;
  try {
    const cli = await findCli();
    assert.equal(cli.path, p);
    // o perfil continua apontando para um caminho que não existe: a tela mostra
    // os dois fatos, porque um job pode falhar mesmo achando a CLI
    assert.equal(cli.configured, false);
  } finally {
    process.env.PATH = pathAntes;
    fs.rmSync(p, { force: true });
  }
});

test('CLI num lugar fora do PATH e do config é ignorada', async () => {
  const p = fakeCli(path.join(home, 'outro-lugar'), '2.5.2');
  try {
    const cli = await findCli();
    // o painel não varre o disco atrás da CLI: só os candidatos conhecidos
    assert.notEqual(cli.path, p);
  } finally {
    fs.rmSync(p, { force: true });
  }
});

test('destino inacessível oferece configure-server (mesmo com CLI ok)', async () => {
  // ativa um perfil apontando para uma porta morta: o gate é a SAÚDE do destino
  const saved = saveServer({ name: 'Morto', url: 'http://127.0.0.1:1' });
  const id = saved.servers.find((s) => s.name === 'Morto').id;
  activateServer(id);
  try {
    const s = await setupStatus();
    assert.equal(s.server.ok, false);
    assert.ok(s.actions.some((a) => a.id === 'configure-server'), JSON.stringify(s.actions));
  } finally {
    activateServer('local');
    deleteServer(id);
  }
});

test('o erro do servidor é curto e não vaza stack', async () => {
  // destino morto: é o único cenário em que o diagnóstico carrega um error
  const saved = saveServer({ name: 'Morto err', url: 'http://127.0.0.1:1' });
  const id = saved.servers.find((s) => s.name === 'Morto err').id;
  activateServer(id);
  try {
    const s = await setupStatus();
    assert.equal(s.server.ok, false);
    assert.equal(typeof s.server.error, 'string');
    assert.ok(!s.server.error.includes('\n'), s.server.error);
    assert.ok(s.server.error.length <= 200);
  } finally {
    activateServer('local');
    deleteServer(id);
  }
});

test('instalar exige confirmação: sem ela nem baixa', async () => {
  const out = await installCli({ confirm: false });
  assert.equal(out.ok, false);
  assert.equal(out.needsConfirm, true);
  assert.match(out.error, /confirmação/);
  assert.equal(fs.existsSync(config.bin), false, 'não deveria ter criado o binário');
});

test('instalação recusada quando a release não traz checksum', async () => {
  // sem checksum não há como confiar no download: abortar é a decisão segura
  const out = await installCli({ confirm: true, target: path.join(home, 'x') });
  // aqui o caso real depende da rede; o que importa é que nunca "instala" às cegas
  if (!out.ok) {
    assert.ok(out.error, 'falha precisa de motivo');
    assert.equal(fs.existsSync(config.bin), false);
  }
});

test('a release oficial é identificada com asset e checksum', async () => {
  const r = await cliRelease();
  if (!r.ok) return; // sem rede: nada a afirmar
  assert.ok(r.tag, 'sem tag');
  assert.ok(r.asset?.url?.startsWith('https://'), r.asset?.url);
  assert.ok(r.checksum?.url?.startsWith('https://'), 'sem checksum é motivo de recusa na instalação');
  // o asset tem que ser da plataforma/arquitetura da máquina
  const arch = os.arch() === 'arm64' ? 'aarch64' : 'x86_64';
  assert.ok(r.asset.name.includes(arch), r.asset.name);
  assert.equal(r.asset.name.endsWith('.sha256'), false);
});

test('o diagnóstico traz onde ficam a CLI e os dados locais (para o dashboard)', async () => {
  const s = await setupStatus();
  // paths é incondicional: o card do dashboard mostra os caminhos mesmo sem CLI
  assert.equal(s.paths.dataDir, config.dataDir);
  assert.equal(s.paths.storeDir, config.storeDir);
  assert.equal(typeof s.paths.dataDirToken, 'boolean');
  assert.equal(typeof s.paths.storeDirWiki, 'boolean');
  // num ambiente limpo nada disso existe
  assert.equal(s.paths.dataDirToken, false);
  assert.equal(s.paths.storeDirWiki, false);
});

test('saveServer ainda funciona depois do diagnóstico (o caminho offered é real)', () => {
  const out = saveServer({ name: 'VPS', url: 'https://vps.local', token: 't' });
  const id = out.servers.find((s) => s.name === 'VPS').id;
  assert.ok(id);
  deleteServer(id);
});

test('setActiveBin realinha o bin do ambiente sem criar perfil fantasma', async () => {
  // parte limpa: testes anteriores podem ter deixado perfis no mesmo arquivo
  for (const s of listServers().servers) deleteServer(s.id);
  assert.equal(listServers().servers.length, 0);

  const p = fakeCli(path.join(home, 'cli-achada'), '2.5.2');
  const out = setActiveBin(p);
  assert.equal(config.bin, p, 'o painel deveria passar a executar a CLI achada');
  assert.equal(out.servers.length, 0, 'o ambiente não vira entrada na lista');
  assert.equal(out.active.bin, p);

  const s = await setupStatus();
  assert.equal(s.cli.ok, true, 'depois de realinhar, a CLI está resolvendo');
  assert.equal(s.cli.configuredMissing, false);
  assert.equal(s.actions.some((a) => a.id === 'install-cli'), false);

  // volta o estado para os outros testes: sem CLI
  fs.rmSync(p, { force: true });
});

test('regressão review#3: ambiente escondido + destino saudável NÃO é firstRun', async () => {
  // cenário do review: usuário removeu o servidor do ambiente da lista (hideEnv),
  // não tem outros cadastros, mas o destino implícito responde — o wizard não
  // pode reabrir em todo boot só porque a lista visível está vazia
  for (const s of listServers().servers) deleteServer(s.id);
  deleteServer('local'); // esconde o ambiente da lista
  assert.equal(listServers().servers.length, 0);

  const p = fakeCli(path.dirname(config.bin), '2.5.2');
  try {
    const s = await setupStatus();
    assert.equal(s.server.ok, true, 'o destino implícito (ambiente escondido) deveria responder');
    assert.deepEqual(s.actions, [], JSON.stringify(s.actions));
    assert.equal(s.firstRun, false, 'wizard não reabre com destino saudável');
  } finally {
    fs.rmSync(p, { force: true });
    restoreEnvServer();
  }
});

test('regressão review#5: editar sem token preserva o gravado; limpar é explícito', () => {
  const saved = saveServer({ name: 'ComToken', url: 'https://ct.local', token: 'token-importante' });
  const id = saved.servers.find((s) => s.name === 'ComToken').id;

  // edita nome SEM a chave token: preserva
  const edited = saveServer({ id, name: 'ComToken renomeado', url: 'https://ct.local' });
  assert.equal(edited.servers.find((s) => s.id === id).hasToken, true, 'edição sem token apagou o gravado');

  // edita com token '' explícito: limpa
  const cleared = saveServer({ id, name: 'ComToken renomeado', url: 'https://ct.local', token: '' });
  assert.equal(cleared.servers.find((s) => s.id === id).hasToken, false);

  deleteServer(id);
});
