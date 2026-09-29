import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listDirs, defaultBrowseRoot } from '../server/dirs.mjs';

const home = os.homedir();

test('raiz padrão de navegação fica sob o home', () => {
  const root = defaultBrowseRoot();
  assert.ok(root === home || root.startsWith(home + path.sep));
  assert.ok(fs.existsSync(root));
});

test('lista subdiretórios e ignora arquivos, dotfiles e node_modules', () => {
  const fixture = fs.mkdtempSync(path.join(home, 'aim-dirtest-'));
  try {
    fs.mkdirSync(path.join(fixture, 'proj-a', '.git'), { recursive: true });
    fs.mkdirSync(path.join(fixture, 'proj-b'));
    fs.mkdirSync(path.join(fixture, 'node_modules'));
    fs.mkdirSync(path.join(fixture, '.oculta'));
    fs.writeFileSync(path.join(fixture, 'arquivo.txt'), 'x');

    const out = listDirs(fixture);
    assert.equal(out.path, fixture);
    const names = out.dirs.map((d) => d.name);
    assert.deepEqual(names, ['proj-a', 'proj-b']); // sem arquivo, .oculta, node_modules
    assert.equal(out.dirs.find((d) => d.name === 'proj-a').isRepo, true);
    assert.equal(out.dirs.find((d) => d.name === 'proj-b').isRepo, false);
    assert.equal(out.parent, path.dirname(fixture));
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('caminho com ~ é expandido', () => {
  const out = listDirs('~');
  assert.equal(out.path, home);
  assert.equal(out.parent, null); // home é a raiz da navegação
});

test('caminho fora do home é rejeitado', () => {
  assert.throws(() => listDirs('/etc'), /restrita ao diretório home/);
  assert.throws(() => listDirs('/tmp'), /restrita ao diretório home/);
  assert.throws(() => listDirs('/'), /restrita ao diretório home|não é um diretório|ENOENT/);
});

test('escape com .. para fora do home é rejeitado', () => {
  assert.throws(() => listDirs(path.join(home, '..', '..')), /restrita ao diretório home/);
});

test('caminho inexistente falha', () => {
  assert.throws(() => listDirs(path.join(home, 'definitivamente-nao-existe-xyz')), /ENOENT|inexistente/);
});
