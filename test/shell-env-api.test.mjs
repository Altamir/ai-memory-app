import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A rota POST /api/servers com applyShell: salva o destino, registra o perfil na
// CLI e grava o bloco gerenciado nos rc's — e voltar ao ambiente desfaz os dois.
//
// Sobe o painel de verdade num HOME temporário: nenhum rc real é tocado e o CLI
// é um binário falso que só registra como foi chamado.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// porta exclusiva deste arquivo: 4798 já é usada por api.test.mjs (persistência
// de sessões), que sobe um painel na mesma hora quando os arquivos rodam juntos
const PORT = 4792;
const BASE = `http://127.0.0.1:${PORT}`;

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-shellenv-api-'));
const home = path.join(base, 'home');
const remoteData = path.join(base, 'data-remote');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(remoteData, { recursive: true });
fs.writeFileSync(path.join(remoteData, 'auth-token'), 'token-remoto\n');
// rc com a linha obsoleta que o painel precisa neutralizar
fs.writeFileSync(path.join(home, '.zshrc'), 'export PATH="$HOME/bin:$PATH"\n');

// CLI falsa: grava argv+stdin e sai com 0
const calls = path.join(base, 'cli-calls.jsonl');
const fakeCli = path.join(base, 'ai-memory-fake');
fs.writeFileSync(fakeCli, `#!/usr/bin/env node
const fs = require('fs');
let stdin = '';
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv: process.argv.slice(2), stdin }) + '\\n');
});
`, { mode: 0o755 });

const cliCalls = () => (fs.existsSync(calls)
  ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  : []);

const zshrc = () => fs.readFileSync(path.join(home, '.zshrc'), 'utf8');

