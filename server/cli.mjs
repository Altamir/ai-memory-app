import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';

/** Token lido a cada chamada (sobrevive a rotação sem reiniciar o app). */
export function cliEnv() {
  const env = { ...process.env };
  if (!env.AI_MEMORY_AUTH_TOKEN) {
    try {
      env.AI_MEMORY_AUTH_TOKEN = fs.readFileSync(path.join(config.dataDir, 'auth-token'), 'utf8').trim();
    } catch {
      // sem arquivo de token: servidor sem auth ainda funciona
    }
  }
  return env;
}

/**
 * Executa o binário ai-memory e resolve com { code, stdout, stderr, timedOut }.
 * stderr carrega os logs INFO da CLI; stdout é a saída do comando.
 * `stdinText` (string) alimenta o stdin do processo (ex.: write-page --body -).
 * `env` sobrepõe variáveis (ex.: apontar a CLI para outro servidor).
 */
export function runCli(args, { timeoutMs = 120_000, cwd, stdinText, env: extraEnv } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(config.bin, ['--data-dir', config.dataDir, ...args], {
        cwd,
        env: extraEnv ? { ...cliEnv(), ...extraEnv } : cliEnv(),
        stdio: [stdinText === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err);
      return;
    }

    const chunks = { out: [], err: [] };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    if (stdinText !== undefined) {
      // o processo pode morrer antes de ler (timeout/validação): EPIPE não é erro aqui
      child.stdin.on('error', () => {});
      child.stdin.end(stdinText);
    }

    child.stdout.on('data', (d) => chunks.out.push(d));
    child.stderr.on('data', (d) => chunks.err.push(d));

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code,
        timedOut,
        stdout: Buffer.concat(chunks.out).toString('utf8'),
        stderr: Buffer.concat(chunks.err).toString('utf8'),
      });
    });
  });
}

/** Executa com --json e faz parse do stdout. Em caso de falha de parse, devolve { raw }. */
export async function runCliJson(args, opts = {}) {
  const hasJson = args.includes('--json');
  const finalArgs = hasJson ? args : [...args, '--json'];
  const res = await runCli(finalArgs, opts);
  if (res.code !== 0) {
    const err = new Error(stderrMessage(res));
    err.code = res.code;
    err.stderr = res.stderr;
    err.timedOut = res.timedOut;
    throw err;
  }
  try {
    return JSON.parse(res.stdout);
  } catch {
    return { raw: res.stdout };
  }
}

export function stderrMessage(res) {
  const line = (res.stderr || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('INFO ') && !l.startsWith('WARN '))
    .pop();
  if (res.timedOut) return 'comando excedeu o tempo limite e foi encerrado';
  return line || `comando saiu com código ${res.code}`;
}
