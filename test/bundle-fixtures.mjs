import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTarGz } from '../server/tar.mjs';

// Store de fixtures do exportador: um wiki com dois escopos (um deles _global),
// páginas com frontmatter variado, arquivos que NÃO são páginas (log-*.md,
// _pending/), uma página que só existe no SQLite e uma versão antiga
// (is_latest = 0) que não pode entrar no bundle.

export function sqliteCliAvailable() {
  try {
    execFileSync('sqlite3', ['-version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

const PAGE_FILES = {
  'proj-a/_rules/sempre-testar.md': `---
kind: rule
title: Sempre testar
tier: procedural
tags:
- testes
- disciplina
pinned: true
type: Rule
generated:
  by: process:ai-memory/2.4.0
  at: 2026-01-02T10:00:00Z
---
# Sempre testar

Rodar os testes antes de commitar.
`,
  'proj-a/notes/deploy.md': `---
kind: note
title: Deploy do painel
tier: semantic
tags: [deploy, docker]
type: Note
---
# Deploy do painel

O painel roda em Docker com volume em ~/.ai-memory-data.
`,
  'proj-a/sessions/2026-01-02-sessao.md': `---
kind: note
title: Sessao de 02/01
tier: episodic
type: Note
---
# Sessao de 02/01

Transcricao crua da sessao.
`,
  'proj-a/index.md': `---
kind: note
title: proj-a
type: Note
---
# proj-a

Pagina inicial do escopo.
`,
  'proj-a/_lint/report.md': `---
kind: lint-report
title: Lint report
tier: semantic
type: LintReport
---
# Lint report

- nada a reportar
`,
  'proj-a/log-2026-01.md': `# Log de janeiro

Este arquivo fica no wiki mas NÃO é página (não está no SQLite).
`,
  'proj-a/_pending/auto-improve/proposta.md': `# Proposta pendente

Também não é página: só existe no disco.
`,
  'proj-a/notes/so-no-db.md': null, // existe no SQLite, não no wiki
  '_global/notes/estilo-zzportal.md': `---
kind: note
title: Estilo zzportal
tier: semantic
tags:
- ui
- zzportal
type: Note
---
# Estilo zzportal

Usar os tokens do zzportal.
`,
  '_global/gotchas/docker-mktemp.md': `---
kind: gotcha
title: Docker mktemp volume
tier: procedural
pinned: true
type: Gotcha
---
# Docker mktemp volume

Is a directory ao montar um arquivo de mktemp.
`,
};

const DB_PAGES = [
  { ws: 'default', project: 'proj-a', dir: 'proj-a', path: '_rules/sempre-testar.md', title: 'Sempre testar', tier: 'procedural', pinned: 1, fm: { tags: ['testes', 'disciplina'], tier: 'procedural', pinned: true, type: 'Rule' } },
  { ws: 'default', project: 'proj-a', dir: 'proj-a', path: 'notes/deploy.md', title: 'Deploy do painel', tier: 'semantic', pinned: 0, fm: { tags: ['deploy', 'docker'], tier: 'semantic', type: 'Note' } },
  { ws: 'default', project: 'proj-a', dir: 'proj-a', path: 'sessions/2026-01-02-sessao.md', title: 'Sessao de 02/01', tier: 'episodic', pinned: 0, fm: { tier: 'episodic', type: 'Note' } },
  { ws: 'default', project: 'proj-a', dir: 'proj-a', path: 'index.md', title: 'proj-a', tier: 'semantic', pinned: 0, fm: { tier: 'semantic', type: 'Note' } },
  { ws: 'default', project: 'proj-a', dir: 'proj-a', path: '_lint/report.md', title: 'Lint report', tier: 'semantic', pinned: 0, fm: { tier: 'semantic', type: 'LintReport' } },
  { ws: 'default', project: 'proj-a', dir: 'proj-a', path: 'notes/so-no-db.md', title: 'So no banco', tier: 'semantic', pinned: 0, fm: { tags: ['banco'], tier: 'semantic', type: 'Note' }, body: '# So no banco\n\nO arquivo sumiu do wiki; o corpo vem do SQLite.\n', fileMissing: true },
  { ws: 'default', project: '_global', dir: '_global', path: 'notes/estilo-zzportal.md', title: 'Estilo zzportal', tier: 'semantic', pinned: 0, fm: { tags: ['ui', 'zzportal'], tier: 'semantic', type: 'Note' } },
  { ws: 'default', project: '_global', dir: '_global', path: 'gotchas/docker-mktemp.md', title: 'Docker mktemp volume', tier: 'procedural', pinned: 1, fm: { tags: [], tier: 'procedural', pinned: true, type: 'Gotcha' } },
];

// versão antiga da página de deploy: nunca deve ser exportada
const SUPERSEDED = { ws: 'default', project: 'proj-a', path: 'notes/deploy.md', title: 'Deploy (versão antiga)', body: '# Deploy antigo\n' };

const q = (value) => `'${String(value).replace(/'/g, "''")}'`;

function writeDb(dbFile) {
  const rows = DB_PAGES.map((p) => {
    const body = p.fileMissing ? p.body : fs.readFileSync(path.join(path.dirname(dbFile), '..', 'wiki', 'ws1', p.dir, p.path), 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
    return `insert into pages (id, workspace_id, project_id, path, title, tier, pinned, frontmatter_json, is_latest, created_at, updated_at, body)
values (${q(`id-${p.path}`)}, 'ws1', ${q(`proj-${p.project}`)}, ${q(p.path)}, ${q(p.title)}, ${q(p.tier)}, ${p.pinned}, ${q(JSON.stringify(p.fm))}, 1, 1700000000000000, 1700000000000000, ${q(body)});`;
  });
  const sql = [
    'create table workspaces (id blob primary key not null, name text not null unique, created_at integer not null);',
    'create table projects (id blob primary key not null, workspace_id blob not null, name text not null, repo_path text, created_at integer not null, unique (workspace_id, name));',
    'create table pages (id blob primary key not null, workspace_id blob not null, project_id blob not null, path text not null, title text not null, tier text not null, body text not null, frontmatter_json text not null default \'{}\', is_latest integer not null default 1, pinned integer not null default 0, created_at integer not null, updated_at integer not null);',
    `insert into workspaces (id, name, created_at) values ('ws1', 'default', 1700000000000000);`,
    `insert into projects (id, workspace_id, name, repo_path, created_at) values ('proj-proj-a', 'ws1', 'proj-a', '/tmp/repos/proj-a', 1700000000000000);`,
    `insert into projects (id, workspace_id, name, repo_path, created_at) values ('proj-_global', 'ws1', '_global', null, 1700000000000000);`,
    ...rows,
    `insert into pages (id, workspace_id, project_id, path, title, tier, pinned, frontmatter_json, is_latest, created_at, updated_at, body)
values ('old-1', 'ws1', 'proj-proj-a', ${q(SUPERSEDED.path)}, ${q(SUPERSEDED.title)}, 'semantic', 0, '{}', 0, 1600000000000000, 1600000000000000, ${q(SUPERSEDED.body)});`,
  ].join('\n');
  execFileSync('sqlite3', [dbFile], { input: sql, timeout: 20_000 });
}

export function makeBundleFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-bundle-'));
  const storeDir = path.join(tmp, 'store');
  const wikiDir = path.join(storeDir, 'wiki');
  const wsDir = path.join(wikiDir, 'ws1');
  const write = (rel, content) => {
    const file = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };

  fs.mkdirSync(path.join(storeDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(wikiDir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(wikiDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const writeWiki = (rel, content) => {
    const file = path.join(wsDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  writeWiki('_meta.md', '---\nworkspace: default\ntype: Scope Manifest\n---\n');
  for (const dir of ['proj-a', '_global']) {
    writeWiki(path.join(dir, '_meta.md'), `---\nproject: ${dir}\ntype: Scope Manifest\n---\n`);
  }
  for (const [rel, content] of Object.entries(PAGE_FILES)) {
    if (content === null) continue;
    writeWiki(rel, content);
  }

  const dbFile = path.join(storeDir, 'db', 'memory.sqlite');
  const hasSqlite = sqliteCliAvailable();
  if (hasSqlite) writeDb(dbFile);

  // data-dir do cliente: token local (o painel não pode vazá-lo para servidor remoto)
  write('data/auth-token', 'token-local-do-painel\n');
  write('data/client-projects.json', `${JSON.stringify({
    version: 1,
    links: [{ server: 'http://127.0.0.1:49374', workspace: 'default', project: 'proj-a', path: path.join(tmp, 'repos', 'proj-a') }],
  }, null, 2)}\n`);

  return {
    tmp,
    storeDir,
    wikiDir,
    dbFile,
    hasSqlite,
    exportsDir: path.join(tmp, 'exports'),
    dataDir: path.join(tmp, 'data'),
    stateFile: path.join(tmp, 'import-state.json'),
    localToken: 'token-local-do-painel',
    pages: DB_PAGES,
    expected: {
      all: DB_PAGES.length,
      raw: DB_PAGES.filter((p) => p.path.startsWith('sessions/') || p.tier === 'episodic').length,
      curated: DB_PAGES.filter((p) => !p.path.startsWith('sessions/') && p.tier !== 'episodic').length,
      projAll: DB_PAGES.filter((p) => p.project === 'proj-a').length,
      projCurated: DB_PAGES.filter((p) => p.project === 'proj-a' && !p.path.startsWith('sessions/') && p.tier !== 'episodic').length,
      global: DB_PAGES.filter((p) => p.project === '_global').length,
      scopes: ['default/_global', 'default/proj-a'],
    },
  };
}

/** Bundle no layout do `ai-memory export-okf` (um escopo, tudo na raiz). */
export function makeOkfBundle(file, { project = 'okf-proj', workspace = 'default' } = {}) {
  const tar = createTarGz([
    { name: 'index.md', data: '---\nokf_version: "0.2"\n---\n\n# Bundle index\n\n- [notes/](notes/)\n' },
    { name: '_meta.md', data: `---\nworkspace: ${workspace}\nproject: ${project}\ntype: Scope Manifest\n---\n` },
    { name: 'notes/topico.md', data: '---\nkind: note\ntitle: Topico do OKF\ntype: Note\n---\n# Topico do OKF\n\nCorpo do tópico.\n' },
    { name: 'decisions/uma-decisao.md', data: '---\nkind: decision\ntitle: Uma decisao\ntype: Decision\n---\n# Uma decisao\n\nPorque sim.\n' },
    { name: 'notes/sem-frontmatter.md', data: '# Sem frontmatter\n\nSó título.\n' },
    { name: 'notes/sem-nada.md', data: 'texto solto sem título nenhum\n' },
  ]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, tar);
  return file;
}
