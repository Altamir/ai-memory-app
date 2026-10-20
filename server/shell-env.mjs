import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Escreve o destino do painel no shell do usuário, para que a CLI da linha de
// comando (`ai-memory run <harness>`, `ai-memory search`, …) fale com o mesmo
// servidor do painel.
//
// Por que variáveis de ambiente e não o perfil do CLI: em 2.5.x os perfis
// (`ai-memory server add`) roteiam apenas a captura por hooks — o launcher do
// `run`, o ledger e os heartbeats continuam hablando com o "install default",
// que é o que o env define. A doc (docs/marker-file.md) é explícita sobre essa
// limitação, então o env continua sendo o caminho para o `run`.
//
// O bloco é gerenciado e delimitado para ser reversível e idempotente:
//
//   # >>> ai-memory-app >>>
//   export AI_MEMORY_SERVER_URL="https://…"
//   export AI_MEMORY_AUTH_TOKEN="…"
//   # <<< ai-memory-app <<<
//
// Reexecutar reescreve o bloco; nunca duplica. Linhas soltas de AI_MEMORY_*
// fora do bloco são comentadas (não apagadas) — é assim que um .zshrc com
// `export AI_MEMORY_SERVER_URL=http://127.0.0.1:49374` antigo deixa de ganhar
// da linha gerenciada sem perder o histórico do arquivo.

const BEGIN = '# >>> ai-memory-app >>>';
const END = '# <<< ai-memory-app <<<';
const MANAGED_KEYS = ['AI_MEMORY_SERVER_URL', 'AI_MEMORY_AUTH_TOKEN'];

const home = () => process.env.AIM_APP_SHELL_HOME || os.homedir();

function shq(value) {
  return `'${String(value ?? '').replace(/'/g, "'\\''")}'`;
}

/** Sufixo do backup: ordena no tempo e não depende do separador do SO. */
function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
}

/**
 * Quais rc's fazem sentido nesta máquina: os que existem sempre entram; o
 * .bash_profile entra só quando existe e não chama o .bashrc (senão o bloco
 * seria avaliado duas vezes). Um rc inexistente que a gente cria precisa ser
 * criado também — é o caso do shell que o usuário ainda não configurou.
 */
function targets({ home: h, exists = fs.existsSync }) {
  const names = ['.zshrc', '.bashrc'];
  const bp = '.bash_profile';
  if (exists(path.join(h, bp))) {
    let body = '';
    try {
      body = fs.readFileSync(path.join(h, bp), 'utf8');
    } catch {
      body = '';
    }
    // se ele já sourcea o .bashrc, escrever lá também é duplicata
    if (!/\.bashrc/.test(body)) names.push(bp);
  }
  return names.map((n) => path.join(h, n));
}

function blockLines({ url, token }) {
  const lines = [BEGIN, `export AI_MEMORY_SERVER_URL=${shq(url)}`];
  if (token) lines.push(`export AI_MEMORY_AUTH_TOKEN=${shq(token)}`);
  lines.push(END);
  return lines.join('\n');
}

/** Índice da linha do BEGIN gerenciado (-1 se não houver bloco). */
function findBlock(lines) {
  const begin = lines.findIndex((l) => l.trim() === BEGIN);
  if (begin < 0) return -1;
  const end = lines.findIndex((l, i) => i > begin && l.trim() === END);
  if (end < 0) return -1; // bloco truncado: não arrisca reescrever o resto do rc
  return begin;
}

/** Linhas soltas (fora do bloco) que definem as vars — precisam sair do caminho. */
function staleLines(lines, blockStart, blockEnd) {
  const out = [];
  lines.forEach((line, i) => {
    // dentro do bloco gerenciado não é linha solta (blockStart = -1 = sem bloco)
    if (blockStart >= 0 && i >= blockStart && i <= blockEnd) return;
    const m = line.match(/^\s*(?:export\s+)?(AI_MEMORY_SERVER_URL|AI_MEMORY_AUTH_TOKEN)\s*=/);
    if (!m) return;
    const commented = line.trim().startsWith('#');
    out.push({ index: i, line, key: m[1], commented });
  });
  return out;
}

