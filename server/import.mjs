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
import { getBundleCandidate, listBundles, resolveBundlePath, scanBundleCandidates } from './bundle.mjs';
import { tryTool } from './mcp.mjs';
import { runCli, stderrMessage } from './cli.mjs';

// Orquestração do importador: varre as memórias do Grok/Kiro (e bundles do
// próprio ai-memory), resolve o destino (projeto vinculado, escopo do bundle ou
// _global), compara com o que já foi importado e grava página a página via MCP
// (com fallback para `write-page` da CLI).

export const IMPORT_SOURCES = [
  { id: 'grok-v1', label: 'Grok · memória v1', hint: 'MEMORY.md global + por projeto (+ sessões)', root: () => path.join(config.grokDir, 'memory') },
  { id: 'grok-v2', label: 'Grok · memória v2', hint: 'topics do global e dos workspaces (+ observações)', root: () => path.join(config.grokDir, 'memory-v2') },
  { id: 'kiro', label: 'Kiro · crew + steering', hint: 'semantic/episodic do crew, steering e diários', root: () => config.kiroDir },
  { id: 'bundle', label: 'Bundle do ai-memory', hint: 'bundle .tar.gz de outro painel/servidor (ou de `ai-memory export-okf`)', root: () => config.exportsDir, needsFile: true },
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

async function collectCandidates(id, { includeRaw = true, links, sqliteQuery, bundleFile } = {}) {
  const resolvedLinks = links || getLinks();
  if (id === 'grok-v1') return scanGrokV1({ grokDir: config.grokDir }, { includeRaw });
  if (id === 'grok-v2') return scanGrokV2({ grokDir: config.grokDir }, { links: resolvedLinks, includeRaw, sqliteQuery });
  if (id === 'kiro') return scanKiro({ kiroDir: config.kiroDir, links: resolvedLinks, includeRaw, sqliteQuery });
  if (id === 'bundle') {
    if (!bundleFile) throw new Error('escolha o arquivo do bundle');
    const file = await resolveBundlePath(bundleFile);
    return scanBundleCandidates(file, { includeRaw });
  }
  throw new Error(`fonte desconhecida: ${id}`);
}

/** Escopo do bundle → destino: a página volta para o mesmo escopo de origem. */
function bundleTargetReason(scopeKey, links) {
  const linked = (links || []).find((l) => `${l.workspace}/${l.project}` === scopeKey);
  if (linked?.path) return `escopo do bundle (${scopeKey}) · vinculado aqui a ${linked.path}`;
  return `escopo do bundle (${scopeKey}) — o destino cria o projeto se ele não existir`;
}

/** targetHint (parser) → { workspace, project } | { global: true } | null. */
function resolveTarget(hint, links) {
  if (!hint) return { target: null, reason: 'origem sem destino identificado' };
  if (hint.kind === 'global') return { target: { global: true }, reason: 'escopo global (_global)' };
  if (hint.kind === 'bundle') return { target: { workspace: hint.target.workspace, project: hint.target.project }, reason: bundleTargetReason(`${hint.target.workspace}/${hint.target.project}`, links) };
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
export async function scanImportSource(id, { includeRaw = true, links, sqliteQuery, bundleFile } = {}) {
  const source = IMPORT_SOURCES.find((s) => s.id === id);
  if (!source) throw new Error(`fonte desconhecida: ${id}`);
  if (source.needsFile) {
    return scanImportFile(id, { includeRaw, links, bundleFile });
  }
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

/** Fontes que são um arquivo escolhido na tela (bundle), não um diretório. */
async function scanImportFile(id, { includeRaw, links, bundleFile } = {}) {
  let file = null;
  try {
    file = await resolveBundlePath(bundleFile);
  } catch (err) {
    return { source: id, root: config.exportsDir, available: false, file: null, items: [], warnings: [err.message], summary: emptySummary() };
  }
  const { items: rawItems, warnings, manifest, scopes } = await collectCandidates(id, { includeRaw, links, bundleFile: file });
  const state = importStateSummary();
  const resolvedLinks = links || getLinks();
  const items = rawItems.map((raw) => lightweight(decorateItem(raw, resolvedLinks, state)));
  return {
    source: id,
    root: file,
    file,
    available: true,
    items,
    warnings: warnings || [],
    bundle: {
      exportedAt: manifest?.exportedAt || null,
      origin: manifest?.origin?.storeDir || null,
      format: manifest?.format || null,
      scopes: scopes || [],
      totals: manifest?.totals || null,
    },
    summary: summarize(items),
  };
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
  if (id === 'bundle') {
    const file = await resolveBundlePath(opts.bundleFile);
    return getBundleCandidate(file, key, { includeRaw: opts.includeRaw !== false });
  }
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
 * Servidor de destino de uma importação: `null` = o do painel. Com `url`, a
 * gravação vai para outro ai-memory — e o token local fica de fora do envio.
 */
export function normalizeServer(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const url = String(raw.url ?? '').trim().replace(/\/+$/, '');
  if (!url) return null;
  if (!/^https?:\/\/[^\s]+$/i.test(url)) throw new Error(`url de servidor inválida: ${url.slice(0, 80)}`);
  const token = String(raw.token ?? '').trim().slice(0, 500);
  return { url, token: token || null };
}

function serverEnv(server) {
  if (!server) return undefined;
  // '' (e não o token local) quando o destino remoto não tem token
  return { AI_MEMORY_SERVER_URL: server.url, AI_MEMORY_AUTH_TOKEN: server.token || '' };
}

/**
 * Grava uma página: MCP `memory_write_page` primeiro (aceita scope global e
 * devolve erro estruturado) e `write-page` da CLI como fallback. O motivo da
 * queda vai no resultado para o log do job explicar o caminho usado.
 */
export async function writePage({ pagePath, body, title, kind, tier, tags, pinned, target, server = null }) {
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
  const where = server ? ' (remoto)' : '';

  const res = await tryTool('memory_write_page', mcpArgs, { timeoutMs: 60_000, target: server });
  if (res.ok) return { via: `mcp${where}`, note: null, remote: Boolean(server) };

  const mcpNote = String(res.error || 'erro desconhecido').split('\n')[0].slice(0, 200);
  try {
    const r = await runCli(cliArgsFor({ pagePath, title, kind, tier, tags, pinned, target }), {
      stdinText: body,
      timeoutMs: 120_000,
      env: serverEnv(server),
    });
    if (r.code !== 0) throw new Error(stderrMessage(r));
    return { via: `cli${where}`, note: mcpNote, remote: Boolean(server) };
  } catch (err) {
    throw new Error(`MCP: ${res.error} · CLI: ${err.message}`);
  }
}

/**
 * Grava os itens escolhidos (já decorados por `decorateItem`), sequencialmente,
 * e registra fingerprint/destino no estado. Vale para qualquer fonte: Grok,
 * Kiro e bundle usam o mesmo caminho de escrita.
 */
export async function applyItems({ items, keys, overrides = {}, source, label = null, dryRun = false, jobId = null, log = () => {}, server = null }) {
  const byKey = new Map(items.map((item) => [item.key, item]));
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

  log('sys', `import ${label || source}: ${chosen.length} selecionado(s), ${skipped.length} ignorado(s)${dryRun ? ' (dry-run: nada será gravado)' : ''}\n`);
  if (server) log('sys', `destino: ${server.url} (remoto${server.token ? ', com token' : ', sem token'})\n`);
  const imported = [];
  const failed = [];
  const entries = [];
  let i = 0;
  for (const item of chosen) {
    i += 1;
    const place = item.target.global ? '_global' : `${item.target.workspace}/${item.target.project}`;
    const line = `[${i}/${chosen.length}] ${place} · ${item.suggested.path}`;
    if (dryRun) {
      log('out', `${line} (dry-run)\n`);
      continue;
    }
    try {
      const out = await writePage({ pagePath: item.suggested.path, body: item.body, title: item.title, kind: item.suggested.kind, tier: item.suggested.tier, tags: item.suggested.tags, pinned: item.suggested.pinned, target: item.target, server });
      imported.push({ key: item.key, path: item.suggested.path, target: place, via: out.via });
      entries.push({ key: item.key, fp: item.fingerprint, destPath: item.suggested.path, destTarget: place, importedAt: new Date().toISOString() });
      log('out', `${line} ✓ (${out.via}${out.note ? `; MCP falhou: ${out.note}` : ''})\n`);
    } catch (err) {
      failed.push({ key: item.key, path: item.suggested.path, error: err.message });
      log('err', `${line} ✗ ${err.message}\n`);
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
    ...(server ? { server: server.url } : {}),
  };
  recordImportRun(run);
  log('sys', `resumo: ${imported.length} importada(s), ${failed.length} falha(s), ${skipped.length} ignorada(s)${dryRun ? ' — dry-run' : ''}\n`);
  return { runId, imported, failed, skipped };
}

/**
 * Importa os itens escolhidos de uma fonte lida do disco (Grok/Kiro). Re-escaneia
 * no servidor (o cliente manda só as chaves), decora e delega para `applyItems`.
 */
export async function applyImport({ source, keys, overrides = {}, includeRaw = true, dryRun = false, jobId = null, log = () => {}, links, sqliteQuery }) {
  const resolvedLinks = links || getLinks();
  // o apply precisa dos corpos (o scan que a tela viu é leve) — re-lê a origem
  const { items: rawItems } = await collectCandidates(source, { includeRaw, links: resolvedLinks, sqliteQuery });
  const state = importStateSummary();
  const items = rawItems.map((raw) => decorateItem(raw, resolvedLinks, state));
  return applyItems({ items, keys, overrides, source, dryRun, jobId, log });
}

/**
 * Importa páginas de um bundle .tar.gz — o caminho para levar memórias a outro
 * servidor (o bundle pode ter vindo de outra máquina e o destino pode ser
 * remoto, via URL + token).
 */
export async function applyBundleImport({ keys, overrides = {}, includeRaw = true, bundleFile, dryRun = false, jobId = null, log = () => {}, links, server = null }) {
  if (!bundleFile) throw new Error('escolha o arquivo do bundle');
  const file = await resolveBundlePath(bundleFile);
  const resolvedLinks = links || getLinks();
  const target = normalizeServer(server);
  const { items: rawItems, warnings } = await collectCandidates('bundle', { includeRaw, links: resolvedLinks, bundleFile: file });
  for (const w of (warnings || []).slice(0, 10)) log('sys', `aviso: ${w}\n`);
  const state = importStateSummary();
  const items = rawItems.map((raw) => decorateItem(raw, resolvedLinks, state));
  log('sys', `bundle: ${path.basename(file)}\n`);
  return applyItems({ items, keys, overrides, source: 'bundle', label: `bundle ${path.basename(file)}`, dryRun, jobId, log, server: target });
}

/** Fontes detectadas + contagens leves + últimos imports. */
export async function listImportSources() {
  const links = getLinks();
  const sqlite = await sqliteAvailable();
  const state = loadImportState();
  const sources = [];
  const bundles = await listBundles();

  for (const src of IMPORT_SOURCES) {
    const lastRun = state.runs.find((r) => r.source === src.id) || null;
    if (src.needsFile) {
      // bundle: a "fonte" é a pasta de exports + os arquivos que estão nela
      const pages = bundles.bundles.reduce((n, b) => n + (Number(b.pages) || 0), 0);
      sources.push({
        id: src.id,
        label: src.label,
        hint: src.hint,
        root: bundles.dir,
        available: true,
        needsFile: true,
        counts: { curated: pages, raw: 0, bundles: bundles.bundles.length },
        bundles: bundles.bundles.map((b) => ({ file: b.file, bytes: b.bytes, mtime: b.mtime, pages: b.pages, scopes: b.scopes, exportedAt: b.exportedAt, origin: b.origin, error: b.error })),
        warnings: [],
        lastRun: lastRun ? { id: lastRun.id, endedAt: lastRun.endedAt, imported: lastRun.imported, planned: lastRun.planned ?? 0, dryRun: Boolean(lastRun.dryRun), failed: lastRun.failed } : null,
      });
      continue;
    }

    const root = src.root();
    const available = await exists(root);
    const counts = { curated: 0, raw: 0 };
    const warnings = [];

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
