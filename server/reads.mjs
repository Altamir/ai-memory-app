import os from 'node:os';
import fs from 'node:fs';
import { tryTool } from './mcp.mjs';
import { runCliJson, stderrMessage } from './cli.mjs';
import { config } from './config.mjs';
import { isEnvServerActive } from './servers.mjs';

// Leituras (recent / read-page / search) via MCP HTTP, com fallback para a CLI.
// scope = { workspace, project } restringe a um projeto; null = busca global.

const home = os.homedir();

function firstArray(data, keys) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return null;
  let fallback = null;
  for (const k of keys) {
    if (Array.isArray(data[k])) {
      if (data[k].length > 0) return data[k];
      if (!fallback) fallback = data[k];
    }
  }
  return fallback; // só retorna array vazio se nenhuma chave tiver conteúdo
}

const pick = (obj, keys) => {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
};

export function normalizePageItem(p) {
  if (!p || typeof p !== 'object') return null;
  const path = pick(p, ['path', 'page_path', 'wiki_path']);
  if (!path) return null;
  return {
    path,
    title: pick(p, ['title', 'name']) || String(path).split('/').pop(),
    snippet: pick(p, ['snippet', 'excerpt', 'highlights', 'match']) || null,
    score: pick(p, ['rank', 'score']) ?? null,
    kind: pick(p, ['kind']) || null,
    tier: pick(p, ['tier']) || null,
    tags: Array.isArray(p.tags) ? p.tags : [],
    updatedAt: pick(p, ['updated_at', 'updatedAt', 'last_updated']) || null,
    workspace: pick(p, ['workspace_name', 'workspace']) || null,
    project: pick(p, ['project_name', 'project']) || null,
    pinned: Boolean(p.pinned),
  };
}

function scopeArgs(scope) {
  return scope && scope.workspace && scope.project
    ? { workspace: scope.workspace, project: scope.project }
    : {};
}

export async function recentPages(limit = 20, scope = null) {
  const max = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const res = await tryTool('memory_recent', { limit: max, ...scopeArgs(scope) });
  if (res.ok) {
    const arr = firstArray(res.data, ['hits', 'pages', 'recent', 'results', 'items']);
    if (arr) {
      const items = arr.map(normalizePageItem).filter(Boolean);
      return { source: 'mcp', items };
    }
    if (res.data?.raw) return cliRecent(max, scope, res.data.raw);
  }
  return cliRecent(max, scope, res.ok ? null : res.error);
}

async function cliRecent(max, scope, errorNote) {
  // o store em disco é o volume do servidor LOCAL: só vale listar quando o
  // servidor ativo é este. Com o painel apontado para outro ai-memory, essas
  // páginas seriam de outro lugar e apareceriam como se fossem do destino.
  if (!isEnvServerActive()) {
    return {
      source: 'none',
      note: `${errorNote ? `${errorNote}; ` : ''}o painel está conectado em ${config.serverUrl} — o store local (${config.storeDir}) não vale para esta leitura`,
      items: [],
    };
  }
  // último recurso: cataloga os .md do wiki no volume do servidor (leitura direta)
  try {
    const { readdir } = await import('node:fs/promises');
    const path = await import('node:path');
    const wikiDir = path.join(config.storeDir, 'wiki');
    const walk = async (dir, base = '') => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return [];
      }
      const out = [];
      for (const e of entries) {
        if (e.name.startsWith('_') || e.name.startsWith('.')) continue;
        const rel = base ? `${base}/${e.name}` : e.name;
        if (e.isDirectory()) out.push(...(await walk(path.join(dir, e.name), rel)));
        else if (e.name.endsWith('.md')) out.push(rel.replace(/\.md$/, ''));
      }
      return out;
    };
    let paths = await walk(wikiDir);
    if (scope?.workspace && scope?.project) {
      paths = paths.filter((p) => p.startsWith(`${scope.workspace}/${scope.project}/`));
    }
    paths = paths.slice(0, max);
    return {
      source: 'fs',
      note: errorNote ? `MCP indisponível (${errorNote}); listando arquivos do wiki` : null,
      items: paths.map((p) => ({ path: p, title: p.split('/').pop(), snippet: null, score: null, kind: null, tier: null, tags: [], updatedAt: null, workspace: scope?.workspace || null, project: scope?.project || null, pinned: false })),
    };
  } catch {
    return { source: 'none', note: errorNote, items: [] };
  }
}

