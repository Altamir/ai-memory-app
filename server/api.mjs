import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { runCliJson, runCli, stderrMessage } from './cli.mjs';
import { recentPages, readPage, searchMemory, listScopes } from './reads.mjs';
import { callTool } from './mcp.mjs';
import { createJob, createRunnerJob, getJob, jobDetail, listJobs, subscribe } from './jobs.mjs';
import { buildMaintenanceArgs, checkConfirmation, commandCatalog, previewArgs, confirmationFor, SPEC } from './spec.mjs';
import { IMPORT_SOURCES, applyBundleImport, applyImport, getImportItem, importState, listImportSources, scanImportSource } from './import.mjs';
import { buildBundle, deleteBundle, listBundles, listStoreScopes, planBundle, resolveBundlePath } from './bundle.mjs';
import { config } from './config.mjs';
import { createSession, getSession, killSession, listSessions, removeSession, revealSession, runningSessionPids } from './pty.mjs';
import { listHostSessions, isHostRunProcess, isProtectedPid } from './host-sessions.mjs';
import { listDirs } from './dirs.mjs';
import { listSkills, getSkillContent, installSkill, listSkillFiles, readSkillFile, listWorkspaces, getWorkspaceSkills, compareSkillCopies, diffSkillCopies, reconcileSkillCopies, RECONCILE_CONFIRM } from './skills.mjs';
import { listServers, saveServer, activateServer, deleteServer, restoreEnvServer, probeServer, setActiveBin } from './servers.mjs';
import { projectInventory } from './scopes.mjs';
import { listLogs, readLog, streamLog } from './logs.mjs';
import { setupStatus, cliRelease } from './setup-check.mjs';
import { installCli, initClientDir, installHooks } from './cli-install.mjs';
import { listHarnessMcp, previewHarnessMcp, applyHarnessMcp, applyHarnessMcpMany } from './harness-mcp.mjs';
import { listCollectionSkills, getCollectionContent, listCollectionFiles, readCollectionFile, writeCollectionFile, listCollectionVersions, importToCollection, importToCollectionBatch, listHarnessSkills, saveCollectionVersion, restoreCollectionVersion, installCollectionSkill, exportSkillsBundle, resolveSkillsBundlePath, scanSkillsBundle, importSkillsBundle } from './skills-collection.mjs';
import { expandTilde } from './config.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitPidGone(pid, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isHostRunProcess(pid))) return true;
    await sleep(500);
  }
  return false;
}

function bufferText(session) {
  return (session?.buffer || []).join('');
}

/**
 * Retomar um run externo no painel: encerra o processo externo, aguarda a
 * morte e cria a sessão do painel com retries — o ai-memory segura um lease
 * do workstream por ~90s mesmo com o processo morto (409 Conflict).
 */
async function retomarHostSession(pid) {
  const all = await listHostSessions();
  const host = all.find((p) => p.pid === pid);
  if (!host) throw new Error('processo não está mais vivo');
  if (host.kind !== 'run' || !host.harness) throw new Error('só é possível retomar `ai-memory run <harness>`');
  if (!host.cwd) throw new Error('não consegui resolver o diretório do processo');
  if (!host.isRepo) throw new Error(`o diretório ${host.cwd} não é um repositório git — o run falharia`);

  // um run pode ter launcher + harness no ps: encerra todos os do mesmo cwd
  // (nenhum deles pode ser protegido)
  const sameRun = all.filter((p) => p.cwd === host.cwd && !p.protected);
  for (const p of sameRun) {
    try {
      process.kill(p.pid, 'SIGTERM');
    } catch {
      // já saiu
    }
  }
  const gone = await Promise.all(sameRun.map((p) => waitPidGone(p.pid, 8000)));
  if (gone.some((g) => !g)) {
    for (const p of sameRun) {
      try {
        process.kill(p.pid, 'SIGKILL');
      } catch {
        // já saiu
      }
    }
    await Promise.all(sameRun.map((p) => waitPidGone(p.pid, 4000)));
  }

  // o lease do workstream sobrevive ~90s à morte do dono. Cada tentativa
  // conflita em ~1-2s ("another launcher owns…") e o 409 revela o 'until':
  // cria (invisível), detecta o conflito pelo buffer, espera a expiração
  // exata e recria. Só vira card quando o workstream é dela de verdade.
  const startedAt = Date.now();
  const deadline = startedAt + 240_000;
  let lastError = null;
  while (Date.now() < deadline) {
    const session = createSession({ harness: host.harness, cwd: host.cwd, hidden: true });
    let outcome = null; // { ok } | { failed, text }
    const obsDeadline = Date.now() + 30_000;
    while (Date.now() < obsDeadline) {
      const cur = getSession(session.id);
      const text = bufferText(cur);
      if (cur && cur.status !== 'running') {
        outcome = { failed: true, text };
        break;
      }
      if (text.includes('another launcher owns this workstream')) {
        // condenada: espera o CLI desistir e o processo sair (não pode virar zumbi segurando estado)
        const zDeadline = Date.now() + 30_000;
        while (Date.now() < zDeadline) {
          const dying = getSession(session.id);
          if (dying && dying.status !== 'running') break;
          await sleep(500);
        }
        const dying = getSession(session.id);
        if (dying && dying.status === 'running') {
          try {
            dying.proc?.kill();
          } catch {
            // já saiu
          }
          await sleep(500);
        }
        outcome = { failed: true, text: bufferText(getSession(session.id)) };
        break;
      }
      if (Date.now() - session.createdAt >= 20_000) {
        outcome = { ok: true }; // 20s vivo e sem conflito: o workstream é dela
        break;
      }
      await sleep(500);
    }
    if (!outcome) outcome = { ok: true }; // sobreviveu à observação inteira
    if (outcome.ok) {
      const live = getSession(session.id) || session;
      revealSession(session.id); // agora sim: vira card
      return live;
    }
    removeSession(session.id); // tentativa invisível descartada
    const text = outcome.text || '';
    lastError = text.split('\n').map((l) => l.trim()).filter(Boolean).pop() || 'run saiu imediatamente';
    const conflict = /workstream is already active|409 Conflict|another launcher owns/.test(text);
    if (!conflict) {
      const err = new Error(`o run falhou em ${host.cwd}: ${lastError}`);
      err.detail = text.slice(-1200);
      throw err;
    }
    const untilMatch = text.match(/until ([0-9T:.-]+Z)/);
    if (untilMatch) {
      const untilMs = Date.parse(untilMatch[1]);
      const waitMs = Number.isFinite(untilMs) ? untilMs - Date.now() + 3000 : 15_000;
      if (waitMs > 0) await sleep(Math.min(waitMs, 180_000));
    } else {
      await sleep(15_000);
    }
  }
  throw new Error(`workstream continuou ocupado por lease após ${Math.round((Date.now() - startedAt) / 1000)}s de tentativas`);
}

