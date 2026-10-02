import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, expandTilde } from './config.mjs';
import { diffLines } from './diff.mjs';
import { tryTool } from './mcp.mjs';

// Catálogo de Agent Skills dos harnesses. A fonte canônica das skills gerenciadas
// do ai-memory é a tool MCP memory_install_self_routing (embutidas no binário);
// o resto vem do filesystem: roots de usuário (instaláveis) e roots somente
// leitura (bundled do grok, plugins do zcode).

export const MANAGED_MARKER = '<!-- ai-memory-managed: routing-skill -->';

/** Palavra que o usuário digita para confirmar uma conciliação destrutiva. */
export const RECONCILE_CONFIRM = 'conciliar';

const MAX_SKILLS = 500;
export const MAX_CONTENT = 256 * 1024;
const MAX_TEXT_FILE = 512 * 1024;
const MAX_IMAGE_FILE = 5 * 1024 * 1024;
const MAX_TREE = 300;
const MAX_HASH_FILE = 1024 * 1024; // acima disso, compara só pelo tamanho
const BACKUP_DIRNAME = '.skill-backups';
export const NAME_RE = /^[\w][\w.-]*$/;

export const IMAGE_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  avif: 'image/avif',
};

/** Home dos roots de skills; env só para testes/isolamento. */
function resolveHome() {
  return process.env.AI_MEMORY_SKILLS_HOME ? expandTilde(process.env.AI_MEMORY_SKILLS_HOME) : os.homedir();
}

/** Mapa de harnesses: roots de leitura e o root de usuário (alvo de instalação). */
export function harnessTargets(home = resolveHome()) {
  const grokHome = process.env.GROK_HOME ? expandTilde(process.env.GROK_HOME) : path.join(home, '.grok');
  const configHome = process.env.XDG_CONFIG_HOME ? expandTilde(process.env.XDG_CONFIG_HOME) : path.join(home, '.config');
  return [
    {
      id: 'claude',
      label: 'Claude Code',
      projectRoot: '.claude/skills',
      roots: [{ kind: 'user', path: path.join(home, '.claude', 'skills') }],
    },
    {
      id: 'agents',
      label: 'Agents (AGENTS.md)',
      projectRoot: '.agents/skills',
      roots: [{ kind: 'user', path: path.join(home, '.agents', 'skills') }],
    },
    {
      id: 'opencode',
      label: 'OpenCode',
      projectRoot: '.opencode/skills',
      roots: [{ kind: 'user', path: path.join(configHome, 'opencode', 'skills') }],
    },
    {
      id: 'zcode',
      label: 'ZCode',
      projectRoot: '.zcode/skills',
      roots: [
        { kind: 'user', path: path.join(home, '.zcode', 'skills') },
        { kind: 'plugin', path: path.join(home, '.zcode', 'cli', 'plugins', 'cache') },
      ],
    },
    {
      id: 'grok',
      label: 'Grok',
      projectRoot: '.grok/skills',
      roots: [
        { kind: 'user', path: path.join(grokHome, 'skills') },
        { kind: 'bundled', path: path.join(grokHome, 'bundled', 'skills') },
      ],
    },
    {
      id: 'kiro',
      label: 'Kiro',
      projectRoot: '.kiro/skills',
      roots: [{ kind: 'user', path: path.join(home, '.kiro', 'skills') }],
    },
    {
      id: 'devin',
      label: 'Devin',
      projectRoot: '.devin/skills',
      roots: [{ kind: 'user', path: path.join(home, '.devin', 'skills') }],
    },
  ];
}

export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text.slice(0, 8192));
  if (!m) return {};
  const out = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let value = kv[2].trim();
    // block scalar (description: > / |-): junta as linhas indentadas seguintes
    if (/^[>|][+-]?$/.test(value)) {
      const folded = value.startsWith('>');
      const parts = [];
      i++;
      while (i < lines.length && (/^\s/.test(lines[i]) || lines[i].trim() === '')) {
        parts.push(lines[i].trim());
        i++;
      }
      i--;
      value = parts.filter(Boolean).join(folded ? ' ' : '\n');
    }
    out[kv[1].toLowerCase()] = value.replace(/^["']+|["']+$/g, '').trim();
  }
  return out;
}

/** Lista `<root>/<skill>/SKILL.md`; silencioso se o root não existe. */
function scanFlat(dir, { harness, kind }, limit) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (out.length >= limit) break;
    // roots como o do zcode instalam skills como symlink: statSync segue o link
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const skillDir = path.join(dir, entry.name);
    const skillFile = path.join(skillDir, 'SKILL.md');
    let text;
    try {
      if (!fs.statSync(skillDir).isDirectory()) continue;
      text = fs.readFileSync(skillFile, 'utf8');
    } catch {
      continue; // symlink quebrado ou dir sem SKILL.md (ex.: `shared` do grok)
    }
    const fm = parseFrontmatter(text);
    out.push({
      harness,
      kind,
      file: skillFile,
      name: (fm.name || entry.name).trim(),
      description: (fm.description || '').trim(),
      managed: text.includes(MANAGED_MARKER),
      content: text.slice(0, MAX_CONTENT),
    });
  }
  return out;
}

