import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandTilde } from './config.mjs';

// Navegação de diretórios para o seletor de projetos da aba Sessões.
// Restrita à árvore do home: o painel é local, mas evitamos servir o filesystem inteiro.

const home = os.homedir();
const NOISE = new Set(['node_modules', '.git', '.DS_Store']);
const MAX_DIRS = 500;

export function defaultBrowseRoot() {
  const projetos = path.join(home, 'projetos');
  return fs.existsSync(projetos) ? projetos : home;
}

export function listDirs(rawPath) {
  const expanded = expandTilde(String(rawPath || '').trim()) || defaultBrowseRoot();
  const real = fs.realpathSync.native(path.resolve(expanded)); // lança se não existir
  if (real !== home && !real.startsWith(home + path.sep)) {
    throw new Error('navegação restrita ao diretório home');
  }
  if (!fs.statSync(real).isDirectory()) throw new Error('não é um diretório');

  const dirs = [];
  for (const entry of fs.readdirSync(real, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || NOISE.has(entry.name)) continue;
    if (!entry.isDirectory()) continue;
    const full = path.join(real, entry.name);
    let isRepo = false;
    try {
      isRepo = fs.existsSync(path.join(full, '.git'));
    } catch {
      // sem permissão de leitura: trata como não-repo
    }
    dirs.push({ name: entry.name, path: full, isRepo });
    if (dirs.length >= MAX_DIRS) break;
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));

  return {
    path: real,
    home,
    parent: real === home ? null : path.dirname(real),
    isRepoHere: fs.existsSync(path.join(real, '.git')),
    dirs,
  };
}
