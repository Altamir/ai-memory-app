import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { buildMaintenanceArgs, checkConfirmation, SPEC, requiresConfirmation } from '../server/spec.mjs';

const ctx = { home: os.homedir() };

test('SPEC cobre os grupos esperados', () => {
  for (const cmd of ['doctor', 'curator', 'lint', 'forget-sweep', 'finalize-session', 'embed', 'compact', 'reindex', 'purge-project', 'purge-session', 'backup', 'bootstrap', 'backfill']) {
    assert.ok(SPEC[cmd], `faltou ${cmd}`);
  }
});

test('comando fora da whitelist é rejeitado', () => {
  assert.throws(() => buildMaintenanceArgs('reset', { confirm: true }, ctx), /não permitido/);
  assert.throws(() => buildMaintenanceArgs('hook', {}, ctx), /não permitido/);
  assert.throws(() => buildMaintenanceArgs('rm -rf /', {}, ctx), /não permitido/);
});

test('compact sempre recebe --confirm', () => {
  const built = buildMaintenanceArgs('compact', {}, ctx);
  assert.deepEqual(built.args, ['compact', '--confirm']);
  assert.equal(built.group, 'danger');
});

test('confirmação digitada é validada', () => {
  assert.ok(requiresConfirmation('compact'));
  assert.ok(!requiresConfirmation('doctor'));
  assert.throws(() => checkConfirmation('compact', 'compact '), /confirmação/);
  assert.throws(() => checkConfirmation('compact', undefined), /confirmação/);
  checkConfirmation('compact', 'compact'); // ok
});

test('flags numéricas são validadas', () => {
  assert.deepEqual(buildMaintenanceArgs('doctor', { sinceDays: 7 }, ctx).args, ['doctor', '--since-days', '7']);
  assert.throws(() => buildMaintenanceArgs('doctor', { sinceDays: -1 }, ctx), /número inválido/);
  assert.throws(() => buildMaintenanceArgs('doctor', { sinceDays: 'abc' }, ctx), /número inválido/);
  assert.deepEqual(buildMaintenanceArgs('doctor', {}, ctx).args, ['doctor']);
});

test('flags booleanas respeitam defaults', () => {
  // lint: noLlm e dryRun default true
  assert.deepEqual(buildMaintenanceArgs('lint', {}, ctx).args, ['lint', '--no-llm', '--dry-run']);
  assert.deepEqual(buildMaintenanceArgs('lint', { noLlm: false, dryRun: false }, ctx).args, ['lint']);
  // forget-sweep: dryRun default true, rodada real remove a flag
  assert.deepEqual(buildMaintenanceArgs('forget-sweep', {}, ctx).args, ['forget-sweep', '--dry-run']);
  assert.deepEqual(buildMaintenanceArgs('forget-sweep', { dryRun: false }, ctx).args, ['forget-sweep']);
});

test('purge exige argumentos obrigatórios', () => {
  assert.throws(() => buildMaintenanceArgs('purge-project', {}, ctx), /inválido/);
  assert.deepEqual(
    buildMaintenanceArgs('purge-project', { project: 'scratch' }, ctx).args,
    ['purge-project', '--project', 'scratch', '--confirm'],
  );
  // sem shell: o valor é passado como um único argv, então metacaracteres são inofensivos
  const session = buildMaintenanceArgs('purge-session', { sessionId: 'qualquer-id-123' }, ctx);
  assert.deepEqual(session.args, ['purge-session', '--session-id', 'qualquer-id-123', '--confirm']);
});

test('backup gera caminho padrão e aceita override com ~', () => {
  const def = buildMaintenanceArgs('backup', {}, ctx);
  assert.equal(def.args[0], 'backup');
  assert.equal(def.args[1], '-o');
  assert.match(def.args[2], /^\/.*ai-memory-backup-\d{4}-\d{2}-\d{2}T.*\.tar\.gz$/);

  const custom = buildMaintenanceArgs('backup', { out: '~/backups/meu.tar.gz' }, ctx);
  assert.equal(custom.args[2], `${os.homedir()}/backups/meu.tar.gz`);
});

test('strings de opção não aceitam vazio', () => {
  assert.deepEqual(buildMaintenanceArgs('curator', { stage: '  ' }, ctx).args.filter((a) => a === '--stage'), []);
  assert.deepEqual(buildMaintenanceArgs('curator', { stage: 'obsidian' }, ctx).args, ['curator', '--dry-run', '--stage', 'obsidian']);
});
