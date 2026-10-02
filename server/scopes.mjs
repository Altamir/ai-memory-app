import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.mjs';

// Projetos do servidor cruzados com o que existe nesta máquina.
//
// Duas fontes que respondem perguntas diferentes:
//
// - **Servidor** (`GET <server>/admin/projects`, com o Bearer do perfil): todo
//   workspace/projeto que já tem página lá, com contagem e última atualização.
//   É o inventário do servidor — existem mesmo sem nada na máquina.
// - **Cliente** (`<data-dir>/client-projects.json`): os projetos que ESTA
//   máquina vinculou (o registry que o fluxo de hooks grava, com `linked_at` e
//   o caminho local). Só existe depois de captura com hooks.
//
// O cruzamento é o que a tela de Memórias precisa: "o servidor tem X; deste
// X, a máquina conhece Y pelo caminho Z — que existe/não existe em disco".

const HOME = process.env.HOME || os.homedir();

function clientLinks() {
  try {
    const raw = fs.readFileSync(path.join(config.dataDir, 'client-projects.json'), 'utf8');
    const data = JSON.parse(raw);
    const links = Array.isArray(data?.links) ? data.links : [];
    const map = new Map();
    for (const l of links) {
      if (!l?.workspace || !l?.project) continue;
      const key = `${l.workspace}/${l.project}`;
      if (!map.has(key)) map.set(key, l);
    }
    return map;
  } catch {
    return new Map(); // arquivo ausente = nada vinculado ainda (não é erro)
  }
}

function pathOnDisk(p) {
  if (!p) return null;
  const resolved = p.startsWith('~') ? path.join(HOME, p.slice(1)) : p;
  try {
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * Lista os projetos do servidor chamando a admin API com o token do perfil
 * ativo. Devolve { ok, projects } ou { ok: false, error }.
 */
async function serverProjects() {
  const token = config.token
    || (() => {
      try {
        return fs.readFileSync(path.join(config.dataDir, 'auth-token'), 'utf8').trim();
      } catch {
        return null;
      }
    })();

  const headers = { Authorization: token ? `Bearer ${token}` : '' };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(`${config.serverUrl}/admin/projects`, { headers, signal: controller.signal });
    clearTimeout(timer);
    if (res.status === 401) return { ok: false, error: '401: token recusado pelo servidor' };
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} em /admin/projects` };
    const data = await res.json();
    const items = Array.isArray(data?.projects) ? data.projects : [];
    return {
      ok: true,
      projects: items
        .filter((p) => p?.workspace_name && p?.project_name)
        .map((p) => ({
          workspace: p.workspace_name,
          project: p.project_name,
          pages: Number(p.page_count) || 0,
          lastUpdated: p.last_updated || null,
        }))
        .sort((a, b) => b.pages - a.pages),
    };
  } catch (err) {
    return { ok: false, error: String(err?.cause?.message || err.message || err).slice(0, 200) };
  }
}

/** Projetos do servidor + o estado local de cada um. */
export async function projectInventory() {
  const [server, local] = await Promise.all([serverProjects(), Promise.resolve(clientLinks())]);

  if (!server.ok) {
    return { ok: false, error: server.error, serverUrl: config.serverUrl, projects: [] };
  }

  const projects = server.projects.map((p) => {
    const key = `${p.workspace}/${p.project}`;
    const link = local.get(key);
    const localPath = link?.path ? pathOnDisk(link.path) : null;
    return {
      ...p,
      key,
      // vinculada nesta máquina: o registry do cliente tem o par
      linked: Boolean(link),
      linkedAt: link?.linked_at || null,
      localPath: link?.path || null,
      pathExists: Boolean(localPath),
    };
  });

  // projetos vinculados na máquina que o servidor NÃO conhece: captura local
  // contra outro servidor, ou registry de outra época — vale mostrar
  const serverKeys = new Set(server.projects.map((p) => `${p.workspace}/${p.project}`));
  const orphans = [...local.entries()]
    .filter(([key]) => !serverKeys.has(key))
    .map(([key, l]) => ({ key, path: l.path || null, pathExists: Boolean(pathOnDisk(l.path)) }));

  return {
    ok: true,
    serverUrl: config.serverUrl,
    total: projects.length,
    linked: projects.filter((p) => p.linked).length,
    projects,
    orphans,
  };
}