const home = os.homedir();

/** Escopo vindo do seletor do painel: { workspace, project } ou null. */
function normalizeScope(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null);
  const workspace = clean(raw.workspace);
  const project = clean(raw.project);
  if (!workspace && !project) return null;
  return { workspace, project };
}

// A CLI resolve o escopo dos comandos por projeto a partir do cwd. O painel
// roda os jobs herdando o próprio cwd, então este é o alvo implícito quando o
// usuário não escolhe nada — vale mostrar na tela em vez de adivinhar.
let cwdScopeCache = { at: 0, value: null };

async function resolveCwdScope() {
  const now = Date.now();
  if (cwdScopeCache.value && now - cwdScopeCache.at < 15_000) return cwdScopeCache.value;
  const data = await runCliJson(['doctor'], { timeoutMs: 60_000 });
  const value = {
    workspace: typeof data?.workspace === 'string' ? data.workspace : null,
    project: typeof data?.project === 'string' ? data.project : null,
    uncaptured: Array.isArray(data?.uncaptured) ? data.uncaptured.length : null,
    source: 'doctor (cwd do painel)',
  };
  cwdScopeCache = { at: now, value };
  return value;
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function readJsonBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('corpo da requisição muito grande');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  return JSON.parse(text);
}

export async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;
  const route = `${method} ${pathname}`;

  try {
    // ---- infra ----
    if (route === 'GET /api/health') {
      return json(res, 200, { ok: true, ts: Date.now() });
    }

    // ---- logs do ai-memory (cliente + servidor local) ----
    if (route === 'GET /api/logs') {
      return json(res, 200, listLogs());
    }
    if (route === 'GET /api/logs/content') {
      const tail = Math.min(Math.max(Number(url.searchParams.get('tail')) || 400, 1), 5000);
      try {
        return json(res, 200, await readLog({
          source: url.searchParams.get('source'),
          file: url.searchParams.get('file'),
          tail,
          filter: url.searchParams.get('filter') || '',
        }));
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
    if (route === 'GET /api/logs/stream') {
      await streamLog({
        source: url.searchParams.get('source'),
        file: url.searchParams.get('file'),
        filter: url.searchParams.get('filter') || '',
      }, res);
      return; // resposta fica aberta (SSE)
    }

    // ---- servidores: a qual ai-memory o painel está conectado ----
    if (route === 'GET /api/servers') {
      return json(res, 200, listServers());
    }
    if (route === 'POST /api/servers') {
      const body = await readJsonBody(req);
      try {
        return json(res, 200, saveServer({ ...body, id: body.id || undefined }));
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
    if (route === 'POST /api/servers/activate') {
      const body = await readJsonBody(req);
      try {
        return json(res, 200, activateServer(body.id));
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
    if (route === 'POST /api/servers/probe') {
      const body = await readJsonBody(req);
      try {
        return json(res, 200, await probeServer(body));
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
    {
      const m = pathname.match(/^\/api\/servers\/([\w-]+)$/);
      if (m && method === 'DELETE') {
        try {
          return json(res, 200, deleteServer(m[1]));
        } catch (err) {
          return json(res, 400, { error: err.message });
        }
      }
      // restaurar o ambiente removido (id estável, fora da lista de cadastrados)
      if (m && method === 'POST' && m[1] === 'env') {
        try {
          return json(res, 200, restoreEnvServer());
        } catch (err) {
          return json(res, 400, { error: err.message });
        }
      }
    }

    // ---- MCP dos harnesses: apontam para o servidor conectado ----
    if (route === 'GET /api/harness-mcp') {
      return json(res, 200, { serverUrl: config.serverUrl, harnesses: await listHarnessMcp() });
    }
    if (route === 'POST /api/harness-mcp/apply') {
      const body = await readJsonBody(req);
      const ids = Array.isArray(body.harnesses)
        ? body.harnesses.filter((h) => typeof h === 'string' && h).slice(0, 50)
        : [String(body.harness || '')].filter(Boolean);
      if (!ids.length) return json(res, 400, { error: 'selecione ao menos um harness' });
      if (ids.length === 1) {
        try {
          return json(res, 200, { results: [await applyHarnessMcp(ids[0])] });
        } catch (err) {
          return json(res, 400, { error: err.message });
        }
      }
      // vários: um que falhe não pode impedir os outros de serem corrigidos
      return json(res, 200, { results: await applyHarnessMcpMany(ids) });
    }
    {
      const m = pathname.match(/^\/api\/harness-mcp\/([\w-]+)\/preview$/);
      if (m && method === 'GET') {
        try {
          return json(res, 200, await previewHarnessMcp(m[1]));
        } catch (err) {
          return json(res, 400, { error: err.message });
        }
      }
    }

    // ---- arranque: o que falta para o painel funcionar ----
    if (route === 'GET /api/setup') {
      return json(res, 200, await setupStatus());
    }
    if (route === 'GET /api/setup/cli-release') {
      return json(res, 200, await cliRelease());
    }
    // CLI achada em outro lugar (PATH), mas o perfil aponta para onde ela não
    // está: realinhar o `bin` resolve sem instalar nada
    if (route === 'POST /api/setup/use-cli') {
      const body = await readJsonBody(req);
      try {
        return json(res, 200, setActiveBin(body.path));
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
    // `ai-memory init` no data-dir do cliente — passo 1 do setup oficial
    if (route === 'POST /api/setup/init') {
      const job = createRunnerJob('ai-memory init (data-dir do cliente)', {
        group: 'actions',
        run: async ({ log }) => {
          const out = await initClientDir({ log });
          if (!out.ok) throw new Error(out.error);
        },
      });
      return json(res, 201, { id: job.id });
    }
    // `install-hooks --apply` — o passo que faz o projeto ser vinculado no
    // primeiro capture (a docs manda junto com o install-mcp)
    if (route === 'POST /api/harness-hooks/apply') {
      const body = await readJsonBody(req);
      const agents = Array.isArray(body.agents)
        ? body.agents.filter((a) => typeof a === 'string' && a).slice(0, 30)
        : [String(body.agent || '')].filter(Boolean);
      if (!agents.length) return json(res, 400, { error: 'selecione ao menos um harness' });
      const job = createRunnerJob(`install-hooks: ${agents.join(', ')}`, {
        group: 'actions',
        run: async ({ log }) => {
          let failed = 0;
          for (const agent of agents) {
            const out = await installHooks({ agent, log });
            if (!out.ok) {
              failed += 1;
              log('err', `${agent}: ${out.error}\n`);
            }
          }
          if (failed) throw new Error(`${failed} de ${agents.length} harness(es) falharam — veja o log`);
        },
      });
      return json(res, 201, { id: job.id, agents });
    }
    if (route === 'POST /api/setup/install-cli') {
      const body = await readJsonBody(req);
      // instalar escreve em disco: só com confirmação explícita. O destino é
      // SEMPRE o bin do perfil ativo — `target` do cliente é ignorado, senão
      // bastaria confirm:true para sobrescrever um caminho arbitrário
      if (body.confirm !== true) {
        return json(res, 400, { error: 'instalar a CLI exige confirm: true', needsConfirm: true });
      }
      const job = createRunnerJob('instalar a CLI do ai-memory', {
        group: 'actions',
        run: async ({ log }) => {
          const out = await installCli({ confirm: true, log });
          if (!out.ok) throw new Error(out.error);
          log('sys', `pronto: ${out.path} (v${out.version})\n`);
        },
      });
      return json(res, 201, { id: job.id });
    }

    // ---- dashboard ----
    if (route === 'GET /api/status') {
      try {
        const data = await runCliJson(['status']);
        return json(res, 200, data);
      } catch (err) {
        return json(res, 502, { error: stderrMessage({ stderr: err.stderr, timedOut: err.timedOut, code: err.code }) || err.message });
      }
    }

    // ---- memórias ----
    if (route === 'GET /api/scopes') {
      return json(res, 200, listScopes());
    }
    // inventário completo: o que o servidor tem + o que desta máquina está
    // vinculado (client-projects.json) e se os caminhos existem em disco
    if (route === 'GET /api/server-scopes') {
      return json(res, 200, await projectInventory());
    }
    if (route === 'GET /api/recent') {
      const scope = {
        workspace: url.searchParams.get('workspace') || null,
        project: url.searchParams.get('project') || null,
      };
      const out = await recentPages(url.searchParams.get('limit') || 20, scope.workspace ? scope : null);
      return json(res, 200, out);
    }
    if (route === 'GET /api/page') {
      const p = url.searchParams.get('path');
      const scope = {
        workspace: url.searchParams.get('workspace') || null,
        project: url.searchParams.get('project') || null,
      };
      try {
        return json(res, 200, await readPage(p, scope.workspace ? scope : null));
      } catch (err) {
        return json(res, 404, { error: err.message });
      }
    }
    if (route === 'POST /api/search') {
      const body = await readJsonBody(req);
      const scope = body.workspace && body.project ? { workspace: body.workspace, project: body.project } : null;
      const out = await searchMemory(body.query, body.limit, scope);
      return json(res, 200, out);
    }

    // ---- exportação: bundles de memórias ----
    if (route === 'GET /api/export/sources') {
      try {
        const store = await listStoreScopes();
        const bundles = await listBundles();
        return json(res, 200, {
          store: {
            dir: store.dir,
            wikiDir: store.wikiDir,
            dbFile: store.dbFile,
            available: store.available,
            sqlite: store.sqlite,
            note: store.note,
            error: store.error || null,
          },
          scopes: store.scopes,
          totals: store.totals,
          exportsDir: bundles.dir,
          bundles: bundles.bundles,
          runtime: { bin: config.bin, dataDir: config.dataDir, serverUrl: config.serverUrl, cwd: process.cwd() },
        });
      } catch (err) {
        return json(res, 500, { error: err.message });
      }
    }
    if (route === 'POST /api/export/plan') {
      const body = await readJsonBody(req);
      try {
        const plan = await planBundle({ scopes: body.scopes, includeRaw: body.includeRaw === true, name: body.name });
        return json(res, 200, plan);
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
    if (route === 'POST /api/export/run') {
      const body = await readJsonBody(req);
      const scopes = Array.isArray(body.scopes) ? body.scopes.slice(0, 500) : [];
      const includeRaw = body.includeRaw === true;
      const name = body.name ? String(body.name).slice(0, 120) : null;
      const job = createRunnerJob(`exportar bundle (${scopes.length || 'todos'} escopo(s))`, {
        run: async ({ log }) => {
          const out = await buildBundle({ scopes, includeRaw, name, log });
          log('sys', `pronto: ${out.fileName} — importe na aba Importar, fonte "Bundle do ai-memory"\n`);
        },
      });
      return json(res, 201, { id: job.id, scopes, includeRaw, name });
    }
    if (route === 'GET /api/export/download') {
      const file = url.searchParams.get('file') || '';
      let target;
      try {
        target = await resolveBundlePath(file);
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
      const stat = fs.statSync(target);
      res.writeHead(200, {
        'Content-Type': 'application/gzip',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${path.basename(target)}"`,
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(target).pipe(res);
      return;
    }
    if (route === 'POST /api/export/delete') {
      const body = await readJsonBody(req);
      try {
        const out = await deleteBundle(body.file, { confirm: body.confirm });
        return json(res, 200, out);
      } catch (err) {
        if (err.code === 'NEEDS_CONFIRM') return json(res, 409, { error: err.message, needsConfirm: true, file: err.file });
        return json(res, 400, { error: err.message });
      }
    }

    // ---- importação de memórias (Grok v1/v2, Kiro, bundle do ai-memory) ----
    if (route === 'GET /api/import/sources') {
      try {
        return json(res, 200, await listImportSources());
      } catch (err) {
        return json(res, 500, { error: err.message });
      }
    }
    if (route === 'POST /api/import/scan') {
      const body = await readJsonBody(req);
      try {
        const out = await scanImportSource(String(body.source || ''), {
          includeRaw: body.includeRaw !== false,
          bundleFile: body.bundleFile ? String(body.bundleFile) : undefined,
        });
        return json(res, 200, out);
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
    if (route === 'POST /api/import/item') {
      const body = await readJsonBody(req);
      try {
        const item = await getImportItem(String(body.source || ''), String(body.key || ''), {
          includeRaw: body.includeRaw !== false,
          bundleFile: body.bundleFile ? String(body.bundleFile) : undefined,
        });
        return json(res, 200, item);
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
    if (route === 'POST /api/import/apply') {
      const body = await readJsonBody(req);
      const source = String(body.source || '');
      if (!IMPORT_SOURCES.some((s) => s.id === source)) {
        return json(res, 400, { error: `fonte desconhecida: ${source || '(vazia)'}` });
      }
      const keys = Array.isArray(body.keys) ? body.keys.filter((k) => typeof k === 'string' && k).slice(0, 5000) : [];
      if (!keys.length) return json(res, 400, { error: 'selecione ao menos um item' });
      const dryRun = body.dryRun === true;
      const overrides = body.overrides && typeof body.overrides === 'object' ? body.overrides : {};
      const includeRaw = body.includeRaw !== false;
      const bundleFile = body.bundleFile ? String(body.bundleFile) : undefined;
      if (source === 'bundle' && !bundleFile) return json(res, 400, { error: 'escolha o arquivo do bundle' });
      const job = createRunnerJob(`import ${source}${dryRun ? ' (dry-run)' : ''}`, {
        run: async ({ log, job: runnerJob }) => {
          const args = { keys, overrides, includeRaw, dryRun, jobId: runnerJob.id, log };
          // o bundle escolhe o próprio apply: aceita arquivo e servidor de destino
          if (source === 'bundle') await applyBundleImport({ ...args, bundleFile, server: body.server });
          else await applyImport({ ...args, source });
        },
      });
      return json(res, 201, { id: job.id, source, total: keys.length, dryRun });
    }
    if (route === 'GET /api/import/state') {
      return json(res, 200, importState());
    }

    // ---- skills dos harnesses ----
    // home é resolvido dentro de skills.mjs (AI_MEMORY_SKILLS_HOME permite isolar em testes)
    if (route === 'GET /api/skills') {
      try {
        return json(res, 200, await listSkills());
      } catch (err) {
        return json(res, 500, { error: err.message });
      }
    }
    if (route === 'GET /api/skills/content') {
      try {
        return json(res, 200, await getSkillContent({
          name: url.searchParams.get('name') || '',
          harness: url.searchParams.get('harness') || undefined,
          kind: url.searchParams.get('kind') || undefined,
        }));
      } catch (err) {
        return json(res, 404, { error: err.message });
      }
    }
    if (route === 'GET /api/skills/workspaces') {
      try {
        return json(res, 200, listWorkspaces({ parent: url.searchParams.get('parent') || undefined }));
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
    if (route === 'GET /api/skills/workspace') {
      try {
        return json(res, 200, getWorkspaceSkills({ dir: url.searchParams.get('dir') || '' }));
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
    if (route === 'GET /api/skills/files') {
      try {
        return json(res, 200, listSkillFiles({
          name: url.searchParams.get('name') || '',
          harness: url.searchParams.get('harness') || undefined,
          kind: url.searchParams.get('kind') || undefined,
          ws: url.searchParams.get('ws') || undefined,
        }));
      } catch (err) {
        return json(res, 404, { error: err.message });
      }
    }
    if (route === 'GET /api/skills/file') {
      try {
        return json(res, 200, readSkillFile({
          name: url.searchParams.get('name') || '',
          harness: url.searchParams.get('harness') || undefined,
          kind: url.searchParams.get('kind') || undefined,
          ws: url.searchParams.get('ws') || undefined,
          rel: url.searchParams.get('rel') || undefined,
        }));
      } catch (err) {
        return json(res, 404, { error: err.message });
      }
    }
    if (route === 'GET /api/skills/compare') {
      try {
        return json(res, 200, await compareSkillCopies({ name: url.searchParams.get('name') || '' }));
      } catch (err) {
        return json(res, 404, { error: err.message });
      }
    }
    if (route === 'GET /api/skills/diff') {
      try {
        return json(res, 200, await diffSkillCopies({
          name: url.searchParams.get('name') || '',
          a: url.searchParams.get('a') || '',
          b: url.searchParams.get('b') || '',
          context: Number(url.searchParams.get('context')) || 3,
        }));
      } catch (err) {
        return json(res, 404, { error: err.message });
      }
    }
    if (route === 'POST /api/skills/reconcile') {
      const body = await readJsonBody(req);
      try {
        const out = await reconcileSkillCopies({
          name: String(body.name || ''),
          source: body.source ?? '',
          targets: Array.isArray(body.targets) ? body.targets : [],
          includeResources: body.includeResources !== false,
          removeExtra: body.removeExtra === true,
          dryRun: body.dryRun === true,
          confirm: body.confirm,
        });
        return json(res, 200, out);
      } catch (err) {
        if (err.code === 'NEEDS_CONFIRM') {
          return json(res, 409, { error: err.message, needsConfirm: true, word: RECONCILE_CONFIRM, plan: err.plan });
        }
        return json(res, 400, { error: err.message });
      }
    }
    if (route === 'POST /api/skills/install') {
      const body = await readJsonBody(req);
      try {
        const out = await installSkill({
          name: String(body.name || ''),
          scope: body.scope === 'project' ? 'project' : 'global',
          harness: String(body.harness || ''),
          projectDir: body.projectDir ? String(body.projectDir) : undefined,
          force: body.force === true,
        });
        return json(res, 200, out);
      } catch (err) {
        if (err.code === 'NEEDS_FORCE') return json(res, 409, { error: err.message, needsForce: true });
        return json(res, 400, { error: err.message });
      }
    }

    // ---- gestor de skills: coleção do painel ----
    // caminhos vêm de config (AIM_APP_SKILLS_DIR / AIM_APP_SKILLS_EXPORT_DIR)
    if (route === 'GET /api/collection/skills') {
      try {
        return json(res, 200, await listCollectionSkills());
      } catch (err) {
        return json(res, 500, { error: err.message });
      }
    }
    if (route === 'GET /api/collection/skills/content') {
      try {
        return json(res, 200, getCollectionContent({
          name: url.searchParams.get('name') || '',
          version: url.searchParams.get('version') || undefined,
        }));
      } catch (err) {
        return json(res, 404, { error: err.message });
      }
    }
    if (route === 'GET /api/collection/skills/files') {
      try {
        return json(res, 200, listCollectionFiles({ name: url.searchParams.get('name') || '' }));
      } catch (err) {
        return json(res, 404, { error: err.message });
      }
    }
    if (route === 'GET /api/collection/skills/file') {
      try {
        return json(res, 200, readCollectionFile({
          name: url.searchParams.get('name') || '',
          rel: url.searchParams.get('rel') || 'SKILL.md',
        }));
      } catch (err) {
        return json(res, 404, { error: err.message });
      }
    }
    if (route === 'POST /api/collection/skills/file') {
      const body = await readJsonBody(req);
      try {
        return json(res, 200, writeCollectionFile({
          name: String(body.name || ''),
          rel: String(body.rel || ''),
          content: typeof body.content === 'string' ? body.content : '',
          note: body.note ? String(body.note) : null,
        }));
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
    if (route === 'GET /api/collection/skills/versions') {
      try {
        return json(res, 200, listCollectionVersions({ name: url.searchParams.get('name') || '' }));
      } catch (err) {
        return json(res, 404, { error: err.message });
      }
    }
    if (route === 'POST /api/collection/skills/import') {
      const body = await readJsonBody(req);
      try {
        const out = await importToCollection({
          name: String(body.name || ''),
          harness: body.harness ? String(body.harness) : undefined,
          kind: body.kind ? String(body.kind) : undefined,
          ws: body.ws ? String(body.ws) : undefined,
        });
        return json(res, 200, out);
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
    if (route === 'GET /api/collection/harness-skills') {
      try {
        return json(res, 200, await listHarnessSkills({ harness: url.searchParams.get('harness') || '' }));
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
    if (route === 'POST /api/collection/skills/import-batch') {
      const body = await readJsonBody(req);
      try {
        return json(res, 200, await importToCollectionBatch({ items: Array.isArray(body.items) ? body.items : [] }));
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
    if (route === 'POST /api/collection/skills/version') {
      const body = await readJsonBody(req);
      try {
        return json(res, 200, saveCollectionVersion({ name: String(body.name || ''), note: body.note ? String(body.note) : null }));
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
    if (route === 'POST /api/collection/skills/restore') {
      const body = await readJsonBody(req);
      try {
        return json(res, 200, restoreCollectionVersion({ name: String(body.name || ''), version: Number(body.version) }));
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
    if (route === 'POST /api/collection/skills/install') {
      const body = await readJsonBody(req);
      try {
        const out = await installCollectionSkill({
          name: String(body.name || ''),
          harness: String(body.harness || ''),
          scope: body.scope === 'project' ? 'project' : 'global',
          projectDir: body.projectDir ? String(body.projectDir) : undefined,
          force: body.force === true,
        });
        return json(res, 200, out);
      } catch (err) {
        if (err.code === 'NEEDS_FORCE') return json(res, 409, { error: err.message, needsForce: true });
        return json(res, 400, { error: err.message });
      }
    }
    if (route === 'POST /api/collection/bundle/scan') {
      const body = await readJsonBody(req);
      try {
        return json(res, 200, await scanSkillsBundle({ file: String(body.file || '') }));
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
    if (route === 'POST /api/collection/bundle/export') {
      const body = await readJsonBody(req);
      const name = body.name ? String(body.name).slice(0, 120) : null;
      const job = createRunnerJob('exportar bundle de skills', {
        run: async ({ log }) => {
          const out = await exportSkillsBundle({ name, log });
          log('sys', `pronto: ${out.fileName} (${out.skills} skill(s), ${out.files} arquivo(s))\n`);
        },
      });
      return json(res, 201, { id: job.id, name });
    }
    if (route === 'POST /api/collection/bundle/import') {
      const body = await readJsonBody(req);
      const file = String(body.file || '');
      const names = Array.isArray(body.names) ? body.names.filter((n) => typeof n === 'string' && n).slice(0, 500) : [];
      if (!names.length) return json(res, 400, { error: 'selecione ao menos uma skill do bundle' });
      const update = body.update !== false;
      const job = createRunnerJob(`importar bundle de skills (${names.length} skill(s))`, {
        run: async ({ log }) => {
          const out = await importSkillsBundle({ file, names, update, log });
          log('sys', `pronto: ${out.created} criada(s), ${out.updated} atualizada(s), ${out.skipped} ignorada(s), ${out.errors} erro(s)\n`);
        },
      });
      return json(res, 201, { id: job.id, file, total: names.length, update });
    }
    if (route === 'GET /api/collection/bundle/download') {
      const file = url.searchParams.get('file') || '';
      let target;
      try {
        target = await resolveSkillsBundlePath(file);
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
      const stat = fs.statSync(target);
      res.writeHead(200, {
        'Content-Type': 'application/gzip',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${path.basename(target)}"`,
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(target).pipe(res);
      return;
    }

    // ---- jobs de manutenção ----
    if (route === 'GET /api/maintenance') {
      // catálogo completo + de onde vêm o binário, o data-dir e a store
      return json(res, 200, {
        ...commandCatalog(),
        runtime: { bin: config.bin, dataDir: config.dataDir, serverUrl: config.serverUrl, cwd: process.cwd() },
      });
    }
    if (route === 'GET /api/maintenance/scope') {
      // escopo que a CLI resolveria para o cwd do painel — é o alvo dos
      // comandos por projeto quando o seletor fica em "automático"
      try {
        return json(res, 200, await resolveCwdScope());
      } catch (err) {
        return json(res, 200, { workspace: null, project: null, source: 'fallback', error: stderrMessage({ stderr: err.stderr, timedOut: err.timedOut, code: err.code }) || err.message });
      }
    }
    if (route === 'GET /api/jobs') {
      return json(res, 200, { jobs: listJobs(), commands: Object.keys(SPEC) });
    }
    if (route === 'POST /api/jobs') {
      const body = await readJsonBody(req);
      const command = String(body.command || '');
      const scope = normalizeScope(body.scope);
      const options = body.options ?? {};
      let built;
      try {
        // preview: mesma validação, sem executar — alimenta o modal de ajuda
        // (com fill: true, que tolera campos ainda vazios) e o de confirmação
        if (body.preview === true) {
          const args = previewArgs(command, options, { home, scope, fill: body.fill === true });
          const confirm = confirmationFor(command, options);
          return json(res, 200, { preview: true, command, args, scope: scope || null, confirmWord: confirm?.word || null, confirmHint: confirm?.hint || null });
        }
        built = buildMaintenanceArgs(command, options, { home, scope });
        checkConfirmation(command, body.confirm, options);
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
      const job = createJob(command, built.args, { timeoutMs: built.timeoutMs, group: built.group });
      return json(res, 201, { id: job.id, command, args: job.displayArgs, group: job.group, scope: scope || null });
    }
    {
      const m = pathname.match(/^\/api\/jobs\/([\w-]+)(\/stream)?$/);
      if (m && method === 'GET') {
        const job = getJob(m[1]);
        if (!job) return json(res, 404, { error: 'job não encontrado' });
        if (m[2]) {
          const ok = subscribe(job.id, res);
          if (!ok) return json(res, 404, { error: 'job não encontrado' });
          return; // SSE mantém aberta
        }
        return json(res, 200, jobDetail(m[1]));
      }
    }

    // ---- pending-writes ----
    if (route === 'GET /api/pending') {
      try {
        const data = await runCliJson(['pending-writes', 'list']);
        return json(res, 200, { items: Array.isArray(data) ? data : (data.items ?? data.pages ?? data.proposals ?? data.writes ?? []) });
      } catch (err) {
        return json(res, 502, { error: stderrMessage({ stderr: err.stderr, timedOut: err.timedOut, code: err.code }) || err.message });
      }
    }
    {
      const m = pathname.match(/^\/api\/pending\/([^/]+)\/(diff|show)$/);
      if (m && method === 'GET') {
        try {
          const data = await runCliJson(['pending-writes', 'diff', m[1]]);
          return json(res, 200, data);
        } catch (err) {
          return json(res, 502, { error: stderrMessage({ stderr: err.stderr, timedOut: err.timedOut, code: err.code }) || err.message });
        }
      }
    }
    {
      const m = pathname.match(/^\/api\/pending\/([^/]+)\/(approve|reject)$/);
      if (m && method === 'POST') {
        const body = await readJsonBody(req);
        const args = ['pending-writes', m[2] === 'approve' ? 'approve' : 'reject', m[1]];
        if (m[2] === 'reject' && body.reason) args.push('--reason', String(body.reason).slice(0, 2000));
        try {
          const data = await runCliJson(args);
          return json(res, 200, typeof data === 'object' && data !== null ? data : { ok: true, output: data });
        } catch (err) {
          return json(res, 502, { error: stderrMessage({ stderr: err.stderr, timedOut: err.timedOut, code: err.code }) || err.message });
        }
      }
    }

    // ---- handoffs ----
    if (route === 'GET /api/handoffs') {
      try {
        const data = await runCliJson(['handoffs', '--limit', '50']);
        const items = Array.isArray(data) ? data : (data.handoffs ?? data.items ?? data.pages ?? []);
        return json(res, 200, { items });
      } catch (err) {
        return json(res, 502, { error: stderrMessage({ stderr: err.stderr, timedOut: err.timedOut, code: err.code }) || err.message });
      }
    }
    if (route === 'POST /api/handoffs/accept') {
      const body = await readJsonBody(req);
      if (!body.handoffId || typeof body.handoffId !== 'string') {
        return json(res, 400, { error: 'handoffId obrigatório' });
      }
      try {
        const data = await callTool('memory_handoff_accept', { handoff_id: body.handoffId }, { timeoutMs: 30_000 });
        return json(res, 200, data);
      } catch (err) {
        return json(res, 502, { error: err.message });
      }
    }

    // ---- mensagens ----
    if (route === 'GET /api/messages') {
      const box = url.searchParams.get('box') === 'outbox' ? 'outbox' : 'inbox';
      try {
        const args = ['message', 'list'];
        if (box === 'outbox') args.push('--outbox');
        const data = await runCliJson(args);
        const items = Array.isArray(data) ? data : (data.messages ?? data.items ?? []);
        return json(res, 200, { box, items });
      } catch (err) {
        return json(res, 502, { error: stderrMessage({ stderr: err.stderr, timedOut: err.timedOut, code: err.code }) || err.message });
      }
    }
    if (route === 'POST /api/messages/pop') {
      const body = await readJsonBody(req);
      const args = ['message', 'pop'];
      if (body.messageId) args.push('--id', String(body.messageId));
      try {
        const data = await runCliJson(args);
        return json(res, 200, typeof data === 'object' && data !== null ? data : { ok: true, output: data });
      } catch (err) {
        return json(res, 502, { error: stderrMessage({ stderr: err.stderr, timedOut: err.timedOut, code: err.code }) || err.message });
      }
    }
    if (route === 'POST /api/messages/cancel') {
      const body = await readJsonBody(req);
      const args = ['message', 'cancel'];
      if (body.all) args.push('--all');
      else if (body.messageId) args.push('--id', String(body.messageId));
      else return json(res, 400, { error: 'messageId ou all obrigatório' });
      try {
        const data = await runCliJson(args);
        return json(res, 200, typeof data === 'object' && data !== null ? data : { ok: true, output: data });
      } catch (err) {
        return json(res, 502, { error: stderrMessage({ stderr: err.stderr, timedOut: err.timedOut, code: err.code }) || err.message });
      }
    }
    if (route === 'POST /api/messages/send') {
      const body = await readJsonBody(req);
      const toWorkspace = String(body.toWorkspace || '').trim();
      const toProject = String(body.toProject || '').trim();
      if (!toWorkspace || !toProject) {
        return json(res, 400, { error: 'toWorkspace e toProject obrigatórios' });
      }
      if (!body.body || typeof body.body !== 'string') {
        return json(res, 400, { error: 'corpo da mensagem obrigatório' });
      }
      const args = ['message', 'send', '--to-workspace', toWorkspace, '--to-project', toProject];
      if (body.subject) args.push('--subject', String(body.subject).slice(0, 500));
      args.push(String(body.body).slice(0, 20_000));
      try {
        const data = await runCliJson(args);
        return json(res, 200, typeof data === 'object' && data !== null ? data : { ok: true, output: data });
      } catch (err) {
        return json(res, 502, { error: stderrMessage({ stderr: err.stderr, timedOut: err.timedOut, code: err.code }) || err.message });
      }
    }

    // ---- sessões rodando fora do painel (tabela de processos) ----
    if (route === 'GET /api/host-sessions') {
      // pids dos cards do painel não reaparecem aqui: já têm terminal no app
      const managedPids = new Set(runningSessionPids());
      try {
        return json(res, 200, { items: await listHostSessions(managedPids) });
      } catch (err) {
        return json(res, 500, { error: err.message });
      }
    }
    if (route === 'POST /api/host-sessions/kill') {
      const body = await readJsonBody(req);
      const pid = Number(body.pid);
      if (!Number.isInteger(pid) || pid <= 1) return json(res, 400, { error: 'pid inválido' });
      if (isProtectedPid(pid)) return json(res, 403, { error: 'pid protegido — listado em .protected-pids.json' });
      if (!(await isHostRunProcess(pid))) {
        return json(res, 404, { error: 'pid não é um ai-memory run/show/continue/resume vivo' });
      }
      try {
        process.kill(pid, 'SIGTERM');
        return json(res, 200, { ok: true });
      } catch (err) {
        return json(res, 500, { error: err.message });
      }
    }

    if (route === 'POST /api/host-sessions/retomar') {
      const body = await readJsonBody(req);
      const pid = Number(body.pid);
      if (!Number.isInteger(pid) || pid <= 1) return json(res, 400, { error: 'pid inválido' });
      if (isProtectedPid(pid)) return json(res, 403, { error: 'pid protegido — listado em .protected-pids.json' });
      try {
        const session = await retomarHostSession(pid);
        return json(res, 200, { id: session.id, pid: session.pid, harness: session.harness, cwd: session.cwd });
      } catch (err) {
        return json(res, err.detail ? 502 : 400, { error: err.message, detail: err.detail || undefined });
      }
    }

    // ---- sessões (ai-memory run) ----
    if (route === 'GET /api/dirs') {
      try {
        return json(res, 200, listDirs(url.searchParams.get('path')));
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
    if (route === 'GET /api/workstreams') {
      try {
        const data = await runCliJson(['workstreams']);
        const arr = Array.isArray(data) ? data : (data.workstreams ?? data.items ?? []);
        const items = arr
          .map((w) => ({
            name: w?.name ?? w?.workstream ?? w?.id ?? null,
            project: w?.project ?? w?.project_name ?? null,
            path: w?.path ?? w?.cwd ?? w?.worktree ?? null,
            raw: w,
          }))
          .filter((w) => w.name);
        return json(res, 200, { items });
      } catch (err) {
        return json(res, 502, { error: stderrMessage({ stderr: err.stderr, timedOut: err.timedOut, code: err.code }) || err.message });
      }
    }
    if (route === 'GET /api/sessions') {
      return json(res, 200, { sessions: listSessions() });
    }
    if (route === 'POST /api/sessions') {
      const body = await readJsonBody(req);
      try {
        const session = createSession({
          harness: String(body.harness || ''),
          cwd: expandTilde(String(body.cwd || '')),
          newWorkstream: body.newWorkstream ? String(body.newWorkstream).slice(0, 120) : null,
          workstream: body.workstream ? String(body.workstream).slice(0, 120) : null,
          yolo: body.yolo === true,
          fresh: body.fresh === true,
        });
        return json(res, 201, { id: session.id, pid: session.pid, harness: session.harness, cwd: session.cwd });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
    {
      const m = pathname.match(/^\/api\/sessions\/([\w-]+)\/kill$/);
      if (m && method === 'POST') {
        const ok = killSession(m[1]);
        return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'sessão não encontrada' });
      }
    }
    {
      const m = pathname.match(/^\/api\/sessions\/([\w-]+)$/);
      if (m && method === 'DELETE') {
        const session = getSession(m[1]);
        if (!session) return json(res, 404, { error: 'sessão não encontrada' });
        const ok = removeSession(m[1]);
        return json(res, ok ? 200 : 409, ok ? { ok: true } : { error: 'sessão ainda rodando — encerre antes de excluir' });
      }
    }

    return json(res, 404, { error: `rota desconhecida: ${route}` });
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
}
