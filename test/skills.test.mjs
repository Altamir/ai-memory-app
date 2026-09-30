import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSkills, getSkillContent, installSkill, listSkillFiles, readSkillFile, listWorkspaces, getWorkspaceSkills, compareSkillCopies, diffSkillCopies, reconcileSkillCopies, MANAGED_MARKER, RECONCILE_CONFIRM } from '../server/skills.mjs';

// Ambiente isolado: home temporário com roots de skills falsos + catálogo
// gerenciado injetado (nenhum acesso ao MCP nem ao home real).

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-skills-'));
const home = fs.realpathSync.native(base); // macOS: /var/... → /private/var/...

const managedContent = [
  '---',
  'name: ai-memory-demo',
  'description: "skill gerenciada de teste"',
  '---',
  MANAGED_MARKER,
  '',
  '# ai-memory demo',
  '',
  'conteúdo v1',
  '',
].join('\n');

const catalog = {
  error: null,
  skills: new Map([
    ['ai-memory-demo', { name: 'ai-memory-demo', description: 'skill gerenciada de teste', relativePath: 'ai-memory-demo/SKILL.md', content: managedContent }],
    ['ai-memory-sozinha', { name: 'ai-memory-sozinha', description: 'só no catálogo', relativePath: 'ai-memory-sozinha/SKILL.md', content: `---\nname: ai-memory-sozinha\ndescription: "só no catálogo"\n---\n${MANAGED_MARKER}\n\# sozinha\n` }],
    ['ai-memory-com-recursos', { name: 'ai-memory-com-recursos', description: 'gerenciada com recursos em disco', relativePath: 'ai-memory-com-recursos/SKILL.md', content: managedContent.replace('ai-memory-demo', 'ai-memory-com-recursos') }],
  ]),
};

function writeSkill(file, { name, description = 'desc', managed = false, body = 'corpo' }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fm = `---\nname: ${name}\ndescription: "${description}"\n---\n`;
  fs.writeFileSync(file, `${fm}${managed ? `${MANAGED_MARKER}\n` : ''}\n${body}\n`);
}

