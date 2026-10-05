import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from './config.mjs';
import { probeGh, resolveCredential } from './skills-git.mjs';

// Config do repositório git da coleção: qual repo do GitHub e qual credencial.
//
// A credencial tem duas fontes, nesta ordem de preferência:
//   1. `gh` autenticado — o painel não pede token e o token do gh fica no
//      keychain do sistema; o painel nunca o lê nem o grava.
//   2. PAT digitado, guardado aqui (0600, fora do git) só quando não há gh.
// O mesmo modelo de `.servers.json` (server/servers.mjs) para o arquivo, e o
// mesmo cuidado: o segredo nunca volta para o cliente.

const configFile = () => process.env.AIM_APP_SKILLS_GIT_FILE || path.join(config.root, '.skills-git.json');

const DEFAULT_BRANCH = 'main';

function sanitizeGitHub(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const owner = String(raw.owner ?? '').trim();
  const repo = String(raw.repo ?? '').trim();
  if (!owner && !repo) return null;
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) throw new Error('owner/repo do GitHub inválido');
  const branch = String(raw.branch ?? '').trim() || DEFAULT_BRANCH;
  if (!/^[A-Za-z0-9._/-]+$/.test(branch)) throw new Error('branch inválida');
  return { owner, repo, branch };
}

function load() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch {
    // ausente ou corrompido: sem config, o gestor oferece criar/conectar
    return { version: 1, github: null, token: null };
  }
  let github = null;
  try {
    github = sanitizeGitHub(parsed?.github);
  } catch {
    github = null;
  }
  const token = typeof parsed?.token === 'string' && parsed.token.trim() ? parsed.token.trim() : null;
  return { version: 1, github, token };
}

function save(state) {
  const file = configFile();
  const tmp = `${file}.tmp`;
  // 0600: guarda o PAT do GitHub — é credencial, não sai para o git
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, github: state.github, token: state.token }, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // FS sem chmod (ex.: volume de rede): segue com o modo do umask
  }
}

let state = load();

/**
 * O que a tela vê: config sem o token, só se ele existe. `credential` diz qual
 * caminho o gestor vai usar — é o que permite à tela oferecer "usar o gh" em
 * vez do campo de token quando o gh já está autenticado.
 */
export async function publicState() {
  const gh = await probeGh();
  return {
    github: state.github,
    branch: state.github?.branch || DEFAULT_BRANCH,
    hasToken: Boolean(state.token),
    configured: Boolean(state.github),
    file: configFile(),
    gh: { installed: gh.installed, authenticated: gh.authenticated, login: gh.login },
    // 'gh' quando há gh autenticado (nada a digitar), 'pat' quando só há token
    credential: gh.authenticated ? 'gh' : state.token ? 'pat' : 'none',
  };
}

/** O token, para uso interno (header de auth). Nunca sai daqui para o cliente. */
export function currentToken() {
  return state.token;
}

/**
 * Grava a config do repositório. `token` ausente = manter o que está gravado;
 * `''` = limpar de propósito; valor = gravar. Mesma regra tri-estado do
 * `saveServer` — sem isso, editar o nome do repo apagaria o PAT.
 */
export async function saveGitHubConfig({ owner, repo, branch, token } = {}) {
  const next = { ...state };
  if (owner !== undefined || repo !== undefined || branch !== undefined) {
    next.github = sanitizeGitHub({
      owner: owner ?? state.github?.owner,
      repo: repo ?? state.github?.repo,
      branch: branch ?? state.github?.branch ?? DEFAULT_BRANCH,
    });
  }
  if (token !== undefined) {
    next.token = String(token ?? '').trim() || null;
  }
  state = next;
  save(state);
  // publicState consulta o gh (async): sem await, quem chama recebia uma Promise
  // e `cfg.github` vinha undefined — o passo de ligar o remote quebrava logo
  // depois de o repositório já ter sido criado no GitHub.
  return publicState();
}

/** Testes e cenários de "configurar agora" precisam zerar o estado em memória. */
export function resetGitConfigForTest() {
  state = load();
}

// ---------- GitHub (API) ----------
//
// Prefere `gh api` (que já tem a credencial do keychain) e só cai em `fetch`
// com Bearer quando há PAT. O resultado é o mesmo em ambos os caminhos; o que
// muda é que o caminho do gh não pede token nenhum ao usuário.

const GITHUB_API = 'https://api.github.com';
const execFileAsync = promisify(execFile);

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'ai-memory-app',
  };
}

/**
 * Chama a API do GitHub. Com `gh` autenticado, delega para `gh api`; senão usa
 * `fetch` com o PAT. `method`/`body` são os mesmos nos dois casos.
 * Lança um erro com `code: 'NEEDS_AUTH'` quando a resposta é 401/403.
 */
