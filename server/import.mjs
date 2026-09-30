import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.mjs';
import { listScopes } from './reads.mjs';
import { scanGrokV1, scanGrokV2 } from './import-grok.mjs';
import { scanKiro } from './import-kiro.mjs';
import { sqliteAvailable, sqliteJsonQuery } from './import-sqlite.mjs';
import { fingerprint, matchSlugToLinks, resolveTargetByPath } from './import-util.mjs';
import { loadImportState, markImported, recordImportRun, importStateSummary } from './import-store.mjs';
import { tryTool } from './mcp.mjs';
import { runCli, stderrMessage } from './cli.mjs';

// Orquestração do importador: varre as memórias do Grok/Kiro, resolve o destino
// (projeto vinculado ou _global), compara com o que já foi importado e grava
// página a página via MCP (com fallback para `write-page` da CLI).

export const IMPORT_SOURCES = [
  { id: 'grok-v1', label: 'Grok · memória v1', hint: 'MEMORY.md global + por projeto (+ sessões)', root: () => path.join(config.grokDir, 'memory') },
  { id: 'grok-v2', label: 'Grok · memória v2', hint: 'topics do global e dos workspaces (+ observações)', root: () => path.join(config.grokDir, 'memory-v2') },
  { id: 'kiro', label: 'Kiro · crew + steering', hint: 'semantic/episodic do crew, steering e diários', root: () => config.kiroDir },
];

/** Links path→projeto vêm do client-projects.json (mesmo mapa da tela de Memórias). */
function getLinks() {
  return (listScopes().scopes || []).filter((s) => s.path);
}

