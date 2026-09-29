import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePsOutput, parseLsofCwd } from '../server/host-sessions.mjs';

const SAMPLE = `  PID TTY           STARTED      COMMAND
  30784 ttys004    Mon Sep 28 10:25:40 2026 ai-memory run grok
  59571 ttys006    Mon Sep 28 21:25:06 2026 ai-memory run opencode
    94365 ttys007   Tue Sep 29 08:45:16 2026 node server/index.mjs
  60001 ttys008    Tue Sep 29 09:00:00 2026 /Users/alt-zz/.local/bin/ai-memory run claude
  60002 ??         Tue Sep 29 09:00:00 2026 ai-memory continue
  60003 ttys009    Tue Sep 29 09:00:00 2026 ai-memory run
  60004 ttys010    Tue Sep 29 09:00:00 2026 vim notas.txt
  60005 ttys011    Tue Sep 29 09:00:00 2026 grep ai-memory run algo`;

test('detecta runs iniciados no terminal do usuário', () => {
  const items = parsePsOutput(SAMPLE);
  const pids = items.map((p) => p.pid);
  assert.deepEqual(pids, [30784, 59571, 60001, 60002, 60003]);
});

test('extrai harness, tty, kind e data', () => {
  const items = parsePsOutput(SAMPLE);
  const grok = items.find((p) => p.pid === 30784);
  assert.equal(grok.harness, 'grok');
  assert.equal(grok.tty, 'ttys004');
  assert.equal(grok.kind, 'run');
  const d = new Date(grok.started);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 8); // Sep
  assert.equal(d.getDate(), 28);
});

test('caminho completo do binário também casa', () => {
  const claude = parsePsOutput(SAMPLE).find((p) => p.pid === 60001);
  assert.equal(claude.harness, 'claude');
  assert.equal(claude.kind, 'run');
});

test('sem tty mostra null; continue/resume têm kind próprio', () => {
  const items = parsePsOutput(SAMPLE);
  const cont = items.find((p) => p.pid === 60002);
  assert.equal(cont.tty, null);
  assert.equal(cont.kind, 'continue');
  assert.equal(cont.harness, null);
});

test('run sem harness explícito tem harness null', () => {
  const run = parsePsOutput(SAMPLE).find((p) => p.pid === 60003);
  assert.equal(run.kind, 'run');
  assert.equal(run.harness, null);
});

test('linhas não relacionadas são ignoradas', () => {
  const pids = parsePsOutput(SAMPLE).map((p) => p.pid);
  assert.ok(!pids.includes(94365)); // node server
  assert.ok(!pids.includes(60004)); // vim
  assert.ok(!pids.includes(60005)); // grep que menciona "ai-memory run" no meio do comando
});

test('texto vazio devolve lista vazia', () => {
  assert.deepEqual(parsePsOutput(''), []);
});

test('parseLsofCwd extrai o caminho após "n/"', () => {
  const out = 'p30784\nfcwd\nn/Users/alt-zz/projetos/arezzo/zz-workspace\n';
  assert.equal(parseLsofCwd(out), '/Users/alt-zz/projetos/arezzo/zz-workspace');
  assert.equal(parseLsofCwd('p30784\nfcwd\n'), null);
  assert.equal(parseLsofCwd(''), null);
});
