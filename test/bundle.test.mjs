import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createTarGz, readTarGz } from '../server/tar.mjs';
import { makeBundleFixture, makeOkfBundle } from './bundle-fixtures.mjs';

// Exportação: a lista de páginas vem do SQLite (is_latest = 1) e o conteúdo do
// wiki em disco — arquivos que não são páginas (log-*.md, _pending/) ficam fora.

const fx = makeBundleFixture();
process.env.AIM_STORE_DIR = fx.storeDir;
process.env.AIM_APP_EXPORT_DIR = fx.exportsDir;
process.env.AI_MEMORY_DATA_DIR = fx.dataDir;
process.env.AIM_APP_IMPORT_FILE = fx.stateFile;

const bundle = await import('../server/bundle.mjs');
const { isRawPage, kindForWrite, tierForWrite, parsePageFrontmatter } = bundle;
const requireSqlite = { skip: fx.hasSqlite ? false : 'sqlite3 ausente no PATH' };

const tarNames = (file) => readTarGz(fs.readFileSync(file)).entries.map((e) => e.name);

test('classificação pura: raw, kind e tier de escrita', () => {
  assert.equal(isRawPage({ path: 'sessions/x.md' }), true);
  assert.equal(isRawPage({ path: 'logs/x.md' }), true);
  assert.equal(isRawPage({ path: 'log-2026-01.md' }), true);
  assert.equal(isRawPage({ path: 'notes/x.md', tier: 'episodic' }), true);
  assert.equal(isRawPage({ path: 'notes/x.md', tier: 'semantic' }), false);

  assert.equal(kindForWrite('note'), 'fact');
  assert.equal(kindForWrite('concept'), 'fact');
  assert.equal(kindForWrite('rule'), 'rule');
  assert.equal(kindForWrite('lint-report', '_rules/x.md'), 'rule');
  assert.equal(kindForWrite(null, 'gotchas/x.md'), 'gotcha');
  assert.equal(kindForWrite(null, 'decisions/x.md'), 'decision');
  assert.equal(kindForWrite(null, ''), 'fact');

  assert.equal(tierForWrite('semantic'), 'semantic');
  assert.equal(tierForWrite('qualquer', 'sessions/x.md'), 'episodic');
  assert.equal(tierForWrite(null, 'notes/x.md'), 'semantic');
});

test('frontmatter: escalares, listas em bloco, inline e mapa aninhado', () => {
  const { meta, body } = parsePageFrontmatter(`---
kind: rule
title: Regra
tier: procedural
pinned: true
tags:
- a
- b
tags_inline: [x, y]
generated:
  by: process:ai-memory/2.4.0
sources: []
---
# Regra

Corpo.
`);
  assert.equal(meta.kind, 'rule');
  assert.equal(meta.pinned, 'true');
  assert.deepEqual(meta.tags, ['a', 'b']);
  assert.deepEqual(meta.tags_inline, ['x', 'y']);
  assert.deepEqual(meta.sources, []);
  assert.equal(meta.generated, undefined); // mapa aninhado não interessa
  assert.equal(body, '# Regra\n\nCorpo.\n');
});

test('store: escopos e contagens vêm do SQLite', requireSqlite, async () => {
  const info = await bundle.listStoreScopes();
  assert.equal(info.available, true);
  assert.deepEqual(info.scopes.map((s) => `${s.workspace}/${s.project}`).sort(), ['default/_global', 'default/proj-a']);
  assert.equal(info.totals.pages, fx.expected.all);
  assert.equal(info.totals.raw, fx.expected.raw);
  assert.equal(info.totals.scopes, 2);
  const projA = info.scopes.find((s) => s.project === 'proj-a');
  assert.equal(projA.repoPath, '/tmp/repos/proj-a');
  assert.equal(projA.pinned, 1);
  assert.equal(projA.tiers.episodic, 1);
  assert.equal(info.scopes.find((s) => s.project === '_global').global, true);
});

