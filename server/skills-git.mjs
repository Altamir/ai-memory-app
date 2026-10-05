import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from './config.mjs';
import { installSkill, NAME_RE } from './skills.mjs';

// Versionamento da coleção de skills por git: a pasta inteira
// (`~/.ai-memory-app/skills`, AIM_APP_SKILLS_DIR) passa a ser um repositório,
// e o histórico passa a ser o histórico do git — commits no lugar dos snapshots
// em `.versions/`, que ficam de fora (e de fora do git) só por compatibilidade
// com quem já tem versões gravadas.
//
// Invariantes deste arquivo:
// - NUNCA shell. Tudo é `execFile('git', [argv…])`: nenhum argv vindo do
//   usuário vira string interpretada, que é a propriedade que o README declara
//   ("não existe rota de shell arbitrário").
// - O token NUNCA é gravado no `.git/config`: o remote fica sem credencial e a
//   autenticação entra por `-c http.extraheader=…`, montado só na chamada.
//   Assim `git remote -v` numa outra máquina não expõe nada, e o `.git/config`
//   não vira arquivo de credencial.
// - `GIT_TERMINAL_PROMPT=0`: sem token válido o git falha logo em vez de ficar
//   esperando senha num terminal invisível.
// - Toda chamada tem timeout. Rede (fetch/push/pull) tem teto maior que leitura.

const execFileAsync = promisify(execFile);

const READ_TIMEOUT_MS = 10_000;
const NET_TIMEOUT_MS = 120_000;

// Identidade fixa: o commit não pode depender do `.gitconfig` global da máquina
// (a collection pode ser versionada numa máquina sem git configurado).
const IDENTITY = ['-c', 'user.name=ai-memory-app', '-c', 'user.email=gestor@localhost'];

// `.versions/` é o histórico em disco antigo. Deixamos de escrever nele quando
// há git, mas não apagamos: quem já tem v3, v7, v12 continua com elas.
const VERSIONS_IGNORE = '.versions/';

/** Erro de git que a UI precisa diferenciar de "algo deu errado". */
function gitError(message, { needsAuth = false, code = 'GIT_FAILED' } = {}) {
  const err = new Error(message);
  err.code = code;
  if (needsAuth) err.needsAuth = true;
  return err;
}

/** Texto útil do stderr do git (o stdout costuma vir vazio em falha de rede). */
function gitStderr(stderr) {
  const lines = String(stderr || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^(warning|remote:|Receiving|Resolving|Counting|Compressing|Enumerating|Writing|Total|Unpacking)/i.test(l));
  return lines.slice(-2).join(' ').slice(0, 400);
}

// ---------- GitHub CLI (gh) como fonte de credencial ----------

// Ter o `gh` instalado e autenticado é o caminho sem atrito: o painel não pede
// token nenhum, e o token do gh fica no keychain do sistema — o painel nunca o
// lê nem o grava. `gh` responde ao protocolo de credential helper do git
// (`gh auth git-credential`), então dá para plugá-lo só na chamada, sem
// `gh auth setup-git` e sem mexer no .gitconfig global da máquina.
//
// A ordem de preferência é deliberada: gh autenticado > PAT digitado. gh é o
// caminho que a pessoa já configurou uma vez e esqueceu; PAT é o passo chato
// que ela não deveria precisar dar.

const GH_HELPER = '!gh auth git-credential';

/** gh instalado? está autenticado? como quem? */
export async function probeGh() {
  try {
    await execFileAsync('gh', ['--version'], { timeout: 5000 });
  } catch (err) {
    return {
      installed: false,
      authenticated: false,
      login: null,
      error: err.code === 'ENOENT' ? 'GitHub CLI (gh) não encontrado no PATH' : err.message,
    };
  }
  try {
    const { stdout } = await execFileAsync('gh', ['api', 'user', '--jq', '.login'], { timeout: 10_000 });
    const login = String(stdout).trim();
    if (login) return { installed: true, authenticated: true, login };
  } catch {
    // instalado mas sem sessão: cai no erro abaixo
  }
  return {
    installed: true,
    authenticated: false,
    login: null,
    error: 'gh instalado, mas sem login — rode `gh auth login` ou use "Entrar pelo navegador" aqui no painel',
  };
}

