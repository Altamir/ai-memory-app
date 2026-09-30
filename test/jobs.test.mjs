import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunnerJob, getJob } from '../server/jobs.mjs';

// O runner job é o que dá log ao vivo (SSE) para operações que não são um
// subprocesso único — hoje a importação de memórias.

async function waitDone(id, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = getJob(id);
    if (job && job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('job não terminou a tempo');
}

test('runner job: log por linha e status ok', async () => {
  const job = createRunnerJob('teste-ok', {
    run: async ({ log }) => {
      log('out', 'primeira linha');
      log('sys', 'nota do sistema');
      log('out', 'segunda linha\n');
    },
  });
  assert.equal(job.status, 'running');
  const done = await waitDone(job.id);
  assert.equal(done.status, 'ok');
  assert.equal(done.exitCode, 0);
  const text = done.lines.map((l) => l.text).join('');
  assert.match(text, /primeira linha\n/);
  assert.match(text, /segunda linha\n/);
  assert.match(text, /— fim \(ok\) —/);
  assert.ok(done.lines.some((l) => l.kind === 'sys' && /nota do sistema/.test(l.text)));
});

test('runner job: erro do run vira status error com a mensagem no log', async () => {
  const job = createRunnerJob('teste-erro', {
    run: async ({ log }) => {
      log('out', 'começando');
      throw new Error('deu ruim no item 3');
    },
  });
  const done = await waitDone(job.id);
  assert.equal(done.status, 'error');
  assert.equal(done.exitCode, 1);
  const text = done.lines.map((l) => l.text).join('');
  assert.match(text, /deu ruim no item 3/);
  assert.ok(done.lines.some((l) => l.kind === 'err'));
});

test('runner job: aparece no detail com contagem de linhas', async () => {
  const job = createRunnerJob('teste-detail', { run: async ({ log }) => log('out', 'x') });
  await waitDone(job.id);
  const detail = getJob(job.id);
  assert.equal(detail.command, 'teste-detail');
  assert.ok(detail.lines.length >= 1);
  assert.ok(detail.endedAt >= detail.startedAt);
});