test('plano (dry-run) não escreve nada e resume o que entraria', requireSqlite, async () => {
  const plan = await bundle.planBundle({ scopes: [{ workspace: 'default', project: 'proj-a' }] });
  assert.match(plan.file, /^ai-memory-bundle-.*\.tar\.gz$/);
  assert.equal(plan.pages, fx.expected.projCurated);
  assert.equal(plan.rawSkipped, 1);
  assert.ok(plan.bytes > 0);
  assert.equal(plan.scopes.length, 1);
  assert.equal(plan.scopes[0].rawSkipped, 1);
  assert.ok(plan.preview.length >= 4);
  assert.ok(plan.preview.every((p) => p.scope === 'default/proj-a' && p.path.endsWith('.md')));
  assert.equal(fs.existsSync(fx.exportsDir) && fs.readdirSync(fx.exportsDir).length, false);
});

test('bundle: manifesto, _meta.md por escopo e só páginas do SQLite', requireSqlite, async () => {
  const logs = [];
  const built = await bundle.buildBundle({
    scopes: [{ workspace: 'default', project: 'proj-a' }, { workspace: 'default', project: '_global' }],
    includeRaw: false,
    name: 'meu-bundle',
    log: (kind, text) => logs.push(`${kind}:${text}`),
  });

  assert.equal(built.fileName, 'meu-bundle.tar.gz');
  assert.equal(built.manifestOk, true, 'a releitura do bundle deve conferir');
  assert.equal(built.pages, fx.expected.curated);
  assert.equal(built.skippedRaw, 1);
  assert.match(logs.join(''), /verificação ok/);

  const names = tarNames(built.file);
  assert.equal(names[0], 'README.md');
  assert.equal(names[1], 'manifest.json');
  assert.ok(names.includes('scopes/default/proj-a/_meta.md'));
  assert.ok(names.includes('scopes/default/_global/_meta.md'));
  assert.ok(names.includes('scopes/default/proj-a/_rules/sempre-testar.md'));
  assert.ok(names.includes('scopes/default/_global/notes/estilo-zzportal.md'));
  assert.ok(names.includes('scopes/default/proj-a/notes/so-no-db.md'), 'página que só existe no SQLite entra pelo corpo do banco');

  // o que NÃO é página ficou fora: log do wiki, propostas pendentes, versão antiga, sessão crua
  assert.ok(!names.some((n) => n.includes('log-2026-01.md')));
  assert.ok(!names.some((n) => n.includes('_pending/')));
  assert.ok(!names.includes('scopes/default/proj-a/sessions/2026-01-02-sessao.md'));

  const manifest = JSON.parse(readTarGz(fs.readFileSync(built.file)).entries.find((e) => e.name === 'manifest.json').data.toString('utf8'));
  assert.equal(manifest.format, 'ai-memory-bundle');
  assert.equal(manifest.version, 1);
  assert.equal(manifest.totals.pages, fx.expected.curated);
  assert.equal(manifest.totals.scopes, 2);
  assert.equal(manifest.includeRaw, false);
  const rule = manifest.pages.find((p) => p.path === '_rules/sempre-testar.md');
  assert.equal(rule.kind, 'rule');
  assert.equal(rule.tier, 'procedural');
  assert.equal(rule.pinned, true);
  assert.deepEqual(rule.tags, ['testes', 'disciplina']);
  assert.ok(rule.sha256 && rule.bytes > 0);
  assert.equal(rule.scope, 'default/proj-a');

  const meta = readTarGz(fs.readFileSync(built.file)).entries.find((e) => e.name === 'scopes/default/proj-a/_meta.md').data.toString('utf8');
  assert.match(meta, /workspace: default/);
  assert.match(meta, /project: proj-a/);

  const readme = readTarGz(fs.readFileSync(built.file)).entries.find((e) => e.name === 'README.md').data.toString('utf8');
  assert.match(readme, /Como importar/);
  assert.match(readme, /default\/proj-a/);
});