/**
 * Resolve qual credencial usar nas operações de rede.
 *
 * `prefer` explicitado pela tela sempre manda; sem ele, gh autenticado vence o
 * PAT. Devolve `{kind, token}` — `kind: 'gh'` não tem token porque o git resolve
 * a senha sozinho pelo helper.
 */
export async function resolveCredential({ prefer = 'auto', token = null } = {}) {
  if (prefer === 'pat') {
    const t = String(token || '').trim();
    if (!t) return { kind: 'none', token: null, reason: 'PAT não informado' };
    return { kind: 'pat', token: t };
  }
  if (prefer === 'gh') {
    const gh = await probeGh();
    return gh.authenticated
      ? { kind: 'gh', token: null, login: gh.login }
      : { kind: 'none', token: null, reason: gh.error };
  }
  // auto: gh primeiro
  const gh = await probeGh();
  if (gh.authenticated) return { kind: 'gh', token: null, login: gh.login };
  const t = String(token || '').trim();
  if (t) return { kind: 'pat', token: t };
  return { kind: 'none', token: null, reason: gh.installed ? gh.error : 'sem gh autenticado e sem PAT' };
}

/**
 * Roda um comando git na coleção.
 *
 * A credencial entra por `-c` (só memória do processo, nada vai para o
 * .git/config): com PAT, um header Basic; com gh, o credential helper.
 */
async function git(args, { dir, token = null, credential = 'pat', timeout = READ_TIMEOUT_MS, allowFail = false } = {}) {
  const base = [...IDENTITY, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false'];
  if (credential === 'gh') {
    // o `!` faz o git executar via shell e anexar a operação (`get`); o
    // credential.helper vazio impede o osxkeychain local de responder antes
    base.push('-c', 'credential.helper=', '-c', `credential.https://github.com.helper=${GH_HELPER}`);
  } else if (token) {
    // GitHub aceita "x-access-token:<PAT>" como usuário do Basic. O `-c` é
    // só memória do processo: nada disso vai para o .git/config.
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    base.push('-c', `http.extraheader=Authorization: Basic ${basic}`);
  }
  try {
    const { stdout, stderr } = await execFileAsync('git', [...base, ...args], {
      cwd: dir,
      timeout,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GIT_PAGER: 'cat' },
    });
    return { ok: true, stdout, stderr };
  } catch (err) {
    if (allowFail) return { ok: false, stdout: '', stderr: err.stderr || err.message, code: err.code };
    const detail = gitStderr(err.stderr);
    // 401/403 no transporte = token inválido ou sem escopo: a UI mostra o link
    // de criação de PAT em vez de "erro genérico".
    const needsAuth = /Authentication failed|could not read Username|403 Forbidden|401 Unauthorized/i.test(
      `${err.stderr || ''} ${err.stdout || ''}`,
    );
    throw gitError(detail || `git ${args[0]} falhou`, { needsAuth });
  }
}

/** git existe e responde? (o Gestor degrada para snapshots se não) */
export async function probeGit() {
  try {
    const { stdout } = await execFileAsync('git', ['--version'], { timeout: 5000 });
    const m = /git version (\S+)/.exec(String(stdout));
    return { ok: true, version: m ? m[1] : String(stdout).trim() };
  } catch (err) {
    return { ok: false, version: null, error: err.code === 'ENOENT' ? 'git não encontrado no PATH' : err.message };
  }
}

// ---------- estado da coleção ----------

function collectionRoot(dir) {
  return path.resolve(dir || config.skillsDir);
}

/** A própria coleção é um repositório? */
export function isRepo(dir) {
  try {
    return fs.existsSync(path.join(collectionRoot(dir), '.git'));
  } catch {
    return false;
  }
}

/**
 * A coleção está dentro de outro repositório? `git init` ali criaria um repo
 * aninhado — funciona, mas surprising e o push do pai pode engolir o filho.
 */
export function insideOtherRepo(dir) {
  const root = collectionRoot(dir);
  let cur = root;
  for (let i = 0; i < 12; i += 1) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    if (fs.existsSync(path.join(parent, '.git'))) return parent;
    cur = parent;
  }
  return null;
}

/**
 * Os quatro estados que a tela de configuração distingue:
 *   'sem-config'  não é repo e não há remoto configurado → escolher criar/conectar
 *   'repo-local'  não é repo mas há config salva → falta só criar o repo local
 *   'sem-remoto'  já é repo, sem remote → versiona local, falta ligar o remoto
 *   'pronto'      já é repo com remote → tudo configurado
 */
