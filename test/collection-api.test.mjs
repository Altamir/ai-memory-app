import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Rotas do gestor de skills com servidor isolado: coleção, home e exports em
// temporários (nenhuma escrita no painel real nem no home do usuário).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4795;
const BASE = `http://127.0.0.1:${PORT}`;

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-col-api-'));
const home = fs.realpathSync.native(base);
const colDir = path.join(home, 'colecao');
const skillsExports = path.join(home, 'exports-skills');

let child;

async function waitHealth(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch {
      // ainda não subiu
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

test.before(async () => {
  child = spawn('node', ['server/index.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      AIM_APP_PORT: String(PORT),
      AI_MEMORY_BIN: '/bin/echo',
      AI_MEMORY_SKILLS_HOME: home,
      AIM_APP_SKILLS_DIR: colDir,
      AIM_APP_SKILLS_EXPORT_DIR: skillsExports,
    },
    stdio: 'ignore',
  });
  assert.ok(await waitHealth(), 'servidor de teste não subiu');
});

test.after(() => {
  if (child) child.kill('SIGTERM');
});

const api = async (path_, { method = 'GET', body } = {}) => {
  const res = await fetch(`${BASE}${path_}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
};

/** Espera um job runner terminar (com teto de tempo para não travar a suíte). */
async function waitJob(id, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data } = await api(`/api/jobs/${id}`);
    if (data && data.status !== 'running') return data;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`job ${id} não terminou em ${timeoutMs}ms`);
}

test('coleção começa vazia e os caminhos vêm do env', async () => {
  const { status, data } = await api('/api/collection/skills');
  assert.equal(status, 200);
  assert.equal(data.dir, colDir);
  assert.equal(data.skills.length, 0);
  assert.equal(data.bundles.dir, skillsExports);
});

function writeHarnessSkill(name, body) {
  const dir = path.join(home, '.claude/skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: "skill do harness"\n---\n\n${body}\n`);
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts/run.sh'), 'echo oi\n');
}

async function importBundleAndFinish(file, names) {
  const { status, data } = await api('/api/collection/bundle/import', { method: 'POST', body: { file, names, update: true } });
  assert.equal(status, 201);
  const job = await waitJob(data.id);
  assert.equal(job.status, 'ok', job.error || job.tail);
  return job;
}

test('import do harness, versões, restore e instalação pela API', async () => {
  writeHarnessSkill('da-api', 'conteúdo original');

  const imp = await api('/api/collection/skills/import', { method: 'POST', body: { name: 'da-api', harness: 'claude', kind: 'user' } });
  assert.equal(imp.status, 200);
  assert.equal(imp.data.action, 'criada');
  assert.ok(fs.existsSync(path.join(colDir, 'da-api/scripts/run.sh')));

  const list = await api('/api/collection/skills');
  const skill = list.data.skills.find((s) => s.name === 'da-api');
  assert.equal(skill.files, 2);
  assert.deepEqual(skill.installed, ['claude']);

  const content = await api('/api/collection/skills/content?name=da-api');
  assert.equal(content.status, 200);
  assert.match(content.data.content, /conteúdo original/);

  const ver = await api('/api/collection/skills/version', { method: 'POST', body: { name: 'da-api', note: 'pela api' } });
  assert.equal(ver.status, 200);
  assert.equal(ver.data.version, 1);

  const versions = await api('/api/collection/skills/versions?name=da-api');
  assert.equal(versions.data.versions.length, 1);
  assert.equal(versions.data.versions[0].note, 'pela api');

  const contentV1 = await api('/api/collection/skills/content?name=da-api&version=1');
  assert.equal(contentV1.status, 200);

  const restore = await api('/api/collection/skills/restore', { method: 'POST', body: { name: 'da-api', version: 1 } });
  assert.equal(restore.status, 200);
  assert.equal(restore.data.restored, 1);
  assert.ok(Number.isInteger(restore.data.snapshotId));

  const projectDir = path.join(home, 'projetos/app');
  fs.mkdirSync(projectDir, { recursive: true });
  const install = await api('/api/collection/skills/install', { method: 'POST', body: { name: 'da-api', harness: 'agents', scope: 'project', projectDir } });
  assert.equal(install.status, 200);
  assert.ok(fs.existsSync(path.join(projectDir, '.agents/skills/da-api/SKILL.md')));

  const badName = await api('/api/collection/skills/import', { method: 'POST', body: { name: '../escapa', harness: 'claude', kind: 'user' } });
  assert.equal(badName.status, 400);
  assert.match(badName.data.error, /nome de skill inválido/);
});

test('import com ws (skill de projeto) pela API', async () => {
  const projectDir = path.join(home, 'projetos/proj-x');
  fs.mkdirSync(path.join(projectDir, '.agents/skills/proj-skill'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.agents/skills/proj-skill/SKILL.md'), '---\nname: proj-skill\ndescription: "do projeto"\n---\n\ncorpo\n');

  const imp = await api('/api/collection/skills/import', { method: 'POST', body: { name: 'proj-skill', harness: 'agents', ws: projectDir } });
  assert.equal(imp.status, 200);
  assert.equal(imp.data.action, 'criada');
  assert.match(imp.data.source, /projeto proj-x · agents/);
  assert.ok(fs.existsSync(path.join(colDir, 'proj-skill/SKILL.md')));

  const fora = await api('/api/collection/skills/import', { method: 'POST', body: { name: 'proj-skill', harness: 'agents', ws: '/etc' } });
  assert.equal(fora.status, 400);
});

test('harness-skills lista com flags e import-batch importa o lote', async () => {
  writeHarnessSkill('multi-1', 'lote um');
  writeHarnessSkill('multi-2', 'lote dois');

  const list = await api('/api/collection/harness-skills?harness=claude');
  assert.equal(list.status, 200);
  const alvo = list.data.skills.filter((s) => s.name === 'multi-1' || s.name === 'multi-2');
  assert.equal(alvo.length, 2);
  assert.ok(alvo.every((s) => s.exists === false && s.kinds.includes('user')));

  const batch = await api('/api/collection/skills/import-batch', {
    method: 'POST',
    body: {
      items: [
        { name: 'multi-1', harness: 'claude', kind: 'user' },
        { name: 'multi-2', harness: 'claude', kind: 'user' },
        { name: 'fantasma', harness: 'claude', kind: 'user' },
      ],
    },
  });
  assert.equal(batch.status, 200);
  assert.equal(batch.data.created, 2);
  assert.equal(batch.data.errors, 1);

  // segunda passada: todas idênticas (o servidor responde sem mexer)
  const deNovo = await api('/api/collection/harness-skills?harness=claude');
  const flags = deNovo.data.skills.filter((s) => s.name.startsWith('multi-'));
  assert.ok(flags.every((s) => s.exists === true && s.same === true));

  const again = await api('/api/collection/skills/import-batch', {
    method: 'POST',
    body: { items: [{ name: 'multi-1', harness: 'claude', kind: 'user' }] },
  });
  assert.equal(again.data.same, 1);
  assert.equal(again.data.created + again.data.updated, 0);

  const vazio = await api('/api/collection/skills/import-batch', { method: 'POST', body: { items: [] } });
  assert.equal(vazio.status, 400);
  const harnessRuim = await api('/api/collection/harness-skills?harness=zut');
  assert.equal(harnessRuim.status, 400);
});

test('edição de arquivos pela API com snapshot automático', async () => {
  const files = await api('/api/collection/skills/files?name=multi-1');
  assert.equal(files.status, 200);
  assert.ok(files.data.files.some((f) => f.rel === 'SKILL.md' && f.editable));

  const read = await api('/api/collection/skills/file?name=multi-1&rel=SKILL.md');
  assert.equal(read.status, 200);
  assert.equal(read.data.kind, 'text');

  const save = await api('/api/collection/skills/file', {
    method: 'POST',
    body: { name: 'multi-1', rel: 'SKILL.md', content: `${read.data.content}\neditado pela api\n` },
  });
  assert.equal(save.status, 200);
  assert.equal(save.data.saved, true);
  assert.ok(Number.isInteger(save.data.snapshotId));

  const bad = await api('/api/collection/skills/file', { method: 'POST', body: { name: 'multi-1', rel: '../escapa', content: 'x' } });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /caminho/);

  const missing = await api('/api/collection/skills/files?name=fantasma');
  assert.equal(missing.status, 404);
});

test('bundle de skills pela API: export (job), scan, import (job) e download', async () => {
  const { status, data } = await api('/api/collection/bundle/export', { method: 'POST', body: { name: 'api-skills' } });
  assert.equal(status, 201);
  const job = await waitJob(data.id);
  assert.equal(job.status, 'ok', job.error);

  const bundleFile = path.join(skillsExports, 'api-skills.tar.gz');
  assert.ok(fs.existsSync(bundleFile));

  const scan = await api('/api/collection/bundle/scan', { method: 'POST', body: { file: 'api-skills.tar.gz' } });
  assert.equal(scan.status, 200);
  const names = scan.data.skills.map((s) => s.name);
  assert.ok(names.includes('da-api'));
  const target = scan.data.skills.find((s) => s.name === 'da-api');
  assert.equal(target.exists, true);
  assert.equal(target.same, true); // mesma coleção que exportou

  // reimportar na própria coleção: nada muda (todas idênticas)
  await importBundleAndFinish('api-skills.tar.gz', names);
  assert.ok(fs.existsSync(path.join(colDir, 'da-api/SKILL.md')));

  const download = await fetch(`${BASE}/api/collection/bundle/download?file=${encodeURIComponent('api-skills.tar.gz')}`);
  assert.equal(download.status, 200);
  const bytes = Buffer.from(await download.arrayBuffer());
  assert.ok(bytes.length > 200);

  const missing = await api('/api/collection/bundle/import', { method: 'POST', body: { file: 'api-skills.tar.gz', names: [] } });
  assert.equal(missing.status, 400);

  const badFile = await api('/api/collection/bundle/scan', { method: 'POST', body: { file: '/etc/hosts' } });
  assert.equal(badFile.status, 400);
});
