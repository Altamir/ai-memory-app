import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.mjs';
import { listServers } from './servers.mjs';
import { callTool } from './mcp.mjs';

// Diagnóstico de arranque do painel: o ai-memory local existe? a CLI está
// instalada? Sem os dois, metade das telas não funciona — e o painel precisa
// dizer isso logo, em vez de cada aba falhar por conta própria com um erro
// diferente.

const run = promisify(execFile);

// HOME da env, não os.homedir(): o macOS ignora $HOME aqui, o que vazava os
// caminhos da máquina real para dentro de instâncias isoladas (testes/painel
// em porta separada) e fazia o diagnóstico olhar a CLI errada.
const HOME = process.env.HOME || os.homedir();

// Onde a CLI pode estar, em ordem: o que o perfil ativo pede, o PATH e os
// lugares onde o instalador costuma deixá-la.
function candidateBins() {
  const list = [];
  const push = (p) => {
    if (p && !list.includes(p)) list.push(p);
  };
  push(config.bin);
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir) push(path.join(dir, 'ai-memory'));
  }
  push(path.join(HOME, '.local', 'bin', 'ai-memory'));
  push(path.join(HOME, 'Applications', 'ai-memory', 'ai-memory'));
  push('/opt/homebrew/bin/ai-memory');
  push('/usr/local/bin/ai-memory');
  return list;
}

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

async function cliVersion(p) {
  try {
    const { stdout } = await run(p, ['--version'], { timeout: 8_000 });
    return String(stdout || '').match(/(\d+\.\d+\.\d+)/)?.[1] || null;
  } catch {
    return null; // existe mas não respondeu
  }
}

/**
 * Primeira CLI utilizável entre os candidatos, com a versão se conseguir ler.
 * `configured` diz se o primeiro achado é justamente o caminho do perfil — é o
 * que decide se o painel está bem servido ou se precisa instalar/reapontar.
 */
export async function findCli() {
  const candidates = candidateBins();
  let first = null;
  for (const p of candidates) {
    // symlink quebrado passa por existsSync? não — accessSync no alvo falha
    if (!isExecutable(p)) continue;
    const version = await cliVersion(p);
    if (!first) first = { path: p, version, configured: p === config.bin };
    if (p === config.bin) {
      // o configurado manda: devolve ele mesmo havendo outro antes na lista
      return { path: p, version, configured: true, configuredPath: config.bin };
    }
  }
  if (first) return { ...first, configuredPath: config.bin };
  return { path: null, version: null, configured: false, configuredPath: config.bin, searched: candidates.length };
}

/** O servidor do perfil ativo responde? Falso também quando está sem token. */
export async function checkServer() {
  const active = listServers().active;
  try {
    const res = await callTool('memory_status', {}, { timeoutMs: 8_000 });
    return {
      ok: true,
      url: active.url,
      name: active.name,
      hasToken: Boolean(active.hasToken),
      counts: res?.counts || null,
    };
  } catch (err) {
    return {
      ok: false,
      url: active.url,
      name: active.name,
      hasToken: Boolean(active.hasToken),
      error: String(err?.message || err).split('\n')[0].slice(0, 200),
    };
  }
}

/**
 * Resumo único do boot: o que falta para o painel funcionar.
 *
 * A CLI é avaliada pelo `bin` do perfil ativo, não pelo PATH. Um binário em
 * outro lugar não resolve o problema real: os jobs chamam `config.bin`, então
 * se aquele caminho está quebrado a manutenção e o run continuam falhando — e a
 * tela diria que está tudo bem. O PATH só entra como informação de apoio.
 */
export async function setupStatus() {
  const [cli, server] = await Promise.all([findCli(), checkServer()]);
  const servers = listServers();

  const configuredOk = Boolean(cli.configuredPath) && isExecutable(cli.configuredPath);
  // o que resolve é o caminho configurado; um achado no PATH é contexto
  const needsCli = !configuredOk;

  // Onde ficam os dados do lado local: o data-dir do cliente do perfil ativo
  // (token, config, client-projects) e o volume do store que o exportador lê.
  // É o que o dashboard mostra em "CLI e dados locais".
  const dataDir = config.dataDir;
  const storeDir = config.storeDir;
  const paths = {
    dataDir,
    dataDirToken: isFile(path.join(dataDir, 'auth-token')),
    dataDirProjects: isFile(path.join(dataDir, 'client-projects.json')),
    dataDirConfig: isFile(path.join(dataDir, 'config.toml')),
    storeDir,
    storeDirWiki: isDir(path.join(storeDir, 'wiki')),
    storeDirDb: isFile(path.join(storeDir, 'db', 'memory.sqlite')),
  };

  const needsServer = !server.ok;

  return {
    ok: server.ok && !needsCli,
    cli: {
      ok: !needsCli,
      path: configuredOk ? cli.configuredPath : null,
      version: configuredOk ? cli.version : null,
      configuredPath: cli.configuredPath,
      configuredMissing: !configuredOk,
      // existe em outro lugar: a tela pode oferecer "usar este"
      foundElsewhere: !configuredOk && cli.path ? cli.path : null,
      foundElsewhereVersion: !configuredOk && cli.path ? cli.version : null,
    },
    paths,
    server: {
      ok: server.ok,
      url: server.url,
      name: server.name,
      hasToken: server.hasToken,
      error: server.error || null,
      count: servers.servers.length,
    },
    // ações que a tela deve oferecer, na ordem.
    // ATENÇÃO: o sinal é a SAÚDE do destino, não o tamanho da lista visível —
    // com o perfil do ambiente escondido (hideEnv) e o painel falando bem com
    // ele, não há nada a configurar (antes o wizard reabria em todo boot).
    actions: [
      ...(needsServer
        ? [{ id: 'configure-server', label: 'Apontar para um servidor', primary: true }]
        : []),
      ...(needsCli
        ? [{ id: 'install-cli', label: 'Instalar a CLI do ai-memory', primary: needsServer }]
        : []),
    ],
    firstRun: needsServer || needsCli,
  };
}

/** Detalhes da release oficial, para a tela mostrar de onde vem a instalação. */
export async function cliRelease({ repo = 'akitaonrails/ai-memory' } = {}) {
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  try {
    const { stdout } = await run('curl', ['-sL', '--max-time', '20', url], { timeout: 25_000 });
    const data = JSON.parse(stdout);
    const arch = os.arch() === 'arm64' ? 'aarch64' : 'x86_64';
    const pick = (suffix) => data.assets?.find((a) => a.name.endsWith(suffix)) || null;
    const tar = pick(`macos-${arch}.tar.gz`) || pick(`linux-${arch}.tar.gz`);
    const sha = tar ? data.assets.find((a) => a.name === `${tar.name}.sha256`) : null;
    return {
      ok: true,
      tag: data.tag_name,
      name: data.name,
      publishedAt: data.published_at,
      url: data.html_url,
      asset: tar ? { name: tar.name, url: tar.browser_download_url, size: tar.size } : null,
      checksum: sha ? { name: sha.name, url: sha.browser_download_url } : null,
    };
  } catch (err) {
    return { ok: false, error: String(err?.message || err).slice(0, 200) };
  }
}