export async function detectState(dir, { configured = false } = {}) {
  const repo = isRepo(dir);
  const state = repo ? 'repo-local' : 'sem-config';
  const out = { state, isRepo: repo, branch: null, remote: null, ahead: 0, behind: 0, changed: [], insideRepo: null };
  if (!repo) {
    const parent = insideOtherRepo(dir);
    if (parent) out.insideRepo = parent;
    return { ...out, state: configured ? 'repo-local' : 'sem-config' };
  }
  return { ...out, ...(await gitStatus(dir)) };
}

/** Estado da coleção para a UI:branch, remote, ahead/behind e pendências. */
export async function gitStatus(dir) {
  const root = collectionRoot(dir);
  if (!isRepo(dir)) return { isRepo: false, branch: null, remote: null, ahead: 0, behind: 0, changed: [], hasCommits: false, dirty: false };
  const run = (args) => git(args, { dir: root, allowFail: true });
  const [branch, remotes, porcelain, upstream] = await Promise.all([
    // symbolic-ref funciona mesmo sem nenhum commit; rev-parse é o plano B
    run(['symbolic-ref', '--short', 'HEAD']),
    run(['remote']),
    run(['status', '--porcelain']),
    run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
  ]);
  const branchName = branch.ok ? String(branch.stdout).trim() : '';
  const head = await run(['rev-parse', 'HEAD']);
  const changed = String(porcelain.stdout || '')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    // dot-dirs e o próprio .gitignore não são "pendência" que o usuário precisa ver
    .filter((p) => !p.split('/').some((seg) => seg.startsWith('.')));
  const hasRemote = String(remotes.stdout || '').split('\n').filter(Boolean);
  const remoteUrl = hasRemote.length ? (await run(['remote', 'get-url', 'origin'])).stdout.trim() : null;

  let ahead = 0;
  let behind = 0;
  const up = String(upstream.stdout || '').trim();
  if (up && head.ok) {
    const counts = await run(['rev-list', '--left-right', '--count', `${up}...HEAD`]);
    if (counts.ok) {
      const [behindRaw, aheadRaw] = String(counts.stdout || '').trim().split(/\s+/);
      behind = Number(behindRaw) || 0;
      ahead = Number(aheadRaw) || 0;
    }
  }
  return {
    isRepo: true,
    branch: branchName || null,
    remote: remoteUrl || null,
    hasRemote: hasRemote.length > 0,
    upstream: up || null,
    ahead,
    behind,
    changed,
    dirty: changed.length > 0,
    hasCommits: head.ok,
  };
}

// ---------- criação/adoção do repo ----------

/**
 * Acrescenta `.versions/` ao .gitignore da coleção sem apagar o que já existir.
 * Um .gitignore do usuário é preservado: só a linha que faltava é adicionada.
 */
export async function ensureGitignore(dir) {
  const root = collectionRoot(dir);
  const file = path.join(root, '.gitignore');
  let current = '';
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch {
    // ainda não existe
  }
  const already = current.split('\n').some((l) => l.trim().replace(/\/$/, '') === VERSIONS_IGNORE.replace(/\/$/, ''));
  if (already) return { file, changed: false };
  const prefix = current && !current.endsWith('\n') ? '\n' : '';
  await fsp.writeFile(file, `${current}${prefix}${VERSIONS_IGNORE}\n`, 'utf8');
  return { file, changed: true };
}

/**
 * Cria o repositório local se ainda não existir. Idempotente: chamar de novo
 * numa coleção que já é repo não faz nada. NÃO mexe em remote — quem decide
 * qual remote usar é `setupRemote`, e sempre por confirmação explícita.
 */
export async function ensureRepo(dir, { log = () => {} } = {}) {
  const root = collectionRoot(dir);
  fs.mkdirSync(root, { recursive: true });
  const existed = isRepo(dir);
  if (!existed) {
    log('sys', `criando repositório em ${root}\n`);
    await git(['init', '-q'], { dir: root });
    await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], { dir: root });
    log('sys', 'branch inicial: main\n');
  }
  const ignore = await ensureGitignore(dir);
  if (ignore.changed) log('sys', `.gitignore: acrescentado ${VERSIONS_IGNORE}\n`);
  return { dir: root, created: !existed, gitignore: ignore.changed };
}