export async function readPage(pagePath, scope = null) {
  if (typeof pagePath !== 'string' || !pagePath.trim()) {
    throw new Error('path obrigatório');
  }
  const clean = pagePath.trim().replace(/^\/+/, '');
  if (clean.includes('..')) throw new Error('path inválido');

  const res = await tryTool('memory_read_page', { path: clean, ...scopeArgs(scope) });
  if (res.ok && res.data && (res.data.body !== undefined || res.data.title)) {
    return {
      path: res.data.path || clean,
      title: res.data.title || clean.split('/').pop(),
      body: res.data.body || '',
      frontmatter: res.data.frontmatter || null,
    };
  }

  // fallback CLI
  const args = ['read-page', '--path', clean];
  if (scope?.workspace) args.push('--workspace', scope.workspace);
  if (scope?.project) args.push('--project', scope.project);
  const r = await runCliJson(args);
  if (r && typeof r === 'object' && !r.raw) {
    return { path: r.path || clean, title: r.title || clean.split('/').pop(), body: r.body || '', frontmatter: r.frontmatter || null };
  }
  if (r?.raw) {
    return { path: clean, title: clean.split('/').pop(), body: r.raw, frontmatter: null };
  }
  throw new Error('página não encontrada');
}

export async function searchMemory(query, limit = 10, scope = null) {
  const q = String(query || '').trim();
  if (!q) return { source: 'none', items: [], note: 'consulta vazia' };
  const max = Math.min(Math.max(Number(limit) || 10, 1), 50);

  const mcpArgs = scope?.workspace
    ? { query: q, limit: max, workspace: scope.workspace, project: scope.project }
    : { query: q, limit: max, global: true };
  const res = await tryTool('memory_query', mcpArgs);
  if (res.ok) {
    const arr = firstArray(res.data, ['hits', 'global_hits', 'results', 'pages', 'items']);
    if (arr) {
      return { source: 'mcp', items: arr.map(normalizePageItem).filter(Boolean) };
    }
  }

  // fallback CLI: search é sempre FTS no escopo atual; sem global
  if (!scope?.workspace) {
    return { source: 'none', items: [], note: 'busca global exige o MCP (fallback CLI só cobre um projeto)' };
  }
  try {
    const r = await runCliJson(['search', q, '-n', String(max), '--workspace', scope.workspace, '--project', scope.project]);
    const arr = firstArray(r, ['results', 'hits', 'pages']) || (Array.isArray(r) ? r : []);
    return { source: 'cli', items: arr.map(normalizePageItem).filter(Boolean) };
  } catch (err) {
    return { source: 'none', items: [], note: stderrMessage({ stderr: err.stderr || '', timedOut: false, code: err.code }) || err.message };
  }
}

/** Escopos conhecidos, do client-projects.json do data-dir. */
export function listScopes() {
  try {
    const raw = fs.readFileSync(`${config.dataDir}/client-projects.json`, 'utf8');
    const data = JSON.parse(raw);
    const links = Array.isArray(data?.links) ? data.links : [];
    const seen = new Map();
    for (const l of links) {
      if (!l?.workspace || !l?.project) continue;
      const key = `${l.workspace}/${l.project}`;
      if (!seen.has(key)) seen.set(key, { workspace: l.workspace, project: l.project, path: l.path || null });
    }
    return { scopes: [...seen.values()] };
  } catch {
    return { scopes: [], note: 'client-projects.json indisponível' };
  }
}
