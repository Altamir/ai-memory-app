import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config, expandTilde } from './config.mjs';
import { sqliteAvailable, sqliteJsonQuery } from './import-sqlite.mjs';
import { createTarGz, readTarGz } from './tar.mjs';
import { firstHeading, normalizeBody } from './import-util.mjs';

// Bundles do ai-memory: um .tar.gz com as páginas de um ou mais escopos, feito
// para ser levado para outro servidor e importado pela aba Importar (fonte
// "Bundle do ai-memory"). O pacote é o próprio wiki — os .md ficam como estão
// no store, com frontmatter e tudo, dentro de `scopes/<workspace>/<projeto>/`:
//
//   manifest.json                          metadados estruturados de cada página
//   README.md                              o que é e como importar
//   scopes/<workspace>/<projeto>/_meta.md  manifesto do escopo (nome dos dois)
//   scopes/<workspace>/<projeto>/<path>.md as páginas
//
// A lista de páginas vem do SQLite do servidor (só `is_latest = 1`: o wiki em
// disco tem arquivos que não são páginas, como log-*.md e _pending/) e o
// conteúdo, do arquivo — a mesma garantia do `reindex` ("o DB é reconstruível
// a partir dos arquivos"). Bundle exportado pelo `ai-memory export-okf` também
// é aceito na importação (é um escopo só, com _meta.md na raiz).

export const BUNDLE_FORMAT = 'ai-memory-bundle';
export const BUNDLE_VERSION = 1;

const home = os.homedir();
const PAGE_SQL = `
select w.name as workspace, p.name as project, p.repo_path as repo_path,
       pg.path as path, pg.title as title, pg.tier as tier, pg.pinned as pinned,
       pg.frontmatter_json as frontmatter, pg.updated_at as updated_at,
       length(pg.body) as bytes
from pages pg
join workspaces w on w.id = pg.workspace_id
join projects p on p.id = pg.project_id
where pg.is_latest = 1
order by w.name, p.name, pg.path`;

export const isBundleName = (name) => /\.(tar\.gz|tgz)$/i.test(String(name ?? ''));