/**
 * Liga (ou troca) o remote `origin`. Mantém a URL sem credencial: a
 * autenticação é por header, montada só na chamada.
 */
export async function setRemote(dir, url) {
  const root = collectionRoot(dir);
  const clean = String(url || '').trim();
  if (!clean) throw new Error('url do repositório é obrigatória');
  if (!/^(https?:\/\/|git@|ssh:\/\/|git:\/\/|file:\/\/|\/)/.test(clean)) {
    throw new Error(`url de repositório inválida: ${clean.slice(0, 120)}`);
  }
  const exists = (await git(['remote'], { dir: root, allowFail: true })).stdout.split('\n').includes('origin');
  if (exists) {
    await git(['remote', 'set-url', 'origin', clean], { dir: root });
  } else {
    await git(['remote', 'add', 'origin', clean], { dir: root });
  }
  return { remote: clean, replaced: exists };
}

/** URL https de um repositório do GitHub, sem credencial. */
export function githubRepoUrl({ owner, repo, branch = 'main' } = {}) {
  const o = String(owner || '').trim();
  const r = String(repo || '').trim();
  if (!o || !r) throw new Error('owner e repo do GitHub são obrigatórios');
  if (!/^[\w.-]+$/.test(o) || !/^[\w.-]+$/.test(r)) throw new Error('owner/repo inválido');
  const safeBranch = /^[A-Za-z0-9._/-]+$/.test(String(branch)) ? String(branch) : 'main';
  return { url: `https://github.com/${o}/${r}.git`, owner: o, repo: r, branch: safeBranch };
}

// ---------- commits ----------

/**
 * Commita o que houver de mudou na coleção. Devolve `committed: false` quando a
 * árvore já está limpa — é o que impede um commit vazio a cada escrita.
 */
export async function commitAll({ dir, message, paths = null, log = () => {} } = {}) {
  const root = collectionRoot(dir);
  if (!isRepo(dir)) throw gitError('a coleção ainda não é um repositório git');
  const before = await gitStatus(dir);
  if (before.hasCommits && !before.dirty) {
    return { committed: false, reason: 'nada a commitar', ...before };
  }
  const msg = String(message || 'atualiza coleção').trim().slice(0, 300) || 'atualiza coleção';
  const addArgs = paths?.length ? ['add', '--', ...paths] : ['add', '-A'];
  await git(addArgs, { dir: root });
  const after = await gitStatus(dir);
  if (!after.dirty) return { committed: false, reason: 'nada mudou no conteúdo', ...after };
  const commit = await git(['commit', '-q', '-m', msg], { dir: root, allowFail: true });
  if (!commit.ok) {
    // "nothing to commit" sai com código 1 — não é erro
    if (/nothing to commit|no changes added/i.test(commit.stderr)) {
      return { committed: false, reason: 'nada mudou no conteúdo', ...(await gitStatus(dir)) };
    }
    throw gitError(gitStderr(commit.stderr) || 'git commit falhou');
  }
  const head = await git(['rev-parse', '--short', 'HEAD'], { dir: root });
  const sha = head.ok ? String(head.stdout).trim() : null;
  log('sys', `commit ${sha} — ${msg}\n`);
  return { committed: true, sha, message: msg, ...(await gitStatus(dir)) };
}

/** Commits que mexeram numa skill específica (histórico por skill). */
export async function listCommitsForSkill({ dir, name, limit = 50 } = {}) {
  const root = collectionRoot(dir);
  if (!isRepo(dir)) return { name: String(name), commits: [], git: false };
  if (!NAME_RE.test(String(name))) throw new Error('nome de skill inválido');
  const n = Math.min(Math.max(Number(limit) || 50, 1), 500);
  const res = await git(
    ['log', `-n${n}`, '--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s', '--', String(name)],
    { dir: root, allowFail: true },
  );
  if (!res.ok) return { name: String(name), commits: [], git: true };
  const commits = String(res.stdout)
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, short, author, date, subject] = line.split('\x1f');
      return { sha, short, author, date, message: subject };
    });
  return { name: String(name), commits, git: true };
}

/** Conteúdo do SKILL.md de uma skill num commit — o botão "Ver". */
export async function showCommitFile({ dir, name, sha, rel = 'SKILL.md' } = {}) {
  const root = collectionRoot(dir);
  if (!isRepo(dir)) throw new Error('a coleção ainda não é um repositório git');
  if (!NAME_RE.test(String(name))) throw new Error('nome de skill inválido');
  if (!/^[0-9a-f]{4,40}$/i.test(String(sha))) throw new Error('commit inválido');
  const res = await git(['show', `${sha}:${name}/${rel}`], { dir: root });
  return { name: String(name), sha: String(sha), rel, content: res.stdout };
}