// --- fixtures em disco ---
fs.mkdirSync(path.join(home, '.claude/skills/ai-memory-demo'), { recursive: true });
fs.writeFileSync(path.join(home, '.claude/skills/ai-memory-demo/SKILL.md'), managedContent); // byte-idêntico ao catálogo
writeSkill(path.join(home, '.grok/skills/ai-memory-demo/SKILL.md'), { name: 'ai-memory-demo', managed: true, body: 'conteúdo ANTIGO' }); // desatualizada
writeSkill(path.join(home, '.agents/skills/minha-skill/SKILL.md'), { name: 'minha-skill', description: 'custom do usuário' });
// recursos da skill: scripts/, references/, assets/ e um binário
const minhaSkillDir = path.join(home, '.agents/skills/minha-skill');
fs.mkdirSync(path.join(minhaSkillDir, 'scripts'), { recursive: true });
fs.writeFileSync(path.join(minhaSkillDir, 'scripts/run.sh'), '#!/bin/sh\necho oi\n');
fs.mkdirSync(path.join(minhaSkillDir, 'references'), { recursive: true });
fs.writeFileSync(path.join(minhaSkillDir, 'references/guide.md'), '# Guia\n\ntexto\n');
fs.mkdirSync(path.join(minhaSkillDir, 'assets'), { recursive: true });
fs.writeFileSync(path.join(minhaSkillDir, 'assets/logo.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
fs.mkdirSync(path.join(minhaSkillDir, 'bin'), { recursive: true });
fs.writeFileSync(path.join(minhaSkillDir, 'bin/data.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00]));
writeSkill(path.join(home, '.grok/skills/do-grok/SKILL.md'), { name: 'do-grok' });
// descrição em block scalar (>) deve ser desdobrada em uma linha
fs.mkdirSync(path.join(home, '.kiro/skills/block-scalar'), { recursive: true });
fs.writeFileSync(
  path.join(home, '.kiro/skills/block-scalar/SKILL.md'),
  '---\nname: block-scalar\ndescription: >\n  linha um sobre a skill.\n  linha dois complementa.\n---\n\ncorpo\n',
);
writeSkill(path.join(home, '.grok/bundled/skills/bundled-skill/SKILL.md'), { name: 'bundled-skill' });
writeSkill(path.join(home, '.kiro/skills/do-kiro/SKILL.md'), { name: 'do-kiro' });
writeSkill(path.join(home, '.config/opencode/skills/opencode-skill/SKILL.md'), { name: 'opencode-skill', description: 'skill do opencode' });
// root do zcode: skills instaladas como symlink para outro root (padrão real desta máquina)
fs.mkdirSync(path.join(home, '.zcode/skills'), { recursive: true });
fs.symlinkSync(path.join(home, '.agents/skills/minha-skill'), path.join(home, '.zcode/skills/minha-skill'));
fs.symlinkSync(path.join(home, '.agents/skills/apagada'), path.join(home, '.zcode/skills/link-quebrado'));
writeSkill(path.join(home, '.zcode/cli/plugins/cache/pub-x/meu-plugin/0.1.0/skills/plugin-skill/SKILL.md'), { name: 'plugin-skill' });
fs.mkdirSync(path.join(home, '.grok/skills/shared'), { recursive: true }); // dir sem SKILL.md: deve ser ignorado

const opts = { home, managed: catalog };

test('listSkills une disco e catálogo por nome, com kinds e flag outdated', async () => {
  const out = await listSkills(opts);

  assert.deepEqual(out.harnesses.map((h) => h.id), ['claude', 'agents', 'opencode', 'zcode', 'grok', 'kiro', 'devin']);
  const grok = out.harnesses.find((h) => h.id === 'grok');
  assert.equal(grok.roots.length, 2);
  assert.ok(grok.roots.some((r) => r.kind === 'bundled' && r.exists));
  const devin = out.harnesses.find((h) => h.id === 'devin');
  assert.equal(devin.roots[0].exists, false); // root inexistente não quebra o scan

  const demo = out.skills.find((s) => s.name === 'ai-memory-demo');
  assert.ok(demo, 'skill gerenciada em disco deve aparecer');
  assert.equal(demo.managed, true);
  assert.equal(demo.diverged, true, 'cópias com conteúdos diferentes (claude × grok) marcam diverged');
  assert.deepEqual(demo.installed, { claude: true, grok: true });
  const claudeLoc = demo.locations.find((l) => l.harness === 'claude');
  const grokLoc = demo.locations.find((l) => l.harness === 'grok');
  assert.equal(claudeLoc.outdated, false); // idêntica ao catálogo
  assert.equal(grokLoc.outdated, true); // difere do catálogo

  const sozinha = out.skills.find((s) => s.name === 'ai-memory-sozinha');
  assert.ok(sozinha, 'skill só no catálogo deve aparecer');
  assert.deepEqual(sozinha.installed, {});
  assert.equal(sozinha.installable, true);

  const bundled = out.skills.find((s) => s.name === 'bundled-skill');
  assert.equal(bundled.locations[0].kind, 'bundled');
  assert.equal(bundled.installable, false); // bundled não é fonte de instalação

  const opencodeSkill = out.skills.find((s) => s.name === 'opencode-skill');
  assert.deepEqual(opencodeSkill.installed, { opencode: true });
  assert.equal(opencodeSkill.installable, true); // root de usuário do opencode

  const plugin = out.skills.find((s) => s.name === 'plugin-skill');
  assert.ok(plugin, 'skill de plugin do zcode deve aparecer');
  assert.equal(plugin.locations[0].kind, 'plugin');

  const viaLink = out.skills.find((s) => s.name === 'minha-skill');
  assert.ok(
    viaLink.locations.some((l) => l.harness === 'zcode' && l.kind === 'user'),
    'skill instalada como symlink deve contar como instalada no root de usuário',
  );
  assert.ok(!out.skills.some((s) => s.name === 'link-quebrado'), 'symlink quebrado é ignorado');

  assert.ok(out.skills.every((s) => s.name !== 'shared'), 'dir sem SKILL.md é ignorado');

  const block = out.skills.find((s) => s.name === 'block-scalar');
  assert.equal(block.description, 'linha um sobre a skill. linha dois complementa.');
});

test('getSkillContent prefere o catálogo; com harness lê o disco', async () => {
  const fromCatalog = await getSkillContent({ ...opts, name: 'ai-memory-demo' });
  assert.equal(fromCatalog.source.managed, true);
  assert.match(fromCatalog.content, /conteúdo v1/);

  const fromKiro = await getSkillContent({ ...opts, name: 'do-kiro', harness: 'kiro' });
  assert.equal(fromKiro.source.kind, 'user');
  assert.match(fromKiro.content, /corpo/);

  await assert.rejects(() => getSkillContent({ ...opts, name: 'inexistente' }), /catálogo gerenciado/);
  await assert.rejects(() => getSkillContent({ ...opts, name: '../escape' }), /inválido/);
});

test('installSkill cria arquivo em root de usuário e faz backup ao atualizar gerenciada', async () => {
  const first = await installSkill({ ...opts, name: 'ai-memory-demo', harness: 'devin' });
  assert.equal(first.action, 'created');
  const file = path.join(home, '.devin/skills/ai-memory-demo/SKILL.md');
  assert.equal(fs.readFileSync(file, 'utf8'), managedContent); // conteúdo do catálogo, com marker

  const second = await installSkill({ ...opts, name: 'ai-memory-demo', harness: 'devin' });
  assert.equal(second.action, 'updated');
  assert.match(second.backup, /SKILL\.md\.bak-\d+$/);
  assert.ok(fs.existsSync(second.backup));
});

test('installSkill de não-gerenciada existente no destino exige force e gera backup', async () => {
  // primeira instalação copia minha-skill do root de agents para o kiro
  const first = await installSkill({ ...opts, name: 'minha-skill', harness: 'kiro' });
  assert.equal(first.action, 'created');
  assert.equal(first.source.harness, 'agents');

  const err = await installSkill({ ...opts, name: 'minha-skill', harness: 'kiro' }).catch((e) => e);
  assert.equal(err.code, 'NEEDS_FORCE');

  const forced = await installSkill({ ...opts, name: 'minha-skill', harness: 'kiro', force: true });
  assert.equal(forced.action, 'updated');
  assert.ok(fs.existsSync(forced.backup));
});

test('installSkill valida harness, escopo projeto e containment do home', async () => {
  await assert.rejects(() => installSkill({ ...opts, name: 'x', harness: 'nope' }), /harness desconhecido/);
  await assert.rejects(() => installSkill({ ...opts, name: 'do-kiro', harness: 'kiro', scope: 'project' }), /projectDir/);

  const fora = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-fora-'));
  const foraReal = fs.realpathSync.native(fora);
  await assert.rejects(
    () => installSkill({ ...opts, name: 'do-kiro', harness: 'kiro', scope: 'project', projectDir: foraReal }),
    /fora do diretório home/,
  );

  const proj = path.join(home, 'tmp-proj/meu-app'); // fora de projetos/: não interfere no teste de workspaces
  fs.mkdirSync(proj, { recursive: true });
  const out = await installSkill({ ...opts, name: 'do-kiro', harness: 'claude', scope: 'project', projectDir: proj });
  assert.equal(out.action, 'created');
  assert.ok(fs.existsSync(path.join(proj, '.claude/skills/do-kiro/SKILL.md')));
});

test('listSkillFiles lista SKILL.md e resources (scripts, references, assets, binário)', () => {
  const out = listSkillFiles({ ...opts, name: 'minha-skill', harness: 'agents' });
  const rels = out.files.map((f) => f.rel);
  assert.deepEqual(rels, [
    'SKILL.md',
    'assets',
    'assets/logo.png',
    'bin',
    'bin/data.bin',
    'references',
    'references/guide.md',
    'scripts',
    'scripts/run.sh',
  ]);
  const dirEntry = out.files.find((f) => f.rel === 'scripts');
  assert.equal(dirEntry.type, 'dir');
  assert.equal(out.files.find((f) => f.rel === 'assets/logo.png').kind, 'image');
  assert.equal(out.files.find((f) => f.rel === 'scripts/run.sh').kind, 'text');
  assert.ok(out.dir.endsWith('/minha-skill'));

  assert.throws(() => listSkillFiles({ ...opts, name: 'so-no-catalogo-xyz' }), /não encontrada/);
});

test('readSkillFile devolve texto, imagem em data URL, binário e rejeita traversal', () => {
  const text = readSkillFile({ ...opts, name: 'minha-skill', harness: 'agents', rel: 'scripts/run.sh' });
  assert.equal(text.kind, 'text');
  assert.match(text.content, /echo oi/);

  const md = readSkillFile({ ...opts, name: 'minha-skill', harness: 'agents' }); // default: SKILL.md
  assert.equal(md.rel, 'SKILL.md');
  assert.equal(md.kind, 'text');

  const img = readSkillFile({ ...opts, name: 'minha-skill', harness: 'agents', rel: 'assets/logo.png' });
  assert.equal(img.kind, 'image');
  assert.match(img.dataUrl, /^data:image\/png;base64,/);

  const bin = readSkillFile({ ...opts, name: 'minha-skill', harness: 'agents', rel: 'bin/data.bin' });
  assert.equal(bin.kind, 'binary');

  assert.throws(() => readSkillFile({ ...opts, name: 'minha-skill', harness: 'agents', rel: '../fora.txt' }), /inválido/);
  assert.throws(() => readSkillFile({ ...opts, name: 'minha-skill', harness: 'agents', rel: 'nao/existe.txt' }), /ENOENT|no such file/i);
});

// --- skills de projeto (workspaces) ---
writeSkill(path.join(home, 'projetos/app-alpha/.grok/skills/proj-grok/SKILL.md'), { name: 'proj-grok', description: 'skill do grok no projeto' });
writeSkill(path.join(home, 'projetos/app-alpha/.opencode/skills/proj-oc/SKILL.md'), { name: 'proj-oc' });
fs.mkdirSync(path.join(home, 'projetos/app-alpha/.opencode/skills/proj-oc/scripts'), { recursive: true });
fs.writeFileSync(path.join(home, 'projetos/app-alpha/.opencode/skills/proj-oc/scripts/tool.py'), 'print("oi")\n');
writeSkill(path.join(home, 'projetos/app-beta/.claude/skills/proj-claude/SKILL.md'), { name: 'proj-claude' });
fs.mkdirSync(path.join(home, 'projetos/sem-skills'), { recursive: true }); // sem harness dirs: não lista

test('listWorkspaces acha workspaces com skills de projeto, por harness', () => {
  const out = listWorkspaces({ home });
  assert.equal(out.parent, path.join(home, 'projetos'));
  assert.deepEqual(out.items.map((i) => i.name), ['app-alpha', 'app-beta']);
  const alpha = out.items[0];
  assert.equal(alpha.skillCount, 2);
  assert.deepEqual(alpha.harnesses, [
    { id: 'opencode', label: 'OpenCode', count: 1 },
    { id: 'grok', label: 'Grok', count: 1 },
  ]);
  const beta = out.items[1];
  assert.deepEqual(beta.harnesses.map((h) => h.id), ['claude']);

  assert.throws(() => listWorkspaces({ parent: '/etc', home }), /fora do diretório home/);
});

test('getWorkspaceSkills detalha harnesses e respeita o home', () => {
  const d = getWorkspaceSkills({ dir: path.join(home, 'projetos/app-alpha'), home });
  assert.equal(d.skillCount, 2);
  const grok = d.harnesses.find((h) => h.id === 'grok');
  assert.equal(grok.skills[0].name, 'proj-grok');
  assert.ok(grok.skills[0].path.endsWith('.grok/skills/proj-grok/SKILL.md'));
  assert.equal(d.harnesses.find((h) => h.id === 'opencode').exists, true);
  assert.equal(d.harnesses.find((h) => h.id === 'claude').skills.length, 0);

  assert.throws(() => getWorkspaceSkills({ dir: '/etc', home }), /fora do diretório home/);
});

test('listSkillFiles/readSkillFile com ws leem a cópia de projeto', () => {
  const alpha = path.join(home, 'projetos/app-alpha');
  const tree = listSkillFiles({ name: 'proj-oc', harness: 'opencode', ws: alpha, home });
  assert.deepEqual(tree.files.map((f) => f.rel), ['SKILL.md', 'scripts', 'scripts/tool.py']);
  assert.equal(tree.kind, 'project');

  const file = readSkillFile({ name: 'proj-oc', harness: 'opencode', ws: alpha, rel: 'scripts/tool.py', home });
  assert.equal(file.kind, 'text');
  assert.match(file.content, /print/);

  // skill não existe nesse workspace (existe em outro): não vaza entre projetos
  assert.throws(
    () => readSkillFile({ name: 'proj-oc', harness: 'opencode', ws: path.join(home, 'projetos/app-beta'), rel: 'SKILL.md', home }),
    /não encontrada/,
  );
  assert.throws(() => listSkillFiles({ name: '../escape', harness: 'opencode', ws: alpha, home }), /inválido/);
  assert.throws(() => listSkillFiles({ name: 'proj-oc', harness: 'inexistente', ws: alpha, home }), /harness desconhecido/);
});

// --- cópias divergentes (comparar / diff / conciliar) ---
const conciliarSrc = path.join(home, '.kiro/skills/conciliar-demo');
writeSkill(path.join(conciliarSrc, 'SKILL.md'), { name: 'conciliar-demo', description: 'origem boa', body: 'v2' });
fs.mkdirSync(path.join(conciliarSrc, 'scripts'), { recursive: true });
fs.writeFileSync(path.join(conciliarSrc, 'scripts/run.sh'), '#!/bin/sh\necho v2\n');
const conciliarDst = path.join(home, '.zcode/skills/conciliar-demo');
writeSkill(path.join(conciliarDst, 'SKILL.md'), { name: 'conciliar-demo', description: 'cópia velha', body: 'v1' });
fs.mkdirSync(path.join(conciliarDst, 'scripts'), { recursive: true });
fs.writeFileSync(path.join(conciliarDst, 'scripts/run.sh'), '#!/bin/sh\necho v1\n');
fs.writeFileSync(path.join(conciliarDst, 'scripts/velho.sh'), 'antigo\n'); // só no destino
writeSkill(path.join(home, '.grok/bundled/skills/conciliar-demo/SKILL.md'), { name: 'conciliar-demo', body: 'v0' }); // somente leitura
writeSkill(path.join(home, '.agents/skills/conciliar-demo/SKILL.md'), { name: 'conciliar-demo', description: 'customizada à mão', body: 'local' });

test('compareSkillCopies reúne cópias com inventário, assinatura e roots graváveis', async () => {
  const out = await compareSkillCopies({ ...opts, name: 'conciliar-demo' });

  assert.deepEqual(out.copies.map((c) => c.id).sort(), ['agents:user', 'grok:bundled', 'kiro:user', 'zcode:user']);
  assert.equal(out.copies.some((c) => 'content' in c), false, 'o compare não devolve conteúdo');

  const kiro = out.copies.find((c) => c.id === 'kiro:user');
  assert.equal(kiro.writable, true);
  assert.deepEqual(kiro.files.map((f) => f.rel), ['SKILL.md', 'scripts/run.sh']);
  assert.equal(kiro.fileCount, 2);
  assert.match(kiro.skillHash, /^[a-f0-9]{64}$/);
  assert.ok(kiro.outdated === undefined, 'skill fora do catálogo não tem flag outdated');

  const bundled = out.copies.find((c) => c.id === 'grok:bundled');
  assert.equal(bundled.writable, false, 'bundled só serve como origem');

  const destino = out.copies.find((c) => c.id === 'zcode:user');
  assert.notEqual(destino.signature, kiro.signature);
  assert.equal(destino.files.find((f) => f.rel === 'scripts/velho.sh').hash !== null, true);

  const zcodeHarness = out.harnesses.find((h) => h.id === 'zcode');
  assert.equal(zcodeHarness.hasCopy, true);
  assert.equal(zcodeHarness.writable, true);
  const claudeHarness = out.harnesses.find((h) => h.id === 'claude');
  assert.equal(claudeHarness.hasCopy, false);
  assert.ok(claudeHarness.root.endsWith('/.claude/skills'));
  const devinHarness = out.harnesses.find((h) => h.id === 'devin');
  assert.equal(devinHarness.hasCopy, false);
  assert.equal(devinHarness.writable, true, 'harness sem cópia ainda é destino válido');
});

test('compareSkillCopies marca roots symlinkados como a mesma pasta', async () => {
  const out = await compareSkillCopies({ ...opts, name: 'minha-skill' });
  const agents = out.copies.find((c) => c.id === 'agents:user');
  const zcode = out.copies.find((c) => c.id === 'zcode:user');
  assert.equal(agents.signature, zcode.signature);
  assert.equal(zcode.sameDirAs, 'agents:user');

  // a gerenciada aparece também como cópia do catálogo, com outdated por cópia
  const demo = await compareSkillCopies({ ...opts, name: 'ai-memory-demo' });
  const cat = demo.copies.find((c) => c.id === 'managed');
  assert.equal(cat.catalog, true);
  assert.equal(cat.writable, false);
  assert.deepEqual(cat.files.map((f) => f.rel), ['SKILL.md']);
  assert.equal(demo.copies.find((c) => c.id === 'claude:user').outdated, false);
  assert.equal(demo.copies.find((c) => c.id === 'grok:user').outdated, true);

  await assert.rejects(() => compareSkillCopies({ ...opts, name: '../x' }), /inválido/);
});

test('diffSkillCopies devolve hunks do SKILL.md e status por arquivo', async () => {
  const out = await diffSkillCopies({ ...opts, name: 'conciliar-demo', a: 'kiro:user', b: 'zcode:user' });
  assert.equal(out.skillMdSame, false);
  assert.ok(out.diff.hunks.length >= 1);
  assert.ok(out.diff.hunks[0].lines.some((l) => l.type === 'del' && l.text.includes('v2')));
  assert.ok(out.diff.hunks[0].lines.some((l) => l.type === 'add' && l.text.includes('v1')));
  assert.equal(out.files[0].rel, 'SKILL.md', 'SKILL.md vem primeiro no inventário comparado');
  assert.equal(out.files.find((f) => f.rel === 'scripts/run.sh').status, 'differs');
  assert.equal(out.files.find((f) => f.rel === 'scripts/velho.sh').status, 'only-b');

  const iguais = await diffSkillCopies({ ...opts, name: 'conciliar-demo', a: 'kiro:user', b: 'kiro:user' });
  assert.equal(iguais.skillMdSame, true);
  assert.deepEqual(iguais.diff.hunks, []);

  await assert.rejects(() => diffSkillCopies({ ...opts, name: 'conciliar-demo', a: 'kiro:user', b: 'nada:user' }), /não encontrada/);
});

test('reconcileSkillCopies planeja, exige confirmação e propaga com backup', async () => {
  const backupRoot = path.join(home, 'tmp-backups');
  const base = { ...opts, name: 'conciliar-demo', backupRoot };

  const dry = await reconcileSkillCopies({ ...base, source: 'kiro:user', targets: ['zcode:user'], dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.summary.destinations, 1);
  assert.equal(dry.summary.filesToWrite, 2);
  assert.equal(dry.summary.needsConfirm, true, 'destino sem marker gerenciado exige confirmação');
  const dest = dry.plan[0];
  assert.deepEqual(dest.overwrite.sort(), ['SKILL.md', 'scripts/run.sh']);
  assert.deepEqual(dest.create, []);
  assert.deepEqual(dest.extra, ['scripts/velho.sh']);
  assert.deepEqual(dest.remove, [], 'sem removeExtra nada é removido');
  assert.equal(dest.foreignOverwrite, true);
  assert.equal(fs.readFileSync(path.join(conciliarDst, 'SKILL.md'), 'utf8').includes('v1'), true, 'dry-run não escreve');

  const err = await reconcileSkillCopies({ ...base, source: 'kiro:user', targets: ['zcode:user'] }).catch((e) => e);
  assert.equal(err.code, 'NEEDS_CONFIRM');
  assert.match(err.message, new RegExp(RECONCILE_CONFIRM));

  const out = await reconcileSkillCopies({
    ...base,
    source: 'kiro:user',
    targets: ['zcode:user'],
    removeExtra: true,
    confirm: RECONCILE_CONFIRM,
    now: Date.UTC(2026, 0, 2, 3, 4, 5),
  });
  assert.equal(out.ok, true);
  assert.equal(out.summary.filesToRemove, 1);
  const res = out.results[0];
  assert.equal(res.status, 'atualizada');
  assert.deepEqual(res.wrote, []);
  assert.deepEqual(res.overwritten, ['SKILL.md', 'scripts/run.sh']);
  assert.deepEqual(res.removed, ['scripts/velho.sh']);
  assert.equal(fs.readFileSync(path.join(conciliarDst, 'SKILL.md'), 'utf8'), fs.readFileSync(path.join(conciliarSrc, 'SKILL.md'), 'utf8'));
  assert.equal(fs.readFileSync(path.join(conciliarDst, 'scripts/run.sh'), 'utf8'), '#!/bin/sh\necho v2\n');
  assert.equal(fs.existsSync(path.join(conciliarDst, 'scripts/velho.sh')), false);
  assert.ok(res.backup.startsWith(backupRoot), 'backup fica fora da árvore da skill');
  assert.match(fs.readFileSync(path.join(res.backup, 'SKILL.md'), 'utf8'), /v1/, 'backup guarda a versão anterior');
  assert.match(fs.readFileSync(path.join(res.backup, 'scripts/velho.sh'), 'utf8'), /antigo/);

  // segunda passada: nada a fazer, sem confirmação e sem backup novo
  const igual = await reconcileSkillCopies({ ...base, source: 'kiro:user', targets: ['zcode:user'], backupRoot: path.join(home, 'tmp-backups-2') });
  assert.equal(igual.summary.needsConfirm, false);
  assert.equal(igual.summary.filesToWrite, 0);
  assert.equal(igual.results[0].status, 'atualizada');
  assert.deepEqual(igual.results[0].overwritten, []);
  assert.equal(igual.results[0].backup, null, 'sem mudança não gera backup');
  assert.equal(fs.existsSync(path.join(home, 'tmp-backups-2')), false);
});

test('reconcileSkillCopies valida origem/destinos e cria harness sem cópia', async () => {
  const backupRoot = path.join(home, 'tmp-backups');
  const base = { ...opts, name: 'conciliar-demo', backupRoot };

  const mesma = await reconcileSkillCopies({ ...base, source: 'kiro:user', targets: ['kiro:user'], dryRun: true });
  assert.match(mesma.plan[0].skipped, /própria origem/);

  const soLeitura = await reconcileSkillCopies({ ...base, source: 'kiro:user', targets: ['grok:bundled'], dryRun: true });
  assert.match(soLeitura.plan[0].skipped, /somente leitura/);
  assert.equal(soLeitura.summary.destinations, 0);

  const fora = await reconcileSkillCopies({ ...base, source: 'kiro:user', targets: [{ id: 'kiro:project', ws: '/etc' }], dryRun: true });
  assert.match(fora.plan[0].skipped, /fora do diretório home/);

  await assert.rejects(() => reconcileSkillCopies({ ...base, source: 'nada:user', targets: ['zcode:user'] }), /origem não encontrada/);
  await assert.rejects(() => reconcileSkillCopies({ ...base, source: 'kiro:user', targets: [] }), /ao menos um destino/);

  // harness sem cópia: cria a pasta da skill (só o SKILL.md quando includeResources=false)
  const nova = await reconcileSkillCopies({ ...base, source: 'kiro:user', targets: ['opencode:user'], includeResources: false, dryRun: true });
  assert.equal(nova.plan[0].existing, false);
  assert.equal(nova.summary.toCreate, 1);
  const feito = await reconcileSkillCopies({ ...base, source: 'kiro:user', targets: ['opencode:user'], includeResources: false });
  assert.equal(feito.results[0].status, 'criada');
  assert.equal(feito.results[0].backup, null);
  assert.deepEqual(feito.results[0].wrote, ['SKILL.md']);
  const criada = path.join(home, '.config/opencode/skills/conciliar-demo');
  assert.equal(fs.readdirSync(criada).sort().join(','), 'SKILL.md');

  // recursos: a cópia em projeto usa o projectRoot do harness
  const proj = path.join(home, 'tmp-proj/app-concilia');
  fs.mkdirSync(proj, { recursive: true });
  const emProjeto = await reconcileSkillCopies({ ...base, source: 'kiro:user', targets: [{ id: 'claude:project', ws: proj }] });
  assert.equal(emProjeto.results[0].status, 'criada');
  assert.ok(fs.existsSync(path.join(proj, '.claude/skills/conciliar-demo/scripts/run.sh')));
});

test('reconcileSkillCopies restaura cópia gerenciada a partir do catálogo', async () => {
  const out = await reconcileSkillCopies({
    ...opts,
    name: 'ai-memory-demo',
    source: 'managed',
    targets: ['grok:user'],
    backupRoot: path.join(home, 'tmp-backups'),
  });
  assert.equal(out.source.catalog, true);
  assert.equal(out.summary.needsConfirm, false, 'sobrescrever cópia gerenciada não exige confirmação');
  assert.equal(out.results[0].status, 'atualizada');
  assert.equal(fs.readFileSync(path.join(home, '.grok/skills/ai-memory-demo/SKILL.md'), 'utf8'), managedContent);
});

test('reconcileSkillCopies com o catálogo nunca remove recursos do destino', async () => {
  const dir = path.join(home, '.kiro/skills/ai-memory-com-recursos');
  writeSkill(path.join(dir, 'SKILL.md'), { name: 'ai-memory-com-recursos', managed: true, body: 'versão velha' });
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts/util.sh'), 'echo util\n');
  fs.writeFileSync(path.join(dir, 'SKILL.md.bak-1'), 'backup antigo\n');

  const plan = await reconcileSkillCopies({
    ...opts,
    name: 'ai-memory-com-recursos',
    source: 'managed',
    targets: ['kiro:user'],
    removeExtra: true,
    dryRun: true,
  });
  assert.deepEqual(plan.plan[0].extra, [], 'catálogo não tem inventário: nada é "a mais"');
  assert.deepEqual(plan.plan[0].remove, []);
  assert.equal(plan.summary.needsConfirm, false);

  const out = await reconcileSkillCopies({
    ...opts,
    name: 'ai-memory-com-recursos',
    source: 'managed',
    targets: ['kiro:user'],
    removeExtra: true,
    backupRoot: path.join(home, 'tmp-backups'),
  });
  assert.equal(out.results[0].status, 'atualizada');
  assert.ok(fs.existsSync(path.join(dir, 'scripts/util.sh')), 'recurso do destino sobrevive');
  assert.ok(fs.existsSync(path.join(dir, 'SKILL.md.bak-1')), 'backup do destino sobrevive');
  assert.match(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), /conteúdo v1/);
});

// --- rotas HTTP (servidor isolado com home de skills temporário) ---
const HTTP_PORT = 4891;
const HTTP_BASE = `http://127.0.0.1:${HTTP_PORT}`;
const httpHome = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'aim-skills-http-')));
writeSkill(path.join(httpHome, '.kiro/skills/http-skill/SKILL.md'), { name: 'http-skill', description: 'fixture http' });
fs.mkdirSync(path.join(httpHome, '.kiro/skills/http-skill/scripts'), { recursive: true });
fs.writeFileSync(path.join(httpHome, '.kiro/skills/http-skill/scripts/x.sh'), 'echo x\n');
writeSkill(path.join(httpHome, 'projetos/app/.opencode/skills/http-proj/SKILL.md'), { name: 'http-proj', description: 'skill de projeto' });
// duas cópias divergentes da mesma skill (com recurso diferente)
writeSkill(path.join(httpHome, '.kiro/skills/http-dup/SKILL.md'), { name: 'http-dup', description: 'cópia nova', body: 'v2' });
fs.mkdirSync(path.join(httpHome, '.kiro/skills/http-dup/scripts'), { recursive: true });
fs.writeFileSync(path.join(httpHome, '.kiro/skills/http-dup/scripts/run.sh'), 'echo v2\n');
writeSkill(path.join(httpHome, '.grok/skills/http-dup/SKILL.md'), { name: 'http-dup', description: 'cópia velha', body: 'v1' });

test.before(async () => {
  globalThis.__skillsServer = spawn('node', ['server/index.mjs'], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    env: {
      ...process.env,
      AIM_APP_PORT: String(HTTP_PORT),
      AI_MEMORY_BIN: '/bin/echo',
      AI_MEMORY_SKILLS_HOME: httpHome, // scan não toca nos roots reais
      AI_MEMORY_SKILLS_BACKUP_DIR: path.join(httpHome, 'backups'),
      AI_MEMORY_SERVER_URL: 'http://127.0.0.1:1', // MCP indisponível: catálogo vazio e determinístico
    },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${HTTP_BASE}/api/health`)).ok) return;
    } catch {
      // ainda não subiu
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.fail('servidor de teste não subiu');
});

test.after(() => {
  globalThis.__skillsServer?.kill('SIGTERM');
});

test('GET /api/skills lista os harnesses sem depender do MCP', async () => {
  const res = await fetch(`${HTTP_BASE}/api/skills`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(
    data.harnesses.map((h) => h.id),
    ['claude', 'agents', 'opencode', 'zcode', 'grok', 'kiro', 'devin'],
  );
  assert.ok(Array.isArray(data.skills));
  if (data.managedError) assert.equal(data.skills.some((s) => s.managed && s.installable), false);
});

test('POST /api/skills/install rejeita harness desconhecido; content 404 para skill inexistente', async () => {
  const res = await fetch(`${HTTP_BASE}/api/skills/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'qualquer', harness: 'nao-existe' }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /harness desconhecido/);

  const res2 = await fetch(`${HTTP_BASE}/api/skills/content?name=skill-inexistente-xyz`);
  assert.equal(res2.status, 404);
});

