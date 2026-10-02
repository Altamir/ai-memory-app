import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listCollectionSkills,
  getCollectionContent,
  listCollectionFiles,
  readCollectionFile,
  writeCollectionFile,
  listCollectionVersions,
  importToCollection,
  importToCollectionBatch,
  listHarnessSkills,
  saveCollectionVersion,
  restoreCollectionVersion,
  installCollectionSkill,
  exportSkillsBundle,
  listSkillsBundles,
  scanSkillsBundle,
  importSkillsBundle,
} from '../server/skills-collection.mjs';
import { MANAGED_MARKER } from '../server/skills.mjs';

// Ambiente isolado: coleção e home temporários (nenhum acesso ao home real,
// catálogo gerenciado injetado — sem MCP).

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-col-'));
const root = fs.realpathSync.native(base); // macOS: /var/... → /private/var/...
const colDir = path.join(root, 'colecao');
const home = path.join(root, 'home');
const exportsDir = path.join(root, 'exports-skills');
fs.mkdirSync(colDir, { recursive: true });
fs.mkdirSync(home, { recursive: true });

function writeSkill(dir, name, { description = 'desc', body = 'corpo', managed = false, extra = {} } = {}) {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  const fm = `---\nname: ${name}\ndescription: "${description}"\n---\n`;
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `${fm}${managed ? `${MANAGED_MARKER}\n` : ''}\n${body}\n`);
  for (const [rel, content] of Object.entries(extra)) {
    fs.mkdirSync(path.dirname(path.join(skillDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(skillDir, rel), content);
  }
  return skillDir;
}

const managedContentFor = (name, body) => `---\nname: ${name}\ndescription: "gerenciada ${name}"\n---\n${MANAGED_MARKER}\n\n${body}\n`;
const catalog = (entries) => ({
  error: null,
  skills: new Map(entries.map(([name, content]) => [name, { name, description: `gerenciada ${name}`, relativePath: `${name}/SKILL.md`, content }])),
});

const opts = { dir: colDir, home };

test('coleção vazia lista zero skills e aponta a pasta', async () => {
  const out = await listCollectionSkills(opts);
  assert.equal(out.dir, colDir);
  assert.equal(out.skills.length, 0);
  assert.equal(out.totals.skills, 0);
  assert.ok(out.harnesses.some((h) => h.id === 'claude' && h.userRoot.includes('.claude/skills')));
  assert.equal(path.basename(out.versionsRoot), '.versions');
});

test('importToCollection copia pasta com recursos do harness para a coleção', async () => {
  writeSkill(path.join(home, '.claude/skills'), 'com-recursos', {
    description: 'vem do claude',
    extra: { 'scripts/run.sh': '#!/bin/sh\necho oi\n', 'references/g.md': '# guia\n' },
  });
  const out = await importToCollection({ ...opts, name: 'com-recursos', harness: 'claude', kind: 'user' });
  assert.equal(out.action, 'criada');
  assert.ok(fs.existsSync(path.join(colDir, 'com-recursos/scripts/run.sh')));
  assert.ok(fs.existsSync(path.join(colDir, 'com-recursos/references/g.md')));

  const list = await listCollectionSkills(opts);
  const skill = list.skills.find((s) => s.name === 'com-recursos');
  assert.equal(skill.files, 3);
  assert.deepEqual(skill.installed, ['claude']); // já instalada no harness de origem
  assert.deepEqual(skill.copies.map((c) => `${c.harness}:${c.kind}`), ['claude:user']);
  assert.match(skill.copies[0].path, /com-recursos\/SKILL\.md$/);
  assert.equal(skill.description, 'vem do claude');
});

test('importToCollection é idempotente (igual) e divergência cria snapshot', async () => {
  // mesma origem: nada muda
  const same = await importToCollection({ ...opts, name: 'com-recursos', harness: 'claude', kind: 'user' });
  assert.equal(same.action, 'igual');
  assert.equal(same.skipped, true);
  assert.equal(listCollectionVersions({ name: 'com-recursos', dir: colDir }).versions.length, 0);

  // muda a origem: importar por cima salva o estado anterior como versão
  writeSkill(path.join(home, '.claude/skills'), 'com-recursos', { description: 'vem do claude', body: 'MUDADO' });
  const upd = await importToCollection({ ...opts, name: 'com-recursos', harness: 'claude', kind: 'user' });
  assert.equal(upd.action, 'atualizada');
  assert.ok(Number.isInteger(upd.snapshotId));
  const versions = listCollectionVersions({ name: 'com-recursos', dir: colDir });
  assert.equal(versions.versions.length, 1);
  assert.match(versions.versions[0].note, /antes de importar/);
  assert.equal(fs.readFileSync(path.join(colDir, 'com-recursos/SKILL.md'), 'utf8').includes('MUDADO'), true);
});

test('importToCollection aceita skill só no catálogo gerenciado (só SKILL.md)', async () => {
  const managed = catalog([['so-do-catalogo', managedContentFor('so-do-catalogo', 'conteúdo do binário')]]);
  const out = await importToCollection({ ...opts, name: 'so-do-catalogo', kind: 'managed', managed });
  assert.equal(out.action, 'criada');
  const text = fs.readFileSync(path.join(colDir, 'so-do-catalogo/SKILL.md'), 'utf8');
  assert.match(text, /conteúdo do binário/);
  // reimportar igual: nada acontece
  const again = await importToCollection({ ...opts, name: 'so-do-catalogo', kind: 'managed', managed });
  assert.equal(again.action, 'igual');
});

test('importToCollection rejeita nome inválido', async () => {
  await assert.rejects(() => importToCollection({ ...opts, name: '../escapa', harness: 'claude', kind: 'user' }), /nome de skill inválido/);
  await assert.rejects(() => importToCollection({ ...opts, name: '', harness: 'claude', kind: 'user' }));
});

test('saveCollectionVersion registra versão manual e content lê por versão', () => {
  writeSkill(colDir, 'versionada', { body: 'v-atual' });
  const first = saveCollectionVersion({ name: 'versionada', dir: colDir, note: 'primeira' });
  assert.equal(first.version, 1);

  fs.writeFileSync(path.join(colDir, 'versionada/SKILL.md'), '---\nname: versionada\ndescription: "d"\n---\n\nv-atual-2\n');
  const second = saveCollectionVersion({ name: 'versionada', dir: colDir, note: 'segunda' });
  assert.equal(second.version, 2);

  const versions = listCollectionVersions({ name: 'versionada', dir: colDir });
  assert.equal(versions.versions.length, 2);
  assert.deepEqual(versions.versions.map((v) => v.id).sort((a, b) => b - a), [2, 1]);

  const old = getCollectionContent({ name: 'versionada', dir: colDir, version: 1 });
  assert.match(old.content, /v-atual\n/);
  const cur = getCollectionContent({ name: 'versionada', dir: colDir });
  assert.match(cur.content, /v-atual-2/);
  assert.equal(cur.version, null);
  assert.throws(() => getCollectionContent({ name: 'versionada', dir: colDir, version: 99 }), /não encontrada/);
});

test('restoreCollectionVersion volta o conteúdo e snapshota o estado anterior', () => {
  const out = restoreCollectionVersion({ name: 'versionada', dir: colDir, version: 1 });
  assert.equal(out.restored, 1);
  assert.ok(Number.isInteger(out.snapshotId));
  assert.match(fs.readFileSync(path.join(colDir, 'versionada/SKILL.md'), 'utf8'), /v-atual\n/);
  const versions = listCollectionVersions({ name: 'versionada', dir: colDir });
  const note = versions.versions.find((v) => v.id === out.snapshotId);
  assert.match(note.note, /antes de restaurar v1/);
  assert.throws(() => restoreCollectionVersion({ name: 'versionada', dir: colDir, version: 777 }));
});

test('skill excluída da coleção reaparece como recuperável e restore recria a pasta', async () => {
  fs.rmSync(path.join(colDir, 'versionada'), { recursive: true, force: true });
  const list = await listCollectionSkills(opts);
  const deleted = list.deleted.find((d) => d.name === 'versionada');
  assert.ok(deleted, 'deve listar como excluída');
  assert.ok(deleted.versions >= 3);
  assert.equal(list.skills.some((s) => s.name === 'versionada'), false);

  restoreCollectionVersion({ name: 'versionada', dir: colDir, version: 1 });
  const after = await listCollectionSkills(opts);
  assert.equal(after.skills.some((s) => s.name === 'versionada'), true);
  assert.equal(after.deleted.some((d) => d.name === 'versionada'), false);
});

test('installCollectionSkill instala a pasta inteira no harness e em projeto', async () => {
  writeSkill(colDir, 'instalavel', {
    description: 'para instalar',
    extra: { 'scripts/run.sh': 'echo oi\n' },
  });
  const out = await installCollectionSkill({ ...opts, name: 'instalavel', harness: 'claude', scope: 'global' });
  assert.equal(out.action, 'created');
  const destDir = path.join(home, '.claude/skills/instalavel');
  assert.ok(fs.existsSync(path.join(destDir, 'scripts/run.sh')));

  // project scope: dentro do home isolado
  const projectDir = path.join(home, 'projetos/meu-app');
  fs.mkdirSync(projectDir, { recursive: true });
  const proj = await installCollectionSkill({ ...opts, name: 'instalavel', harness: 'agents', scope: 'project', projectDir });
  assert.equal(proj.action, 'created');
  assert.ok(fs.existsSync(path.join(projectDir, '.agents/skills/instalavel/SKILL.md')));

  // destino com conteúdo estranho exige force
  fs.writeFileSync(path.join(destDir, 'SKILL.md'), '---\nname: instalavel\ndescription: "estrangeira"\n---\n');
  await assert.rejects(
    () => installCollectionSkill({ ...opts, name: 'instalavel', harness: 'claude', scope: 'global' }),
    (err) => err.code === 'NEEDS_FORCE',
  );
  const forced = await installCollectionSkill({ ...opts, name: 'instalavel', harness: 'claude', scope: 'global', force: true });
  assert.equal(forced.action, 'updated');
  assert.ok(forced.backup && fs.existsSync(path.join(forced.backup, 'SKILL.md')), 'backup da pasta anterior');
  assert.match(fs.readFileSync(path.join(destDir, 'SKILL.md'), 'utf8'), /para instalar/);
  // resources reinstalados
  assert.ok(fs.existsSync(path.join(destDir, 'scripts/run.sh')));
});

test('exportSkillsBundle grava tar.gz com manifesto verificado', async () => {
  const out = await exportSkillsBundle({ dir: colDir, exportsDir, name: 'teste-skills' });
  assert.equal(out.fileName, 'teste-skills.tar.gz');
  assert.equal(out.manifestOk, true);
  assert.ok(out.skills >= 3);
  assert.ok(fs.existsSync(out.file));

  const listing = await listSkillsBundles({ exportsDir });
  assert.equal(listing.dir, exportsDir);
  const peek = listing.bundles.find((b) => b.file === 'teste-skills.tar.gz');
  assert.equal(peek.format, 'ai-memory-skills-bundle');
  assert.ok(peek.skills >= 3);

  await assert.rejects(() => exportSkillsBundle({ dir: path.join(root, 'vazio-inexistente'), exportsDir }), /nenhuma skill na coleção/);
});

test('scanSkillsBundle marca existentes/idênticas e importSkillsBundle versiona divergências', async () => {
  // coleção paralela para simular o "outro painel": importar do bundle
  const bundleFile = path.join(exportsDir, 'teste-skills.tar.gz');
  const colB = path.join(root, 'colecao-b');
  fs.mkdirSync(colB, { recursive: true });
  const scanNew = await scanSkillsBundle({ file: bundleFile, dir: colB, exportsDir });
  assert.ok(scanNew.skills.every((s) => !s.exists));

  const allNames = () => scanNew.skills.map((s) => s.name);
  const imp = await importSkillsBundle({ file: bundleFile, names: allNames(), dir: colB, exportsDir });
  assert.equal(imp.created, scanNew.skills.length);
  assert.ok(fs.existsSync(path.join(colB, 'com-recursos/scripts/run.sh')));

  // reimportar: todas idênticas → puladas
  const again = await importSkillsBundle({ file: bundleFile, names: allNames(), dir: colB, exportsDir });
  assert.equal(again.created + again.updated, 0);
  assert.equal(again.skipped, scanNew.skills.length);

  // coleção origem diverge do bundle de B: scan marca diverge
  writeSkill(colDir, 'instalavel', { body: 'DIVERGENTE' });
  const scanDiff = await scanSkillsBundle({ file: bundleFile, dir: colDir, exportsDir });
  const divergent = scanDiff.skills.find((s) => s.name === 'instalavel');
  assert.equal(divergent.exists, true);
  assert.equal(divergent.same, false);

  // update=false: pula sem mexer
  const skippedImp = await importSkillsBundle({ file: bundleFile, names: ['instalavel'], dir: colDir, exportsDir, update: false });
  assert.deepEqual(skippedImp.results[0], { name: 'instalavel', action: 'divergente', skipped: true });
  assert.match(fs.readFileSync(path.join(colDir, 'instalavel/SKILL.md'), 'utf8'), /DIVERGENTE/);

  // update=true: estado atual vira versão e conteúdo do bundle entra
  const versionsBefore = listCollectionVersions({ name: 'instalavel', dir: colDir }).versions.length;
  const updatedImp = await importSkillsBundle({ file: bundleFile, names: ['instalavel'], dir: colDir, exportsDir, update: true });
  assert.equal(updatedImp.updated, 1);
  assert.match(fs.readFileSync(path.join(colDir, 'instalavel/SKILL.md'), 'utf8'), /para instalar/);
  const versionsAfter = listCollectionVersions({ name: 'instalavel', dir: colDir }).versions;
  assert.equal(versionsAfter.length, versionsBefore + 1);
  assert.ok(versionsAfter.some((v) => v.source === 'antes de importar bundle'));

  // skill que não está no bundle vira erro no resultado
  const missing = await importSkillsBundle({ file: bundleFile, names: ['nao-existe'], dir: colDir, exportsDir });
  assert.equal(missing.results[0].action, 'erro');
  await assert.rejects(
    () => importSkillsBundle({ file: bundleFile, names: [], dir: colDir, exportsDir }),
    /selecione ao menos uma/,
  );
});

test('edição de arquivos: lista, lê, salva com snapshot e valida caminhos', () => {
  const colE = path.join(root, 'colecao-e');
  writeSkill(colE, 'editavel', {
    body: 'original',
    extra: {
      'scripts/run.sh': 'echo oi\n',
      'assets/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]),
      'bin/data.bin': Buffer.from([0x00, 0x01, 0x02, 0xff]),
    },
  });

  const files = listCollectionFiles({ name: 'editavel', dir: colE });
  const fileRels = files.files.filter((f) => f.type === 'file').map((f) => f.rel);
  assert.deepEqual(fileRels.sort(), ['SKILL.md', 'assets/logo.png', 'bin/data.bin', 'scripts/run.sh']);
  assert.ok(files.files.some((f) => f.type === 'dir' && f.rel === 'scripts'));
  assert.equal(files.files.find((f) => f.rel === 'bin/data.bin').editable, false);
  assert.equal(files.files.find((f) => f.rel === 'scripts/run.sh').editable, true);

  const read = readCollectionFile({ name: 'editavel', rel: 'scripts/run.sh', dir: colE });
  assert.equal(read.kind, 'text');
  assert.equal(read.content, 'echo oi\n');
  // png com NUL: vai como imagem (data URL) para o viewer renderizar
  const img = readCollectionFile({ name: 'editavel', rel: 'assets/logo.png', dir: colE });
  assert.equal(img.kind, 'image');
  assert.match(img.dataUrl, /^data:image\/png;base64,/);
  // binário sem ext de imagem: kind binary
  assert.equal(readCollectionFile({ name: 'editavel', rel: 'bin/data.bin', dir: colE }).kind, 'binary');

  // salvar SKILL.md: snapshot do estado anterior + conteúdo novo no disco
  const versionsBefore = listCollectionVersions({ name: 'editavel', dir: colE }).versions.length;
  const out = writeCollectionFile({ name: 'editavel', rel: 'SKILL.md', dir: colE, content: '---\nname: editavel\ndescription: "d"\n---\n\neditado' });
  assert.equal(out.saved, true);
  assert.ok(Number.isInteger(out.snapshotId));
  assert.equal(listCollectionVersions({ name: 'editavel', dir: colE }).versions.length, versionsBefore + 1);
  const inDisk = fs.readFileSync(path.join(colE, 'editavel/SKILL.md'), 'utf8');
  assert.match(inDisk, /editado/);
  assert.ok(inDisk.endsWith('\n')); // newline final normalizado

  // mesmo conteúdo: nada a fazer e nenhuma versão nova
  const same = writeCollectionFile({ name: 'editavel', rel: 'SKILL.md', dir: colE, content: inDisk });
  assert.equal(same.saved, false);
  assert.equal(same.same, true);
  assert.equal(listCollectionVersions({ name: 'editavel', dir: colE }).versions.length, versionsBefore + 1);

  // arquivo novo também registra o estado anterior da skill
  const novo = writeCollectionFile({ name: 'editavel', rel: 'references/g.md', dir: colE, content: '# guia\n' });
  assert.equal(novo.saved, true);
  assert.ok(fs.existsSync(path.join(colE, 'editavel/references/g.md')));

  // validações: traversal, absoluto, NUL, skill inexistente
  assert.throws(() => writeCollectionFile({ name: 'editavel', rel: '../escapa.md', dir: colE, content: 'x' }), /caminho/);
  assert.throws(() => writeCollectionFile({ name: 'editavel', rel: '/etc/hosts', dir: colE, content: 'x' }), /caminho/);
  assert.throws(() => writeCollectionFile({ name: 'editavel', rel: 'SKILL.md', dir: colE, content: 'a\0b' }), /nulos/);
  assert.throws(() => readCollectionFile({ name: 'editavel', rel: '../../fora', dir: colE }), /caminho/);
  assert.throws(() => listCollectionFiles({ name: 'nao-existe', dir: colE }), /não está na coleção/);
});

test('scanSkillsBundle rejeita caminhos fora do permitido', async () => {
  await assert.rejects(() => scanSkillsBundle({ file: '/tmp/fora.tar.gz', dir: colDir }), /restrito|não encontrado/);
  await assert.rejects(() => scanSkillsBundle({ file: 'arquivo.txt', dir: colDir }), /\.tar\.gz/);
});

test('importToCollection aceita origem de projeto (ws)', async () => {
  const colF = path.join(root, 'colecao-f');
  fs.mkdirSync(colF, { recursive: true });
  const projDir = path.join(home, 'projetos/app');
  writeSkill(path.join(projDir, '.claude/skills'), 'do-projeto', { body: 'do projeto', extra: { 'refs/r.md': 'guia\n' } });

  const out = await importToCollection({ dir: colF, home, name: 'do-projeto', harness: 'claude', ws: projDir });
  assert.equal(out.action, 'criada');
  assert.match(out.source, /projeto app · claude/);
  assert.ok(fs.existsSync(path.join(colF, 'do-projeto/refs/r.md')));

  // reimport idêntica e divergência versionada
  const again = await importToCollection({ dir: colF, home, name: 'do-projeto', harness: 'claude', ws: projDir });
  assert.equal(again.action, 'igual');
  writeSkill(path.join(projDir, '.claude/skills'), 'do-projeto', { body: 'MUDOU NO PROJETO' });
  const upd = await importToCollection({ dir: colF, home, name: 'do-projeto', harness: 'claude', ws: projDir });
  assert.equal(upd.action, 'atualizada');
  assert.ok(Number.isInteger(upd.snapshotId));

  // ws fora do home e skill inexistente no projeto são recusados
  await assert.rejects(() => importToCollection({ dir: colF, home, name: 'do-projeto', harness: 'claude', ws: '/tmp' }), /home/);
  await assert.rejects(() => importToCollection({ dir: colF, home, name: 'fantasma', harness: 'claude', ws: projDir }), /não encontrada/);
});

test('listHarnessSkills lista as do harness com match contra a coleção', async () => {
  // coleção nova para os flags ficarem previsíveis
  const colC = path.join(root, 'colecao-c');
  fs.mkdirSync(colC, { recursive: true });
  writeSkill(path.join(home, '.claude/skills'), 'h-claude-1', { description: 'primeira do claude' });
  writeSkill(path.join(home, '.claude/skills'), 'h-claude-2', { description: 'segunda do claude', extra: { 'scripts/x.sh': 'echo\n' } });
  writeSkill(path.join(home, '.agents/skills'), 'h-agents', { description: 'do agents' });
  const managedExtra = catalog([['so-catalogo-h', managedContentFor('so-catalogo-h', 'conteúdo')]]);
  const managedVazio = { error: 'sem mcp', skills: new Map() };

  // claude: 2 em disco + a só-no-catálogo (+ com-recursos de testes anteriores); agents não deve aparecer
  const claude = await listHarnessSkills({ harness: 'claude', dir: colC, home, managed: managedExtra });
  const names = claude.skills.map((s) => s.name);
  assert.ok(names.includes('h-claude-1') && names.includes('h-claude-2') && names.includes('so-catalogo-h'), JSON.stringify(names));
  assert.ok(names.every((n) => n !== 'h-agents'), JSON.stringify(names));
  const comRecursos = claude.skills.find((s) => s.name === 'h-claude-2');
  assert.equal(comRecursos.fileCount, 2);
  assert.equal(comRecursos.exists, false);

  // managed-only sem MCP não quebra; coleção ainda vazia
  const semMcp = await listHarnessSkills({ harness: 'claude', dir: colC, home, managed: managedVazio });
  assert.equal(semMcp.skills.some((s) => s.name === 'so-catalogo-h'), false);

  // importar uma e editar a outra: flags viram idêntica/diverge
  await importToCollection({ dir: colC, home, name: 'h-claude-1', harness: 'claude', kind: 'user' });
  writeSkill(path.join(home, '.claude/skills'), 'h-claude-1', { description: 'primeira do claude', body: 'MUDOU' });
  const after = await listHarnessSkills({ harness: 'claude', dir: colC, home, managed: managedExtra });
  assert.equal(after.skills.find((s) => s.name === 'h-claude-1').same, false); // diverge
  assert.equal(after.skills.find((s) => s.name === 'h-claude-2').exists, false);
  const colecao = await listCollectionSkills({ dir: colC, home });
  writeSkill(colC, 'h-agents-copia', { body: 'igual à origem' });
  // idêntica byte a byte: importar de novo é no-op
  fs.cpSync(path.join(colC, 'h-agents-copia'), path.join(home, '.agents/skills/h-agents-copia'), { recursive: true });
  const agents = await listHarnessSkills({ harness: 'agents', dir: colC, home, managed: managedVazio });
  const ident = agents.skills.find((s) => s.name === 'h-agents-copia');
  assert.equal(ident.exists, true);
  assert.equal(ident.same, true);

  await assert.rejects(() => listHarnessSkills({ harness: 'inexistente', dir: colC, home }), /harness desconhecido/);
});

test('importToCollectionBatch importa em lote e cada item falha sozinho', async () => {
  const colD = path.join(root, 'colecao-d');
  fs.mkdirSync(colD, { recursive: true });
  writeSkill(path.join(home, '.claude/skills'), 'b-1', { body: 'um' });
  writeSkill(path.join(home, '.claude/skills'), 'b-2', { body: 'dois', extra: { 'refs/r.md': 'guia\n' } });

  const out = await importToCollectionBatch({
    dir: colD,
    home,
    items: [
      { name: 'b-1', harness: 'claude', kind: 'user' },
      { name: 'b-2', harness: 'claude', kind: 'user' },
      { name: 'nao-existe-em-lugar-nenhum', harness: 'claude', kind: 'user' },
      { name: '../escapa', harness: 'claude', kind: 'user' },
    ],
  });
  assert.equal(out.created, 2);
  assert.equal(out.errors, 2);
  assert.equal(out.results.find((r) => r.name === 'b-2').action, 'criada');
  assert.ok(fs.existsSync(path.join(colD, 'b-2/refs/r.md')));
  assert.equal(out.results.find((r) => r.name === 'nao-existe-em-lugar-nenhum').action, 'erro');

  // reimportar tudo: idênticas; erro de item não interrompe o lote
  const again = await importToCollectionBatch({
    dir: colD,
    home,
    items: [
      { name: 'b-1', harness: 'claude', kind: 'user' },
      { name: 'nao-existe-em-lugar-nenhum', harness: 'claude', kind: 'user' },
    ],
  });
  assert.equal(out.same, 0);
  assert.equal(again.same, 1);
  assert.equal(again.created + again.updated, 0);

  await assert.rejects(() => importToCollectionBatch({ dir: colD, home, items: [] }), /selecione ao menos uma/);
});
