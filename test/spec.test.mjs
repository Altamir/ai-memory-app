import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { buildMaintenanceArgs, checkConfirmation, commandCatalog, confirmationFor, previewArgs, requiresConfirmation, SPEC, GROUPS, SCOPES } from '../server/spec.mjs';

const ctx = { home: os.homedir() };
const scoped = { home: os.homedir(), scope: { workspace: 'default', project: 'zz-workspace' } };

test('SPEC cobre os grupos esperados', () => {
  for (const cmd of ['doctor', 'curator', 'lint', 'forget-sweep', 'finalize-session', 'embed', 'compact', 'reindex', 'purge-project', 'purge-session', 'backup', 'bootstrap', 'backfill']) {
    assert.ok(SPEC[cmd], `faltou ${cmd}`);
  }
});

test('SPEC cobre as ações de recuperação, git e diagnóstico', () => {
  for (const cmd of ['restore', 'checkpoints', 'restore-page', 'commit', 'export-okf', 'reorg', 'llm-test', 'reset', 'auto-improve-report', 'audit-contamination']) {
    assert.ok(SPEC[cmd], `faltou ${cmd} — a CLI tem a ação e o painel precisa expô-la`);
  }
});

test('todo comando tem metadata completa (a tela é gerada daqui)', () => {
  const groupIds = GROUPS.map((g) => g.id);
  for (const [id, entry] of Object.entries(SPEC)) {
    assert.equal(typeof entry.label, 'string', `${id}: label`);
    assert.ok(entry.label.length > 0, `${id}: label vazio`);
    assert.equal(typeof entry.summary, 'string', `${id}: summary`);
    assert.equal(typeof entry.details, 'string', `${id}: details`);
    assert.ok(Array.isArray(entry.sideEffects) && entry.sideEffects.length > 0, `${id}: sideEffects`);
    assert.ok(['global', 'project'].includes(entry.scope), `${id}: scope inválido`);
    assert.ok(groupIds.includes(entry.group), `${id}: grupo desconhecido (${entry.group})`);
    assert.ok(entry.effects && typeof entry.effects === 'object', `${id}: effects`);
    assert.ok(Array.isArray(entry.flags), `${id}: flags`);
    assert.ok(Number.isFinite(entry.timeoutMs) && entry.timeoutMs > 0, `${id}: timeoutMs`);
    assert.equal(typeof entry.args, 'function', `${id}: builder`);
    for (const f of entry.flags) {
      assert.ok(f.key && f.flag && f.type, `${id}: flag incompleta`);
      if (f.required) assert.equal(typeof f.label, 'string', `${id}/${f.key}: flag obrigatória sem label`);
    }
  }
});