test('GET /api/skills/files e /file servem a árvore e o conteúdo', async () => {
  const tree = await fetch(`${HTTP_BASE}/api/skills/files?name=http-skill&harness=kiro`);
  assert.equal(tree.status, 200);
  const data = await tree.json();
  assert.deepEqual(data.files.map((f) => f.rel), ['SKILL.md', 'scripts', 'scripts/x.sh']);

  const file = await fetch(`${HTTP_BASE}/api/skills/file?name=http-skill&harness=kiro&rel=scripts%2Fx.sh`);
  assert.equal(file.status, 200);
  const body = await file.json();
  assert.equal(body.kind, 'text');
  assert.match(body.content, /echo x/);

  const traversal = await fetch(`${HTTP_BASE}/api/skills/file?name=http-skill&harness=kiro&rel=..%2F..%2Fetc%2Fpasswd`);
  assert.equal(traversal.status, 404);
});

test('GET /api/skills/workspaces e /workspace listam skills de projeto', async () => {
  const listRes = await fetch(`${HTTP_BASE}/api/skills/workspaces`);
  assert.equal(listRes.status, 200);
  const data = await listRes.json();
  assert.deepEqual(data.items.map((i) => i.name), ['app']);
  assert.deepEqual(data.items[0].harnesses, [{ id: 'opencode', label: 'OpenCode', count: 1 }]);

  const wsDir = path.join(httpHome, 'projetos/app');
  const detail = await (await fetch(`${HTTP_BASE}/api/skills/workspace?dir=${encodeURIComponent(wsDir)}`)).json();
  assert.equal(detail.skillCount, 1);

  const tree = await (await fetch(`${HTTP_BASE}/api/skills/files?name=http-proj&harness=opencode&ws=${encodeURIComponent(wsDir)}`)).json();
  assert.deepEqual(tree.files.map((f) => f.rel), ['SKILL.md']);
  assert.equal(tree.kind, 'project');

  const fora = await fetch(`${HTTP_BASE}/api/skills/workspace?dir=${encodeURIComponent('/etc')}`);
  assert.equal(fora.status, 400);
});

