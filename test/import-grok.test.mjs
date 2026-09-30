import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeImportFixture } from './import-fixtures.mjs';

// Importação do Grok: parsing do v1/v2, classificação (regra/gotcha/nota),
// resolução de destino e o ciclo de status new → same → duplicate.

const fx = makeImportFixture();
process.env.AIM_IMPORT_GROK_DIR = fx.grokDir;
process.env.AI_MEMORY_DATA_DIR = fx.dataDir;
process.env.AIM_APP_IMPORT_FILE = fx.stateFile;

const { scanImportSource, getImportItem } = await import('../server/import.mjs');
const { markImported } = await import('../server/import-store.mjs');

const scans = {};

test('v1: global dividido por seção, com regra em _rules e nota em notes', async () => {
  const scan = await scanImportSource('grok-v1', { links: fx.links });
  scans.v1 = scan;
  const global = scan.items.filter((i) => i.originKind === 'memory-global');
  assert.equal(global.length, 3);

  const estilo = global.find((i) => i.title === 'Estilo de codigo');
  assert.equal(estilo.suggested.path, '_rules/estilo-de-codigo.md');
  assert.equal(estilo.suggested.kind, 'rule');
  assert.equal(estilo.suggested.tier, 'procedural');
  assert.equal(estilo.suggested.pinned, true);
  assert.deepEqual(estilo.target, { global: true });
  assert.ok(estilo.suggested.tags.includes('grok'));
  assert.equal(estilo.status, 'new');

  const contexto = global.find((i) => i.title === 'Contexto do produto');
  assert.match(contexto.suggested.path, /^notes\/imported\/grok-v1\//);
  assert.equal(contexto.suggested.kind, 'fact');
  assert.equal(contexto.suggested.pinned, false);
});

test('v1: projeto usa o path do header (com markdown) e sessões entram cruas', async () => {
  const scan = scans.v1;
  const arquitetura = scan.items.find((i) => i.title === 'Decisoes de arquitetura');
  assert.deepEqual(arquitetura.target, { workspace: 'default', project: 'proj-a' });
  assert.match(arquitetura.targetReason, /vinculado a/);

  const sessao = scan.items.find((i) => i.originKind === 'session');
  assert.equal(sessao.raw, true);
  assert.equal(sessao.suggested.tier, 'episodic');
  assert.deepEqual(sessao.target, { workspace: 'default', project: 'proj-a' });
  // o corpo completo (com as seções internas da sessão) sai pelo viewer
  const full = await getImportItem('grok-v1', sessao.key, { links: fx.links });
  assert.match(full.body, /Decisions & rationale/);
});

test('v1: projeto sem header resolve pelo slug; sem qualquer vínculo fica sem destino', async () => {
  const scan = scans.v1;
  // a pasta `orfao-9999ffff` não tem header, mas o slug casa com o link `orfao`
  const orfao = scan.items.find((i) => i.title === 'Notas do orfao');
  assert.deepEqual(orfao.target, { workspace: 'default', project: 'orfao' });
  assert.match(orfao.targetReason, /slug "orfao" casado/);

  const desconhecido = scan.items.find((i) => i.title === 'Notas do desconhecido');
  assert.equal(desconhecido.target, null);
  assert.match(desconhecido.targetReason, /nenhum projeto vinculado/);
  assert.equal(scan.summary.noTarget >= 1, true);
  assert.ok(scan.warnings.some((w) => /sem cabeçalho/.test(w)));
});

test('v2: topics viram itens com destino do workspace e observações ficam cruas', async () => {
  const scan = await scanImportSource('grok-v2', { links: fx.links });
  scans.v2 = scan;

  const docker = scan.items.find((i) => i.title.startsWith('Docker Desktop'));
  assert.equal(docker.suggested.path, 'gotchas/docker-desktop-mktemp-volume-mount.md');
  assert.equal(docker.suggested.kind, 'gotcha');
  assert.deepEqual(docker.target, { workspace: 'default', project: 'proj-a' });

  const obs = scan.items.find((i) => i.originKind === 'observation');
  assert.equal(obs.raw, true);
  assert.equal(obs.title, 'mktemp volume no Docker');
  assert.ok(obs.suggested.tags.includes('docker'));
  assert.deepEqual(obs.target, { workspace: 'default', project: 'proj-a' });

  const semProjeto = scan.items.find((i) => i.title === 'Sem projeto');
  assert.equal(semProjeto.target, null);
  assert.ok(scan.warnings.some((w) => /sem projeto vinculado/.test(w)));
});

test('getImportItem devolve o corpo completo pelo key', async () => {
  const key = scans.v2.items.find((i) => i.title === 'Sem projeto').key;
  const item = await getImportItem('grok-v2', key, { links: fx.links });
  assert.match(item.body, /Topico de workspace sem vinculo/);
  assert.ok(item.fingerprint);
});

test('status: new → same depois de importado, duplicate entre fontes', async () => {
  const shared = scans.v1.items.find((i) => i.title === 'Regra compartilhada');
  assert.equal(shared.status, 'new');

  markImported([{ key: shared.key, fp: shared.fingerprint, destPath: shared.suggested.path, destTarget: '_global', importedAt: new Date().toISOString() }]);

  const again = await scanImportSource('grok-v1', { links: fx.links });
  const sharedAgain = again.items.find((i) => i.key === shared.key);
  assert.equal(sharedAgain.status, 'same');
  assert.equal(again.summary.same, 1);

  // o mesmo conteúdo em outro arquivo (v2) aparece como duplicado, apontando a origem já importada
  const v2 = await scanImportSource('grok-v2', { links: fx.links });
  const dup = v2.items.find((i) => i.title === 'Regra compartilhada');
  assert.equal(dup.status, 'duplicate');
  assert.equal(dup.duplicateOf, shared.key);
});

test('colisão: dois arquivos com o mesmo título disputam a mesma página', async () => {
  const v2 = await scanImportSource('grok-v2', { links: fx.links });
  const iguais = v2.items.filter((i) => i.title === 'Contexto do produto');
  assert.equal(iguais.length, 2);
  const paths = new Set(iguais.map((i) => i.suggested.path));
  assert.equal(paths.size, 1);
  const colididos = iguais.filter((i) => i.status === 'collision');
  assert.equal(colididos.length, 1);
  assert.equal(colididos[0].duplicateOf, iguais.find((i) => i.status !== 'collision').key);
  assert.equal(v2.summary.collision, 1);
});

test('a flag includeRaw controla sessões e observações', async () => {
  const v1 = await scanImportSource('grok-v1', { links: fx.links, includeRaw: false });
  assert.equal(v1.items.some((i) => i.originKind === 'session'), false);
  const v2 = await scanImportSource('grok-v2', { links: fx.links, includeRaw: false });
  assert.equal(v2.items.some((i) => i.originKind === 'observation'), false);
});

test('fonte ausente devolve available=false sem explodir', async () => {
  const prev = process.env.AIM_IMPORT_GROK_DIR;
  process.env.AIM_IMPORT_GROK_DIR = path.join(fx.tmp, 'nao-existe');
  // config lê o env no load; aqui o teste vale para o caminho missing do parser
  const { scanGrokV1 } = await import('../server/import-grok.mjs');
  const out = await scanGrokV1({ grokDir: path.join(fx.tmp, 'nao-existe') }, {});
  assert.deepEqual(out.items, []);
  process.env.AIM_IMPORT_GROK_DIR = prev;
});

test('listImportSources conta as entradas das fixtures', async () => {
  const { listImportSources } = await import('../server/import.mjs');
  process.env.AI_MEMORY_DATA_DIR = fx.dataDir;
  const out = await listImportSources();
  const v1 = out.sources.find((s) => s.id === 'grok-v1');
  assert.equal(v1.available, true);
  assert.ok(v1.counts.curated >= 3); // global + 2 projetos
  assert.ok(v1.counts.raw >= 1); // sessão
  const v2 = out.sources.find((s) => s.id === 'grok-v2');
  assert.ok(v2.counts.curated >= 3);
  fs.rmSync(path.join(fx.tmp, 'nope'), { force: true });
});