test('includeRaw: true leva as páginas cruas junto', requireSqlite, async () => {
  const built = await bundle.buildBundle({ scopes: [{ workspace: 'default', project: 'proj-a' }], includeRaw: true, name: 'com-cruas', log: () => {} });
  const names = tarNames(built.file);
  assert.ok(names.includes('scopes/default/proj-a/sessions/2026-01-02-sessao.md'));
  assert.equal(built.pages, fx.expected.projAll);
});

test('scan do bundle: itens com destino de origem, kind/tier/tags e raw', requireSqlite, async () => {
  const built = await bundle.buildBundle({
    scopes: [{ workspace: 'default', project: 'proj-a' }, { workspace: 'default', project: '_global' }],
    includeRaw: true,
    name: 'para-scan',
    log: () => {},
  });
  const scan = await bundle.scanBundleCandidates(built.file, { includeRaw: true });
  assert.deepEqual(scan.scopes, ['default/_global', 'default/proj-a']);
  assert.equal(scan.items.length, fx.expected.all);
  assert.deepEqual(scan.warnings, []);

  const rule = scan.items.find((i) => i.key === 'bundle|default/proj-a|_rules/sempre-testar.md');
  assert.deepEqual(rule.targetHint, { kind: 'bundle', target: { workspace: 'default', project: 'proj-a' } });
  assert.deepEqual(rule.suggested, { path: '_rules/sempre-testar.md', kind: 'rule', tier: 'procedural', pinned: true, tags: ['testes', 'disciplina'] });
  assert.equal(rule.raw, false);
  assert.match(rule.body, /Rodar os testes/);
  assert.ok(!rule.body.includes('---'), 'o corpo vai sem frontmatter');

  const global = scan.items.find((i) => i.key === 'bundle|default/_global|notes/estilo-zzportal.md');
  assert.deepEqual(global.targetHint, { kind: 'global' });
  assert.deepEqual(global.suggested.tags, ['ui', 'zzportal']);

  const session = scan.items.find((i) => i.suggested.path.startsWith('sessions/'));
  assert.equal(session.raw, true);
  assert.equal(session.suggested.tier, 'episodic');

  // sem cruas, a sessão sai da lista
  const curatedOnly = await bundle.scanBundleCandidates(built.file, { includeRaw: false });
  assert.equal(curatedOnly.items.length, fx.expected.curated);
  assert.ok(!curatedOnly.items.some((i) => i.key.includes('sessions/')));

  const one = await bundle.getBundleCandidate(built.file, rule.key);
  assert.equal(one.title, 'Sempre testar');
  assert.equal(one.fingerprint.length, 64);
  await assert.rejects(() => bundle.getBundleCandidate(built.file, 'bundle|nada|nada.md'), /não encontrada/);
});

test('bundle adulterado: sha256 divergente vira aviso, não passa batido', () => {
  const tar = createTarGz([
    { name: 'manifest.json', data: JSON.stringify({ format: 'ai-memory-bundle', version: 1, pages: [{ scope: 'default/x', path: 'notes/a.md', title: 'A', sha256: 'deadbeef' }] }) },
    { name: 'scopes/default/x/_meta.md', data: '---\nworkspace: default\nproject: x\n---\n' },
    { name: 'scopes/default/x/notes/a.md', data: '---\nkind: note\ntitle: A\n---\n# A\n\ncorpo\n' },
  ]);
  const file = path.join(fx.tmp, 'adulterado.tar.gz');
  fs.writeFileSync(file, tar);
  return bundle.readBundleFile(file).then((read) => {
    assert.match(read.warnings.join(' '), /sha256 do manifesto difere/);
  });
});