/**
 * Devolve a skill ao estado de um commit: `checkout <sha> -- <skillDir>` e um
 * commit novo por cima. Nunca `reset --hard` — isso reverteria a coleção toda,
 * e o usuário pediu "restaurar esta skill", não "desfazer tudo".
 */
export async function restoreCommit({ dir, name, sha, log = () => {} } = {}) {
  const root = collectionRoot(dir);
  if (!isRepo(dir)) throw new Error('a coleção ainda não é um repositório git');
  if (!NAME_RE.test(String(name))) throw new Error('nome de skill inválido');
  if (!/^[0-9a-f]{4,40}$/i.test(String(sha))) throw new Error('commit inválido');
  const exists = await git(['cat-file', '-e', `${sha}:${name}/SKILL.md`], { dir: root, allowFail: true });
  if (!exists.ok) throw new Error(`o commit ${sha.slice(0, 8)} não tem "${name}/SKILL.md"`);
  await git(['checkout', String(sha), '--', String(name)], { dir: root });
  const out = await commitAll({ dir, message: `restaura ${name} de ${String(sha).slice(0, 8)}` });
  log('sys', out.committed ? `restaurado e commitado (${out.sha})\n` : 'nada a mudar\n');
  return { name: String(name), from: String(sha), ...out };
}

// ---------- remoto ----------

/**
 * Fetch/pull/push. O token entra por header e só existe durante a chamada.
 * `pull` é --ff-only: divergência entre máquinas não vira merge automático —
 * o painel devolve "divergiu" e o usuário decide.
 */
export async function pushRemote({ dir, cred, log = () => {} } = {}) {
  const root = collectionRoot(dir);
  log('sys', 'enviando ao remoto…\n');
  const res = await git(['push', '-u', 'origin', 'HEAD'], { dir: root, credential: cred?.kind, token: cred?.token, timeout: NET_TIMEOUT_MS, allowFail: true });
  if (!res.ok) {
    throw gitError(gitStderr(res.stderr) || 'push falhou', { needsAuth: /Authentication failed|403|401|could not read Username/i.test(res.stderr) });
  }
  log('out', String(res.stdout || ''));
  return { pushed: true, ...(await gitStatus(dir)) };
}

export async function fetchRemote({ dir, cred, log = () => {} } = {}) {
  const root = collectionRoot(dir);
  log('sys', 'buscando do remoto…\n');
  const res = await git(['fetch', '--prune', 'origin'], { dir: root, credential: cred?.kind, token: cred?.token, timeout: NET_TIMEOUT_MS, allowFail: true });
  if (!res.ok) {
    throw gitError(gitStderr(res.stderr) || 'fetch falhou', { needsAuth: /Authentication failed|403|401|could not read Username/i.test(res.stderr) });
  }
  log('out', String(res.stdout || ''));
  return { fetched: true, ...(await gitStatus(dir)) };
}

