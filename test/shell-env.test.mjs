import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Espelhamento do destino para fora do painel: o bloco gerenciado nos rc's (o
// que faz `ai-memory run <harness>` no terminal falar com o servidor escolhido) e
// o perfil da CLI (o que faz os hooks capturarem nele).
//
// Tudo roda contra um HOME temporário e um binário falso: nenhum rc real é
// tocado e nenhum servidor real é chamado — o que o painel faria na máquina do
// usuário fica registrado num arquivo e conferido aqui.

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-shellenv-'));
const home = path.join(base, 'home');
const dataDir = path.join(base, 'data');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'auth-token'), 'token-da-vps\n');

// binário falso: grava argv e stdin num arquivo e sai com 0
const calls = path.join(base, 'calls.jsonl');
const fakeBin = path.join(base, 'ai-memory-fake');
fs.writeFileSync(fakeBin, `#!/usr/bin/env node
const fs = require('fs');
let stdin = '';
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv: process.argv.slice(2), stdin }) + '\\n');
  if (process.argv.includes('--json')) process.stdout.write(JSON.stringify({ servers: [] }));
});
`, { mode: 0o755 });

process.env.AIM_APP_SHELL_HOME = home;
process.env.AIM_APP_SERVERS_FILE = path.join(base, '.servers.json');
process.env.AI_MEMORY_DATA_DIR = dataDir;

const { writeShellEnv, removeShellEnv, shellEnvStatus } = await import('../server/shell-env.mjs');
const { syncCliProfile, removeCliProfile, profileSlug } = await import('../server/cli-profiles.mjs');

const read = (f) => fs.readFileSync(path.join(home, f), 'utf8');
const rcCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);

function reset() {
  for (const f of ['.zshrc', '.bashrc', '.bash_profile']) {
    fs.rmSync(path.join(home, f), { force: true });
  }
  fs.rmSync(calls, { force: true });
}