async function listDirEntries(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function countFiles(dir, filter = (n) => n.endsWith('.md')) {
  return (await listDirEntries(dir)).filter((e) => e.isFile() && filter(e.name)).length;
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function collectCandidates(id, { includeRaw = true, links, sqliteQuery } = {}) {
  const resolvedLinks = links || getLinks();
  if (id === 'grok-v1') return scanGrokV1({ grokDir: config.grokDir }, { includeRaw });
  if (id === 'grok-v2') return scanGrokV2({ grokDir: config.grokDir }, { links: resolvedLinks, includeRaw, sqliteQuery });
  if (id === 'kiro') return scanKiro({ kiroDir: config.kiroDir, links: resolvedLinks, includeRaw, sqliteQuery });
  throw new Error(`fonte desconhecida: ${id}`);
}

/** targetHint (parser) → { workspace, project } | { global: true } | null. */
function resolveTarget(hint, links) {
  if (!hint) return { target: null, reason: 'origem sem destino identificado' };
  if (hint.kind === 'global') return { target: { global: true }, reason: 'escopo global (_global)' };
  if (hint.kind === 'resolved') return { target: { workspace: hint.target.workspace, project: hint.target.project }, reason: hint.target.reason || 'projeto vinculado' };
  if (hint.kind === 'path') {
    const found = resolveTargetByPath(hint.path, links);
    if (found) return { target: { workspace: found.workspace, project: found.project }, reason: found.reason };
    return { target: null, reason: `sem projeto vinculado para ${hint.path}` };
  }
  if (hint.kind === 'slug') {
    const found = matchSlugToLinks(hint.slug, links);
    if (found) return { target: { workspace: found.workspace, project: found.project }, reason: found.reason };
    return { target: null, reason: `nenhum projeto vinculado parece ser "${hint.slug}"` };
  }
  return { target: null, reason: 'origem sem destino identificado' };
}

const destKey = (target, pagePath) => (target?.global ? '_global' : `${target?.workspace}/${target?.project}`) + `|${pagePath}`;

/** Candidato completo → item decorado com destino, fingerprint e status. */
function decorateItem(raw, links, state) {
  const fp = fingerprint(raw.body);
  const { target, reason } = resolveTarget(raw.targetHint, links);
  const prev = state.items[raw.key];
  let status = 'new';
  let duplicateOf = null;
  if (prev && prev.fp === fp) status = 'same';
  else if (prev) status = 'changed';
  else if (state.byFingerprint.has(fp)) {
    status = 'duplicate';
    duplicateOf = state.byFingerprint.get(fp);
  }
  return { ...raw, fingerprint: fp, target, targetReason: reason, status, duplicateOf };
}

/** Versão leve para a tela: sem o corpo (o viewer busca sob demanda). */
function lightweight(item) {
  const { body, ...rest } = item;
  return { ...rest, chars: body.length, preview: body.replace(/\s+/g, ' ').trim().slice(0, 200) };
}

/** Varre uma fonte e devolve os candidatos com destino, classificação e status. */
export async function scanImportSource(id, { includeRaw = true, links, sqliteQuery } = {}) {
  const source = IMPORT_SOURCES.find((s) => s.id === id);
  if (!source) throw new Error(`fonte desconhecida: ${id}`);
  const root = source.root();
  if (!(await exists(root))) {
    return { source: id, root, available: false, items: [], warnings: [`${root} não existe`], summary: emptySummary() };
  }

  const { items: rawItems, warnings } = await collectCandidates(id, { includeRaw, links, sqliteQuery });
  const state = importStateSummary();
  const resolvedLinks = links || getLinks();
  const items = rawItems.map((raw) => lightweight(decorateItem(raw, resolvedLinks, state)));

  // dois itens diferentes querendo a mesma página: o segundo esbarra no primeiro
  const byDest = new Map();
  for (const item of items) {
    if (!item.target) continue;
    const key = destKey(item.target, item.suggested.path);
    const first = byDest.get(key);
    if (!first) {
      byDest.set(key, item);
      continue;
    }
    if (first.fingerprint !== item.fingerprint) {
      item.status = 'collision';
      item.duplicateOf = first.key;
      item.targetReason = `${item.targetReason} · mesma página que "${first.title}"`;
    }
  }

  return { source: id, root, available: true, items, warnings, summary: summarize(items) };
}

function emptySummary() {
  return { total: 0, new: 0, changed: 0, same: 0, duplicate: 0, collision: 0, raw: 0, noTarget: 0 };
}

function summarize(items) {
  const s = emptySummary();
  s.total = items.length;
  for (const item of items) {
    s[item.status] = (s[item.status] || 0) + 1;
    if (item.raw) s.raw += 1;
    if (!item.target) s.noTarget += 1;
  }
  return s;
}

/** Um item com o corpo completo (para o viewer da tela). */
export async function getImportItem(id, key, opts = {}) {
  const { items: rawItems } = await collectCandidates(id, opts);
  const found = rawItems.find((i) => i.key === key);
  if (!found) throw new Error('item não encontrado (a origem pode ter mudado)');
  const resolvedLinks = opts.links || getLinks();
  const { target, reason } = resolveTarget(found.targetHint, resolvedLinks);
  return { ...found, target, targetReason: reason, fingerprint: fingerprint(found.body) };
}

function normalizeOverride(override) {
  if (!override || typeof override !== 'object') return null;
  if (override.global === true) return { global: true };
  const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null);
  const workspace = clean(override.workspace);
  const project = clean(override.project);
  if (!workspace || !project) return null;
  return { workspace, project };
}

/** Ajustes por item vindos da tela: destino e/ou path/kind/tier/pinned. */
function applyItemOverride(item, raw) {
  if (!raw || typeof raw !== 'object') return;
  const cleanPath = typeof raw.path === 'string' ? raw.path.trim().replace(/^\/+/, '') : '';
  if (cleanPath && cleanPath.endsWith('.md') && !cleanPath.includes('..') && /^[\w./ -]+$/.test(cleanPath)) {
    item.suggested = { ...item.suggested, path: cleanPath };
  }
  if (['fact', 'rule', 'decision', 'gotcha'].includes(raw.kind)) item.suggested = { ...item.suggested, kind: raw.kind };
  if (['working', 'episodic', 'semantic', 'procedural'].includes(raw.tier)) item.suggested = { ...item.suggested, tier: raw.tier };
  if (typeof raw.pinned === 'boolean') item.suggested = { ...item.suggested, pinned: raw.pinned };
}

function cliArgsFor({ pagePath, title, kind, tier, tags, pinned, target }) {
  const args = ['write-page', '--path', pagePath, '--body', '-'];
  if (title) args.push('--title', title);
  if (kind) args.push('--kind', kind);
  for (const tag of tags || []) args.push('-t', tag);
  if (tier) args.push('--tier', tier);
  if (pinned) args.push('--pinned');
  if (target.global) args.push('--workspace', 'default', '--project', '_global');
  else {
    if (target.workspace) args.push('--workspace', target.workspace);
    if (target.project) args.push('--project', target.project);
  }
  return args;
}

/**
 * Grava uma página: MCP `memory_write_page` primeiro (aceita scope global e
 * devolve erro estruturado) e `write-page` da CLI como fallback. O motivo da
 * queda vai no resultado para o log do job explicar o caminho usado.
 */
export async function writePage({ pagePath, body, title, kind, tier, tags, pinned, target }) {
  const payload = {
    path: pagePath,
    body,
    tier: tier || 'semantic',
    pinned: Boolean(pinned),
    tags: (tags || []).slice(0, 12),
  };
  if (title) payload.title = title;
  if (kind) payload.kind = kind;
  const mcpArgs = target.global ? { ...payload, scope: 'global' } : { ...payload, workspace: target.workspace, project: target.project };

  const res = await tryTool('memory_write_page', mcpArgs, { timeoutMs: 60_000 });
  if (res.ok) return { via: 'mcp', note: null };

  const mcpNote = String(res.error || 'erro desconhecido').split('\n')[0].slice(0, 200);
  try {
    const r = await runCli(cliArgsFor({ pagePath, title, kind, tier, tags, pinned, target }), {
      stdinText: body,
      timeoutMs: 120_000,
    });
    if (r.code !== 0) throw new Error(stderrMessage(r));
    return { via: 'cli', note: mcpNote };
  } catch (err) {
    throw new Error(`MCP: ${res.error} · CLI: ${err.message}`);
  }
}

/**
 * Importa os itens escolhidos. Re-escaneia no servidor (o cliente manda só as
 * chaves), grava sequencialmente e registra fingerprint/destino no estado.
 */
export async function applyImport({ source, keys, overrides = {}, includeRaw = true, dryRun = false, jobId = null, log = () => {}, links, sqliteQuery }) {
  const resolvedLinks = links || getLinks();
  // o apply precisa dos corpos (o scan que a tela viu é leve) — re-lê a origem
  const { items: rawItems } = await collectCandidates(source, { includeRaw, links: resolvedLinks, sqliteQuery });
  const state = importStateSummary();
  const byKey = new Map(rawItems.map((raw) => {
    const item = decorateItem(raw, resolvedLinks, state);
    return [item.key, item];
  }));
  const runId = randomUUID();
  const startedAt = Date.now();

  const chosen = [];
  const skipped = [];
  for (const key of keys) {
    const item = byKey.get(key);
    if (!item) {
      skipped.push({ key, reason: 'não está mais na origem' });
      continue;
    }
    const raw = overrides[key];
    const prepared = { ...item, suggested: { ...item.suggested } };
    applyItemOverride(prepared, raw);
    const target = normalizeOverride(raw) || item.target;
    if (!target) {
      skipped.push({ key, reason: 'sem destino definido' });
      continue;
    }
    prepared.target = target;
    chosen.push(prepared);
  }

  log('sys', `import ${source}: ${chosen.length} selecionado(s), ${skipped.length} ignorado(s)${dryRun ? ' (dry-run: nada será gravado)' : ''}\n`);
  const imported = [];
  const failed = [];
  const entries = [];
  let i = 0;
  for (const item of chosen) {
    i += 1;
    const place = item.target.global ? '_global' : `${item.target.workspace}/${item.target.project}`;
    const label = `[${i}/${chosen.length}] ${place} · ${item.suggested.path}`;
    if (dryRun) {
      log('out', `${label} (dry-run)\n`);
      continue;
    }
    try {
      const out = await writePage({ pagePath: item.suggested.path, body: item.body, title: item.title, kind: item.suggested.kind, tier: item.suggested.tier, tags: item.suggested.tags, pinned: item.suggested.pinned, target: item.target });
      imported.push({ key: item.key, path: item.suggested.path, target: place, via: out.via });
      entries.push({ key: item.key, fp: item.fingerprint, destPath: item.suggested.path, destTarget: place, importedAt: new Date().toISOString() });
      log('out', `${label} ✓ (${out.via}${out.note ? `; MCP falhou: ${out.note}` : ''})\n`);
    } catch (err) {
      failed.push({ key: item.key, path: item.suggested.path, error: err.message });
      log('err', `${label} ✗ ${err.message}\n`);
    }
  }

  if (entries.length) markImported(entries);
  const run = {
    id: runId,
    jobId,
    source,
    startedAt,
    endedAt: Date.now(),
    dryRun,
    planned: chosen.length,
    imported: imported.length,
    failed: failed.length,
    skipped: skipped.length,
    items: imported.map((x) => ({ key: x.key, path: x.path, target: x.target })),
    errors: failed.map((x) => ({ key: x.key, path: x.path, error: x.error })),
  };
  recordImportRun(run);
  log('sys', `resumo: ${imported.length} importada(s), ${failed.length} falha(s), ${skipped.length} ignorada(s)${dryRun ? ' — dry-run' : ''}\n`);
  return { runId, imported, failed, skipped };
}

/** Fontes detectadas + contagens leves + últimos imports. */
export async function listImportSources() {
  const links = getLinks();
  const sqlite = await sqliteAvailable();
  const state = loadImportState();
  const sources = [];

  for (const src of IMPORT_SOURCES) {
    const root = src.root();
    const available = await exists(root);
    const counts = { curated: 0, raw: 0 };
    const warnings = [];
    let lastRun = state.runs.find((r) => r.source === src.id) || null;

    if (available && src.id === 'grok-v1') {
      const dirs = (await listDirEntries(root)).filter((e) => e.isDirectory());
      counts.curated += (await exists(path.join(root, 'MEMORY.md'))) ? 1 : 0;
      for (const dir of dirs) {
        if (await exists(path.join(root, dir.name, 'MEMORY.md'))) counts.curated += 1;
        counts.raw += await countFiles(path.join(root, dir.name, 'sessions'));
      }
    } else if (available && src.id === 'grok-v2') {
      counts.curated += await countFiles(path.join(root, 'global', 'topics'));
      for (const ws of (await listDirEntries(path.join(root, 'workspaces'))).filter((e) => e.isDirectory())) {
        counts.curated += await countFiles(path.join(root, 'workspaces', ws.name, 'topics'));
        counts.raw += await countFiles(path.join(root, 'workspaces', ws.name, 'observations', '_inbox'));
      }
    } else if (available && src.id === 'kiro') {
      counts.curated += await countFiles(path.join(root, 'steering'));
      for (const link of links) counts.curated += await countFiles(path.join(link.path, '.kiro', 'steering'));
      counts.raw += await countFiles(path.join(root, 'crew', 'workspace', 'memory', 'history'));
      if (sqlite) {
        const dbFile = path.join(root, 'crew', 'memory.db');
        try {
          const [s] = await sqliteJsonQuery(dbFile, 'SELECT count(*) AS n FROM semantic_memory WHERE is_deleted = 0');
          const [e] = await sqliteJsonQuery(dbFile, 'SELECT count(*) AS n FROM episodic_memories WHERE is_deleted = 0');
          counts.curated += Number(s?.n) || 0;
          counts.raw += Number(e?.n) || 0;
        } catch (err) {
          warnings.push(`memory.db: ${err.message}`);
        }
      } else {
        warnings.push('sqlite3 não encontrado: as memórias do crew (semantic/episodic) ficam de fora');
      }
    }

    sources.push({
      id: src.id,
      label: src.label,
      hint: src.hint,
      root,
      available,
      counts,
      warnings,
      lastRun: lastRun ? { id: lastRun.id, endedAt: lastRun.endedAt, imported: lastRun.imported, planned: lastRun.planned ?? 0, dryRun: Boolean(lastRun.dryRun), failed: lastRun.failed } : null,
    });
  }

  return {
    sources,
    runtime: { grokDir: config.grokDir, kiroDir: config.kiroDir, sqlite, links: links.length, bin: config.bin, dataDir: config.dataDir, serverUrl: config.serverUrl },
  };
}

export function importState() {
  const state = loadImportState();
  return {
    imported: Object.keys(state.items).length,
    runs: state.runs,
  };
}
