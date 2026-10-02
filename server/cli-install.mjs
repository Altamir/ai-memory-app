import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { config } from './config.mjs';
import { cliRelease } from './setup-check.mjs';
import { runCli } from './cli.mjs';

// Instalação da CLI do ai-memory a partir da release oficial do GitHub.
//
// Decisões que não são óbvias:
//
// - **O checksum é obrigatório.** A release publica `<asset>.sha256` ao lado do
//   tarball; sem comparar, estaríamos executando qualquer coisa que um redirect
//   devolvesse. Verifico antes de extrair.
// - **Extrai numa pasta nova e só depois move.** Um `tar` no lugar pode deixar
//   o diretório meio instalado se falhar no meio; o binário em uso continua
//   intacto até o swap.
// - **Nunca executa nada do tarball.** Só o executável `ai-memory` é copiado; o
//   resto (hooks, docs, crates) fica de fora — o que o painel precisa é o binário.
// - **O alvo é o `bin` do perfil ativo, salvo `target` explícito.** Se o perfil
//   aponta para `~/.local/bin/ai-memory`, é lá que o binário vai, e o painel
//   volta a funcionar sem configuração extra.

const HOME = os.homedir();
const BIN_NAME = 'ai-memory';

function defaultTarget() {
  return config.bin || path.join(HOME, '.local', 'bin', BIN_NAME);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs || 120_000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
  });
}

async function download(url, dest, log) {
  log(`baixando ${path.basename(url)}…`);
  const res = await run('curl', ['-sL', '--fail', '--max-time', '300', '-o', dest, url], { timeoutMs: 320_000 });
  if (res.code !== 0) throw new Error(`download falhou (HTTP ${res.code}): ${res.stderr.trim().slice(0, 200) || url}`);
  if (!fs.existsSync(dest) || fs.statSync(dest).size === 0) throw new Error('download veio vazio');
  return dest;
}

function sha256(file) {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

/**
 * Instala a CLI. `confirm` precisa ser true — a tela pede antes. Sem isso a
 * função nem baixa nada.
 */
export async function installCli({ confirm = false, target = null, log = () => {} } = {}) {
  if (confirm !== true) {
    return { ok: false, needsConfirm: true, error: 'instalar a CLI exige confirmação' };
  }

  const release = await cliRelease();
  if (!release.ok) return { ok: false, error: `não consegui consultar a release: ${release.error}` };
  if (!release.asset) {
    return { ok: false, error: `a release ${release.tag} não tem binário para ${os.platform()}-${os.arch()}` };
  }
  if (!release.checksum) {
    // sem checksum não há como confiar no download: melhor recusar do que
    // executar um binário que não foi verificado
    return { ok: false, error: 'a release não publica checksum para este asset — instalação abortada por segurança' };
  }

  const dest = target ? path.resolve(String(target)) : defaultTarget();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-cli-install-'));
  const tarPath = path.join(work, release.asset.name);
  const shaPath = path.join(work, release.checksum.name);

  try {
    await download(release.asset.url, tarPath, log);
    await download(release.checksum.url, shaPath, log);

    const expected = fs.readFileSync(shaPath, 'utf8').trim().split(/\s+/)[0];
    const actual = sha256(tarPath);
    if (!expected || expected !== actual) {
      log(`checksum divergiu\n  esperado: ${expected}\n  obtido:   ${actual}\n`);
      return { ok: false, error: 'checksum não confere — o download foi descartado' };
    }
    log('checksum confere\n');

    // extrai numa pasta limpa: o tar tem ./ai-memory na raiz
    const extractDir = path.join(work, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });
    const untar = await run('tar', ['xzf', tarPath, '-C', extractDir], { timeoutMs: 120_000 });
    if (untar.code !== 0) throw new Error(`falha ao extrair: ${untar.stderr.trim().slice(0, 200)}`);

    const binInTar = path.join(extractDir, BIN_NAME);
    if (!fs.existsSync(binInTar)) throw new Error('o tarball não tem o executável ai-memory na raiz');
    fs.chmodSync(binInTar, 0o755);

    // só agora troca o lugar: o binário anterior (se houver) fica até aqui
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const backup = fs.existsSync(dest) ? `${dest}.bak-${Date.now()}` : null;
    if (backup) fs.copyFileSync(dest, backup);
    fs.copyFileSync(binInTar, dest);
    fs.chmodSync(dest, 0o755);
    log(`instalado em ${dest}\n`);

    // confere que responde de verdade antes de dizer que deu certo
    const check = await run(dest, ['--version'], { timeoutMs: 15_000 });
    const version = String(check.stdout || '').match(/(\d+\.\d+\.\d+)/)?.[1] || null;
    if (check.code !== 0 || !version) {
      return { ok: false, error: `instalado, mas a CLI não respondeu a --version (código ${check.code})`, path: dest };
    }

    return {
      ok: true,
      path: dest,
      version,
      previous: backup,
      release: { tag: release.tag, url: release.url },
    };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch {
      // best-effort: o temp é limpo pelo SO
    }
  }
}

/**
 * `ai-memory init` no data-dir do perfil ativo — o primeiro passo do setup
 * oficial (cria o layout do data-dir e o config.toml). Idempotente: sem
 * --force, re-executar sobre um data-dir existente não destrói nada.
 */
export async function initClientDir({ log = () => {} } = {}) {
  const r = await runCli(['init'], { timeoutMs: 30_000 });
  if (r.code !== 0) {
    return { ok: false, error: r.stderr.trim().split('\n').pop()?.slice(0, 200) || `init saiu com código ${r.code}` };
  }
  const created = ['config.toml'].filter((f) => fs.existsSync(path.join(config.dataDir, f)));
  log(`init ok em ${config.dataDir}${created.length ? ` (${created.join(', ')} presente)` : ''}\n`);
  return { ok: true, dataDir: config.dataDir, files: created };
}

/**
 * `ai-memory install-hooks --agent <id> --apply` para um harness — o passo que
 * a docs manda junto com o install-mcp. É o que faz o projeto ser vinculado no
 * primeiro capture (registry client-projects.json).
 */
export async function installHooks({ agent, log = () => {} } = {}) {
  const id = String(agent || '').trim();
  if (!/^[\w-]{1,40}$/.test(id)) return { ok: false, error: `agente inválido: ${id}` };
  const r = await runCli(['install-hooks', '--agent', id, '--apply'], { timeoutMs: 60_000 });
  if (r.code !== 0) {
    return { ok: false, error: r.stderr.trim().split('\n').pop()?.slice(0, 200) || `install-hooks saiu com código ${r.code}` };
  }
  log(`hooks de ${id} instalados\n`);
  return { ok: true, agent: id, output: r.stdout.trim().slice(0, 2000) };
}
