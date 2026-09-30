import fs from 'node:fs/promises';
import path from 'node:path';
import { classify, firstHeading, matchSlugToLinks, parseFrontmatter, splitH2, slugify } from './import-util.mjs';
import { sqliteJsonQuery } from './import-sqlite.mjs';

// Leitura das memórias do Grok CLI — dois formatos convivendo no disco:
//   v1  ~/.grok/memory/        MEMORY.md global + MEMORY.md/sessions por projeto
//   v2  ~/.grok/memory-v2/     global/ e workspaces/<slug>/ com topics/*.md e
//                              observations/_inbox/*.md
// Nada é escrito aqui: cada item vira um candidato que a tela mostra e o
// usuário decide (ver applyImport em import.mjs).

const SOURCE_V1 = 'grok-v1';
const SOURCE_V2 = 'grok-v2';

async function listDirEntries(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function readText(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/** Header do MEMORY.md de projeto → caminho do projeto (com markdown removido). */
export function parseProjectMemoryHeader(body) {
  const m = /^#\s*Project Memory\s*[—–-]\s*(.+?)\s*$/m.exec(body || '');
  if (!m) return { projectPath: null, rest: body || '' };
  const projectPath = m[1].replace(/\*\*/g, '').replace(/[`'"]/g, '').trim();
  const rest = String(body).replace(m[0], '').replace(/^>\s*Auto-populated[^\n]*\n?/m, '').trim();
  return { projectPath: projectPath || null, rest };
}

function candidate({ key, title, body, originPath, originKind, sourceSlug, raw = false, tagsExtra = [], targetHint }) {
  const suggested = classify({ title, body, sourceSlug });
  // cru é transcript/histórico: entra no tier episodic (e sofre o decay normal)
  if (raw) suggested.tier = 'episodic';
  return {
    key,
    title,
    body,
    originPath,
    originKind,
    raw,
    suggested: { ...suggested, tags: ['grok', sourceSlug, ...tagsExtra] },
    targetHint,
  };
}

/** Seções `##` de um MEMORY.md v1 → um candidato por seção. */
function sectionCandidates({ body, titlePrefix, keyPrefix, originPath, originKind, sourceSlug, targetHint, tagsExtra }) {
  const sections = splitH2(body);
  const usable = sections.filter((s) => s.body || s.title);
  if (!usable.length) {
    const plain = String(body || '').trim();
    if (!plain) return [];
    const title = firstHeading(plain) || titlePrefix;
    return [candidate({
      key: `${keyPrefix}#pagina`,
      title,
      body: plain.startsWith('#') ? plain : `# ${title}\n\n${plain}`,
      originPath,
      originKind,
      sourceSlug,
      tagsExtra,
      targetHint,
    })];
  }
  return usable.map((s) => candidate({
    key: `${keyPrefix}#${slugify(s.title, { max: 80 })}`,
    title: s.title,
    body: `# ${s.title}\n\n${s.body}`.trim(),
    originPath,
    originKind,
    sourceSlug,
    tagsExtra,
    targetHint,
  }));
}

/** Grok v1: MEMORY.md global (raiz) + um por projeto + sessions opcionais. */
export async function scanGrokV1({ grokDir }, { includeRaw = true } = {}) {
  const root = path.join(grokDir, 'memory');
  const warnings = [];
  const items = [];

  const globalBody = await readText(path.join(root, 'MEMORY.md'));
  if (globalBody !== null) {
    items.push(...sectionCandidates({
      body: globalBody,
      titlePrefix: 'Memória global (Grok v1)',
      keyPrefix: `${SOURCE_V1}:global`,
      originPath: path.join(root, 'MEMORY.md'),
      originKind: 'memory-global',
      sourceSlug: SOURCE_V1,
      targetHint: { kind: 'global' },
      tagsExtra: ['global'],
    }));
  }

  const entries = await listDirEntries(root);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectDir = path.join(root, entry.name);
    const body = await readText(path.join(projectDir, 'MEMORY.md'));
    if (body === null) continue;
    const { projectPath, rest } = parseProjectMemoryHeader(body);
    // sem cabeçalho, o nome da pasta ainda costuma identificar o projeto (`ai-session-dev-9757d928`)
    const targetHint = projectPath ? { kind: 'path', path: projectPath } : { kind: 'slug', slug: slugBase(entry.name) };
    if (!projectPath) warnings.push(`${path.relative(root, projectDir)}/MEMORY.md sem cabeçalho "# Project Memory — <path>"`);
    items.push(...sectionCandidates({
      body: rest,
      titlePrefix: entry.name,
      keyPrefix: `${SOURCE_V1}:${entry.name}`,
      originPath: path.join(projectDir, 'MEMORY.md'),
      originKind: 'project-memory',
      sourceSlug: SOURCE_V1,
      targetHint,
      tagsExtra: [slugify(entry.name, { max: 40 })],
    }));

    if (!includeRaw) continue;
    for (const file of await listDirEntries(path.join(projectDir, 'sessions'))) {
      if (!file.isFile() || !file.name.endsWith('.md')) continue;
      const sessionBody = await readText(path.join(projectDir, 'sessions', file.name));
      if (!sessionBody?.trim()) continue;
      const title = firstHeading(sessionBody) || `Sessão ${file.name.replace(/\.md$/, '')}`;
      items.push(candidate({
        key: `${SOURCE_V1}:${entry.name}:sessions/${file.name}`,
        title,
        body: sessionBody,
        originPath: path.join(projectDir, 'sessions', file.name),
        originKind: 'session',
        sourceSlug: SOURCE_V1,
        raw: true,
        tagsExtra: ['sessao'],
        targetHint,
      }));
    }
  }

  return { items, warnings };
}

/** `exemplo-workspace-0c7c6037` → `exemplo-workspace` (o hash de 8 hex é o sufixo). */
export function slugBase(slug) {
  return String(slug || '').replace(/-[0-9a-f]{8}$/i, '');
}

/**
 * Acha o projeto de um workspace v2: primeiro pelos caminhos de arquivo
 * indexados no index.sqlite, depois pelo nome do slug contra os links.
 */
export async function resolveWorkspaceTarget({ slug, scopeDir, links = [], sqliteQuery = sqliteJsonQuery }) {
  const indexSqlite = path.join(scopeDir, 'index.sqlite');
  try {
    const rows = await sqliteQuery(indexSqlite, 'SELECT DISTINCT path FROM chunks LIMIT 400');
    const votes = new Map();
    for (const row of rows) {
      const p = typeof row?.path === 'string' ? row.path : null;
      if (!p || !p.startsWith('/')) continue;
      for (const link of links) {
        if (!link?.path) continue;
        const base = String(link.path).replace(/\/+$/, '');
        if (p === base || p.startsWith(`${base}/`)) votes.set(base, (votes.get(base) || 0) + 1);
      }
    }
    if (votes.size) {
      const [base] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
      const link = links.find((l) => String(l.path).replace(/\/+$/, '') === base);
      if (link) return { workspace: link.workspace, project: link.project, reason: `caminhos indexados em ${base}` };
    }
  } catch {
    // sqlite indisponível/lockado: cai para o casamento por nome
  }

  const base = slugBase(slug).toLowerCase();
  const bySlug = base ? matchSlugToLinks(base, links) : null;
  if (bySlug) return bySlug;
  return null;
}

/** Grok v2: topics do global e de cada workspace + observations cruas. */
export async function scanGrokV2({ grokDir }, { links = [], includeRaw = true, sqliteQuery = sqliteJsonQuery } = {}) {
  const root = path.join(grokDir, 'memory-v2');
  const warnings = [];
  const items = [];

  const addTopics = async ({ scopeDir, scopeLabel, targetHint, tagsExtra }) => {
    for (const file of await listDirEntries(path.join(scopeDir, 'topics'))) {
      if (!file.isFile() || !file.name.endsWith('.md')) continue;
      const body = await readText(path.join(scopeDir, 'topics', file.name));
      if (!body?.trim()) continue;
      const title = firstHeading(body) || file.name.replace(/\.md$/, '');
      items.push(candidate({
        key: `${SOURCE_V2}:${scopeLabel}:topics/${file.name}`,
        title,
        body,
        originPath: path.join(scopeDir, 'topics', file.name),
        originKind: 'topic',
        sourceSlug: SOURCE_V2,
        tagsExtra,
        targetHint,
      }));
    }
  };

  await addTopics({
    scopeDir: path.join(root, 'global'),
    scopeLabel: 'global',
    targetHint: { kind: 'global' },
    tagsExtra: ['global'],
  });

  for (const entry of await listDirEntries(path.join(root, 'workspaces'))) {
    if (!entry.isDirectory()) continue;
    const scopeDir = path.join(root, 'workspaces', entry.name);
    const resolved = await resolveWorkspaceTarget({ slug: entry.name, scopeDir, links, sqliteQuery });
    const targetHint = resolved ? { kind: 'resolved', target: resolved } : { kind: 'none' };
    if (!resolved) warnings.push(`workspace "${entry.name}" sem projeto vinculado (escolha o destino na tela)`);
    const tagsExtra = [slugify(slugBase(entry.name), { max: 40 })];
    await addTopics({ scopeDir, scopeLabel: entry.name, targetHint, tagsExtra });

    if (!includeRaw) continue;
    for (const file of await listDirEntries(path.join(scopeDir, 'observations', '_inbox'))) {
      if (!file.isFile() || !file.name.endsWith('.md')) continue;
      const raw = await readText(path.join(scopeDir, 'observations', '_inbox', file.name));
      if (!raw?.trim()) continue;
      const { meta, body } = parseFrontmatter(raw);
      const title = (typeof meta.topic_hint === 'string' && meta.topic_hint) || firstHeading(body) || `Observação ${file.name.replace(/\.md$/, '')}`;
      const keywords = Array.isArray(meta.keywords) ? meta.keywords : [];
      items.push(candidate({
        key: `${SOURCE_V2}:${entry.name}:observations/${file.name}`,
        title,
        body: body.trim() || raw,
        originPath: path.join(scopeDir, 'observations', '_inbox', file.name),
        originKind: 'observation',
        sourceSlug: SOURCE_V2,
        raw: true,
        tagsExtra: ['observacao', ...keywords.map((k) => slugify(k, { max: 30 }))].slice(0, 6),
        targetHint,
      }));
    }
  }

  return { items, warnings };
}
