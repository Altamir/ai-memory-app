import test from 'node:test';
import assert from 'node:assert/strict';
import { makeImportFixture, kiroSqliteRows } from './import-fixtures.mjs';

// Importação do Kiro: steering (global e por projeto, inclusive 'inclusion:
// always' → _rules), memórias semantic agrupadas por projeto, episodic por dia
// e os diários do crew — com sqlite injetado (sem depender do binário sqlite3).

const fx = makeImportFixture();
process.env.AIM_IMPORT_KIRO_DIR = fx.kiroDir;
process.env.AI_MEMORY_DATA_DIR = fx.dataDir;
process.env.AIM_APP_IMPORT_FILE = fx.stateFile;

const { scanKiro } = await import('../server/import-kiro.mjs');
const { scanImportSource } = await import('../server/import.mjs');

const links = [
  { workspace: 'default', project: 'proj-a', path: fx.repoA },
];

const sqliteQuery = async (_db, sql) => kiroSqliteRows(sql);

test('steering: global vira regra em _global e o do projeto vai para o projeto', async () => {
  const scan = await scanKiro({ kiroDir: fx.kiroDir, links, sqliteQuery });
  const steering = scan.items.filter((i) => i.originKind === 'steering');
  assert.equal(steering.length, 2);

  const globalRule = steering.find((i) => i.title === 'Regra global do Kiro');
  assert.equal(globalRule.suggested.path, '_rules/regra-global-do-kiro.md');
  assert.equal(globalRule.suggested.kind, 'rule');
  assert.equal(globalRule.suggested.pinned, true);
  assert.deepEqual(globalRule.targetHint, { kind: 'global' });

  const projTech = steering.find((i) => i.title === 'Stack do proj-a');
  assert.equal(projTech.suggested.path, '_rules/stack-do-proj-a.md');
  assert.deepEqual(projTech.targetHint.target.workspace, 'default');
  assert.deepEqual(projTech.targetHint.target.project, 'proj-a');
  // o frontmatter de origem não vaza para o corpo
  assert.equal(projTech.body.startsWith('# Stack do proj-a'), true);
  assert.equal(projTech.body.includes('inclusion'), false);
});

test('semantic: agrupa por projeto e resolve o destino pelo <slug>.path', async () => {
  const scan = await scanKiro({ kiroDir: fx.kiroDir, links, sqliteQuery });
  const semantic = scan.items.filter((i) => i.originKind === 'semantic');
  assert.equal(semantic.length, 2); // projeto showcase + chaves gerais

  const showcase = semantic.find((i) => i.key.endsWith(':showcase'));
  assert.equal(showcase.suggested.path, 'notes/imported/kiro/semantic-showcase.md');
  assert.match(showcase.body, /acme-service-alpha/);
  assert.match(showcase.body, /confiança 0\.80/);
  // sem link para o path do showcase → cai no _global (com aviso no targetReason)
  assert.deepEqual(showcase.targetHint, { kind: 'global' });

  const geral = semantic.find((i) => i.key.endsWith(':geral'));
  assert.equal(geral.title, 'Kiro · memórias gerais');
  assert.match(geral.body, /timezone/);
});

test('episodic: agrupa por dia, cru e tier episodic', async () => {
  const scan = await scanKiro({ kiroDir: fx.kiroDir, links, sqliteQuery, includeRaw: true });
  const episodic = scan.items.filter((i) => i.originKind === 'episodic');
  assert.equal(episodic.length, 2);
  const dia3 = episodic.find((i) => i.key.endsWith(':2026-01-03'));
  assert.equal(dia3.raw, true);
  assert.equal(dia3.suggested.tier, 'episodic');
  assert.match(dia3.suggested.path, /notes\/imported\/kiro\/episodic-2026-01-03\.md/);
  assert.match(dia3.body, /pool de MCP/);
  assert.match(dia3.body, /#deploy/);
});

test('includeRaw=false deixa os episódicos de fora', async () => {
  const scan = await scanKiro({ kiroDir: fx.kiroDir, links, sqliteQuery, includeRaw: false });
  assert.equal(scan.items.some((i) => i.originKind === 'episodic'), false);
});

test('sqlite indisponível degrada com aviso, sem perder o resto', async () => {
  const scan = await scanKiro({
    kiroDir: fx.kiroDir,
    links,
    sqliteQuery: async () => {
      throw new Error('sqlite3 não encontrado');
    },
  });
  assert.ok(scan.warnings.some((w) => /sqlite3 não encontrado/.test(w)));
  assert.ok(scan.items.some((i) => i.originKind === 'steering'));
  assert.ok(scan.items.some((i) => i.originKind === 'history'));
  assert.equal(scan.items.some((i) => i.originKind === 'semantic'), false);
});

test('diários do crew entram como itens crus no _global', async () => {
  const scan = await scanKiro({ kiroDir: fx.kiroDir, links, sqliteQuery });
  const history = scan.items.find((i) => i.originKind === 'history');
  assert.equal(history.raw, true);
  assert.equal(history.suggested.path, 'notes/imported/kiro/history-2026-01-05.md');
  assert.deepEqual(history.targetHint, { kind: 'global' });
});

test('pelo orquestrador: destinos resolvidos e status do scan', async () => {
  const scan = await scanImportSource('kiro', { links, sqliteQuery });
  const projTech = scan.items.find((i) => i.title === 'Stack do proj-a');
  assert.deepEqual(projTech.target, { workspace: 'default', project: 'proj-a' });
  assert.match(projTech.targetReason, /steering do projeto/);
  const globalRule = scan.items.find((i) => i.title === 'Regra global do Kiro');
  assert.deepEqual(globalRule.target, { global: true });
  assert.equal(globalRule.status, 'new');
  assert.ok(scan.summary.total >= 7);
});