function applyToFile(file, body, { createIfMissing = true } = {}) {
  const exists = fs.existsSync(file);
  if (!exists && !createIfMissing) return { file, changed: false, reason: 'ausente' };
  const before = exists ? fs.readFileSync(file, 'utf8') : '';
  const hadTrailingNewline = before === '' || before.endsWith('\n');
  const lines = before === '' ? [] : before.split('\n');

  const start = findBlock(lines);
  const blockEnd = start < 0 ? -1 : lines.findIndex((l, i) => i > start && l.trim() === END);
  // neutraliza o que está solto antes de escrever o bloco (senão a linha antiga
  // continuaria definindo depois do export novo — e no shell a última ganha)
  const stale = staleLines(lines, start, blockEnd);
  const neutralized = lines.map((line, i) => {
    const hit = stale.find((s) => s.index === i && !s.commented);
    if (!hit) return line;
    return line.replace(/^(\s*)(export\s+)?/, '$1# (desativado pelo ai-memory-app) $2');
  });

  const next = [...neutralized];
  if (start >= 0) {
    const end = lines.findIndex((l, i) => i > start && l.trim() === END);
    next.splice(start, end - start + 1, ...blockLines(body).split('\n'));
  } else {
    if (next.length) next.push('');
    next.push(...blockLines(body).split('\n'));
  }

  const after = `${next.join('\n')}${hadTrailingNewline || !exists ? '\n' : ''}`;
  if (after === before) return { file, changed: false };
  let backup = null;
  if (exists) {
    backup = `${file}.bak-aimapp-${stamp()}`;
    fs.copyFileSync(file, backup);
  }
  fs.writeFileSync(file, after, { mode: exists ? undefined : 0o644 });
  return {
    file,
    changed: true,
    created: !exists,
    backup,
    commented: stale.filter((s) => !s.commented).map((s) => s.key),
  };
}

/**
 * Grava (ou reescreve) o bloco gerenciado nos rc's do usuário.
 * `body` = { url, token }; sem token, remove a linha do token do bloco.
 */
export function writeShellEnv({ url, token } = {}) {
  if (!url) throw new Error('url do servidor é obrigatória');
  const h = home();
  const files = [];
  const errors = [];
  for (const file of targets({ home: h })) {
    try {
      files.push(applyToFile(file, { url, token }));
    } catch (err) {
      errors.push(`${path.basename(file)}: ${err.message}`);
    }
  }
  return {
    ok: errors.length === 0,
    files: files.filter((f) => f.changed).map((f) => path.basename(f.file)),
    created: files.filter((f) => f.created).map((f) => path.basename(f.file)),
    backups: files.filter((f) => f.backup).map((f) => path.basename(f.backup)),
    commented: [...new Set(files.flatMap((f) => f.commented || []))],
    errors,
  };
}

/** Remove o bloco gerenciado (usado ao voltar ao servidor do ambiente). */
export function removeShellEnv() {
  const h = home();
  const files = [];
  const errors = [];
  for (const file of targets({ home: h })) {
    try {
      if (!fs.existsSync(file)) continue;
      const before = fs.readFileSync(file, 'utf8');
      const lines = before.split('\n');
      const start = findBlock(lines);
      if (start < 0) continue;
      const end = lines.findIndex((l, i) => i > start && l.trim() === END);
      const next = [...lines.slice(0, start), ...lines.slice(end + 1)];
      while (next.length && next[0].trim() === '') next.shift();
      const after = next.join('\n');
      if (after === before.trimEnd()) continue;
      fs.copyFileSync(file, `${file}.bak-aimapp-${stamp()}`);
      fs.writeFileSync(file, after.endsWith('\n') ? after : `${after}\n`);
      files.push(path.basename(file));
    } catch (err) {
      errors.push(`${path.basename(file)}: ${err.message}`);
    }
  }
  return { ok: errors.length === 0, files, errors };
}

/** Estado do bloco gerenciado (para a tela mostrar se está aplicado). */
export function shellEnvStatus() {
  const h = home();
  const files = [];
  for (const file of targets({ home: h })) {
    try {
      if (!fs.existsSync(file)) continue;
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      const start = findBlock(lines);
      if (start < 0) continue;
      const url = lines[start + 1]?.match(/AI_MEMORY_SERVER_URL=['"]([^'"]*)['"]/)?.[1] || null;
      files.push({ file: path.basename(file), url, hasToken: lines.some((l, i) => i > start && i < start + 8 && l.includes('AI_MEMORY_AUTH_TOKEN=')) });
    } catch {
      // rc ilegível: não é motivo para o painel falhar
    }
  }
  return { applied: files.length > 0, files };
}