test('o bloco gerçado vai para .zshrc e .bashrc com url e token', () => {
  reset();
  const out = writeShellEnv({ url: 'https://aim.altamir.dev', token: 'tok-123' });
  assert.equal(out.ok, true);
  assert.deepEqual(out.files.sort(), ['.bashrc', '.zshrc']);
  const zsh = read('.zshrc');
  assert.match(zsh, /# >>> ai-memory-app >>>/);
  assert.match(zsh, /export AI_MEMORY_SERVER_URL='https:\/\/aim\.altamir\.dev'/);
  assert.match(zsh, /export AI_MEMORY_AUTH_TOKEN='tok-123'/);
  assert.match(zsh, /# <<< ai-memory-app <<</);
  assert.equal(shellEnvStatus().applied, true);
});

test('reexecutar reescreve o bloco em vez de duplicar', () => {
  reset();
  writeShellEnv({ url: 'https://a.local', token: 't1' });
  writeShellEnv({ url: 'https://b.local', token: 't2' });
  const zsh = read('.zshrc');
  assert.equal(zsh.match(/# >>> ai-memory-app >>>/g).length, 1, 'bloco duplicado');
  assert.equal(zsh.match(/AI_MEMORY_SERVER_URL/g).length, 1, 'export de url duplicado');
  assert.match(zsh, /AI_MEMORY_SERVER_URL='https:\/\/b\.local'/);
  assert.match(zsh, /AI_MEMORY_AUTH_TOKEN='t2'/);
});

test('linha solta antiga é comentada, não apagada, e o bloco novo vence', () => {
  reset();
  fs.writeFileSync(path.join(home, '.zshrc'), [
    'export PATH="$HOME/bin:$PATH"',
    'export AI_MEMORY_SERVER_URL="http://127.0.0.1:49374"',
    'export AI_MEMORY_AUTH_TOKEN="token-antigo"',
    'alias ll="ls -la"',
    '',
  ].join('\n'));
  const out = writeShellEnv({ url: 'https://aim.altamir.dev', token: 'novo' });
  const zsh = read('.zshrc');
  assert.match(zsh, /# \(desativado pelo ai-memory-app\) export AI_MEMORY_SERVER_URL="http:\/\/127\.0\.0\.1:49374"/);
  assert.match(zsh, /# \(desativado pelo ai-memory-app\) export AI_MEMORY_AUTH_TOKEN="token-antigo"/);
  // a linha antiga continua no arquivo (histórico preservado)
  assert.match(zsh, /127\.0\.0\.1:49374/);
  assert.deepEqual(out.commented.sort(), ['AI_MEMORY_AUTH_TOKEN', 'AI_MEMORY_SERVER_URL']);
  // e o resto do rc sobrevive intacto
  assert.match(zsh, /alias ll="ls -la"/);
  assert.match(zsh, /export PATH="\$HOME\/bin:\$PATH"/);
});

test('o arquivo original é copiado antes de ser reescrito', () => {
  reset();
  fs.writeFileSync(path.join(home, '.zshrc'), 'export FOO=1\n');
  const out = writeShellEnv({ url: 'https://x.local', token: 't' });
  // backup só do que já existia: o .bashrc foi criado do zero, não copiado
  assert.equal(out.backups.length, 1);
  assert.match(out.backups[0], /^\.zshrc\.bak-aimapp-/);
  assert.equal(fs.readFileSync(path.join(home, out.backups[0]), 'utf8'), 'export FOO=1\n');
});

test('remover o bloco devolve o rc ao que era (sem o bloco)', () => {
  reset();
  fs.writeFileSync(path.join(home, '.zshrc'), 'export FOO=1\n');
  writeShellEnv({ url: 'https://x.local', token: 't' });
  const out = removeShellEnv();
  assert.equal(out.ok, true);
  assert.deepEqual(out.files.sort(), ['.bashrc', '.zshrc']);
  const zsh = read('.zshrc');
  assert.doesNotMatch(zsh, /ai-memory-app/);
  assert.match(zsh, /export FOO=1/);
  assert.equal(shellEnvStatus().applied, false);
});

test('sem token, o bloco grava só a url (não deixa export vazio)', () => {
  reset();
  writeShellEnv({ url: 'https://x.local', token: null });
  const zsh = read('.zshrc');
  assert.match(zsh, /AI_MEMORY_SERVER_URL='https:\/\/x\.local'/);
  assert.doesNotMatch(zsh, /AI_MEMORY_AUTH_TOKEN/);
});

test('.bash_profile só entra quando existe e não sourceia o .bashrc', () => {
  reset();
  // caso 1: existe e sourceia o .bashrc -> não duplica alvo
  fs.writeFileSync(path.join(home, '.bash_profile'), '[ -f ~/.bashrc ] && . ~/.bashrc\n');
  writeShellEnv({ url: 'https://x.local', token: 't' });
  assert.equal(fs.existsSync(path.join(home, '.bash_profile')) ? read('.bash_profile').includes('ai-memory-app') : false, false);
  // caso 2: existe sem sourcear o .bashrc -> é alvo válido
  reset();
  fs.writeFileSync(path.join(home, '.bash_profile'), 'export PATH=/opt/homebrew/bin:$PATH\n');
  writeShellEnv({ url: 'https://x.local', token: 't' });
  assert.match(read('.bash_profile'), /# >>> ai-memory-app >>>/);
});

test('o perfil da CLI recebe o token por stdin, nunca em argv', async () => {
  reset();
  const out = await syncCliProfile({ name: 'Altamir Dev', url: 'https://aim.altamir.dev', token: 'segredo-123', dataDir, bin: fakeBin });
  assert.equal(out.ok, true);
  assert.equal(out.slug, 'altamir-dev');
  const [call] = rcCalls();
  assert.deepEqual(call.argv.slice(2), [
    'server', 'add', 'altamir-dev',
    '--url', 'https://aim.altamir.dev',
    '--root', home,
    '--auth-token-stdin',
  ]);
  assert.equal(call.stdin.trim(), 'segredo-123');
  assert.equal(JSON.stringify(call.argv).includes('segredo-123'), false, 'token vazou para argv');
});

test('sem token o perfil é pulado com aviso (perfil sem token quebra o hook)', async () => {
  reset();
  const out = await syncCliProfile({ name: 'Sem token', url: 'https://x.local', token: null, dataDir, bin: fakeBin });
  assert.equal(out.ok, false);
  assert.equal(out.skipped, true);
  assert.match(out.note, /token/);
  assert.equal(rcCalls().length, 0, 'não deveria ter chamado a CLI');
});

test('CLI ausente/antiga não derruba: volta ok:false com o motivo', async () => {
  reset();
  const out = await syncCliProfile({ name: 'X', url: 'https://x.local', token: 't', dataDir, bin: '/nao/existe/ai-memory' });
  assert.equal(out.ok, false);
  assert.ok(out.note, 'sem motivo para o usuário entender');
});

test('server remove usa o slug do perfil', async () => {
  reset();
  const out = await removeCliProfile({ name: 'Altamir Dev', url: 'https://aim.altamir.dev', dataDir, bin: fakeBin });
  assert.equal(out.ok, true);
  assert.deepEqual(rcCalls()[0].argv.slice(2), ['server', 'remove', 'altamir-dev']);
});

test('o slug cai no host quando o nome não vira nada utilizável', () => {
  assert.equal(profileSlug('   ', 'https://aim.altamir.dev'), 'aim-altamir-dev');
  assert.equal(profileSlug('Servidor Local!', 'http://10.0.0.5:49374'), 'servidor-local');
});