test('GET /api/skills/compare e /diff mostram as cópias divergentes', async () => {
  const res = await fetch(`${HTTP_BASE}/api/skills/compare?name=http-dup`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data.copies.map((c) => c.id).sort(), ['grok:user', 'kiro:user']);
  assert.equal(data.copies.every((c) => c.writable), true);
  assert.equal(data.copies.some((c) => 'content' in c), false);
  assert.equal(data.harnesses.find((h) => h.id === 'kiro').hasCopy, true);
  assert.equal(data.managedCopies ?? false, false);

  const diffRes = await fetch(`${HTTP_BASE}/api/skills/diff?name=http-dup&a=kiro:user&b=grok:user`);
  assert.equal(diffRes.status, 200);
  const diff = await diffRes.json();
  assert.equal(diff.diff.identical, false);
  assert.ok(diff.diff.hunks.length >= 1);
  assert.equal(diff.files.find((f) => f.rel === 'scripts/run.sh').status, 'only-a');

  const semCopias = await fetch(`${HTTP_BASE}/api/skills/compare?name=nao-existe-xyz`);
  assert.equal(semCopias.status, 200);
  assert.deepEqual((await semCopias.json()).copies, []);

  const ruim = await fetch(`${HTTP_BASE}/api/skills/diff?name=http-dup&a=kiro:user&b=nope:user`);
  assert.equal(ruim.status, 404);
});