export async function pullFastForward({ dir, cred, log = () => {} } = {}) {
  const root = collectionRoot(dir);
  const target = await remoteTargetRef(root, cred);
  if (!target) throw gitError('a coleção não tem remote configurado — configure em "Repositório…"');
  // num repo ainda sem commit, `rev-parse HEAD` falha; a ref symbolic ainda
  // funciona e é o que queremos saber aqui
  const branch =
    (await git(['symbolic-ref', '--short', 'HEAD'], { dir: root, allowFail: true })).stdout.trim() ||
    (await git(['rev-parse', '--abbrev-ref', 'HEAD'], { dir: root, allowFail: true })).stdout.trim();
  if (!branch || branch === 'HEAD') throw gitError('não há branch local para integrar');

  // Máquina nova: o repo local existe mas está sem nenhum commit, e o
  // `ensureRepo` já deixou um `.gitignore` solto. O git recusa o merge por
  // "untracked working tree files would be overwritten".
  //
  // Só nesse caso (zero commits) removemos os arquivos soltos: eles são nossos,
  // não do usuário, e o conteúdo que importa vem inteiro do remoto. Assim que
  // existe um commit, arquivo solto passa a ser trabalho do usuário — e aí
  // qualquer pendência local bloqueia o pull em vez de ser descartada.
  const before = await gitStatus(dir);
  if (!before.hasCommits) {
    const cleared = await clearUntrackedFiles(dir);
    if (cleared.length) log('sys', `removendo arquivos soltos do git local: ${cleared.join(', ')}\n`);
  } else {
    const tracked = await dirtyTrackedFiles(dir);
    const untracked = await listUntrackedFiles(dir);
    if (tracked.length || untracked.length) {
      const sample = [...tracked, ...untracked].slice(0, 3).join(', ');
      throw gitError(
        `há alterações locais não commitadas (${sample}) — publique ou descarte antes de buscar`,
        { code: 'LOCAL_CHANGES' },
      );
    }
  }

  // A branch precisa ser explícita: `git pull origin` sozinho falha numa máquina
  // que ainda não tem upstream (que é justamente o caso de quem acabou de
  // configurar o repositório).
  log('sys', `buscando e integrando (--ff-only, ${target})…\n`);
  const res = await git(['pull', '--ff-only', 'origin', branch], { dir: root, credential: cred?.kind, token: cred?.token, timeout: NET_TIMEOUT_MS, allowFail: true });
  if (!res.ok) {
    const detail = gitStderr(res.stderr);
    const diverged = /Not possible to fast-forward|diverg|rejected|non-fast-forward/i.test(`${res.stderr}`);
    throw gitError(diverged ? 'divergiu do remoto — resolva antes de publicar (o painel não faz merge automático)' : detail || 'pull falhou', {
      code: diverged ? 'DIVERGED' : 'GIT_FAILED',
      needsAuth: !diverged && /Authentication failed|403|401|could not read Username/i.test(res.stderr),
    });
  }
  log('out', String(res.stdout || ''));
  // o .gitignore pode ter vindo do remoto ou ter sido removido acima; de qualquer
  // forma `.versions/` precisa continuar ignorado
  await ensureGitignore(dir);
  return { pulled: true, ...(await gitStatus(dir)) };
}

/**
 * Skills que existem no remoto — pode ser mais do que a coleção local tem.
 * Resolve a ref por baixo: `origin/HEAD` nem sempre existe num remote recém
 * configurado (só depois do primeiro fetch), então caímos para a branch local.
 */
export async function listRemoteSkills({ dir, cred, ref = null } = {}) {
  const root = collectionRoot(dir);
  if (!isRepo(dir)) return { skills: [], ref: ref || null, git: false };
  const target = ref || (await resolveRemoteRef(root, cred));
  if (!target) return { skills: [], ref: null, git: true, error: 'remote ainda não buscado — rode "Buscar" uma vez' };
  const res = await git(['ls-tree', '-d', '--name-only', target], { dir: root, credential: cred?.kind, token: cred?.token, allowFail: true });
  if (!res.ok) return { skills: [], ref: target, git: true, error: gitStderr(res.stderr) || 'remote ainda não buscado' };
  const names = String(res.stdout)
    .split('\n')
    .filter(Boolean)
    .filter((n) => !n.startsWith('.'));
  return { ref: target, skills: names.map((name) => ({ name })), git: true };
}

/** Qual ref do remoto usar: a branch que o upstream aponta, ou a branch local. */
async function resolveRemoteRef(root, cred) {
  const up = (await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { dir: root, credential: cred?.kind, token: cred?.token, allowFail: true })).stdout.trim();
  if (up) return up;
  const head = (await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { dir: root, credential: cred?.kind, token: cred?.token, allowFail: true })).stdout.trim();
  if (head) return head;
  const branches = (await git(['branch', '-r', '--format=%(refname:short)'], { dir: root, credential: cred?.kind, token: cred?.token, allowFail: true })).stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !s.includes('HEAD'));
  return branches[0] || null;
}

/** Ref remota explícita (ex.: origin/main) resolvendo o branch local. */
async function remoteTargetRef(root, cred) {
  const branch =
    (await git(['symbolic-ref', '--short', 'HEAD'], { dir: root, allowFail: true })).stdout.trim() ||
    (await git(['rev-parse', '--abbrev-ref', 'HEAD'], { dir: root, allowFail: true })).stdout.trim();
  if (branch && branch !== 'HEAD') return `origin/${branch}`;
  return resolveRemoteRef(root, cred);
}