/** `sessions/…`, `log-2026-09.md`, tier episodic: histórico, não memória curada. */
export function isRawPage({ path: pagePath, tier } = {}) {
  const p = String(pagePath ?? '');
  if (tier === 'episodic') return true;
  if (/^(sessions|logs|observations|raw)\//.test(p)) return true;
  return /^log-\d{4}-\d{2}\.md$/.test(p);
}

const TIERS = new Set(['working', 'episodic', 'semantic', 'procedural']);
const KINDS = new Set(['fact', 'rule', 'decision', 'gotcha']);

/** kind do store (`note`, `concept`, `procedure`…) → kind que o write-page aceita. */
export function kindForWrite(kind, pagePath = '') {
  const k = String(kind || '').toLowerCase();
  if (KINDS.has(k)) return k;
  if (/^_rules\//.test(pagePath)) return 'rule';
  if (/^gotchas\//.test(pagePath)) return 'gotcha';
  if (/^decisions\//.test(pagePath)) return 'decision';
  return 'fact';
}

/** tier do store → tier que o write-page aceita (com queda pelo caminho). */
export function tierForWrite(tier, pagePath = '') {
  const t = String(tier || '').toLowerCase();
  if (TIERS.has(t)) return t;
  return isRawPage({ path: pagePath }) ? 'episodic' : 'semantic';
}

/**
 * Frontmatter das páginas do store: escalares, listas inline (`[a, b]`), listas
 * em bloco (`- a` na mesma coluna ou indentadas) e mapas aninhados (ignorados —
 * `generated:`/`sources:` não interessam ao importador).
 */
export function parsePageFrontmatter(text) {
  const src = String(text ?? '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { meta: {}, body: src };
  const meta = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const value = kv[2].trim();
    if (value === '') {
      const items = [];
      while (i + 1 < lines.length && (/^-\s+/.test(lines[i + 1].replace(/^\s+/, '')) || /^\s+\S/.test(lines[i + 1]))) {
        i += 1;
        const line = lines[i].trim();
        if (line.startsWith('- ')) items.push(line.slice(2).trim().replace(/^["']+|["']+$/g, ''));
      }
      if (items.length) meta[key] = items;
      continue;
    }
    if (/^\[.*\]$/.test(value)) {
      meta[key] = value.slice(1, -1).split(',').map((v) => v.trim().replace(/^["']+|["']+$/g, '')).filter(Boolean);
      continue;
    }
    meta[key] = value.replace(/^["']+|["']+$/g, '');
  }
  return { meta, body: src.slice(m[0].length) };
}

const sha256 = (text) => crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');

/** Último segmento do path (nome do arquivo) — título de última instância. */
const stemOf = (pagePath) => String(pagePath ?? '').split('/').pop() || String(pagePath ?? '');

function metaTags(meta) {
  const raw = meta.tags;
  if (Array.isArray(raw)) return raw.map((t) => String(t)).slice(0, 24);
  if (typeof raw === 'string' && raw) return [raw];
  return [];
}

const metaBool = (value) => value === true || String(value).toLowerCase() === 'true';

function frontmatterJson(raw) {
  try {
    const parsed = JSON.parse(String(raw || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Escapa um literal SQL (nomes de escopo/path nunca entram crus na query). */
const sqlLit = (value) => `'${String(value ?? '').replace(/'/g, "''")}'`;

// ---------- lado do store (exportação) ----------

export async function storeInfo() {
  const dir = config.storeDir;
  const wikiDir = path.join(dir, 'wiki');
  const dbFile = path.join(dir, 'db', 'memory.sqlite');
  const note = [];
  if (!fs.existsSync(wikiDir)) note.push(`wiki não encontrado em ${wikiDir}`);
  if (!fs.existsSync(dbFile)) note.push(`memory.sqlite não encontrado em ${dbFile}`);
  const sqlite = await sqliteAvailable();
  if (!sqlite) note.push('sqlite3 não encontrado: sem ele o painel não lista as páginas do store');
  return { dir, wikiDir, dbFile, available: note.length === 0, sqlite, note };
}

async function readManifest(dir, key) {
  try {
    const { meta } = parsePageFrontmatter(await fsp.readFile(path.join(dir, '_meta.md'), 'utf8'));
    const value = meta[key];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

/** Diretório de cada escopo (`<wiki>/<ws_uuid>/<projeto_uuid>`) pelos _meta.md. */
async function scopeDirs(wikiDir) {
  const map = new Map();
  let wsEntries = [];
  try {
    wsEntries = await fsp.readdir(wikiDir, { withFileTypes: true });
  } catch {
    return map;
  }
  for (const wsEntry of wsEntries) {
    if (!wsEntry.isDirectory() || wsEntry.name === '.git') continue;
    const wsDir = path.join(wikiDir, wsEntry.name);
    const workspace = (await readManifest(wsDir, 'workspace')) || wsEntry.name;
    let projEntries = [];
    try {
      projEntries = await fsp.readdir(wsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const projEntry of projEntries) {
      if (!projEntry.isDirectory()) continue;
      const projDir = path.join(wsDir, projEntry.name);
      const project = (await readManifest(projDir, 'project')) || projEntry.name;
      map.set(`${workspace}/${project}`, projDir);
    }
  }
  return map;
}

/** Páginas latest do store com contagens por escopo (para a tela de exportação). */
export async function listStoreScopes() {
  const info = await storeInfo();
  if (!info.sqlite) return { ...info, scopes: [], totals: { pages: 0, raw: 0, scopes: 0 } };
  let rows;
  try {
    rows = await sqliteJsonQuery(info.dbFile, PAGE_SQL);
  } catch (err) {
    return { ...info, scopes: [], totals: { pages: 0, raw: 0, scopes: 0 }, error: `memory.sqlite: ${err.message}` };
  }

  const byScope = new Map();
  for (const row of rows) {
    const key = `${row.workspace}/${row.project}`;
    if (!byScope.has(key)) {
      byScope.set(key, {
        workspace: row.workspace,
        project: row.project,
        global: row.project === '_global',
        repoPath: row.repo_path || null,
        pages: 0,
        raw: 0,
        bytes: 0,
        pinned: 0,
        tiers: { working: 0, episodic: 0, semantic: 0, procedural: 0 },
      });
    }
    const scope = byScope.get(key);
    const raw = isRawPage({ path: row.path, tier: row.tier });
    scope.pages += 1;
    scope.bytes += Number(row.bytes) || 0;
    if (raw) scope.raw += 1;
    if (row.pinned) scope.pinned += 1;
    if (scope.tiers[row.tier] !== undefined) scope.tiers[row.tier] += 1;
  }

  const scopes = [...byScope.values()].sort((a, b) => (a.global === b.global ? (b.pages - a.pages || a.project.localeCompare(b.project)) : a.global ? -1 : 1));
  return {
    ...info,
    scopes,
    totals: {
      pages: scopes.reduce((n, s) => n + s.pages, 0),
      raw: scopes.reduce((n, s) => n + s.raw, 0),
      bytes: scopes.reduce((n, s) => n + s.bytes, 0),
      scopes: scopes.length,
    },
  };
}

function normalizeScopeSelection(selection) {
  if (!Array.isArray(selection) || !selection.length) return null;
  const out = new Map();
  for (const item of selection) {
    if (typeof item === 'string' && item.includes('/')) {
      const [workspace, project] = item.split('/');
      if (workspace && project) out.set(`${workspace}/${project}`, { workspace, project, global: project === '_global' });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const workspace = String(item.workspace ?? '').trim().slice(0, 200);
    const project = String(item.project ?? '').trim().slice(0, 200);
    if (!workspace || !project) continue;
    out.set(`${workspace}/${project}`, { workspace, project, global: project === '_global' });
  }
  return out.size ? [...out.values()] : null;
}

/** Corpos direto do SQLite quando o arquivo do wiki sumiu (o DB é o índice). */
async function dbBodies(dbFile, scope, paths) {
  if (!paths.length) return new Map();
  const sql = `select pg.path as path, pg.body as body, pg.frontmatter_json as frontmatter
from pages pg
join workspaces w on w.id = pg.workspace_id
join projects p on p.id = pg.project_id
where pg.is_latest = 1 and w.name = ${sqlLit(scope.workspace)} and p.name = ${sqlLit(scope.project)}
  and pg.path in (${paths.map(sqlLit).join(',')})`;
  const rows = await sqliteJsonQuery(dbFile, sql);
  return new Map(rows.map((r) => [r.path, r]));
}

/**
 * Reúne as páginas dos escopos pedidos (todos, se `scopes` vazio): metadados do
 * SQLite, conteúdo do arquivo do wiki e `_meta.md` do escopo quando o store
 * tiver sido purgado. `includeRaw` decide se histórico (sessões/logs) entra.
 * `metadataOnly` pula a leitura dos arquivos (plano/dry-run, sem tocar no wiki).
 */
export async function collectPages({ scopes: selection, includeRaw = false, metadataOnly = false, log = () => {} } = {}) {
  const info = await storeInfo();
  if (!info.sqlite) throw new Error('exportar exige o sqlite3 no PATH (é ele que lista as páginas do store)');
  if (!fs.existsSync(info.dbFile)) throw new Error(`store do ai-memory não encontrado em ${info.dir} (memória: defina AIM_STORE_DIR)`);

  const rows = await sqliteJsonQuery(info.dbFile, PAGE_SQL);
  const wanted = normalizeScopeSelection(selection);
  const dirs = metadataOnly ? new Map() : await scopeDirs(info.wikiDir);
  const warnings = [];

  const summaries = new Map();
  const pages = [];
  const skippedRaw = [];

  for (const row of rows) {
    const key = `${row.workspace}/${row.project}`;
    if (wanted && !wanted.some((s) => `${s.workspace}/${s.project}` === key)) continue;
    const raw = isRawPage({ path: row.path, tier: row.tier });
    if (!summaries.has(key)) {
      summaries.set(key, {
        key,
        workspace: row.workspace,
        project: row.project,
        global: row.project === '_global',
        repoPath: row.repo_path || null,
        pages: 0,
        raw: 0,
        rawSkipped: 0,
        bytes: 0,
        missing: 0,
      });
    }
    const summary = summaries.get(key);
    if (raw && !includeRaw) {
      summary.rawSkipped += 1;
      skippedRaw.push({ key, path: row.path });
      continue;
    }

    const scope = { workspace: row.workspace, project: row.project, global: row.project === '_global' };
    const file = dirs.get(key) ? path.join(dirs.get(key), row.path) : null;
    let text = null;
    let fromDb = false;
    if (!metadataOnly && file) {
      try {
        text = await fsp.readFile(file, 'utf8');
      } catch {
        text = null;
      }
    }
    if (metadataOnly) {
      const fm = frontmatterJson(row.frontmatter);
      const page = {
        scope,
        scopeKey: key,
        path: row.path,
        title: row.title || stemOf(row.path),
        kind: String(fm.kind || fm.type || '').toLowerCase() || null,
        type: String(fm.type || '').toLowerCase() || null,
        tier: TIERS.has(String(row.tier)) ? row.tier : tierForWrite(row.tier, row.path),
        tags: metaTags(fm),
        pinned: Boolean(row.pinned) || metaBool(fm.pinned),
        body: '',
        text: '',
        bytes: Number(row.bytes) || 0,
        sha256: null,
        updatedAt: Number(row.updated_at) || null,
        raw,
        fromDb: true,
      };
      pages.push(page);
      summary.pages += 1;
      summary.bytes += page.bytes;
      if (raw) summary.raw += 1;
      continue;
    }
    if (text === null) {
      const fetched = await dbBodies(info.dbFile, scope, [row.path]);
      const found = fetched.get(row.path);
      if (!found) {
        summary.missing += 1;
        warnings.push(`sem conteúdo para ${key}/${row.path} (arquivo e DB)`);
        continue;
      }
      fromDb = true;
      text = renderPageFile({ frontmatter: found.frontmatter, body: found.body, title: row.title, tier: row.tier, pinned: row.pinned });
      warnings.push(`conteúdo de ${key}/${row.path} veio do SQLite (arquivo ausente no wiki)`);
    }

    const { meta, body } = parsePageFrontmatter(text);
    const pageTier = TIERS.has(String(row.tier)) ? row.tier : (meta.tier || tierForWrite(meta.tier, row.path));
    const page = {
      scope,
      scopeKey: key,
      path: row.path,
      title: row.title || meta.title || firstHeading(body) || stemOf(row.path),
      kind: String(meta.kind || '').toLowerCase() || null,
      type: String(meta.type || '').toLowerCase() || null,
      tier: pageTier,
      tags: metaTags(meta).length ? metaTags(meta) : metaTags(frontmatterJson(row.frontmatter)),
      pinned: row.pinned ? true : metaBool(meta.pinned),
      body,
      text,
      bytes: Buffer.byteLength(text, 'utf8'),
      sha256: sha256(normalizeBody(body)),
      updatedAt: Number(row.updated_at) || null,
      raw,
      fromDb,
    };
    pages.push(page);
    summary.pages += 1;
    summary.bytes += page.bytes;
    if (raw) summary.raw += 1;
    if (page.fromDb) summary.missing += 0;
  }

  const scopeList = [...summaries.values()].sort((a, b) => a.key.localeCompare(b.key));
  const unknown = (wanted || []).filter((s) => !summaries.has(`${s.workspace}/${s.project}`));
  for (const s of unknown) warnings.push(`escopo ${s.workspace}/${s.project} não existe no store`);
  for (const s of scopeList) log('out', `escopo ${s.key}: ${s.pages} página(s)${s.rawSkipped ? `, ${s.rawSkipped} crua(s) fora` : ''}\n`);

  return { info, pages, summaries: scopeList, warnings, skippedRaw, unknown };
}

/** Remonta um arquivo de página (frontmatter + corpo) para o fallback do SQLite. */
function renderPageFile({ frontmatter, body, title, tier, pinned }) {
  const fm = frontmatterJson(frontmatter);
  const clean = (v) => String(v).replace(/\r?\n/g, ' ').trim();
  const lines = ['---'];
  for (const [key, value] of Object.entries(fm)) {
    if (value && typeof value === 'object') continue;
    lines.push(`${key}: ${clean(value)}`);
  }
  if (Array.isArray(fm.tags) && fm.tags.length) lines.push(`tags: [${fm.tags.map(clean).join(', ')}]`);
  if (!fm.title && title) lines.push(`title: ${clean(title)}`);
  if (!fm.tier && tier) lines.push(`tier: ${clean(tier)}`);
  if (pinned && fm.pinned === undefined) lines.push('pinned: true');
  lines.push('---', '');
  return `${lines.join('\n')}${String(body ?? '')}`;
}

/**
 * Plano (dry-run) do bundle: o que entraria, sem ler os arquivos nem gravar
 * nada. É o que o botão "simular" da tela mostra.
 */
export async function planBundle({ scopes, includeRaw = false, name } = {}) {
  const collected = await collectPages({ scopes, includeRaw, metadataOnly: true });
  if (!collected.pages.length) {
    throw new Error(`nenhuma página para exportar${collected.warnings.length ? ` — ${collected.warnings.join('; ')}` : ''}`);
  }
  const preview = collected.pages
    .slice()
    .sort((a, b) => (a.scopeKey === b.scopeKey ? a.path.localeCompare(b.path) : a.scopeKey.localeCompare(b.scopeKey)))
    .slice(0, 40)
    .map((p) => ({ scope: p.scopeKey, path: p.path, title: p.title, kind: p.kind, tier: p.tier, pinned: Boolean(p.pinned), bytes: p.bytes, raw: p.raw }));
  return {
    file: `${sanitizeBundleName(name) || defaultBundleName()}.tar.gz`,
    exportsDir: config.exportsDir,
    includeRaw: Boolean(includeRaw),
    scopes: collected.summaries,
    pages: collected.pages.length,
    bytes: collected.pages.reduce((n, p) => n + p.bytes, 0),
    rawSkipped: collected.skippedRaw.length,
    warnings: collected.warnings,
    preview,
  };
}

export function bundleReadme({ scopes, pages, exportedAt, origin }) {
  return `# Bundle do ai-memory

Exportado em ${exportedAt}${origin ? ` de ${origin}` : ''}: ${pages} página(s) em ${scopes.length} escopo(s).

| Escopo | Páginas |
| --- | --- |
${scopes.map((s) => `| \`${s.key}\` | ${s.pages} |`).join('\n')}

## Estrutura

\`\`\`
manifest.json   metadados de cada página (escopo, path, kind, tier, tags, pinned, sha256)
scopes/<workspace>/<projeto>/_meta.md   manifesto do escopo
scopes/<workspace>/<projeto>/<path>.md  as páginas, como estão no wiki de origem
\`\`\`

## Como importar

1. **Pelo painel** (recomendado): abra a aba **Importar**, na fonte *Bundle do ai-memory*
   escolha este arquivo e clique em *Escanear*. A revisão é item a item, com o markdown
   renderizado, e o destino de cada página é o mesmo escopo de origem — aponte para
   outro projeto quando quiser. O campo *servidor de destino* permite gravar em outro
   ai-memory (URL + token) sem trocar a configuração do painel.
2. **Na mão**: extraia o conteúdo em \`<store>/wiki/\` do servidor de destino
   (\`scopes/<workspace>/<projeto>/\` → \`wiki/<workspace>/<projeto>/\`, ajustando os
   diretórios de id) e rode \`ai-memory reindex\` com o servidor parado.

Reimportar o mesmo bundle não duplica páginas: o ai-memory versiona por path.
`;
}

async function freeName(dir, base, ext) {
  for (let i = 0; i < 50; i += 1) {
    const name = i === 0 ? `${base}${ext}` : `${base}-${i}${ext}`;
    if (!fs.existsSync(path.join(dir, name))) return name;
  }
  throw new Error('não consegui um nome livre na pasta de exports');
}

/** Monta o bundle no disco: manifesto + README + um diretório por escopo. */
export async function buildBundle({ scopes, includeRaw = false, name, log = () => {} } = {}) {
  const collected = await collectPages({ scopes, includeRaw, log });
  const { pages, summaries, warnings } = collected;
  if (!pages.length) throw new Error('nenhuma página selecionada para exportar');
  if (warnings.length) for (const w of warnings.slice(0, 20)) log('sys', `aviso: ${w}\n`);

  const exportedAt = new Date().toISOString();
  const entries = [];
  const manifestPages = [];
  for (const page of pages) {
    entries.push({ name: `scopes/${page.scopeKey}/${page.path}`, data: page.text });
    manifestPages.push({
      scope: page.scopeKey,
      path: page.path,
      title: page.title,
      kind: page.kind,
      type: page.type,
      tier: page.tier,
      tags: page.tags,
      pinned: Boolean(page.pinned),
      bytes: page.bytes,
      sha256: page.sha256,
      updatedAt: page.updatedAt ? new Date(Math.round(page.updatedAt / 1000)).toISOString() : null,
      raw: page.raw,
    });
  }
  for (const summary of summaries) {
    entries.push({
      name: `scopes/${summary.key}/_meta.md`,
      data: `---\nworkspace: ${summary.workspace}\nproject: ${summary.project}\ntype: Scope Manifest\nrepo_path: ${summary.repoPath || ''}\n---\n`,
    });
  }

  const manifest = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt,
    generator: { app: 'ai-memory-app', version: '0.1.0' },
    origin: {
      storeDir: collected.info.dir,
      serverUrl: config.serverUrl,
      dataDir: config.dataDir,
    },
    includeRaw: Boolean(includeRaw),
    totals: { pages: pages.length, bytes: pages.reduce((n, p) => n + p.bytes, 0), scopes: summaries.length },
    scopes: summaries.map((s) => ({ workspace: s.workspace, project: s.project, global: s.global, path: s.repoPath, pages: s.pages })),
    pages: manifestPages,
  };

  const readme = bundleReadme({ scopes: summaries, pages: pages.length, exportedAt, origin: collected.info.dir });
  // manifesto/README primeiro: abrir o tar mostra a explicação antes das páginas
  entries.unshift({ name: 'README.md', data: readme }, { name: 'manifest.json', data: `${JSON.stringify(manifest, null, 2)}\n` });

  const tar = createTarGz(entries);
  await fsp.mkdir(config.exportsDir, { recursive: true, mode: 0o700 });
  const base = sanitizeBundleName(name) || defaultBundleName();
  const fileName = await freeName(config.exportsDir, base, '.tar.gz');
  const file = path.join(config.exportsDir, fileName);
  await fsp.writeFile(file, tar, { mode: 0o600 });
  log('out', `bundle gravado: ${file} (${tar.length} bytes)\n`);

  // verificação: relê o arquivo e confere contagem + sha256 de cada página
  const check = await readBundleFile(file);
  const byKey = new Map(check.pages.map((p) => [`${p.scopeKey}|${p.path}`, p]));
  const bad = [];
  for (const page of pages) {
    const back = byKey.get(`${page.scopeKey}|${page.path}`);
    if (!back) bad.push(`${page.scopeKey}/${page.path} (ausente)`);
    else if (back.sha256 && back.sha256 !== page.sha256) bad.push(`${page.scopeKey}/${page.path} (sha256 difere)`);
  }
  if (check.pages.length !== pages.length) bad.push(`contagem: ${check.pages.length} no bundle, ${pages.length} no store`);
  for (const item of bad.slice(0, 10)) log('err', `verificação falhou: ${item}\n`);
  log('sys', bad.length ? `bundle com ${bad.length} problema(s) de verificação\n` : `verificação ok: ${pages.length} página(s) relidas do bundle\n`);

  return { file, fileName, bytes: tar.length, pages: pages.length, scopes: summaries, warnings, manifestOk: bad.length === 0, skippedRaw: collected.skippedRaw.length };
}

/** Nome padrão do bundle: ai-memory-bundle-<data>-<hora>.tar.gz. */
function defaultBundleName() {
  return `ai-memory-bundle-${new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '')}`;
}

function sanitizeBundleName(name) {
  const clean = String(name ?? '')
    .trim()
    .replace(/\.(tar\.gz|tgz)$/i, '')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return clean || null;
}

/** Lê só o manifesto (a listagem da pasta de exports não precisa das páginas). */
export async function readBundleManifest(fileOrBuffer) {
  const raw = Buffer.isBuffer(fileOrBuffer) ? fileOrBuffer : await fsp.readFile(fileOrBuffer);
  const { entries } = readTarGz(raw, { only: new Set(['manifest.json']) });
  const found = entries.find((e) => e.name === 'manifest.json');
  if (!found) return null;
  try {
    return JSON.parse(found.data.toString('utf8'));
  } catch {
    return null;
  }
}

/** Um bundle do disco: tamanho, data e o resumo do manifesto (best-effort). */
async function peekBundle(file, stat) {
  const out = { file: path.basename(file), path: file, bytes: stat.size, mtime: stat.mtimeMs, format: null, scopes: [], pages: null, exportedAt: null, origin: null, error: null };
  if (stat.size > 128 * 1024 * 1024) {
    out.error = 'bundle grande demais para inspecionar na listagem';
    return out;
  }
  try {
    const manifest = await readBundleManifest(file);
    if (manifest) {
      out.format = manifest.format || null;
      out.scopes = Array.isArray(manifest.scopes) ? manifest.scopes.map((s) => `${s.workspace}/${s.project}`) : [];
      out.pages = Number(manifest.totals?.pages) || (Array.isArray(manifest.pages) ? manifest.pages.length : null);
      out.exportedAt = manifest.exportedAt || null;
      out.origin = manifest.origin?.storeDir || null;
    }
  } catch (err) {
    out.error = err.message;
  }
  return out;
}

export async function listBundles() {
  const dir = config.exportsDir;
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return { dir, bundles: [] };
  }
  const bundles = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isBundleName(entry.name)) continue;
    const file = path.join(dir, entry.name);
    try {
      bundles.push(await peekBundle(file, await fsp.stat(file)));
    } catch (err) {
      bundles.push({ file: entry.name, path: file, bytes: 0, mtime: null, error: err.message, scopes: [], pages: null });
    }
  }
  bundles.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  return { dir, bundles };
}

/**
 * Resolve o bundle pedido pela tela: nome solto → pasta de exports; caminho →
 * precisa estar sob o home (mesma regra da navegação de pastas) ou na pasta de
 * exports. Nada fora desses dois lugares é lido.
 */
export async function resolveBundlePath(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('informe o arquivo do bundle');
  const hasSep = raw.includes('/') || raw.includes('\\');
  if (!isBundleName(raw)) throw new Error('bundle precisa ser um .tar.gz (ou .tgz)');
  if (!hasSep && !raw.startsWith('.')) {
    const file = path.join(config.exportsDir, raw);
    if (!fs.existsSync(file)) throw new Error(`bundle não encontrado em ${config.exportsDir}: ${raw}`);
    return file;
  }
  const resolved = path.resolve(expandTilde(raw));
  let real;
  try {
    real = await fsp.realpath(resolved);
  } catch {
    throw new Error(`arquivo não encontrado: ${resolved}`);
  }
  const exportsReal = fs.existsSync(config.exportsDir) ? await fsp.realpath(config.exportsDir) : path.resolve(config.exportsDir);
  const inside = (base) => real === base || real.startsWith(base + path.sep);
  if (!inside(exportsReal) && !inside(home)) {
    throw new Error('bundle restrito ao home ou à pasta de exports do painel');
  }
  const stat = await fsp.stat(real);
  if (!stat.isFile()) throw new Error('não é um arquivo');
  return real;
}

export async function deleteBundle(input, { confirm } = {}) {
  const file = await resolveBundlePath(input);
  const base = path.basename(file);
  if (String(confirm ?? '').trim() !== base) {
    const err = new Error(`para excluir, digite o nome do arquivo (${base})`);
    err.code = 'NEEDS_CONFIRM';
    err.file = base;
    throw err;
  }
  const real = await fsp.realpath(file);
  const exportsReal = await fsp.realpath(config.exportsDir).catch(() => path.resolve(config.exportsDir));
  if (real !== exportsReal && !real.startsWith(exportsReal + path.sep)) {
    throw new Error('só bundles da pasta de exports podem ser excluídos pelo painel');
  }
  await fsp.rm(real, { force: true });
  return { file: base, deleted: true };
}

// ---------- lado do bundle (importação) ----------

/**
 * Lê o bundle: aceita o layout do painel (`scopes/<ws>/<proj>/…` + manifest.json)
 * e o do `ai-memory export-okf` (_meta.md e páginas na raiz).
 */
export async function readBundleFile(fileOrBuffer) {
  const raw = Buffer.isBuffer(fileOrBuffer) ? fileOrBuffer : await fsp.readFile(fileOrBuffer);
  const { entries, skipped } = readTarGz(raw);
  const warnings = [];
  if (skipped.length) warnings.push(`${skipped.length} entrada(s) ignorada(s) no bundle (${skipped.slice(0, 3).join(', ')}…)`);

  let manifest = null;
  const files = [];
  for (const entry of entries) {
    if (entry.name === 'manifest.json') {
      try {
        manifest = JSON.parse(entry.data.toString('utf8'));
      } catch (err) {
        warnings.push(`manifest.json inválido: ${err.message}`);
      }
      continue;
    }
    files.push(entry);
  }

  // escopos declarados: manifesto, _meta.md por diretório e _meta.md da raiz
  const scopes = new Map(); // dir do bundle → { workspace, project, global }
  for (const file of files) {
    const m = /^scopes\/([^/]+)\/([^/]+)\/_meta\.md$/.exec(file.name);
    if (!m) continue;
    const { meta } = parsePageFrontmatter(file.data.toString('utf8'));
    const workspace = String(meta.workspace || m[1]);
    const project = String(meta.project || m[2]);
    scopes.set(`scopes/${m[1]}/${m[2]}`, { workspace, project, global: project === '_global' });
  }
  if (!scopes.size) {
    const rootMeta = files.find((f) => f.name === '_meta.md');
    if (rootMeta) {
      const { meta } = parsePageFrontmatter(rootMeta.data.toString('utf8'));
      const workspace = String(meta.workspace || 'default');
      const project = String(meta.project || meta.workspace || 'default');
      scopes.set('', { workspace, project, global: project === '_global' });
    } else if (manifest) {
      for (const s of manifest.scopes || []) {
        if (s?.workspace && s?.project) scopes.set(`scopes/${s.workspace}/${s.project}`, { workspace: s.workspace, project: s.project, global: s.project === '_global' });
      }
    }
  }
  if (!scopes.size) {
    scopes.set('', { workspace: 'default', project: String(manifest?.origin?.project || 'imported-bundle'), global: false });
    warnings.push('bundle sem _meta.md nem manifesto: páginas vão para default/imported-bundle');
  }

  const manifestPages = new Map();
  for (const p of manifest?.pages || []) {
    if (p?.path) manifestPages.set(`${p.scope || ''}|${p.path}`, p);
  }

  const pages = [];
  for (const file of files) {
    if (file.name.endsWith('/_meta.md') || file.name === '_meta.md' || file.name === 'README.md') continue;
    let dir = '';
    let pagePath = file.name;
    const scoped = /^scopes\/([^/]+)\/([^/]+)\/(.+)$/.exec(file.name);
    if (scoped) {
      dir = `scopes/${scoped[1]}/${scoped[2]}`;
      pagePath = scoped[3];
    }
    const scope = scopes.get(dir) || scopes.get('') || [...scopes.values()][0];
    if (!scope) continue;
    const text = file.data.toString('utf8');
    const { meta, body } = parsePageFrontmatter(text);
    // OKF exporta um index.md gerado no bundle: não é página do store
    if (dir === '' && /^index\.md$/.test(pagePath) && String(meta.okf_version || '')) continue;
    // markdown solto sem frontmatter e sem título não é página (ex.: sobras de um bundle estranho)
    if (!meta.kind && !meta.title && !firstHeading(body)) continue;

    const scopeKey = `${scope.workspace}/${scope.project}`;
    const info = manifestPages.get(`${scopeKey}|${pagePath}`) || manifestPages.get(`|${pagePath}`) || null;
    const page = {
      scope,
      scopeKey,
      path: pagePath,
      title: info?.title || meta.title || firstHeading(body) || pagePath.split('/').pop(),
      kind: String(info?.kind || meta.kind || '').toLowerCase() || null,
      tier: String(info?.tier || meta.tier || '').toLowerCase() || null,
      tags: Array.isArray(info?.tags) ? info.tags : metaTags(meta),
      pinned: info ? Boolean(info.pinned) : metaBool(meta.pinned),
      body,
      text,
      bytes: file.data.length,
      sha256: sha256(normalizeBody(body)),
      updatedAt: info?.updatedAt || null,
      raw: isRawPage({ path: pagePath, tier: info?.tier || meta.tier }),
    };
    if (info?.sha256 && info.sha256 !== page.sha256) warnings.push(`${scopeKey}/${pagePath}: sha256 do manifesto difere do arquivo`);
    pages.push(page);
  }

  return { manifest, scopes: [...new Set(pages.map((p) => p.scopeKey))].sort(), pages, warnings, skipped };
}

/** Itens do bundle no formato que o importador entende (ver import-grok.mjs). */
export async function scanBundleCandidates(file, { includeRaw = true } = {}) {
  const bundle = await readBundleFile(file);
  const items = [];
  for (const page of bundle.pages) {
    const raw = page.raw;
    if (raw && !includeRaw) continue;
    items.push({
      key: `bundle|${page.scopeKey}|${page.path}`,
      title: page.title,
      body: page.body,
      originPath: page.path,
      originKind: 'bundle',
      raw,
      suggested: {
        path: page.path,
        kind: kindForWrite(page.kind, page.path),
        tier: page.tier || tierForWrite(page.tier, page.path),
        pinned: Boolean(page.pinned),
        tags: page.tags,
      },
      // o destino padrão é o mesmo escopo de origem (o importador explica o motivo)
      targetHint: page.scope.global
        ? { kind: 'global' }
        : { kind: 'bundle', target: { workspace: page.scope.workspace, project: page.scope.project } },
      bytes: page.bytes,
      updatedAt: page.updatedAt,
    });
  }
  return { items, warnings: bundle.warnings, manifest: bundle.manifest, scopes: bundle.scopes, file };
}

/** Item completo (com corpo) para o viewer da tela de importação. */
export async function getBundleCandidate(file, key, opts = {}) {
  const { items } = await scanBundleCandidates(file, opts);
  const found = items.find((i) => i.key === key);
  if (!found) throw new Error('página não encontrada no bundle');
  return { ...found, fingerprint: sha256(normalizeBody(found.body)) };
}
