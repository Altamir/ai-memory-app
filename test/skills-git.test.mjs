import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Versionamento por git da coleção: unit do núcleo (repo local, commits,
// histórico, restore) e integração pela API com um remote bare de verdade.
// Config e coleção são temporárias — nada toca a máquina real.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'aim-git-')));
const colDir = path.join(base, 'colecao');
const gitCfgFile = path.join(base, 'gitcfg.json');
fs.mkdirSync(colDir, { recursive: true });

// config.mjs congela no import: env precisa vir antes
process.env.AIM_APP_SKILLS_GIT_FILE = gitCfgFile;
process.env.AIM_APP_SERVERS_FILE = path.join(base, 'servers.json');
process.env.AIM_APP_SKILLS_DIR = colDir;

const g = await import('../server/skills-git.mjs');
const cfg = await import('../server/skills-git-config.mjs');

function writeSkill(dir, name, body = 'corpo') {
  const d = path.join(dir, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'SKILL.md'), `---\nname: ${name}\ndescription: "d"\n---\n\n${body}\n`);
  return d;
}

function newCol(name) {
  const d = path.join(base, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

test.after(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

// ---------- config: segredo nunca sai ----------

test('config do git esconde o token e preserva no edit', async () => {
  const f = path.join(base, 'cfg-a.json');
  process.env.AIM_APP_SKILLS_GIT_FILE = f;
  cfg.resetGitConfigForTest();

  assert.equal((await cfg.publicState()).hasToken, false);
  await cfg.saveGitHubConfig({ owner: 'alt-zz', repo: 'minhas-skills' });
  assert.equal((await cfg.publicState()).configured, true);
  assert.equal((await cfg.publicState()).branch, 'main');

  await cfg.saveGitHubConfig({ token: 'PAT-SECRETO-123' });
  assert.equal((await cfg.publicState()).hasToken, true);
  // o token não pode aparecer em nenhum campo público
  assert.equal(JSON.stringify(await cfg.publicState()).includes('PAT-SECRETO-123'), false);

  // editar a branch preserva o token (mesma regra tri-estado do .servers.json)
  await cfg.saveGitHubConfig({ branch: 'trunk' });
  assert.equal(cfg.currentToken(), 'PAT-SECRETO-123');
  assert.equal((await cfg.publicState()).branch, 'trunk');

  // token vazio limpa de propósito
  await cfg.saveGitHubConfig({ token: '' });
  assert.equal(cfg.currentToken(), null);

  // arquivo de credencial é 0600
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  }
  process.env.AIM_APP_SKILLS_GIT_FILE = gitCfgFile;
  cfg.resetGitConfigForTest();
});

// ---------- núcleo git ----------

test('gh é detectado e o auto prefere ele ao PAT', async () => {
  const gh = await g.probeGh();
  // gh pode não existir na máquina de teste — o contrato é o mesmo nos dois casos
  assert.equal(typeof gh.installed, 'boolean');
  assert.equal(typeof gh.authenticated, 'boolean');
  if (!gh.installed) assert.match(gh.error, /gh/i);

  // 'auto' com gh autenticado tem prioridade sobre o PAT guardado
  const auto = await g.resolveCredential({ prefer: 'auto', token: 'PAT-EXISTENTE' });
  if (gh.authenticated) {
    assert.equal(auto.kind, 'gh');
    assert.equal(auto.token, null, 'com gh não há token em jogo');
    assert.equal(auto.login, gh.login);
  } else {
    assert.equal(auto.kind, 'pat');
    assert.equal(auto.token, 'PAT-EXISTENTE');
  }

  // pedir 'pat' sem token é honesto: devolve none com motivo
  const semPat = await g.resolveCredential({ prefer: 'pat' });
  assert.equal(semPat.kind, 'none');
  assert.match(semPat.reason, /PAT/i);

  // pedir 'gh' sem gh autenticado também é honesto
  const semGh = await g.resolveCredential({ prefer: 'gh' });
  if (!gh.authenticated) assert.equal(semGh.kind, 'none');
});

test('probeGit e isRepo refletem a coleção', async () => {
  const probe = await g.probeGit();
  assert.equal(probe.ok, true, 'git deveria estar disponível no PATH do teste');

  const d = newCol('repo-probe');
  assert.equal(g.isRepo(d), false);
  await g.ensureRepo(d);
  assert.equal(g.isRepo(d), true);
});

test('ensureRepo cria o repo, branch main e .gitignore sem apagar o que existe', async () => {
  const d = newCol('repo-init');
  writeSkill(d, 'alpha');
  // .gitignore do usuário precisa sobreviver
  fs.writeFileSync(path.join(d, '.gitignore'), 'minha-coisa/\n');

  const out = await g.ensureRepo(d);
  assert.equal(out.created, true);
  const ignore = fs.readFileSync(path.join(d, '.gitignore'), 'utf8');
  assert.match(ignore, /minha-coisa\//, 'o .gitignore do usuário foi sobrescrito');
  assert.match(ignore, /\.versions\//);

  // idempotente
  const again = await g.ensureRepo(d);
  assert.equal(again.created, false);
  assert.equal(again.gitignore, false, 'não deve reescrever o .gitignore');

  const status = await g.gitStatus(d);
  assert.equal(status.branch, 'main');
});

test('commitAll commita uma vez e detecta árvore limpa', async () => {
  const d = newCol('repo-commit');
  writeSkill(d, 'beta', 'v1');
  await g.ensureRepo(d);

  const c1 = await g.commitAll({ dir: d, message: 'inicial' });
  assert.equal(c1.committed, true);
  assert.match(c1.sha, /^[0-9a-f]{7,}$/);

  // sem mudanças: nada a commitar (e nenhum commit vazio criado)
  const c2 = await g.commitAll({ dir: d, message: 'nada' });
  assert.equal(c2.committed, false);

  // mudou: commita
  writeSkill(d, 'beta', 'v2');
  const c3 = await g.commitAll({ dir: d, message: 'edita beta' });
  assert.equal(c3.committed, true);
  assert.notEqual(c3.sha, c1.sha);

  const log = execFileSync('git', ['log', '--oneline'], { cwd: d }).toString().trim().split('\n');
  assert.equal(log.length, 2);
});

test('histórico por skill filtra pelo caminho e restaura conteúdo', async () => {
  const d = newCol('repo-log');
  writeSkill(d, 'gamma', 'v1');
  writeSkill(d, 'delta', 'outra');
  await g.ensureRepo(d);
  await g.commitAll({ dir: d, message: 'inicial' });

  writeSkill(d, 'gamma', 'v2');
  await g.commitAll({ dir: d, message: 'edita gamma' });
  // mexer só na delta não deve aparecer no histórico da gamma
  writeSkill(d, 'delta', 'muda');
  await g.commitAll({ dir: d, message: 'edita delta' });

  const log = await g.listCommitsForSkill({ dir: d, name: 'gamma' });
  assert.equal(log.commits.length, 2);
  assert.match(log.commits[0].message, /edita gamma/);
  assert.equal(log.commits.some((c) => /edita delta/.test(c.message)), false);

  // "Ver" mostra o conteúdo naquele commit
  const first = log.commits.at(-1);
  const shown = await g.showCommitFile({ dir: d, name: 'gamma', sha: first.sha });
  assert.match(shown.content, /v1/);

  // restaurar devolve o conteúdo e cria commit novo
  const out = await g.restoreCommit({ dir: d, name: 'gamma', sha: first.sha });
  assert.equal(out.committed, true);
  assert.match(fs.readFileSync(path.join(d, 'gamma', 'SKILL.md'), 'utf8'), /v1/);
  // a delta fica intacta: restaurar uma skill não mexe na coleção inteira
  assert.match(fs.readFileSync(path.join(d, 'delta', 'SKILL.md'), 'utf8'), /muda/);

  const after = await g.listCommitsForSkill({ dir: d, name: 'gamma' });
  assert.match(after.commits[0].message, /restaura gamma/);
});

test('restoreCommit recusa commit sem a skill e nome inválido', async () => {
  const d = newCol('repo-restore-err');
  writeSkill(d, 'epsilon');
  await g.ensureRepo(d);
  const c = await g.commitAll({ dir: d, message: 'inicial' });

  await assert.rejects(() => g.restoreCommit({ dir: d, name: 'inexistente', sha: c.sha }));
  await assert.rejects(() => g.restoreCommit({ dir: d, name: 'epsilon', sha: 'não-é-sha' }));
  await assert.rejects(() => g.listCommitsForSkill({ dir: d, name: '../fora' }));
});

// ---------- gh falso: forma da requisição, sem tocar em conta real ----------

/**
 * Os três bugs que quebraram o fluxo real de "criar repositório":
 *  1. o corpo do POST era ignorado (o `input` do execFile não existe no async),
 *     então o gh recebia um POST vazio e respondia 400;
 *  2. um 404 virava 500, e "o repositório ainda não existe" — o caso normal de
 *     quem vai criá-lo agora — aparecia como erro;
 *  3. auto_init criava um commit no remoto e o primeiro push da coleção era
 *     rejeitado como non-fast-forward.
 * O gh falso guarda os argumentos e o corpo para conferir a forma da chamada.
 */
function fakeGh({ status = 200, body = '{}' } = {}) {
  const dir = fs.mkdtempSync(path.join(base, 'fake-gh-'));
  const capture = path.join(dir, 'captured.json');
  const script = path.join(dir, 'gh');
  fs.writeFileSync(script, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "gh version 9.9.9 (fake)"; exit 0; fi
case "$2" in /user|user) echo '{"login":"fake-user"}'; exit 0;; esac
BODY=""
PATH_ARG="$2"
if [ "$1" = "api" ]; then
  while [ $# -gt 0 ]; do
    if [ "$1" = "--input" ]; then shift; BODY=$(cat "$1" 2>/dev/null); fi
    shift
  done
fi
printf '{"args":"%s","body":%s}' "$PATH_ARG" "\${BODY:-null}" > ${capture}
printf '%s' '${body}'
echo "HTTP ${status}" >&2
exit ${status === 200 ? 0 : 1}
`, { mode: 0o755 });
  return { dir, capture, bin: dir };
}

test('saveGitHubConfig devolve config pronta (nao Promise vazia)', async () => {
  // publicState virou async e o save devolvia a Promise sem await: quem chamava
  // recebia {} e `cfg.github` vinha undefined — o repo era criado no GitHub e o
  // passo seguinte, ligar o remote, quebrava com "owner e repo sao obrigatorios".
  const cfgPath = path.join(base, 'cfg-save.json');
  process.env.AIM_APP_SKILLS_GIT_FILE = cfgPath;
  fs.rmSync(cfgPath, { force: true });
  cfg.resetGitConfigForTest();
  try {
    const out = await cfg.saveGitHubConfig({ owner: 'Altamir', repo: 'AIM-Skills', branch: 'main' });
    assert.ok(!(out instanceof Promise), 'nao pode devolver Promise');
    assert.equal(out.github.owner, 'Altamir');
    assert.equal(out.github.repo, 'AIM-Skills');
    assert.equal(out.configured, true);
    // o que o passo de ligar o remote usa
    const spec = g.githubRepoUrl(out.github);
    assert.equal(spec.url, 'https://github.com/Altamir/AIM-Skills.git');
  } finally {
    process.env.AIM_APP_SKILLS_GIT_FILE = gitCfgFile;
    fs.rmSync(cfgPath, { force: true });
    cfg.resetGitConfigForTest();
  }
});

test('gh api manda o corpo do POST e nao cria README inicial', async () => {
  const fake = fakeGh({ body: '{"name":"AIM-Skills","private":true}' });
  const oldPath = process.env.PATH;
  process.env.PATH = `${fake.bin}${path.delimiter}${oldPath}`;
  const cfgPath = path.join(base, 'cfg-fakegh.json');
  process.env.AIM_APP_SKILLS_GIT_FILE = cfgPath;
  fs.rmSync(cfgPath, { force: true });
  cfg.resetGitConfigForTest();
  try {
    const out = await cfg.githubCreateRepo({ repo: 'AIM-Skills', owner: '' });
    assert.equal(out.repo, 'AIM-Skills');

    const captured = JSON.parse(fs.readFileSync(path.join(fake.bin, 'captured.json'), 'utf8'));
    const body = typeof captured.body === 'string' ? JSON.parse(captured.body) : captured.body;
    assert.ok(body, 'o corpo do POST tem que chegar ao gh (era o bug do execFile)');
    assert.equal(body.name, 'AIM-Skills');
    assert.equal(body.private, true);
    assert.equal(
      body.auto_init,
      false,
      'auto_init true faria o primeiro push da colecao ser rejeitado',
    );
  } finally {
    process.env.PATH = oldPath;
    process.env.AIM_APP_SKILLS_GIT_FILE = gitCfgFile;
    fs.rmSync(cfgPath, { force: true });
    cfg.resetGitConfigForTest();
    fs.rmSync(fake.dir, { recursive: true, force: true });
  }
});

test('dono igual ao login cria na conta, nao em /orgs', async () => {
  // O bug real: a tela pre-preenche o dono com o login (comodo), e o codigo
  // tratava qualquer dono explicito como organizacao — POST /orgs/<login>/repos
  // responde 404 e "Criar repositorio" falhava sempre.
  const fake = fakeGh();
  const oldPath = process.env.PATH;
  process.env.PATH = `${fake.bin}${path.delimiter}${oldPath}`;
  const cfgPath = path.join(base, 'cfg-owner.json');
  process.env.AIM_APP_SKILLS_GIT_FILE = cfgPath;
  fs.rmSync(cfgPath, { force: true });
  cfg.resetGitConfigForTest();
  const capture = path.join(fake.bin, 'captured.json');
  try {
    // dono = login (o caso que quebrou)
    await cfg.githubCreateRepo({ owner: 'fake-user', repo: 'AIM-Skills' });
    let args = JSON.parse(fs.readFileSync(capture, 'utf8')).args;
    assert.match(args, /\/user\/repos/, 'dono = meu login tem que usar a conta');
    assert.doesNotMatch(args, /\/orgs\//, 'nao pode ir para /orgs quando o dono sou eu');

    // dono = organizacao de verdade continua indo para /orgs
    await cfg.githubCreateRepo({ owner: 'minha-org', repo: 'AIM-Skills' });
    args = JSON.parse(fs.readFileSync(capture, 'utf8')).args;
    assert.match(args, /\/orgs\/minha-org\/repos/);

    // dono vazio usa a conta
    await cfg.githubCreateRepo({ owner: '', repo: 'AIM-Skills' });
    args = JSON.parse(fs.readFileSync(capture, 'utf8')).args;
    assert.match(args, /\/user\/repos/);
  } finally {
    process.env.PATH = oldPath;
    process.env.AIM_APP_SKILLS_GIT_FILE = gitCfgFile;
    fs.rmSync(cfgPath, { force: true });
    cfg.resetGitConfigForTest();
    fs.rmSync(fake.dir, { recursive: true, force: true });
  }
});

test('404 do gh vira "ainda nao existe", nao erro generico', async () => {
  const fake = fakeGh({ status: 404, body: '{}' });
  const oldPath = process.env.PATH;
  process.env.PATH = `${fake.bin}${path.delimiter}${oldPath}`;
  const cfgPath = path.join(base, 'cfg-fake404.json');
  process.env.AIM_APP_SKILLS_GIT_FILE = cfgPath;
  fs.rmSync(cfgPath, { force: true });
  cfg.resetGitConfigForTest();
  try {
    const probe = await cfg.githubProbe({ owner: 'Altamir', repo: 'AIM-Skills' });
    assert.equal(probe.ok, true, 'repo inexistente nao pode virar erro: e o caso de quem vai criar');
    assert.equal(probe.repo.exists, false);
    assert.match(probe.repo.error, /nao encontrado|não encontrado/);
  } finally {
    process.env.PATH = oldPath;
    process.env.AIM_APP_SKILLS_GIT_FILE = gitCfgFile;
    fs.rmSync(cfgPath, { force: true });
    cfg.resetGitConfigForTest();
    fs.rmSync(fake.dir, { recursive: true, force: true });
  }
});

// ---------- remoto (bare local como GitHub de mentira) ----------

test('publicar, buscar de máquina nova e divergir', async () => {
  const bare = path.join(base, 'origin-bare.git');
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bare]);
  // credencial sem segredos: o remote é local, então nenhuma autenticação é usada
  const cred = { kind: 'gh', token: null };

  const A = newCol('maq-A');
  writeSkill(A, 'skill-a', 'v1');
  await g.ensureRepo(A);
  await g.setRemote(A, bare);
  await g.commitAll({ dir: A, message: 'coleção inicial' });
  await g.pushRemote({ dir: A, cred, log: () => {} });

  // máquina nova, coleção vazia: busca tudo do remoto
  const B = newCol('maq-B');
  await g.ensureRepo(B);
  await g.setRemote(B, bare);
  const pulled = await g.pullFastForward({ dir: B, cred, log: () => {} });
  assert.equal(pulled.pulled, true);
  assert.equal(pulled.branch, 'main');
  assert.ok(fs.existsSync(path.join(B, 'skill-a', 'SKILL.md')), 'a skill do remoto não chegou');

  // skills do remoto são listadas
  const remote = await g.listRemoteSkills({ dir: B });
  assert.equal(remote.skills.some((s) => s.name === 'skill-a'), true);

  // A edita e publica; B integra
  writeSkill(A, 'skill-a', 'v2');
  await g.commitAll({ dir: A, message: 'edita para v2' });
  await g.pushRemote({ dir: A, cred, log: () => {} });
  await g.pullFastForward({ dir: B, cred, log: () => {} });
  assert.match(fs.readFileSync(path.join(B, 'skill-a', 'SKILL.md'), 'utf8'), /v2/);

  // as duas publicam em paralelo → divergência explícita, sem merge automático
  writeSkill(A, 'skill-a', 'v3');
  await g.commitAll({ dir: A, message: 'A v3' });
  await g.pushRemote({ dir: A, cred, log: () => {} });
  writeSkill(B, 'skill-b-nova', 'nova');
  await g.commitAll({ dir: B, message: 'B adiciona skill' });
  await assert.rejects(
    () => g.pullFastForward({ dir: B, cred, log: () => {} }),
    (err) => err.code === 'DIVERGED',
  );

  // alteração local não commitada bloqueia o pull (não é descartada)
  const C = newCol('maq-C');
  writeSkill(C, 'skill-c');
  await g.ensureRepo(C);
  await g.setRemote(C, bare);
  await g.pullFastForward({ dir: C, cred, log: () => {} });
  await g.commitAll({ dir: C, message: 'C edita' });
  writeSkill(C, 'skill-c', 'editada sem commitar');
  await assert.rejects(
    () => g.pullFastForward({ dir: C, cred, log: () => {} }),
    (err) => err.code === 'LOCAL_CHANGES',
  );
  assert.match(fs.readFileSync(path.join(C, 'skill-c', 'SKILL.md'), 'utf8'), /sem commitar/, 'o arquivo local não pode sumir');
});

test('setRemote não sobrescreve remote existente sem replaceRemote (rota)', async () => {
  // coberto pela integração HTTP abaixo; aqui só validamos o formato da URL
  await assert.rejects(() => g.setRemote(newCol('repo-url'), 'nao-e-url'));
});

// ---------- integração HTTP ----------

const PORT = 4801;
let child;

const api = async (p, { method = 'GET', body } = {}) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* resposta sem corpo */ }
  return { status: res.status, data };
};

const waitJob = async (id, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data } = await api(`/api/jobs/${id}`);
    if (data?.status && data.status !== 'running') return data;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`job ${id} não terminou`);
};

test('API do git: status, setup, commit, push, log e token oculto', async (t) => {
  const httpBase = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'aim-git-api-')));
  const httpCol = path.join(httpBase, 'skills');
  fs.mkdirSync(path.join(httpCol, 'http-skill'), { recursive: true });
  fs.writeFileSync(path.join(httpCol, 'http-skill', 'SKILL.md'), '---\nname: http-skill\ndescription: "d"\n---\n\n# HTTP v1\n');
  const bare = path.join(httpBase, 'origin.git');
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bare]);

  child = spawn('node', ['server/index.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      AIM_APP_PORT: String(PORT),
      AI_MEMORY_BIN: '/bin/echo',
      AI_MEMORY_SKILLS_HOME: path.join(httpBase, 'home'),
      AIM_APP_SKILLS_DIR: httpCol,
      AIM_APP_SKILLS_EXPORT_DIR: path.join(httpBase, 'exp'),
      AI_MEMORY_SKILLS_BACKUP_DIR: path.join(httpBase, 'bak'),
      AIM_APP_SKILLS_GIT_FILE: path.join(httpBase, 'gitcfg.json'),
      AIM_APP_SERVERS_FILE: path.join(httpBase, 'servers.json'),
      AI_MEMORY_SERVER_URL: 'http://127.0.0.1:1',
    },
    stdio: 'ignore',
  });
  t.after(() => {
    child?.kill('SIGTERM');
    fs.rmSync(httpBase, { recursive: true, force: true });
  });

  // espera o health
  const deadline = Date.now() + 15_000;
  let up = false;
  while (Date.now() < deadline && !up) {
    try { up = (await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok; } catch { /* ainda subindo */ }
    if (!up) await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(up, 'servidor de teste não subiu');

  // estado inicial: coleção não é repo
  const st = await api('/api/collection/git/status');
  assert.equal(st.status, 200);
  assert.equal(st.data.isRepo, false);
  assert.equal(st.data.git.ok, true);

  // setup cria o repo e liga o remote
  const setup = await api('/api/collection/git/setup', { method: 'POST', body: { remoteUrl: bare } });
  assert.equal(setup.status, 200);
  assert.equal(setup.data.repo.created, true);
  assert.equal(setup.data.remote.remote, bare);

  // trocar o remote exige confirmação explícita
  const again = await api('/api/collection/git/setup', { method: 'POST', body: { remoteUrl: path.join(httpBase, 'outro.git') } });
  assert.equal(again.status, 409);
  assert.equal(again.data.needsReplaceRemote, true);

  // salvar versão = commit
  const saved = await api('/api/collection/skills/version', { method: 'POST', body: { name: 'http-skill', note: 'nota de teste' } });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.git, true);
  assert.ok(saved.data.sha, 'o commit precisa trazer o sha');

  // publicar (commit + push) como job
  const push = await api('/api/collection/git/push', { method: 'POST' });
  assert.equal(push.status, 201);
  const job = await waitJob(push.data.id);
  assert.equal(job.status, 'ok');

  // histórico da skill vem do git
  const log = await api('/api/collection/git/log?name=http-skill');
  assert.equal(log.status, 200);
  assert.ok(log.data.commits.length >= 1);
  assert.match(log.data.commits[0].message, /nota de teste/);

  // skills do remoto
  const remote = await api('/api/collection/git/remote-skills');
  assert.equal(remote.status, 200);
  assert.equal(remote.data.skills.some((s) => s.name === 'http-skill'), true);

  // o token configurado nunca aparece no status
  await api('/api/collection/git/setup', {
    method: 'POST',
    body: { github: { owner: 'alt-zz', repo: 'skills-privadas' }, token: 'PAT-DE-TESTE-NAO-VAZA' },
  });
  const st2 = await api('/api/collection/git/status');
  assert.equal(st2.data.config.hasToken, true);
  assert.equal(JSON.stringify(st2.data).includes('PAT-DE-TESTE-NAO-VAZA'), false);
});