test('bundle do export-okf (raiz, _meta.md e index.md gerado) é aceito', async () => {
  const file = makeOkfBundle(path.join(fx.tmp, 'externo', 'okf-bundle.tar.gz'), { project: 'okf-proj' });
  const scan = await bundle.scanBundleCandidates(file, { includeRaw: true });
  assert.deepEqual(scan.scopes, ['default/okf-proj']);
  // index.md gerado pelo export-okf e o markdown sem título ficam de fora
  assert.deepEqual(scan.items.map((i) => i.suggested.path).sort(), ['decisions/uma-decisao.md', 'notes/sem-frontmatter.md', 'notes/topico.md']);
  const topic = scan.items.find((i) => i.suggested.path === 'notes/topico.md');
  assert.equal(topic.suggested.kind, 'fact');
  assert.deepEqual(topic.targetHint, { kind: 'bundle', target: { workspace: 'default', project: 'okf-proj' } });
  const semFm = scan.items.find((i) => i.suggested.path === 'notes/sem-frontmatter.md');
  assert.equal(semFm.title, 'Sem frontmatter');
  assert.equal(semFm.suggested.tier, 'semantic');
});

test('caminho do bundle: nome solto na pasta de exports, nada fora dela ou do home', async () => {
  const file = path.join(fx.exportsDir, 'solto.tar.gz');
  fs.writeFileSync(file, createTarGz([{ name: 'x.md', data: 'x' }]));
  assert.equal(await bundle.resolveBundlePath('solto.tar.gz'), file);
  await assert.rejects(() => bundle.resolveBundlePath('nao-existe.tar.gz'), /não encontrado|não existe/);
  await assert.rejects(() => bundle.resolveBundlePath('/etc/passwd'), /\.tar\.gz/);
  await assert.rejects(() => bundle.resolveBundlePath('/etc/qualquer.tar.gz'), /não encontrado/);
  await assert.rejects(() => bundle.resolveBundlePath(''), /informe o arquivo/);
  const outside = path.join(fx.tmp, '..', `fora-${path.basename(fx.tmp)}.tar.gz`);
  fs.writeFileSync(outside, createTarGz([{ name: 'x.md', data: 'x' }]));
  await assert.rejects(() => bundle.resolveBundlePath(outside), /restrito ao home|não encontrado/);
  fs.rmSync(outside, { force: true });
});

test('exclusão de bundle exige o nome digitado', async () => {
  const file = path.join(fx.exportsDir, 'para-excluir.tar.gz');
  fs.writeFileSync(file, createTarGz([{ name: 'x.md', data: 'x' }]));
  await assert.rejects(() => bundle.deleteBundle('para-excluir.tar.gz'), (err) => err.code === 'NEEDS_CONFIRM');
  await assert.rejects(() => bundle.deleteBundle('para-excluir.tar.gz', { confirm: 'outro.tar.gz' }), /digite o nome/);
  assert.equal(fs.existsSync(file), true);
  assert.deepEqual(await bundle.deleteBundle('para-excluir.tar.gz', { confirm: 'para-excluir.tar.gz' }), { file: 'para-excluir.tar.gz', deleted: true });
  assert.equal(fs.existsSync(file), false);
  await assert.rejects(() => bundle.deleteBundle('para-excluir.tar.gz', { confirm: 'para-excluir.tar.gz' }), /não encontrado/);
});

test('listBundles: tamanho, manifesto resumido e bundel ilegível', async () => {
  const file = path.join(fx.exportsDir, 'listado.tar.gz');
  fs.writeFileSync(file, createTarGz([{ name: 'manifest.json', data: JSON.stringify({ format: 'ai-memory-bundle', version: 1, exportedAt: '2026-01-01T00:00:00Z', origin: { storeDir: '/store' }, totals: { pages: 3 }, scopes: [{ workspace: 'default', project: 'x' }] }) }]));
  fs.writeFileSync(path.join(fx.exportsDir, 'quebrado.tar.gz'), zlib.gzipSync(Buffer.alloc(512, 0x41)));
  const { dir, bundles } = await bundle.listBundles();
  assert.equal(dir, fx.exportsDir);
  const listed = bundles.find((b) => b.file === 'listado.tar.gz');
  assert.equal(listed.pages, 3);
  assert.deepEqual(listed.scopes, ['default/x']);
  assert.equal(listed.origin, '/store');
  assert.ok(listed.bytes > 0);
  const broken = bundles.find((b) => b.file === 'quebrado.tar.gz');
  assert.ok(broken.error, 'bundle ilegível aparece com erro na listagem, sem derrubar a listagem');
});