async function ghApi(pathname, { method = 'GET', body = null, token = null } = {}) {
  const tok = String(token || '').trim() || currentToken();
  if (!tok) {
    const gh = await probeGh();
    if (!gh.authenticated) {
      const err = new Error(gh.error || 'sem credencial do GitHub — entre pelo navegador ou informe um token');
      err.code = 'NEEDS_AUTH';
      throw err;
    }
  }
  if (!tok) {
    // credencial do gh: `gh api` cuida do header sozinho
    const args = ['api', pathname];
    if (method !== 'GET') args.push('--method', method);
    // O corpo vai por ARQUIVO, não por stdin: o `input` do execFile só existe na
    // variante síncrona — no async ele é ignorado em silêncio e o gh recebia um
    // POST vazio ("malformed request"). Com `--input <arquivo>` o corpo chega.
    let tmpBody = null;
    if (body) {
      tmpBody = path.join(os.tmpdir(), `aim-gh-body-${randomUUID()}.json`);
      await fsp.writeFile(tmpBody, JSON.stringify(body), { mode: 0o600 });
      args.push('--input', tmpBody);
    }
    try {
      const { stdout } = await execFileAsync('gh', args, { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
      const parsed = stdout.trim() ? JSON.parse(stdout) : {};
      return { ok: true, status: 200, body: parsed };
    } catch (err) {
      const detail = String(err.stderr || err.message || '').trim();
      // O gh escreve o status no stderr como "(HTTP 404)". Capturar QUALQUER
      // dígito é essencial: sem isso um 404 virava 500 e o caso mais comum de
      // todos — o repositório ainda não existe, porque vai ser criado agora —
      // aparecia como erro em vez de "ainda não existe".
      const status = Number(/HTTP (\d{3})/.exec(detail)?.[1]) || 500;
      const e = new Error(ghStatusMessage(status, detail));
      e.code = status === 401 || status === 403 ? 'NEEDS_AUTH' : status === 404 ? 'NOT_FOUND' : 'GITHUB_ERROR';
      e.status = status;
      throw e;
    } finally {
      if (tmpBody) await fsp.rm(tmpBody, { force: true }).catch(() => {});
    }
  }

  const res = await fetch(`${GITHUB_API}${pathname}`, {
    method,
    headers: { ...ghHeaders(tok), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw await ghError(res);
  return { ok: true, status: res.status, body: await res.json().catch(() => ({})) };
}

/**
 * Mensagem em português para um status do GitHub, igual nos dois caminhos
 * (gh e fetch). O texto cru do gh ("gh: Not Found (HTTP 404)") não diz nada a
 * quem está usando a tela.
 */
function ghStatusMessage(status, detail = '') {
  if (status === 401) return 'credencial inválida ou expirada — entre de novo pelo navegador ou informe outro token';
  if (status === 403) return 'sem permissão para esta operação — a credencial precisa do escopo "repo" (ou "Administration: write" em fine-grained)';
  if (status === 404) return 'repositório não encontrado (ainda não existe, ou a credencial não enxerga repositórios privados)';
  if (status === 422) return 'o GitHub recusou: nome já em uso ou dados inválidos';
  return detail.split('\n').slice(-2).join(' ').slice(0, 300) || `GitHub respondeu ${status}`;
}

/** Erro da API do GitHub em português, com o que a tela precisa mostrar. */
async function ghError(res) {
  let detail = `GitHub respondeu ${res.status}`;
  try {
    const body = await res.json();
    if (body?.message) detail = `${detail}: ${body.message}`;
  } catch {
    // corpo não-JSON: fica a mensagem genérica
  }
  const status = res.status;
  const err = new Error(ghStatusMessage(status, detail));
  err.code = status === 401 || status === 403 ? 'NEEDS_AUTH' : status === 404 ? 'NOT_FOUND' : 'GITHUB_ERROR';
  err.status = status;
  return err;
}

/**
 * Confere a credencial e (se owner/repo forem informados) o acesso ao
 * repositório. Serve para a tela mostrar a verdade antes de o usuário clicar em
 * "publicar". `credential` diz de onde veio a credencial, para a tela explicar.
 */
export async function githubProbe({ token, owner, repo, credential = null } = {}) {
  const cred = credential || (await resolveCredential({ prefer: 'auto', token }));
  if (cred.kind === 'none') {
    return {
      ok: false,
      needsToken: true,
      error: cred.reason || 'sem credencial do GitHub — entre pelo navegador ou informe um token',
    };
  }

  const me = await ghApi('/user', { token: cred.token });
  const user = me.body;

  const out = {
    ok: true,
    credential: cred.kind,
    login: user.login,
    scopes: null, // só o fetch expõe esse cabeçalho; o gh api não devolve
    repo: null,
  };
  const o = String(owner || state.github?.owner || '').trim();
  const r = String(repo || state.github?.repo || '').trim();
  if (o && r) {
    try {
      const res = await ghApi(`/repos/${encodeURIComponent(o)}/${encodeURIComponent(r)}`, { token: cred.token });
      const body = res.body;
      out.repo = {
        owner: body.owner?.login || o,
        repo: body.name || r,
        exists: true,
        private: body.private === true,
        empty: body.size === 0,
        defaultBranch: body.default_branch || DEFAULT_BRANCH,
        url: body.html_url || null,
      };
    } catch (err) {
      if (err.status !== 404) throw err;
      out.repo = { owner: o, repo: r, exists: false, error: 'não encontrado (ou sem acesso)' };
    }
  }
  return out;
}

/**
 * Cria o repositório privado. Se já existir com esse nome, o GitHub responde 422
 * e a tela oferece "usar o existente" em vez de dead-end.
 *
 * O destino depende de QUEM é o dono, e isso não é cosmético:
 *   - dono vazio, ou igual ao login da credencial → `POST /user/repos`
 *   - dono diferente (uma organização de verdade) → `POST /orgs/<org>/repos`
 *
 * Tratar qualquer dono explícito como organização quebrava o caso mais comum: a
 * tela pré-preenche o dono com o login (que é conveniente), e aí `Altamir` —
 * uma conta de usuário — ia para `/orgs/Altamir/repos`, que responde 404.
 */
export async function githubCreateRepo({ token, owner, repo, branch = DEFAULT_BRANCH, description = 'coleção de skills do ai-memory-app', private: isPrivate = true } = {}) {
  const cred = await resolveCredential({ prefer: 'auto', token });
  if (cred.kind === 'none') {
    const err = new Error(cred.reason || 'sem credencial do GitHub');
    err.code = 'NEEDS_AUTH';
    throw err;
  }
  const r = String(repo || '').trim();
  if (!r) throw new Error('repo é obrigatório');
  if (!/^[\w.-]+$/.test(r)) throw new Error('repo inválido');
  const o = String(owner || '').trim();
  if (o && !/^[\w.-]+$/.test(o)) throw new Error('owner inválido');

  // só vale a pena perguntar quem está autenticado quando há dono para comparar
  let login = null;
  if (o) {
    try {
      login = String((await ghApi('/user', { token: cred.token })).body?.login || '').trim();
    } catch {
      login = null; // sem saber o login, mantém o comportamento de organização
    }
  }
  const sameAccount = o && login && o.toLowerCase() === login.toLowerCase();
  const endpoint = !o || sameAccount ? '/user/repos' : `/orgs/${encodeURIComponent(o)}/repos`;

  let res;
  try {
    res = await ghApi(endpoint, {
      method: 'POST',
      token: cred.token,
      // auto_init: false é deliberado. Com true o GitHub cria um commit inicial
      // (README) na branch default, e aí o primeiro "Publicar" da coleção seria
      // rejeitado como non-fast-forward — o usuário criaria o repo e travaria no
      // passo seguinte. Nascendo vazio, o push inicial entra sem force.
      body: { name: r, private: isPrivate !== false, auto_init: false, description },
    });
  } catch (err) {
    // 404 num endpoint de organização significa "não existe org com esse nome
    // (ou a credencial não cria repo nela)" — dizer isso evita a mensagem de
    // "repositório não encontrado", que aponta para o lugar errado
    if (err.status === 404 && endpoint.startsWith('/orgs/')) {
      const e = new Error(
        `não existe a organização "${o}" (ou a credencial não pode criar repositórios nela). ` +
          `Para criar na sua própria conta, use "${login || 'seu usuário'}" como dono.`,
      );
      e.code = 'GITHUB_ERROR';
      e.status = 404;
      throw e;
    }
    throw err;
  }
  const body = res.body;
  return {
    owner: body.owner?.login || o || body.login,
    repo: body.name || r,
    branch: body.default_branch || branch,
    private: body.private === true,
    url: body.html_url || null,
    credential: cred.kind,
  };
}

/**
 * Login do gh pelo fluxo de navegador (device flow): sem token, sem PAT — o
 * `gh` mostra um código e a pessoa confirma no navegador. É a ponte para quem
 * não tinha `gh` autenticado.
 *
 * Não roda `gh auth login` aqui: isso exigiria TTY e abriria um navegador no
 * servidor. O painel só orienta o comando e checa o resultado depois — o que
 * mantém a execução sob controle do operador.
 */
export async function ghLoginHint() {
  const gh = await probeGh();
  return {
    installed: gh.installed,
    authenticated: gh.authenticated,
    login: gh.login,
    command: gh.installed ? 'gh auth login --web' : 'brew install gh && gh auth login --web',
  };
}