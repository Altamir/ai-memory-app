import fs from 'node:fs/promises';
import path from 'node:path';
import { classify, firstHeading, isoDay, matchSlugToLinks, parseFrontmatter, resolveTargetByPath, slugify } from './import-util.mjs';
import { sqliteJsonQuery } from './import-sqlite.mjs';

// Leitura das memórias do Kiro:
//   crew/memory.db            semantic_memory (chaves project.<slug>.<attr>) e
//                             episodic_memories (texto/tags/importância)
//   crew/workspace/memory/    history/YYYY-MM-DD.md (diários do crew)
//   <repo>/.kiro/steering/    regras por projeto (`inclusion: always`)
//   ~/.kiro/steering/         regras globais
// O sqlite é lido read-only pelo CLI do sistema (deps.sqliteQuery é injetável
// para teste); sem sqlite a fonte degrada para os markdown, com aviso.

const SOURCE = 'kiro';

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

function jsonValue(raw) {
  if (raw === null || raw === undefined) return '';
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
  } catch {
    return String(raw);
  }
}

function candidate({ key, title, body, originPath, originKind, targetHint, suggested, raw = false, tagsExtra = [] }) {
  const base = suggested || classify({ title, body, sourceSlug: SOURCE });
  return {
    key,
    title,
    body,
    originPath,
    originKind,
    raw,
    suggested: { ...base, tags: ['kiro', ...tagsExtra] },
    targetHint,
  };
}

/** Steering do Kiro: `inclusion: always` é regra; os demais seguem a heurística. */
async function steeringItems({ dir, targetHint, tagsExtra }) {
  const items = [];
  for (const file of await listDirEntries(dir)) {
    if (!file.isFile() || !file.name.endsWith('.md')) continue;
    const raw = await readText(path.join(dir, file.name));
    if (!raw?.trim()) continue;
    const { meta, body } = parseFrontmatter(raw);
    const content = body.trim() || raw;
    const title = firstHeading(content) || file.name.replace(/\.md$/, '');
    const always = String(meta.inclusion || '').toLowerCase() === 'always';
    const suggested = always
      ? { path: `_rules/${slugify(title)}.md`, kind: 'rule', tier: 'procedural', pinned: true }
      : classify({ title, body: content, sourceSlug: SOURCE });
    items.push(candidate({
      key: `${SOURCE}:steering:${path.basename(dir)}/${file.name}`,
      title,
      body: `${content.startsWith('#') ? content : `# ${title}\n\n${content}`}`,
      originPath: path.join(dir, file.name),
      originKind: 'steering',
      targetHint,
      suggested,
      tagsExtra: [...(always ? ['regra'] : []), ...tagsExtra],
    }));
  }
  return items;
}

/** Um candidato consolidado por projeto (semantic) e por dia (episodic). */
async function memoryDbItems({ dbFile, links, sqliteQuery, includeRaw }) {
  const items = [];
  const warnings = [];

  let semanticRows = [];
  try {
    semanticRows = await sqliteQuery(
      dbFile,
      'SELECT key, value_json, confidence, source, created_at FROM semantic_memory WHERE is_deleted = 0 ORDER BY key',
    );
  } catch (err) {
    warnings.push(`semantic_memory: ${err.message}`);
  }
  let episodicRows = [];
  if (includeRaw) {
    try {
      episodicRows = await sqliteQuery(
        dbFile,
        "SELECT id, text, tags, importance, created_at FROM episodic_memories WHERE is_deleted = 0 ORDER BY created_at DESC",
      );
    } catch (err) {
      warnings.push(`episodic_memories: ${err.message}`);
    }
  }

  const groups = new Map();
  for (const row of semanticRows) {
    const key = String(row?.key || '');
    const m = /^project\.([^.]+)\.(.+)$/.exec(key);
    const slug = m ? m[1] : 'geral';
    const attr = m ? m[2] : key;
    if (!groups.has(slug)) groups.set(slug, []);
    groups.get(slug).push({ attr, value: jsonValue(row.value_json), confidence: row.confidence, source: row.source });
  }

  for (const [slug, entries] of groups) {
    const projectPath = entries.find((e) => e.attr === 'path')?.value || null;
    let targetHint = { kind: 'global' };
    const byPath = projectPath ? resolveTargetByPath(projectPath, links) : null;
    if (byPath) targetHint = { kind: 'resolved', target: byPath };
    else {
      const link = matchSlugToLinks(slug, links);
      if (link) targetHint = { kind: 'resolved', target: link };
    }
    const title = slug === 'geral' ? 'Kiro · memórias gerais' : `Kiro · projeto ${slug}`;
    const lines = entries
      .filter((e) => e.attr !== 'path')
      .map((e) => `- **${e.attr}**: ${String(e.value).replace(/\n+/g, ' ')}${Number.isFinite(Number(e.confidence)) ? ` _(confiança ${Number(e.confidence).toFixed(2)})_` : ''}`);
    items.push(candidate({
      key: `${SOURCE}:semantic:${slug}`,
      title,
      body: `# ${title}\n\n${lines.join('\n') || '_sem atributos_'}\n`,
      originPath: path.join(path.dirname(dbFile), 'memory.db#semantic_memory'),
      originKind: 'semantic',
      targetHint,
      suggested: { path: `notes/imported/kiro/semantic-${slugify(slug)}.md`, kind: 'fact', tier: 'semantic', pinned: false },
      tagsExtra: [slugify(slug, { max: 30 })],
    }));
  }

  const byDay = new Map();
  for (const row of episodicRows) {
    const day = isoDay(row?.created_at);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(row);
  }
  for (const [day, rows] of [...byDay.entries()].sort((a, b) => String(b[0]).localeCompare(String(a[0])))) {
    const title = `Kiro · memórias episódicas ${day}`;
    const lines = rows.map((row) => {
      let tags = [];
      try {
        tags = JSON.parse(row.tags || '[]');
      } catch {
        tags = [];
      }
      const tagText = Array.isArray(tags) && tags.length ? ` ${tags.map((t) => `\`#${t}\``).join(' ')}` : '';
      const imp = Number.isFinite(Number(row.importance)) ? ` _(importância ${Number(row.importance).toFixed(2)})_` : '';
      return `- ${String(row.text || '').replace(/\n+/g, ' ')}${imp}${tagText}`;
    });
    items.push(candidate({
      key: `${SOURCE}:episodic:${day}`,
      title,
      body: `# ${title}\n\n${lines.join('\n')}\n`,
      originPath: path.join(path.dirname(dbFile), 'memory.db#episodic_memories'),
      originKind: 'episodic',
      targetHint: { kind: 'global' },
      suggested: { path: `notes/imported/kiro/episodic-${day}.md`, kind: 'fact', tier: 'episodic', pinned: false },
      raw: true,
      tagsExtra: ['episodico'],
    }));
  }

  return { items, warnings };
}

