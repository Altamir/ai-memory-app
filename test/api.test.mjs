import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4799;
const BASE = `http://127.0.0.1:${PORT}`;

let child;

async function waitHealthFor(base, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return true;
    } catch {
      // ainda não subiu
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

const waitHealth = () => waitHealthFor(BASE);

function spawnServer(port, extraEnv = {}) {
  return spawn('node', ['server/index.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      AIM_APP_PORT: String(port),
      AI_MEMORY_BIN: '/bin/echo', // jobs "rodam" echo: pipeline testado sem tocar no ai-memory
      ...extraEnv,
    },
    stdio: 'ignore',
  });
}

test.before(async () => {
  child = spawnServer(PORT);
  assert.ok(await waitHealth(), 'servidor de teste não subiu');
});

test.after(() => {
  if (child) child.kill('SIGTERM');
});

test('health responde', async () => {
  const res = await fetch(`${BASE}/api/health`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
});

test('estáticos: index.html é servido e traversal é bloqueado', async () => {
  const index = await fetch(`${BASE}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type') || '', /text\/html/);
  assert.match(await index.text(), /ai-memory · painel/);

  const traversal = await fetch(`${BASE}/..%2f..%2f..%2fetc%2fpasswd`);
  assert.ok(traversal.status === 403 || traversal.status === 404, `status inesperado ${traversal.status}`);
});

test('POST /api/jobs rejeita comando fora da whitelist', async () => {
  const res = await fetch(`${BASE}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'reset', options: {} }),
  });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.match(data.error, /não permitido/);
});

test('POST /api/jobs exige confirmação digitada para compact', async () => {
  const res = await fetch(`${BASE}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'compact', options: {}, confirm: 'outra-coisa' }),
  });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.match(data.error, /confirmação/);
});

test('POST /api/jobs executa job (binário de teste) e history registra', async () => {
  const created = await fetch(`${BASE}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'doctor', options: { sinceDays: 7 } }),
  });
  assert.equal(created.status, 201);
  const { id } = await created.json();
  assert.ok(id);

  // aguarda término (echo sai imediatamente)
  let job = null;
  for (let i = 0; i < 40; i += 1) {
    job = await (await fetch(`${BASE}/api/jobs/${id}`)).json();
    if (job.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(job.status, 'ok');
  assert.equal(job.exitCode, 0);

  const history = await (await fetch(`${BASE}/api/jobs`)).json();
  assert.ok(history.jobs.some((j) => j.id === id));
});

test('SSE do job responde com event-stream', async () => {
  const created = await fetch(`${BASE}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'audit-contamination', options: {} }),
  });
  const { id } = await created.json();
  const res = await fetch(`${BASE}/api/jobs/${id}/stream`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
  await res.body.cancel();
});

test('POST /api/sessions valida harness e diretório', async () => {
  const badHarness = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ harness: 'bash', cwd: '/tmp' }),
  });
  assert.equal(badHarness.status, 400);
  assert.match((await badHarness.json()).error, /harness inválido/);

  const badCwd = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ harness: 'opencode', cwd: '/caminho/inexistente/xyz' }),
  });
  assert.equal(badCwd.status, 400);
});

test('GET /api/dirs navega sob o home e rejeita fora dele', async () => {
  const ok = await (await fetch(`${BASE}/api/dirs`)).json();
  assert.ok(Array.isArray(ok.dirs));
  assert.ok(ok.home && ok.path.startsWith(ok.home), 'path deve ficar sob o home');

  const bad = await fetch(`${BASE}/api/dirs?path=/etc`);
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /restrita ao diretório home/);
});

test('GET /api/workstreams devolve lista de itens', async () => {
  const res = await (await fetch(`${BASE}/api/workstreams`)).json();
  assert.ok(Array.isArray(res.items));
});

test('sessão criada termina e pode ser excluída da lista', async () => {
  const created = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ harness: 'opencode', cwd: '/tmp' }), // pty do /bin/echo sai na hora
  });
  assert.equal(created.status, 201);
  const { id } = await created.json();

  let status = 'running';
  for (let i = 0; i < 40; i += 1) {
    const list = await (await fetch(`${BASE}/api/sessions`)).json();
    status = list.sessions.find((x) => x.id === id)?.status;
    if (status && status !== 'running') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(status, 'ended');

  const del = await fetch(`${BASE}/api/sessions/${id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  const list = await (await fetch(`${BASE}/api/sessions`)).json();
  assert.ok(!list.sessions.some((x) => x.id === id), 'sessão excluída não deve mais aparecer');

  const delAgain = await fetch(`${BASE}/api/sessions/${id}`, { method: 'DELETE' });
  assert.equal(delAgain.status, 404);
});

test('GET /api/host-sessions devolve processos vivos e recusa pid alheio', async () => {
  const res = await (await fetch(`${BASE}/api/host-sessions`)).json();
  assert.ok(Array.isArray(res.items));
  for (const item of res.items) {
    assert.ok(Number.isInteger(item.pid));
    assert.ok(['run', 'show', 'continue', 'resume'].includes(item.kind));
  }

  // validação de pid: 1 é estruturalmente inválido; 999999 é válido mas não é um run vivo
  const pid1 = await fetch(`${BASE}/api/host-sessions/kill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pid: 1 }),
  });
  assert.equal(pid1.status, 400);

  const unknown = await fetch(`${BASE}/api/host-sessions/kill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pid: 999999 }),
  });
  assert.equal(unknown.status, 404);

  const invalid = await fetch(`${BASE}/api/host-sessions/kill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pid: 'abc' }),
  });
  assert.equal(invalid.status, 400);
});

test('sessões sobrevivem à reinicialização do painel (persistência)', async () => {
  const stateFile = path.join(os.tmpdir(), `aim-state-test-${Date.now()}.json`);
  const PORT2 = 4798;
  const BASE2 = `http://127.0.0.1:${PORT2}`;
  let s2 = spawnServer(PORT2, { AIM_APP_STATE_FILE: stateFile });
  try {
    assert.ok(await waitHealthFor(BASE2), 'servidor 4798 não subiu');

    const created = await fetch(`${BASE2}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ harness: 'opencode', cwd: '/tmp' }),
    });
    assert.equal(created.status, 201);
    const { id } = await created.json();

    // aguarda o pty do echo terminar
    for (let i = 0; i < 40; i += 1) {
      const list = await (await fetch(`${BASE2}/api/sessions`)).json();
      if (list.sessions.find((x) => x.id === id)?.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 100));
    }

    // "reinicialização": mata o processo e sobe outro com o mesmo arquivo de estado
    s2.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 400));
    s2 = spawnServer(PORT2, { AIM_APP_STATE_FILE: stateFile });
    assert.ok(await waitHealthFor(BASE2), 'servidor reiniciado não subiu');

    const list = await (await fetch(`${BASE2}/api/sessions`)).json();
    const recovered = list.sessions.find((x) => x.id === id);
    assert.ok(recovered, 'card da sessão deve reaparecer após restart');
    assert.equal(recovered.status, 'ended');
    assert.equal(recovered.lostIo, true);
    assert.match(recovered.endedNote, /reinicialização/);
  } finally {
    s2.kill('SIGTERM');
    fs.rmSync(stateFile, { force: true });
  }
});
