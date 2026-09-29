import os from 'node:os';
import { runCliJson, runCli, stderrMessage } from './cli.mjs';
import { recentPages, readPage, searchMemory, listScopes } from './reads.mjs';
import { callTool } from './mcp.mjs';
import { createJob, getJob, jobDetail, listJobs, subscribe } from './jobs.mjs';
import { buildMaintenanceArgs, checkConfirmation, SPEC } from './spec.mjs';
import { createSession, getSession, killSession, listSessions, removeSession, revealSession, runningSessionPids } from './pty.mjs';
import { listHostSessions, isHostRunProcess, isProtectedPid } from './host-sessions.mjs';
import { listDirs } from './dirs.mjs';
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

    // ---- jobs de manutenção ----
    if (route === 'GET /api/jobs') {
      return json(res, 200, { jobs: listJobs(), commands: Object.keys(SPEC) });
    }
    if (route === 'POST /api/jobs') {
      const body = await readJsonBody(req);
      const command = String(body.command || '');
      let built;
      try {
        built = buildMaintenanceArgs(command, body.options ?? {}, { home });
        checkConfirmation(command, body.confirm);
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
      const job = createJob(command, built.args, { timeoutMs: built.timeoutMs, group: built.group });
      return json(res, 201, { id: job.id, command, args: job.displayArgs, group: job.group });
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