test('comando fora da whitelist é rejeitado', () => {
  assert.throws(() => buildMaintenanceArgs('uninstall', {}, ctx), /não permitido/);
  assert.throws(() => buildMaintenanceArgs('auth', {}, ctx), /não permitido/);
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

test('reorg só exige confirmação fora do dry-run', () => {
  assert.equal(confirmationFor('reorg', { dryRun: true }), null);
  assert.equal(confirmationFor('reorg', {}), null); // default é dry-run
  assert.equal(confirmationFor('reorg', { dryRun: false }).word, 'reorg');
  assert.ok(!requiresConfirmation('reorg', { dryRun: true }));
  assert.ok(requiresConfirmation('reorg', { dryRun: false }));
  assert.throws(() => checkConfirmation('reorg', undefined, { dryRun: false }), /confirmação/);
  checkConfirmation('reorg', 'reorg', { dryRun: false });
});

test('todo comando com confirmação tem palavra e dica', () => {
  for (const [id, entry] of Object.entries(SPEC)) {
    if (!entry.confirm) continue;
    assert.equal(typeof entry.confirm.word, 'string', `${id}: palavra`);
    assert.ok(entry.confirm.word.length > 0, `${id}: palavra vazia`);
    assert.ok(entry.confirm.hint, `${id}: sem dica do que vai acontecer`);
  }
  // os destrutivos continuam exigindo a palavra
  for (const id of ['compact', 'reindex', 'purge-project', 'purge-session', 'restore', 'restore-page', 'reset']) {
    assert.ok(requiresConfirmation(id), `${id} deveria exigir confirmação`);
  }
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

test('o escopo do painel entra nos comandos por projeto', () => {
  // o escopo vem logo depois do nome do comando, legível no log
  assert.deepEqual(
    buildMaintenanceArgs('lint', {}, scoped).args,
    ['lint', '--workspace', 'default', '--project', 'zz-workspace', '--no-llm', '--dry-run'],
  );
  // sem escopo escolhido, nada é injetado: a CLI resolve pelo cwd do painel
  assert.deepEqual(buildMaintenanceArgs('lint', {}, ctx).args, ['lint', '--no-llm', '--dry-run']);
  // escopo parcial também vale
  const onlyWs = buildMaintenanceArgs('doctor', {}, { home: '/tmp', scope: { workspace: 'default' } });
  assert.deepEqual(onlyWs.args, ['doctor', '--workspace', 'default']);
});

test('comandos globais nunca recebem escopo', () => {
  const opts = { 'llm-test': { provider: 'openai-compat', model: 'm', prompt: 'p' }, restore: { from: '/tmp/bk.tar.gz' } };
  const globals = ['compact', 'reindex', 'backup', 'checkpoints', 'commit', 'reset', 'reorg', 'llm-test', 'audit-contamination', 'restore'];
  for (const id of globals) {
    const { args } = buildMaintenanceArgs(id, opts[id] ?? {}, scoped);
    assert.ok(!args.includes('--workspace'), `${id} não deveria receber --workspace`);
    assert.ok(!args.includes('--project'), `${id} não deveria receber --project`);
  }
});

test('purge usa o campo próprio ou, vazio, o projeto do escopo', () => {
  assert.throws(() => buildMaintenanceArgs('purge-project', {}, ctx), /inválido|informe o projeto/);
  assert.deepEqual(
    buildMaintenanceArgs('purge-project', { project: 'scratch' }, ctx).args,
    ['purge-project', '--project', 'scratch', '--confirm'],
  );
  // sem campo, cai no seletor de escopo — e o --project não duplica
  const fromScope = buildMaintenanceArgs('purge-project', {}, scoped).args;
  assert.deepEqual(fromScope, ['purge-project', '--workspace', 'default', '--project', 'zz-workspace', '--confirm']);
  assert.equal(fromScope.filter((a) => a === '--project').length, 1);
  // purge-session recebe o escopo para localizar a sessão
  const session = buildMaintenanceArgs('purge-session', { sessionId: 'qualquer-id-123' }, scoped);
  assert.deepEqual(session.args, ['purge-session', '--workspace', 'default', '--project', 'zz-workspace', '--session-id', 'qualquer-id-123', '--confirm']);
});

test('backup gera caminho padrão e aceita override com ~', () => {
  const def = buildMaintenanceArgs('backup', {}, ctx);
  assert.equal(def.args[0], 'backup');
  assert.equal(def.args[1], '-o');
  assert.match(def.args[2], /^\/.*ai-memory-backup-\d{4}-\d{2}-\d{2}T.*\.tar\.gz$/);

  const custom = buildMaintenanceArgs('backup', { out: '~/backups/meu.tar.gz' }, ctx);
  assert.equal(custom.args[2], `${os.homedir()}/backups/meu.tar.gz`);
});

test('restore exige o tarball e aceita ~', () => {
  assert.throws(() => buildMaintenanceArgs('restore', {}, ctx), /tarball de origem/);
  assert.deepEqual(
    buildMaintenanceArgs('restore', { from: '~/bk.tar.gz' }, ctx).args,
    ['restore', '-i', `${os.homedir()}/bk.tar.gz`],
  );
  assert.deepEqual(
    buildMaintenanceArgs('restore', { from: '/tmp/bk.tar.gz', force: true }, ctx).args,
    ['restore', '-i', '/tmp/bk.tar.gz', '--force'],
  );
});

test('restore-page e export-okf dependem do projeto do escopo', () => {
  assert.throws(() => buildMaintenanceArgs('export-okf', {}, ctx), /projeto|inválido/);
  const okf = buildMaintenanceArgs('export-okf', { out: '/tmp/x.tar.gz' }, scoped);
  assert.deepEqual(okf.args, ['export-okf', '--workspace', 'default', '--project', 'zz-workspace', '--to', '/tmp/x.tar.gz']);

  assert.throws(() => buildMaintenanceArgs('restore-page', { path: 'notes/a.md' }, ctx), /checkpoint/);
  assert.deepEqual(
    buildMaintenanceArgs('restore-page', { path: 'notes/a.md', from: 'HEAD~1' }, scoped).args,
    ['restore-page', '--workspace', 'default', '--project', 'zz-workspace', '--path', 'notes/a.md', '--from', 'HEAD~1'],
  );
});

test('reorg, reset, commit, checkpoints e llm-test montam os args certos', () => {
  assert.deepEqual(buildMaintenanceArgs('reorg', {}, ctx).args, ['reorg', '--dry-run']);
  assert.deepEqual(buildMaintenanceArgs('reorg', { dryRun: false }, ctx).args, ['reorg']);
  assert.deepEqual(buildMaintenanceArgs('reset', {}, ctx).args, ['reset', '--confirm']);
  assert.deepEqual(buildMaintenanceArgs('checkpoints', {}, ctx).args, ['checkpoints']);
  assert.deepEqual(buildMaintenanceArgs('checkpoints', { limit: 5 }, ctx).args, ['checkpoints', '-n', '5']);
  assert.deepEqual(buildMaintenanceArgs('commit', {}, ctx).args, ['commit']);
  assert.deepEqual(buildMaintenanceArgs('commit', { message: 'antes do purge' }, ctx).args, ['commit', '-m', 'antes do purge']);
  assert.deepEqual(
    buildMaintenanceArgs('llm-test', { provider: 'openai-compat', model: 'llama3.1:8b', prompt: 'ok' }, ctx).args,
    ['llm-test', '--provider', 'openai-compat', '--model', 'llama3.1:8b', '--prompt', 'ok'],
  );
  // o erro nomeia o campo que falta (é o texto que aparece no toast do painel)
  assert.throws(() => buildMaintenanceArgs('llm-test', { provider: 'openai-compat' }, ctx), /campo "modelo" é obrigatório/);
});

test('audit-contamination aceita restrição por projeto só com os dois campos', () => {
  assert.deepEqual(buildMaintenanceArgs('audit-contamination', {}, ctx).args, ['audit-contamination']);
  assert.deepEqual(
    buildMaintenanceArgs('audit-contamination', { workspace: 'default', project: 'x' }, ctx).args,
    ['audit-contamination', '--workspace', 'default', '--project', 'x'],
  );
  assert.throws(() => buildMaintenanceArgs('audit-contamination', { project: 'x' }, ctx), /workspace E projeto/);
  assert.throws(() => buildMaintenanceArgs('audit-contamination', { workspace: 'default' }, ctx), /workspace E projeto/);
});

test('strings de opção não aceitam vazio', () => {
  assert.deepEqual(buildMaintenanceArgs('curator', { stage: true }, ctx).args, ['curator', '--dry-run', '--stage']);
  assert.deepEqual(buildMaintenanceArgs('curator', { dryRun: false, stage: true }, ctx).args, ['curator', '--stage']);
  assert.deepEqual(buildMaintenanceArgs('commit', { message: '   ' }, ctx).args, ['commit']);
  assert.deepEqual(buildMaintenanceArgs('finalize-session', { agent: '  ' }, ctx).args, ['finalize-session', '--all']);
});

test('preview mostra a linha de comando sem executar, com defaults da tela', () => {
  assert.deepEqual(previewArgs('doctor', {}, ctx), ['doctor', '--since-days', '30']);
  assert.deepEqual(
    previewArgs('doctor', {}, scoped),
    ['doctor', '--workspace', 'default', '--project', 'zz-workspace', '--since-days', '30'],
  );
  // estrito (é o que o botão Executar usa): obrigatório faltando é erro
  assert.throws(() => previewArgs('restore-page', {}, scoped), /campo "caminho da página" é obrigatório/);
  // com fill (modal de ajuda), obrigatório faltando vira placeholder legível
  const rp = previewArgs('restore-page', {}, { ...scoped, fill: true });
  assert.deepEqual(rp.slice(0, 7), ['restore-page', '--workspace', 'default', '--project', 'zz-workspace', '--path', '<caminho da página>']);
  assert.match(rp.join(' '), /--from <checkpoint/);
  // valores informados vencem o default
  assert.deepEqual(previewArgs('doctor', { sinceDays: 7 }, ctx), ['doctor', '--since-days', '7']);
});

test('catálogo expõe grupos, escopos e comandos coerentes', () => {
  const cat = commandCatalog();
  assert.equal(cat.commands.length, Object.keys(SPEC).length);
  assert.deepEqual(cat.scopes, SCOPES);
  assert.ok(cat.groups.some((g) => g.id === 'danger'));
  for (const cmd of cat.commands) {
    assert.ok(SPEC[cmd.id], `${cmd.id} fora do SPEC`);
    assert.equal(cmd.scope, SPEC[cmd.id].scope);
    assert.ok(['none', 'selector', 'own-flag'].includes(cmd.scopeInput), `${cmd.id}: scopeInput`);
    if (cmd.scope === 'project') assert.notEqual(cmd.scopeInput, 'none', `${cmd.id}: comando por projeto sem origem de escopo`);
    if (cmd.scope === 'global') assert.equal(cmd.scopeInput, 'none', `${cmd.id}: global não usa seletor`);
  }
  // os destrutivos ficam na zona de perigo e os de recuperação no grupo próprio
  assert.equal(cat.commands.find((c) => c.id === 'purge-project').group, 'danger');
  assert.equal(cat.commands.find((c) => c.id === 'restore').group, 'recovery');
  assert.equal(cat.commands.find((c) => c.id === 'backup').group, 'recovery');
});
