import os from 'node:os';
import { runCli, stderrMessage } from './cli.mjs';

// Perfis de servidor da CLI (`ai-memory server add`, 2.5.0+). O perfil vive em
// <data-dir>/servers.toml e o token em <data-dir>/auth-tokens/<nome> — nunca no
// repositório, nunca em argv.
//
// Ele serve para os hooks capturarem no servidor certo quando o repositório tem
// um `.ai-memory.toml` com `server = "<nome>"`. O launcher do `ai-memory run`
// NÃO resolve perfil (limitação documentada de todas as versões até 2.5.2), e
// por isso o destino do `run` vem do shell — ver shell-env.mjs.
//
// Falhar aqui não pode derrubar o fluxo do painel: o perfil é um complemento,
// e o destino do painel já está gravado no .servers.json.

const home = () => process.env.AIM_APP_SHELL_HOME || os.homedir();

/** Nome de perfil: slug do nome do servidor, aceito pelo CLI. */
export function profileSlug(name, url) {
  const base = String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  if (base) return base;
  try {
    // sem nome: cai no host da url (ex.: aim.altamir.dev)
    return new URL(url).hostname.replace(/[^a-z0-9]+/gi, '-').slice(0, 48);
  } catch {
    return 'servidor';
  }
}

/**
 * Registra/atualiza o perfil na CLI. O token vai por stdin (--auth-token-stdin):
 * em argv ele apareceria em `ps` e no histórico do shell.
 */
export async function syncCliProfile({ name, url, token, dataDir, bin }) {
  const slug = profileSlug(name, url);
  if (!token) {
    // server add sem token registra o perfil como "tokenless", e um perfil sem
    // token faz o hook não emitir nada (fail-closed) — pior que não ter perfil
    return { ok: false, skipped: true, slug, note: 'perfil sem token: hooks continuariam no servidor padrão' };
  }
  try {
    const res = await runCli(
      ['server', 'add', slug, '--url', url, '--root', home(), '--auth-token-stdin'],
      { stdinText: `${token}\n`, bin, dataDir, timeoutMs: 15_000 },
    );
    if (res.code !== 0) {
      return { ok: false, slug, note: stderrMessage(res) };
    }
    return { ok: true, slug };
  } catch (err) {
    // binário ausente ou CLI anterior a 2.5.0 (não tem `server add`)
    return { ok: false, slug, note: err.message };
  }
}

/** Remove o perfil da CLI (voltar ao servidor do ambiente / apagar o cadastro). */
export async function removeCliProfile({ name, url, dataDir, bin }) {
  const slug = profileSlug(name, url);
  try {
    const res = await runCli(['server', 'remove', slug], { bin, dataDir, timeoutMs: 15_000 });
    if (res.code !== 0) return { ok: false, slug, note: stderrMessage(res) };
    return { ok: true, slug };
  } catch (err) {
    return { ok: false, slug, note: err.message };
  }
}

/**
 * Perfil da CLI já registrado? (para a tela mostrar o estado sem executar nada)
 */
export async function listCliProfiles({ dataDir, bin } = {}) {
  try {
    const res = await runCli(['server', 'list', '--json'], { dataDir, bin, timeoutMs: 15_000 });
    if (res.code !== 0) return { ok: false, profiles: [], note: stderrMessage(res) };
    try {
      const parsed = JSON.parse(res.stdout);
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.servers) ? parsed.servers : [];
      return { ok: true, profiles: list.map((p) => ({ name: p.name, url: p.url, hasToken: Boolean(p.token) || p.has_token })) };
    } catch {
      return { ok: false, profiles: [], note: 'saída do CLI não é JSON' };
    }
  } catch (err) {
    return { ok: false, profiles: [], note: err.message };
  }
}