test('POST /api/skills/reconcile planeja, exige confirmação e propaga via HTTP', async () => {
  const post = (body) => fetch(`${HTTP_BASE}/api/skills/reconcile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const dry = await post({ name: 'http-dup', source: 'kiro:user', targets: ['grok:user'], dryRun: true });
  assert.equal(dry.status, 200);
  const plan = await dry.json();
  assert.equal(plan.summary.destinations, 1);
  assert.equal(plan.summary.needsConfirm, true);
  assert.deepEqual(plan.plan[0].create, ['scripts/run.sh']);

  const semConfirm = await post({ name: 'http-dup', source: 'kiro:user', targets: ['grok:user'] });
  assert.equal(semConfirm.status, 409);
  const body409 = await semConfirm.json();
  assert.equal(body409.needsConfirm, true);
  assert.equal(body409.word, 'conciliar');
  assert.ok(Array.isArray(body409.plan));

  const feito = await post({ name: 'http-dup', source: 'kiro:user', targets: ['grok:user'], confirm: 'conciliar' });
  assert.equal(feito.status, 200);
  const run = await feito.json();
  assert.equal(run.ok, true);
  assert.equal(run.results[0].status, 'atualizada');
  assert.ok(run.results[0].backup.startsWith(path.join(httpHome, 'backups')), 'backup fora da árvore da skill');
  assert.equal(
    fs.readFileSync(path.join(httpHome, '.grok/skills/http-dup/SKILL.md'), 'utf8'),
    fs.readFileSync(path.join(httpHome, '.kiro/skills/http-dup/SKILL.md'), 'utf8'),
  );
  assert.equal(fs.existsSync(path.join(httpHome, '.grok/skills/http-dup/scripts/run.sh')), true);

  const semOrigem = await post({ name: 'http-dup', source: 'managed', targets: ['grok:user'], dryRun: true });
  assert.equal(semOrigem.status, 400);
});