/** Desce cache/<publisher>/<plugin>/<version>/skills/<skill>/SKILL.md (plugins do zcode). */
function scanPluginCache(cacheDir, harness, limit) {
  const out = [];
  let publishers;
  try {
    publishers = fs.readdirSync(cacheDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const pub of publishers) {
    if (out.length >= limit) break;
    if (!pub.isDirectory()) continue;
    let plugins;
    try {
      plugins = fs.readdirSync(path.join(cacheDir, pub.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const plugin of plugins) {
      let versions;
      try {
        versions = fs.readdirSync(path.join(cacheDir, pub.name, plugin.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ver of versions) {
        const skillsDir = path.join(cacheDir, pub.name, plugin.name, ver.name, 'skills');
        out.push(...scanFlat(skillsDir, { harness, kind: 'plugin' }, limit - out.length));
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

export function scanAllLocations(home = resolveHome()) {
  const out = [];
  for (const target of harnessTargets(home)) {
    for (const root of target.roots) {
      const left = MAX_SKILLS - out.length;
      if (left <= 0) return out;
      if (root.kind === 'plugin') out.push(...scanPluginCache(root.path, target.id, left));
      else out.push(...scanFlat(expandTilde(root.path), { harness: target.id, kind: root.kind }, left));
    }
  }
  return out;
}

/** Busca o catálogo de skills gerenciadas no MCP; nunca lança. */
export async function fetchManagedCatalog() {
  const res = await tryTool('memory_install_self_routing', {});
  if (!res.ok) return { error: res.error, skills: new Map() };
  const data = res.data && typeof res.data === 'object' ? res.data : {};
  const list = Array.isArray(data.managed_skills) ? data.managed_skills : [];
  const skills = new Map();
  for (const s of list) {
    if (!s || typeof s.name !== 'string' || !s.name) continue;
    skills.set(s.name, {
      name: s.name,
      description: typeof s.description === 'string' ? s.description : '',
      relativePath: typeof s.relative_path === 'string' ? s.relative_path : `${s.name}/SKILL.md`,
      content: typeof s.content === 'string' ? s.content : '',
    });
  }
  return { error: null, skills };
}

function cut(text) {
  return text.length > MAX_CONTENT ? `${text.slice(0, MAX_CONTENT)}\n<!-- truncado -->` : text;
}

/**
 * Une disco × catálogo gerenciado por nome de skill.
 * `managed` permite injetar o catálogo ({ error, skills: Map }) nos testes.
 */
export async function listSkills({ home = resolveHome(), managed } = {}) {
  const catalog = managed ?? (await fetchManagedCatalog());
  const targets = harnessTargets(home);

  const disk = new Map(); // name -> { description, managed, locations: [loc + content] }
  for (const loc of scanAllLocations(home)) {
    let entry = disk.get(loc.name);
    if (!entry) disk.set(loc.name, (entry = { description: '', managed: false, locations: [] }));
    if (!entry.description && loc.description) entry.description = loc.description;
    if (loc.managed) entry.managed = true;
    entry.locations.push(loc);
  }

  const buildSkill = (name, meta) => {
    const entry = disk.get(name);
    const locations = (entry?.locations || []).map((loc) => ({
      harness: loc.harness,
      kind: loc.kind,
      path: loc.file,
      managed: loc.managed,
      // gerenciada desatualizada: cópia em disco difere do catálogo do binário
      outdated: Boolean(meta?.content) && loc.managed && loc.content !== meta.content,
    }));
    const installed = {};
    for (const loc of locations) installed[loc.harness] = true;
    // mesmo nome em mais de um root pode ser skill diferente (ex.: review do grok
    // user × bundled): sinaliza para o viewer não esconder a outra cópia
    const contents = new Set((entry?.locations || []).map((l) => l.content));
    return {
      name,
      description: entry?.description || meta?.description || '',
      managed: Boolean(entry?.managed) || Boolean(meta),
      locations,
      installed,
      installable: Boolean(meta?.content) || (entry?.locations || []).some((l) => l.kind === 'user'),
      ...(contents.size > 1 ? { diverged: true } : {}),
    };
  };

  const skills = [];
  for (const [name, entry] of disk) skills.push(buildSkill(name, catalog.skills.get(name) || null));
  for (const [name, meta] of catalog.skills) {
    if (!disk.has(name)) skills.push(buildSkill(name, meta));
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));

  return {
    harnesses: targets.map((t) => ({
      id: t.id,
      label: t.label,
      projectRoot: t.projectRoot,
      roots: t.roots.map((r) => {
        const real = expandTilde(r.path);
        return { kind: r.kind, path: real, exists: fs.existsSync(real) };
      }),
    })),
    skills,
    ...(catalog.error ? { managedError: catalog.error } : {}),
  };
}

/** Conteúdo de uma skill: do catálogo gerenciado ou de uma cópia em disco. */
export async function getSkillContent({ name, harness, kind, home = resolveHome(), managed } = {}) {
  if (!name || !NAME_RE.test(name)) throw new Error('nome de skill inválido');

  if (!harness || kind === 'managed') {
    const catalog = managed ?? (await fetchManagedCatalog());
    const meta = catalog.skills.get(name);
    if (meta?.content) return { name, source: { managed: true }, content: cut(meta.content) };
    if (!harness) throw new Error(`skill "${name}" não está no catálogo gerenciado do ai-memory`);
  }

  const locs = scanAllLocations(home).filter(
    (l) => l.name === name && (!harness || l.harness === harness) && (!kind || l.kind === kind),
  );
  const loc = locs.find((l) => l.kind === 'user') || locs[0];
  if (loc) return { name, source: { harness: loc.harness, kind: loc.kind, path: loc.file }, content: cut(loc.content) };

  // ausente no disco pedido, mas pode existir no catálogo (preview de instalável)
  const catalog = managed ?? (await fetchManagedCatalog());
  const meta = catalog.skills.get(name);
  if (meta?.content) return { name, source: { managed: true }, content: cut(meta.content) };
  throw new Error(`skill "${name}" não encontrada${harness ? ` no harness ${harness}` : ''}`);
}

/**
 * Instala uma skill em um harness. Gerenciadas vêm do catálogo do binário;
 * as outras são copiadas do primeiro root de usuário onde existirem.
 * `sourceDir` instala um diretório completo (SKILL.md + recursos) — é o modo
 * usado pelo gestor de skills ao instalar da coleção.
 * Sobrescrita só ocorre com o marker gerenciado no arquivo existente ou com force.
 */
export async function installSkill({ name, scope = 'global', harness, projectDir, force = false, home = resolveHome(), managed, sourceDir } = {}) {
  if (!name || !NAME_RE.test(name)) throw new Error('nome de skill inválido');
  const targets = harnessTargets(home);
  const target = targets.find((t) => t.id === harness);
  if (!target) throw new Error(`harness desconhecido: ${harness || '(vazio)'} — use ${targets.map((t) => t.id).join(', ')}`);

  let content = null;
  let source = null;
  if (sourceDir) {
    if (!fs.existsSync(path.join(sourceDir, 'SKILL.md'))) throw new Error(`origem sem SKILL.md: ${sourceDir}`);
    source = { collection: true, dir: sourceDir };
  } else {
    const catalog = managed ?? (await fetchManagedCatalog());
    const meta = catalog.skills.get(name);
    content = meta?.content || null;
    source = meta ? { managed: true } : null;
    if (!content) {
      const src = scanAllLocations(home).find((l) => l.name === name && l.kind === 'user');
      if (!src) throw new Error(`skill "${name}" não encontrada: não está no catálogo gerenciado nem em nenhum root de usuário`);
      content = src.content;
      source = { harness: src.harness, kind: src.kind, path: src.file };
    }
  }

  let rootDir;
  if (scope === 'project') {
    if (!projectDir) throw new Error('escopo projeto exige projectDir');
    const real = assertUnderHome(projectDir, home);
    if (!fs.statSync(real).isDirectory()) throw new Error('projectDir não é um diretório');
    rootDir = path.join(real, target.projectRoot);
  } else {
    const root = target.roots.find((r) => r.kind === 'user');
    if (!root) throw new Error(`harness ${harness} não tem root de usuário instalável`);
    rootDir = expandTilde(root.path);
  }

  const skillDir = path.join(rootDir, name);
  const skillFile = path.join(skillDir, 'SKILL.md');
  let backup = null;
  if (fs.existsSync(skillFile)) {
    const existing = fs.readFileSync(skillFile, 'utf8');
    if (!existing.includes(MANAGED_MARKER) && !force) {
      const err = new Error(`"${name}" já existe em ${skillFile} sem o marker gerenciado — repita com force para sobrescrever`);
      err.code = 'NEEDS_FORCE';
      throw err;
    }
    if (sourceDir) {
      // diretório completo: backup da pasta inteira no root de backups (mesmo padrão da conciliação)
      const stamp = new Date(Date.now()).toISOString().replace(/[:.]/g, '-');
      backup = path.join(backupRootDir(), `${stamp}-${name}-${target.id}`);
      fs.mkdirSync(backup, { recursive: true });
      fs.cpSync(skillDir, backup, { recursive: true, dereference: false, force: true, errorOnExist: false });
    } else {
      backup = `${skillFile}.bak-${Date.now()}`; // mesmo padrão de backup da CLI install-skills
      fs.copyFileSync(skillFile, backup);
    }
  }
  fs.mkdirSync(skillDir, { recursive: true });
  if (sourceDir) {
    for (const f of listFilesInDir(sourceDir)) {
      if (f.type !== 'file') continue;
      const dest = path.join(skillDir, f.rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(sourceDir, f.rel), dest);
    }
  } else {
    fs.writeFileSync(skillFile, content.endsWith('\n') ? content : `${content}\n`);
  }
  return { ok: true, path: skillFile, action: backup ? 'updated' : 'created', backup, source };
}

/** Resolve um caminho existente e garante que está sob o home. */
export function assertUnderHome(dir, home = resolveHome()) {
  const real = fs.realpathSync.native(path.resolve(expandTilde(dir))); // lança se não existir
  const realHome = fs.realpathSync.native(home);
  if (real !== realHome && !real.startsWith(realHome + path.sep)) throw new Error('caminho fora do diretório home');
  return real;
}

/** Confina ao home um caminho que pode ainda não existir (destino de escrita). */
function assertUnderHomeTarget(target, home) {
  const realHome = fs.realpathSync.native(home);
  let probe = path.resolve(target);
  const rest = [];
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    rest.unshift(path.basename(probe));
    probe = parent;
  }
  const full = path.join(fs.realpathSync.native(probe), ...rest);
  if (full !== realHome && !full.startsWith(realHome + path.sep)) throw new Error('caminho fora do diretório home');
  return full;
}

// ---------- cópias divergentes: comparar, diffar e conciliar ----------

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** Identificador estável de uma cópia: `harness:kind` ou `managed`. */
export function skillCopyId({ harness, kind } = {}) {
  return kind === 'managed' ? 'managed' : `${harness || ''}:${kind || 'user'}`;
}

/** Hash e tamanho de um arquivo; acima do limite compara só pelo tamanho. */
function fileInfo(full) {
  let st;
  try {
    st = fs.statSync(full);
  } catch {
    return { size: 0, hash: null };
  }
  if (!st.isFile()) return { size: 0, hash: null };
  if (st.size > MAX_HASH_FILE) return { size: st.size, hash: `size:${st.size}` };
  try {
    return { size: st.size, hash: sha256(fs.readFileSync(full)) };
  } catch {
    return { size: st.size, hash: null };
  }
}

/** Inventário de arquivos de um diretório de skill: rel, tamanho, hash e tipo. */
function inventoryDir(dir) {
  const out = [];
  for (const f of listFilesInDir(dir)) {
    if (f.type !== 'file') continue;
    const info = fileInfo(path.join(dir, f.rel));
    out.push({ rel: f.rel, size: info.size, hash: info.hash, kind: f.kind });
  }
  return out;
}

/** Assinatura do conteúdo inteiro da cópia: mesma assinatura = cópias idênticas. */
function signatureOf(files) {
  return sha256(files.map((f) => `${f.rel}:${f.hash}`).join('\n'));
}

/**
 * Todas as cópias de uma skill: roots de harness (disco) + catálogo gerenciado.
 * Devolve também o conteúdo de cada SKILL.md — o compare remove antes de responder.
 */
async function collectCopies({ name, home = resolveHome(), managed } = {}) {
  if (!name || !NAME_RE.test(name)) throw new Error('nome de skill inválido');
  const labels = new Map(harnessTargets(home).map((t) => [t.id, t.label]));
  const copies = [];
  const byRealDir = new Map();

  for (const loc of scanAllLocations(home)) {
    if (loc.name !== name) continue;
    const dir = path.dirname(loc.file);
    let realDir = dir;
    try {
      realDir = fs.realpathSync.native(dir);
    } catch {
      // pasta inacessível: mantém o caminho aparente
    }
    let mtime = null;
    try {
      mtime = fs.statSync(loc.file).mtimeMs;
    } catch {
      // sem stat: segue sem data
    }
    const files = inventoryDir(dir);
    const id = `${loc.harness}:${loc.kind}`;
    const twin = byRealDir.get(realDir) || null;
    if (!twin) byRealDir.set(realDir, id);
    copies.push({
      id,
      label: `${labels.get(loc.harness) || loc.harness} · ${loc.kind}`,
      harness: loc.harness,
      kind: loc.kind,
      catalog: false,
      path: loc.file,
      dir,
      realDir,
      // roots com symlink entre si (ex.: .zcode/skills → .agents/skills) são a MESMA pasta
      sameDirAs: twin,
      writable: loc.kind === 'user' || loc.kind === 'project',
      managed: loc.managed,
      mtime,
      skillHash: files.find((f) => f.rel === 'SKILL.md')?.hash ?? null,
      signature: signatureOf(files),
      files,
      fileCount: files.length,
      content: loc.content,
    });
  }

  const catalog = managed ?? (await fetchManagedCatalog());
  const meta = catalog.skills.get(name);
  let catalogHash = null;
  if (meta?.content) {
    catalogHash = sha256(meta.content);
    copies.push({
      id: 'managed',
      label: 'catálogo do ai-memory',
      harness: null,
      kind: 'managed',
      catalog: true,
      path: null,
      dir: null,
      realDir: `catalog:${name}`,
      sameDirAs: null,
      writable: false,
      managed: true,
      mtime: null,
      skillHash: catalogHash,
      signature: signatureOf([{ rel: 'SKILL.md', hash: catalogHash }]),
      files: [{ rel: 'SKILL.md', size: meta.content.length, hash: catalogHash, kind: 'text' }],
      fileCount: 1,
      content: meta.content,
    });
  }
  for (const c of copies) {
    if (!c.catalog && catalogHash) c.outdated = c.skillHash !== catalogHash;
  }
  return { copies, catalogError: catalog.error || null, catalogAvailable: Boolean(catalogHash) };
}

/**
 * Compara as cópias de uma skill: inventário, assinatura de conteúdo e quais
 * roots graváveis existem. É a base do painel de conciliação (sem conteúdo).
 */
export async function compareSkillCopies({ name, home = resolveHome(), managed } = {}) {
  const { copies, catalogError } = await collectCopies({ name, home, managed });
  return {
    name,
    copies: copies.map(({ content, realDir, ...rest }) => rest),
    harnesses: harnessTargets(home).map((t) => {
      const root = t.roots.find((r) => r.kind === 'user');
      return {
        id: t.id,
        label: t.label,
        root: root ? expandTilde(root.path) : null,
        writable: Boolean(root),
        hasCopy: copies.some((c) => !c.catalog && c.harness === t.id),
      };
    }),
    ...(catalogError ? { catalogError } : {}),
  };
}

/** Diff (SKILL.md + inventário de arquivos) entre duas cópias da mesma skill. */
export async function diffSkillCopies({ name, a, b, context = 3, home = resolveHome(), managed } = {}) {
  const { copies } = await collectCopies({ name, home, managed });
  const pick = (id) => {
    const c = copies.find((x) => x.id === id);
    if (!c) throw new Error(`cópia não encontrada nesta skill: ${id || '(vazio)'}`);
    return c;
  };
  const ca = pick(a);
  const cb = pick(b);

  const rels = [...new Set([...ca.files, ...cb.files].map((f) => f.rel))].sort((x, y) => {
    if (x === 'SKILL.md' || y === 'SKILL.md') return x === y ? 0 : x === 'SKILL.md' ? -1 : 1;
    return x.localeCompare(y);
  });
  const ia = new Map(ca.files.map((f) => [f.rel, f.hash]));
  const ib = new Map(cb.files.map((f) => [f.rel, f.hash]));
  const files = rels.map((rel) => {
    const ha = ia.get(rel);
    const hb = ib.get(rel);
    const status = ha === undefined ? 'only-b' : hb === undefined ? 'only-a' : ha === hb ? 'same' : 'differs';
    return { rel, status };
  });

  return {
    name,
    a: { id: ca.id, label: ca.label, dir: ca.dir },
    b: { id: cb.id, label: cb.label, dir: cb.dir },
    skillMdSame: ca.skillHash === cb.skillHash,
    sameFiles: files.filter((f) => f.status === 'same').length,
    files,
    diff: diffLines(ca.content || '', cb.content || '', { context }),
  };
}

/** Raiz gravável de um destino (`user` = root do harness, `project` = workspace). */
function targetRootFor({ harness, kind, ws, home }) {
  const targets = harnessTargets(home);
  const target = targets.find((t) => t.id === harness);
  if (!target) throw new Error(`harness desconhecido: ${harness || '(vazio)'} — use ${targets.map((t) => t.id).join(', ')}`);
  if (kind === 'project') {
    if (!ws) throw new Error('cópia de projeto exige o diretório do workspace (ws)');
    return path.join(assertUnderHome(ws, home), target.projectRoot);
  }
  if (kind !== 'user') throw new Error(`cópia do tipo "${kind}" é somente leitura: serve como origem, não como destino`);
  const root = target.roots.find((r) => r.kind === 'user');
  if (!root) throw new Error(`harness ${target.id} não tem root de usuário gravável`);
  return expandTilde(root.path);
}

function backupRootDir(backupRoot) {
  return expandTilde(backupRoot || process.env.AI_MEMORY_SKILLS_BACKUP_DIR || path.join(config.root, BACKUP_DIRNAME));
}

/** Arquivos de backup gerados pelas instalações (`.bak-<ts>`) não são removidos. */
const KEEP_EXTRA_RE = /\.bak-\d+$/;

/**
 * Concilia cópias: copia o conteúdo de uma origem (uma cópia em disco ou o
 * catálogo gerenciado) para as cópias de destino escolhidas, com backup do
 * destino antes de qualquer escrita.
 *
 * `dryRun` devolve só o plano; sem ele, grava. Destinos com SKILL.md sem o
 * marker gerenciado ou com arquivos a remover exigem `confirm: RECONCILE_CONFIRM`.
 */
export async function reconcileSkillCopies({
  name,
  source,
  targets,
  includeResources = true,
  removeExtra = false,
  dryRun = false,
  confirm,
  home = resolveHome(),
  managed,
  backupRoot,
  now = Date.now(),
} = {}) {
  if (!name || !NAME_RE.test(name)) throw new Error('nome de skill inválido');
  const { copies } = await collectCopies({ name, home, managed });
  const srcId = typeof source === 'string' ? source : skillCopyId(source || {});
  const src = copies.find((c) => c.id === srcId);
  if (!src) throw new Error(`cópia de origem não encontrada nesta skill: ${srcId || '(vazio)'}`);

  const wanted = Array.isArray(targets) ? targets : [];
  if (!wanted.length) throw new Error('escolha ao menos um destino');

  const sourceFiles = includeResources || src.catalog ? src.files : src.files.filter((f) => f.rel === 'SKILL.md');
  const plan = [];
  const usedDirs = new Map();

  for (const raw of wanted) {
    const spec = typeof raw === 'string' ? { id: raw } : raw || {};
    const id = spec.id || skillCopyId(spec);
    const [harness, kind] = id.split(':');
    const known = copies.find((c) => c.id === id);
    const entry = {
      id,
      label: known?.label || `${harness} · ${kind}`,
      harness,
      kind,
      from: known?.dir || null,
    };
    try {
      if (id === src.id) throw new Error('é a própria origem');
      const rootDir = targetRootFor({ harness, kind, ws: spec.ws, home });
      const dir = assertUnderHomeTarget(path.join(rootDir, name), home);
      if (src.dir && dir === src.realDir) throw new Error('é a mesma pasta da origem (roots symlinkados entre si)');
      const seen = usedDirs.get(dir);
      if (seen) throw new Error(`mesma pasta do destino ${seen}`);
      usedDirs.set(dir, id);

      const existing = fs.existsSync(path.join(dir, 'SKILL.md'));
      const current = existing ? inventoryDir(dir) : [];
      const index = new Map(current.map((f) => [f.rel, f.hash]));
      const create = [];
      const overwrite = [];
      const same = [];
      for (const f of sourceFiles) {
        const hash = index.get(f.rel);
        if (hash === undefined) create.push(f.rel);
        else if (hash === f.hash) same.push(f.rel);
        else overwrite.push(f.rel);
      }
      const extra = [];
      const remove = [];
      const kept = [];
      // o catálogo carrega só o SKILL.md: sem inventário completo, nada no destino
      // pode ser considerado "a mais" (evita apagar recursos ao reconciliar do catálogo)
      if (existing && includeResources && !src.catalog) {
        const names = new Set(sourceFiles.map((f) => f.rel));
        for (const f of current) {
          if (names.has(f.rel)) continue;
          extra.push(f.rel);
          if (!removeExtra) continue;
          if (KEEP_EXTRA_RE.test(f.rel)) kept.push(f.rel);
          else remove.push(f.rel);
        }
      }
      const foreignOverwrite = existing && overwrite.includes('SKILL.md') && !fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8').includes(MANAGED_MARKER);
      plan.push({
        ...entry,
        dir,
        existing,
        create,
        overwrite,
        same,
        extra,
        remove,
        kept,
        foreignOverwrite,
        error: null,
      });
    } catch (err) {
      plan.push({ ...entry, skipped: err.message, error: null });
    }
  }

  const active = plan.filter((p) => !p.error && !p.skipped);
  const summary = {
    destinations: active.length,
    toCreate: active.filter((p) => !p.existing).length,
    filesToWrite: active.reduce((n, p) => n + p.create.length + p.overwrite.length, 0),
    filesToRemove: active.reduce((n, p) => n + p.remove.length, 0),
    skipped: plan.filter((p) => p.skipped).length,
    needsConfirm: active.some((p) => p.foreignOverwrite || p.remove.length > 0),
  };
  const base = {
    name,
    source: { id: src.id, label: src.label, dir: src.dir, catalog: src.catalog, files: sourceFiles.length },
    includeResources,
    removeExtra,
    plan,
    summary,
    backupRoot: backupRootDir(backupRoot),
  };

  if (dryRun) return { ...base, dryRun: true };
  if (summary.needsConfirm && confirm !== RECONCILE_CONFIRM) {
    const err = new Error(
      `confirmação necessária: digite "${RECONCILE_CONFIRM}" — o plano sobrescreve cópias sem o marker gerenciado ou remove arquivos`,
    );
    err.code = 'NEEDS_CONFIRM';
    err.plan = plan;
    throw err;
  }

  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const ordered = [...sourceFiles].sort((x, y) => {
    if (x.rel === 'SKILL.md' || y.rel === 'SKILL.md') return x.rel === y.rel ? 0 : x.rel === 'SKILL.md' ? -1 : 1;
    return x.rel.localeCompare(y.rel);
  });

  const results = [];
  for (const p of plan) {
    if (p.error || p.skipped) {
      results.push({ ...p, status: p.skipped ? 'ignorada' : 'erro' });
      continue;
    }
    try {
      let backup = null;
      const mudanca = p.create.length || p.overwrite.length || p.remove.length;
      if (p.existing && mudanca) {
        backup = path.join(base.backupRoot, `${stamp}-${name}-${p.id.replace(/[^\w.-]/g, '-')}`);
        fs.mkdirSync(path.dirname(backup), { recursive: true });
        fs.cpSync(p.dir, backup, { recursive: true, dereference: false, force: true, errorOnExist: false });
      }
      const wrote = [];
      const overwritten = [];
      const skippedFiles = [];
      fs.mkdirSync(p.dir, { recursive: true });
      for (const f of ordered) {
        const known = p.create.includes(f.rel) ? 'create' : p.overwrite.includes(f.rel) ? 'overwrite' : 'same';
        if (known === 'same') {
          skippedFiles.push(f.rel);
          continue;
        }
        const dest = path.join(p.dir, f.rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (src.catalog) fs.writeFileSync(dest, src.content);
        else fs.copyFileSync(path.join(src.dir, f.rel), dest);
        (known === 'create' ? wrote : overwritten).push(f.rel);
      }
      const removed = [];
      for (const rel of p.remove) {
        fs.rmSync(path.join(p.dir, rel), { force: true });
        removed.push(rel);
        // não deixa pasta vazia para trás
        let parent = path.dirname(path.join(p.dir, rel));
        while (parent !== p.dir && parent.startsWith(p.dir + path.sep)) {
          try {
            fs.rmdirSync(parent);
          } catch {
            break; // não vazia
          }
          parent = path.dirname(parent);
        }
      }
      results.push({
        id: p.id,
        label: p.label,
        dir: p.dir,
        status: p.existing ? 'atualizada' : 'criada',
        wrote,
        overwritten,
        same: skippedFiles,
        removed,
        kept: p.kept,
        backup,
      });
    } catch (err) {
      results.push({ id: p.id, label: p.label, dir: p.dir, status: 'erro', error: err.message });
    }
  }

  return { ...base, dryRun: false, results, ok: results.every((r) => r.status !== 'erro') };
}

/** Localiza uma cópia da skill: a pedida (harness/kind) ou a primeira de usuário. */
export function findLocation({ name, harness, kind, home = resolveHome() } = {}) {
  if (!name || !NAME_RE.test(name)) throw new Error('nome de skill inválido');
  const locs = scanAllLocations(home).filter(
    (l) => l.name === name && (!harness || l.harness === harness) && (!kind || l.kind === kind),
  );
  return locs.find((l) => l.kind === 'user') || locs[0] || null;
}

/**
 * Diretório de uma cópia da skill: global (harness/kind) ou de projeto
 * (ws = diretório do workspace + harness, com o projectRoot derivado aqui).
 */
function resolveSkillDir({ name, harness, kind, ws, home = resolveHome() } = {}) {
  if (!name || !NAME_RE.test(name)) throw new Error('nome de skill inválido');
  if (ws) {
    const target = harnessTargets(home).find((t) => t.id === harness);
    if (!target) throw new Error(`harness desconhecido: ${harness || '(vazio)'} — use ${harnessTargets(home).map((t) => t.id).join(', ')}`);
    const base = assertUnderHome(ws, home);
    const dir = path.join(base, target.projectRoot, name);
    if (!fs.existsSync(path.join(dir, 'SKILL.md'))) {
      throw new Error(`skill "${name}" não encontrada em ${base} (${harness})`);
    }
    return { dir, kind: 'project', harness: target.id, ws: base };
  }
  const loc = findLocation({ name, harness, kind, home });
  if (!loc) throw new Error(`skill "${name}" não encontrada${harness ? ` no harness ${harness}` : ''} (a cópia precisa existir em disco)`);
  return { dir: path.dirname(loc.file), kind: loc.kind, harness: loc.harness, ws: null };
}

function fileKindFor(rel) {
  const ext = path.extname(rel).slice(1).toLowerCase();
  return IMAGE_MIME[ext] ? 'image' : 'text'; // o binário é detectado na leitura (byte NUL)
}

/** Árvore de arquivos de um diretório de skill (SKILL.md primeiro). */
export function listFilesInDir(rootDir) {
  const files = [];
  const visited = new Set();

  const visit = (dir, relBase, level) => {
    if (files.length >= MAX_TREE || level > 6) return;
    let real;
    try {
      real = fs.realpathSync.native(dir);
    } catch {
      return;
    }
    if (visited.has(real)) return; // evita loop de symlink
    visited.add(real);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= MAX_TREE) return;
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.DS_Store') continue;
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        let st;
        try {
          st = fs.statSync(full);
        } catch {
          continue; // link quebrado
        }
        if (st.isDirectory()) continue; // não desce em dir symlinkado
        files.push({ rel, type: 'file', kind: fileKindFor(rel), size: st.size });
      } else if (entry.isDirectory()) {
        files.push({ rel, type: 'dir' });
        visit(full, rel, level + 1);
      } else if (entry.isFile()) {
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {
          // sem stat: mostra mesmo assim
        }
        files.push({ rel, type: 'file', kind: fileKindFor(rel), size });
      }
    }
  };

  visit(rootDir, '', 0);
  const mainIdx = files.findIndex((f) => f.rel === 'SKILL.md');
  if (mainIdx > 0) files.unshift(files.splice(mainIdx, 1)[0]);
  return files;
}

/** Árvore de arquivos da skill (global ou de um workspace com `ws`). */
export function listSkillFiles({ name, harness, kind, ws, home = resolveHome() } = {}) {
  const r = resolveSkillDir({ name, harness, kind, ws, home });
  return { name, dir: r.dir, harness: r.harness, kind: r.kind, ws: r.ws, files: listFilesInDir(r.dir) };
}

/** Conteúdo de um arquivo da skill: texto, imagem (data URL) ou metadados de binário. */
export function readSkillFile({ name, harness, kind, ws, rel, home = resolveHome() } = {}) {
  const r = resolveSkillDir({ name, harness, kind, ws, home });
  const rootDir = r.dir;
  const relPath = String(rel || 'SKILL.md').trim();
  if (!relPath || path.isAbsolute(relPath) || relPath.split(/[\\/]/).includes('..')) {
    throw new Error('caminho de arquivo inválido');
  }
  const full = path.resolve(rootDir, relPath);
  if (full !== rootDir && !full.startsWith(rootDir + path.sep)) throw new Error('caminho fora da skill');
  const st = fs.statSync(full); // lança se não existir
  if (!st.isFile()) throw new Error('não é um arquivo');

  const ext = path.extname(full).slice(1).toLowerCase();
  if (IMAGE_MIME[ext]) {
    if (st.size > MAX_IMAGE_FILE) throw new Error(`imagem grande demais para exibir (${st.size} bytes)`);
    const dataUrl = `data:${IMAGE_MIME[ext]};base64,${fs.readFileSync(full).toString('base64')}`;
    return { name, rel: relPath, kind: 'image', size: st.size, dataUrl };
  }
  const buf = fs.readFileSync(full);
  if (buf.includes(0) || st.size > MAX_TEXT_FILE) {
    return { name, rel: relPath, kind: 'binary', size: st.size };
  }
  return { name, rel: relPath, kind: 'text', size: st.size, content: buf.toString('utf8') };
}

/** Skills de projeto dentro de um workspace, agrupadas por harness. */
export function getWorkspaceSkills({ dir, home = resolveHome() } = {}) {
  if (!dir) throw new Error('dir obrigatório');
  const real = assertUnderHome(dir, home);
  if (!fs.statSync(real).isDirectory()) throw new Error('não é um diretório');
  const harnesses = harnessTargets(home).map((t) => {
    const root = path.join(real, t.projectRoot);
    const exists = fs.existsSync(root);
    const skills = exists
      ? scanFlat(root, { harness: t.id, kind: 'project' }, MAX_SKILLS).map((l) => ({
          name: l.name,
          description: l.description,
          managed: l.managed,
          path: l.file,
        }))
      : [];
    return { id: t.id, label: t.label, root, exists, skills };
  });
  return {
    dir: real,
    name: path.basename(real),
    harnesses,
    skillCount: harnesses.reduce((n, h) => n + h.skills.length, 0),
  };
}

function defaultProjectsParent(home) {
  const projetos = path.join(home, 'projetos');
  return fs.existsSync(projetos) ? projetos : home;
}

/** Paths de projetos vinculados no ai-memory (client-projects.json), se houver. */
function knownProjectPaths() {
  try {
    const raw = fs.readFileSync(path.join(config.dataDir, 'client-projects.json'), 'utf8');
    const links = Array.isArray(JSON.parse(raw)?.links) ? JSON.parse(raw).links : [];
    return links.map((l) => l?.path).filter((p) => typeof p === 'string' && p);
  } catch {
    return [];
  }
}

/**
 * Workspaces sob um diretório-pai que têm skills de projeto. Inclui também
 * projetos vinculados ao ai-memory que existam sob o home.
 */
export function listWorkspaces({ parent, home = resolveHome(), limit = 200 } = {}) {
  const base = assertUnderHome(parent || defaultProjectsParent(home), home);
  if (!fs.statSync(base).isDirectory()) throw new Error('parent não é um diretório');
  const realHome = fs.realpathSync.native(home);

  const items = [];
  const seen = new Set();
  const add = (dir) => {
    if (items.length >= limit) return;
    let detail;
    try {
      detail = getWorkspaceSkills({ dir, home });
    } catch {
      return; // fora do home ou inacessível
    }
    // o home não é um "workspace": os roots globais já aparecem na aba Globais
    if (detail.dir === realHome) return;
    if (!detail.skillCount || seen.has(detail.dir)) return;
    seen.add(detail.dir);
    items.push({
      name: detail.name,
      path: detail.dir,
      skillCount: detail.skillCount,
      harnesses: detail.harnesses
        .filter((h) => h.skills.length)
        .map((h) => ({ id: h.id, label: h.label, count: h.skills.length })),
    });
  };

  for (const scopePath of knownProjectPaths()) add(scopePath);

  let entries = [];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    // sem permissão: devolve só os scopes conhecidos
  }
  for (const entry of entries) {
    if (items.length >= limit) break;
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(base, entry.name);
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    try {
      if (!fs.statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    add(full);
  }

  items.sort((a, b) => a.name.localeCompare(b.name));
  return { parent: base, home, items };
}