/** Casamento por nome: `acme-service-alpha` ↔ link `acme-service-alpha`. */

/**
 * Diretórios `.kiro/steering` sob um projeto: o próprio path e até 2 níveis
 * abaixo (monorepos guardam o steering no repo do serviço, ex.
 * `monorepo/servico-web/.kiro/steering`).
 */
async function findSteeringDirs(projectPath, depth = 2) {
  const found = [];
  const walk = async (dir, level) => {
    if (level > depth) return;
    if (await existsDir(path.join(dir, '.kiro', 'steering'))) found.push(path.join(dir, '.kiro', 'steering'));
    if (level === depth) return;
    for (const entry of await listDirEntries(dir)) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      await walk(path.join(dir, entry.name), level + 1);
    }
  };
  await walk(projectPath, 0);
  return found;
}

async function existsDir(dir) {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

export async function scanKiro({ kiroDir, links = [], includeRaw = true, sqliteQuery = sqliteJsonQuery } = {}) {
  const items = [];
  const warnings = [];

  // steering global
  items.push(...(await steeringItems({ dir: path.join(kiroDir, 'steering'), targetHint: { kind: 'global' }, tagsExtra: ['global'] })));

  // steering por projeto vinculado (inclusive repos aninhados)
  for (const link of links) {
    if (!link?.path) continue;
    const targetHint = { kind: 'resolved', target: { workspace: link.workspace, project: link.project, reason: `steering do projeto ${link.path}` } };
    for (const dir of await findSteeringDirs(link.path)) {
      items.push(...(await steeringItems({
        dir,
        targetHint,
        tagsExtra: [slugify(link.project, { max: 30 }), slugify(path.basename(path.dirname(path.dirname(dir))), { max: 30 })],
      })));
    }
  }

  // diários do crew
  const historyDir = path.join(kiroDir, 'crew', 'workspace', 'memory', 'history');
  for (const file of await listDirEntries(historyDir)) {
    if (!file.isFile() || !file.name.endsWith('.md')) continue;
    const raw = await readText(path.join(historyDir, file.name));
    if (!raw?.trim()) continue;
    const day = file.name.replace(/\.md$/, '');
    const title = firstHeading(raw) || `Kiro · histórico ${day}`;
    items.push(candidate({
      key: `${SOURCE}:history:${file.name}`,
      title,
      body: raw,
      originPath: path.join(historyDir, file.name),
      originKind: 'history',
      targetHint: { kind: 'global' },
      suggested: { path: `notes/imported/kiro/history-${slugify(day, { max: 20 })}.md`, kind: 'fact', tier: 'episodic', pinned: false },
      raw: true,
      tagsExtra: ['historico'],
    }));
  }

  // memory.db (semantic + episodic)
  const dbFile = path.join(kiroDir, 'crew', 'memory.db');
  try {
    await fs.access(dbFile);
    const dbResult = await memoryDbItems({ dbFile, links, sqliteQuery, includeRaw });
    items.push(...dbResult.items);
    warnings.push(...dbResult.warnings);
  } catch {
    warnings.push(`memory.db não encontrado em ${dbFile}`);
  }

  return { items, warnings };
}