let panel;
test.before(async () => {
  panel = spawn('node', ['server/index.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      AIM_APP_PORT: String(PORT),
      AIM_APP_SHELL_HOME: home,
      AIM_APP_SERVERS_FILE: path.join(base, '.servers.json'),
      AIM_APP_STATE_FILE: path.join(base, '.sessions.json'),
      AI_MEMORY_BIN: fakeCli,
      AI_MEMORY_SERVER_URL: 'http://127.0.0.1:1',
      AI_MEMORY_DATA_DIR: path.join(base, 'data-local'),
    },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      // ainda não subiu
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('painel de teste não subiu');
});

test.after(() => { if (panel) panel.kill('SIGTERM'); });

const api = async (p, opts = {}) => {
  const res = await fetch(`${BASE}${p}`, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};

test('applyShell grava o bloco no rc e registra o perfil na CLI', async () => {
  const created = await api('/api/servers', {
    method: 'POST',
    body: { name: 'VPS', url: 'https://vps.local', dataDir: remoteData, bin: fakeCli, applyShell: true },
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const vps = created.data.servers.find((s) => s.name === 'VPS');
  assert.ok(vps, JSON.stringify(created.data.servers));
  // criado já ativo: o applyShell do save só age no perfil ativo
  assert.equal(created.data.active.id, vps.id);

  const applied = created.data.applied;
  assert.ok(applied, 'a resposta não traz o resultado do apply');
  assert.equal(applied.shell.ok, true, JSON.stringify(applied.shell));
  assert.equal(applied.cli.ok, true, JSON.stringify(applied.cli));

  // o rc do usuário recebeu o bloco
  const z = zshrc();
  assert.match(z, /# >>> ai-memory-app >>>/);
  assert.match(z, /export AI_MEMORY_SERVER_URL='https:\/\/vps\.local'/);
  assert.match(z, /export AI_MEMORY_AUTH_TOKEN='token-remoto'/);
  // e o PATH do usuário continua lá
  assert.match(z, /export PATH="\$HOME\/bin:\$PATH"/);

  // a CLI recebeu o token por stdin, nunca em argv
  const add = cliCalls().find((c) => c.argv.includes('add'));
  assert.ok(add, 'a CLI não recebeu server add');
  assert.deepEqual(add.argv.slice(2).slice(0, 3), ['server', 'add', 'vps']);
  assert.ok(add.argv.includes('--auth-token-stdin'));
  assert.equal(add.stdin.trim(), 'token-remoto');
  assert.equal(JSON.stringify(add.argv).includes('token-remoto'), false, 'token vazou para argv');
});

test('GET /api/servers mostra o espelhamento aplicado', async () => {
  const { data } = await api('/api/servers');
  assert.equal(data.machine.cliProfile.slug, 'vps');
  assert.equal(data.machine.shell.applied, true);
  assert.ok(data.machine.shell.files.some((f) => f.file === '.zshrc'));
  // e nenhum token na resposta
  assert.equal(JSON.stringify(data).includes('token-remoto'), false);
});

test('sem applyShell nada é escrito fora do painel', async () => {
  const callsBefore = cliCalls().length;
  const zBefore = zshrc();
  const created = await api('/api/servers', {
    method: 'POST',
    body: { name: 'Sem apply', url: 'https://outro.local', dataDir: remoteData, bin: fakeCli },
  });
  assert.equal(created.status, 200);
  assert.equal(created.data.applied, undefined, 'não deveria ter aplicado nada');
  assert.equal(cliCalls().length, callsBefore, 'a CLI não devia ter sido chamada');
  assert.equal(zshrc(), zBefore, 'o rc não devia ter mudado');
  await api(`/api/servers/${created.data.servers.find((s) => s.name === 'Sem apply').id}`, { method: 'DELETE' });
});

test('remover o perfil ativo desfaz o espelhamento (rc e perfil da CLI)', async () => {
  const list = await api('/api/servers');
  const vps = list.data.servers.find((s) => s.name === 'VPS');
  const del = await api(`/api/servers/${encodeURIComponent(vps.id)}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal(del.data.active.id, 'local');
  assert.ok(del.data.removed, 'a resposta não diz o que foi desfeito');
  assert.ok(cliCalls().some((c) => c.argv.includes('remove')), 'o perfil ficou registrado na CLI');
  const z = zshrc();
  assert.doesNotMatch(z, /ai-memory-app/, 'o bloco ficou no rc');
  assert.match(z, /export PATH="\$HOME\/bin:\$PATH"/, 'o rc perdeu o conteúdo do usuário');
});

test('salvar de novo com applyShell não duplica o bloco', async () => {
  const first = await api('/api/servers', {
    method: 'POST',
    body: { name: 'Idempotente', url: 'https://idem.local', dataDir: remoteData, bin: fakeCli, applyShell: true },
  });
  const id = first.data.servers.find((s) => s.name === 'Idempotente').id;
  const zOnce = (zshrc().match(/# >>> ai-memory-app >>>/g) || []).length;
  const second = await api('/api/servers', {
    method: 'POST',
    body: { id, name: 'Idempotente', url: 'https://idem.local', dataDir: remoteData, bin: fakeCli, applyShell: true },
  });
  assert.equal(second.status, 200);
  const zTwice = (zshrc().match(/# >>> ai-memory-app >>>/g) || []).length;
  assert.equal(zTwice, zOnce, 'o bloco duplicou');
  assert.equal((zshrc().match(/AI_MEMORY_SERVER_URL=/g) || []).length, 1, 'export de url duplicado');
  await api(`/api/servers/${encodeURIComponent(id)}`, { method: 'DELETE' });
});

test('CLI ausente não impede o cadastro (volta com o motivo no applied)', async () => {
  const created = await api('/api/servers', {
    method: 'POST',
    body: { name: 'Sem CLI', url: 'https://noclI.local', dataDir: remoteData, bin: '/nao/existe/ai-memory', applyShell: true },
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  assert.ok(created.data.applied, 'sem resultado do apply');
  assert.equal(created.data.applied.cli.ok, false);
  assert.ok(created.data.applied.cli.note, 'sem motivo para o usuário entender');
  // o shell foi configurado mesmo assim — é o que faz o run funcionar
  assert.equal(created.data.applied.shell.ok, true);
  assert.match(zshrc(), /https:\/\/noclI\.local/);
  const id = created.data.servers.find((s) => s.name === 'Sem CLI').id;
  await api(`/api/servers/${encodeURIComponent(id)}`, { method: 'DELETE' });
});