/** Arquivos rastreados e modificados (exclui os soltos, que são removíveis). */
async function dirtyTrackedFiles(root) {
  const res = await git(['diff', '--name-only', 'HEAD'], { dir: root, allowFail: true });
  if (!res.ok) return [];
  return String(res.stdout).split('\n').filter(Boolean).slice(0, 20);
}

/** Arquivos não rastreados (ignorados pelo .gitignore não contam). */
async function listUntrackedFiles(dir) {
  const res = await git(['ls-files', '--others', '--exclude-standard'], { dir: collectionRoot(dir), allowFail: true });
  if (!res.ok) return [];
  return String(res.stdout).split('\n').filter(Boolean).slice(0, 20);
}

/**
 * Arquivos não rastreados que o git bloquearia num merge. Só os soltos
 * (untracked) — nunca toca em algo rastreado, que é trabalho do usuário.
 *
 * A remoção é no filesystem, não `git rm --cached`: um arquivo untracked não
 * está no índice, e o comando falha com "pathspec did not match any files".
 */
async function clearUntrackedFiles(dir) {
  const root = collectionRoot(dir);
  const res = await git(['ls-files', '--others', '--exclude-standard'], { dir: root, allowFail: true });
  if (!res.ok) return [];
  const files = String(res.stdout).split('\n').filter(Boolean);
  const removed = [];
  for (const rel of files) {
    const full = path.join(root, rel);
    // defesa em profundidade: nunca sair da coleção
    if (full !== root && !full.startsWith(root + path.sep)) continue;
    try {
      fs.rmSync(full, { recursive: true, force: true });
      removed.push(rel);
    } catch {
      // o git ainda vai recusar o merge; a mensagem dele explica o que sobrou
    }
  }
  return removed;
}

/**
 * Instala uma skill direto do remoto, sem passar pela coleção local.
 *
 * O git entrega os bytes num clone descartável de um único commit e o
 * `installSkill` que já existe faz a instalação — backup, marker gerenciado e
 * `force` seguem idênticos ao caminho "instalar da coleção".
 *
 * Nada é extraído dentro da coleção: um `git checkout <ref> -- <skill>` ali
 * mexeria na árvore de trabalho e apareceria como alteração não commitada. Um
 * clone em /tmp com `--depth 1` custa um objeto só e não deixa rastro.
 */
export async function installFromRemote({ dir, name, harness, scope = 'global', projectDir, force = false, cred, home, ref = null } = {}) {
  const root = collectionRoot(dir);
  if (!isRepo(dir)) throw new Error('a coleção ainda não é um repositório git');
  if (!NAME_RE.test(String(name))) throw new Error('nome de skill inválido');
  const remoteUrl = (await git(['remote', 'get-url', 'origin'], { dir: root })).stdout.trim();
  if (!remoteUrl) throw new Error('a coleção não tem remote configurado');
  const target = ref || (await resolveRemoteRef(root, cred));
  if (!target) throw new Error('remote ainda não buscado — rode "Buscar" uma vez antes de instalar');
  // `origin/main` → `main` para o --branch do clone
  const shortRef = String(target).replace(/^origin\//, '');

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'aim-remote-skill-'));
  try {
    // valida antes de clonar: erro de "não existe no remoto" sai em ms, não
    // depois de puxar o repositório inteiro
    const check = await git(['cat-file', '-e', `${target}:${name}/SKILL.md`], { dir: root, credential: cred?.kind, token: cred?.token, allowFail: true });
    if (!check.ok) throw new Error(`"${name}" não está no remoto (${target})`);

    const args = [
      'clone', '--depth', '1', '--single-branch', '--branch', shortRef,
      remoteUrl, tmp,
    ];
    // a credencial entra pelo git() — não repetir aqui
    const co = await git(args, { dir: os.tmpdir(), credential: cred?.kind, token: cred?.token, timeout: NET_TIMEOUT_MS });
    if (!co.ok) throw gitError(gitStderr(co.stderr) || 'não consegui baixar do remoto');
    const source = path.join(tmp, name);
    if (!fs.existsSync(path.join(source, 'SKILL.md'))) {
      throw new Error(`"${name}" veio do remoto sem SKILL.md`);
    }
    return await installSkill({
      name,
      harness,
      scope,
      projectDir,
      force,
      home,
      managed: { error: null, skills: new Map() },
      sourceDir: source,
    });
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}