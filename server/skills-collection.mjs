import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.mjs';
import { createTarGz, readTarGz } from './tar.mjs';
import {
  NAME_RE,
  MANAGED_MARKER,
  IMAGE_MIME,
  parseFrontmatter,
  listFilesInDir,
  scanAllLocations,
  harnessTargets,
  findLocation,
  getSkillContent,
  installSkill,
  fetchManagedCatalog,
  assertUnderHome,
} from './skills.mjs';

// Gestor de skills: o painel é dono de uma coleção em `~/.ai-memory-app/skills`
// (AIM_APP_SKILLS_DIR). Cada skill é um diretório `<nome>/SKILL.md` + recursos,
// igual aos roots de harness — instalar copia a pasta inteira.
//
// Versionamento por snapshots (sem git): `<coleção>/.versions/<skill>/<id>/`
// guarda cópias completas e `<skill>/index.json` guarda os metadados. Snapshot
// automático antes de qualquer escrita que perca conteúdo (importar por cima,
// restaurar, importar bundle divergente) e manual pelo painel.
//
// Bundle de skills: .tar.gz com manifest.json + `skills/<nome>/...`, lido de
// volta pelo painel para importar (mesma mecânica dos bundles de memórias).

export const SKILLS_BUNDLE_FORMAT = 'ai-memory-skills-bundle';
export const SKILLS_BUNDLE_VERSION = 1;

const MAX_SKILLS = 500;
const MAX_VERSIONS = 50;
const MAX_BUNDLE_BYTES = 128 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // mesmo teto de preview do skills.mjs
const VERSIONS_DIRNAME = '.versions';

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

function collectionRoot(dir) {
  const root = dir ? path.resolve(dir) : config.skillsDir;
  return root;
}

function skillDirOf(name, dir) {
  if (!name || !NAME_RE.test(String(name))) throw new Error('nome de skill inválido');
  return path.join(collectionRoot(dir), String(name));
}

function versionsRootOf(name, dir) {
  return path.join(collectionRoot(dir), VERSIONS_DIRNAME, String(name));
}

/** Assinatura do conteúdo de um diretório de skill (mesma regra dos bundles). */
function dirSignature(files) {
  return sha256(
    files
      .slice()
      .sort((a, b) => a.rel.localeCompare(b.rel))
      .map((f) => `${f.rel}:${f.hash ?? f.sha256}`)
      .join('\n'),
  );
}

/** Inventário de arquivos de uma skill (só arquivos, com bytes e sha256). */
function inventory(dir) {
  return listFilesInDir(dir)
    .filter((f) => f.type === 'file')
    .map((f) => {
      const buf = fs.readFileSync(path.join(dir, f.rel));
      return { rel: f.rel, bytes: buf.length, sha256: sha256(buf) };
    });
}

/** Cria a estrutura de diretórios de uma entrada no destino. */
function writeFiles(destDir, files, readContent) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const f of files) {
    // defesa em profundidade: o filtro do tar já rejeita `..`/absolutos, mas
    // qualquer chamador futuro com `rel` não confiável não passa daqui
    safeRelInSkillDir(destDir, f.rel);
    const dest = path.join(destDir, f.rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, readContent(f));
  }
}

// ---------- versionamento ----------

function readVersionIndex(name, dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(versionsRootOf(name, dir), 'index.json'), 'utf8'));
    if (parsed && typeof parsed === 'object') {
      return {
        versions: Array.isArray(parsed.versions) ? parsed.versions : [],
        nextId: Number.isInteger(parsed.nextId) ? parsed.nextId : parsed.versions.length + 1,
      };
    }
  } catch {
    // sem versões ainda
  }
  return { versions: [], nextId: 1 };
}

function writeVersionIndex(name, dir, index) {
  const root = versionsRootOf(name, dir);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
}

/**
 * Snapshot do estado atual da skill da coleção. Copia todos os arquivos para
 * `.versions/<skill>/<id>/` e registra no index. Poda o histórico acima de
 * MAX_VERSIONS, removendo o mais antigo.
 */
export function snapshotSkill({ name, dir, note = null, source = 'manual' } = {}) {
  const skillDir = skillDirOf(name, dir);
  if (!fs.existsSync(path.join(skillDir, 'SKILL.md'))) {
    throw new Error(`skill "${name}" não está na coleção (${skillDir})`);
  }
  const files = inventory(skillDir);
  const skillMd = files.find((f) => f.rel === 'SKILL.md');
  const index = readVersionIndex(name, dir);
  const id = index.nextId;
  const versionDir = path.join(versionsRootOf(name, dir), String(id));
  writeFiles(versionDir, files, (f) => fs.readFileSync(path.join(skillDir, f.rel)));

  const entry = {
    id,
    createdAt: new Date().toISOString(),
    note: note ? String(note).slice(0, 300) : null,
    source: String(source).slice(0, 120),
    files: files.length,
    bytes: files.reduce((n, f) => n + f.bytes, 0),
    sha256: skillMd?.sha256 || null,
    signature: dirSignature(files),
  };
  index.versions.push(entry);
  index.nextId = id + 1;

  // poda: apaga do disco e do index os snapshots mais antigos que sobraram
  const pruned = [];
  while (index.versions.length > MAX_VERSIONS) {
    const oldest = index.versions.shift();
    fs.rmSync(path.join(versionsRootOf(name, dir), String(oldest.id)), { recursive: true, force: true });
    pruned.push(oldest.id);
  }
  writeVersionIndex(name, dir, index);
  return { ...entry, pruned };
}

/** Versões registradas de uma skill (o snapshot pode ter sido podado à mão). */
export function listCollectionVersions({ name, dir } = {}) {
  const skillDir = skillDirOf(name, dir);
  const index = readVersionIndex(name, dir);
  const versions = index.versions
    .filter((v) => v && Number.isInteger(v.id))
    .map((v) => ({
      ...v,
      exists: fs.existsSync(path.join(versionsRootOf(name, dir), String(v.id), 'SKILL.md')),
    }));
  versions.sort((a, b) => b.id - a.id);
  return {
    name: String(name),
    inCollection: fs.existsSync(path.join(skillDir, 'SKILL.md')),
    dir: skillDir,
    versions,
  };
}

/** SKILL.md atual ou de uma versão registrada. */
export function getCollectionContent({ name, version, dir } = {}) {
  if (version !== undefined && version !== null && version !== '') {
    const vDir = path.join(versionsRootOf(name, dir), String(version));
    const file = path.join(vDir, 'SKILL.md');
    if (!fs.existsSync(file)) throw new Error(`versão ${version} de "${name}" não encontrada (ou sem SKILL.md)`);
    return {
      name: String(name),
      version: Number(version),
      exists: true,
      content: fs.readFileSync(file, 'utf8'),
    };
  }
  const skillDir = skillDirOf(name, dir);
  const file = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(file)) throw new Error(`skill "${name}" não está na coleção (${skillDir})`);
  return { name: String(name), version: null, exists: true, content: fs.readFileSync(file, 'utf8') };
}

// ---------- edição de arquivos da skill ----------

const MAX_EDIT_BYTES = 256 * 1024;

/** Diretório da skill da coleção, exigindo que ela exista (base das edições). */
function assertSkillDir(name, dir) {
  const skillDir = skillDirOf(name, dir);
  if (!fs.existsSync(path.join(skillDir, 'SKILL.md'))) {
    throw new Error(`skill "${name}" não está na coleção (${skillDir})`);
  }
  return skillDir;
}

/** Valida um caminho relativo dentro da skill (sem traversal, sem absoluto). */
function safeRelInSkillDir(skillDir, rel) {
  const relPath = String(rel || '').trim();
  if (!relPath || path.isAbsolute(relPath) || relPath.split(/[\\/]/).includes('..')) {
    throw new Error('caminho de arquivo inválido');
  }
  const full = path.resolve(skillDir, relPath);
  if (full !== skillDir && !full.startsWith(skillDir + path.sep)) throw new Error('caminho fora da skill');
  return { relPath: path.relative(skillDir, full), full };
}

/** Arquivos da skill da coleção para a árvore do viewer (com flag de edição). */
export function listCollectionFiles({ name, dir } = {}) {
  const skillDir = assertSkillDir(name, dir);
  const files = listFilesInDir(skillDir).map((f) => {
    const isFile = f.type === 'file';
    const small = (f.size || 0) <= MAX_EDIT_BYTES;
    // ext não basta: um .bin "de texto" com NUL não é editável
    const hasNul = isFile && f.kind === 'text' && small && fs.readFileSync(path.join(skillDir, f.rel)).includes(0);
    return {
      rel: f.rel,
      type: f.type,
      kind: f.kind,
      size: f.size || 0,
      editable: Boolean(isFile && f.kind === 'text' && small && !hasNul),
    };
  });
  return { name: String(name), dir: skillDir, files };
}

/** Conteúdo de um arquivo da skill: texto (editável), imagem (data URL) ou binário. */
export function readCollectionFile({ name, rel, dir } = {}) {
  const skillDir = assertSkillDir(name, dir);
  const { relPath, full } = safeRelInSkillDir(skillDir, rel);
  const st = fs.statSync(full); // lança se não existir
  if (!st.isFile()) throw new Error('não é um arquivo');
  const ext = path.extname(full).slice(1).toLowerCase();
  if (IMAGE_MIME[ext]) {
    if (st.size > MAX_IMAGE_BYTES) throw new Error(`imagem grande demais para exibir (${st.size} bytes)`);
    return {
      name: String(name),
      rel: relPath,
      kind: 'image',
      size: st.size,
      dataUrl: `data:${IMAGE_MIME[ext]};base64,${fs.readFileSync(full).toString('base64')}`,
    };
  }
  const buf = fs.readFileSync(full);
  if (buf.includes(0) || st.size > MAX_EDIT_BYTES) {
    return { name: String(name), rel: relPath, kind: 'binary', size: st.size };
  }
  return { name: String(name), rel: relPath, kind: 'text', size: st.size, content: buf.toString('utf8') };
}

/**
 * Salva um arquivo de texto da skill. Mudança de conteúdo cria snapshot do
 * estado anterior da skill inteira ("antes de editar <arquivo>") antes de
 * escrever — o histórico nunca perde a versão de antes do edit. Conteúdo
 * idêntico não faz nada.
 */
export function writeCollectionFile({ name, rel, content, note = null, dir } = {}) {
  const skillDir = assertSkillDir(name, dir);
  const { relPath, full } = safeRelInSkillDir(skillDir, rel);
  const text = String(content ?? '');
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_EDIT_BYTES) throw new Error(`conteúdo grande demais (${bytes} bytes; limite ${MAX_EDIT_BYTES})`);
  if (text.includes('\0')) throw new Error('conteúdo com bytes nulos não é texto editável');

  const normalized = text.endsWith('\n') ? text : `${text}\n`;
  if (fs.existsSync(full)) {
    if (fs.readFileSync(full).equals(Buffer.from(normalized, 'utf8'))) {
      return { name: String(name), rel: relPath, saved: false, same: true, bytes };
    }
  }
  const snapshot = snapshotSkill({ name, dir, note: note || `antes de editar ${relPath}`, source: 'antes de editar' });
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, normalized);
  return { name: String(name), rel: relPath, saved: true, bytes, snapshotId: snapshot.id };
}

/**
 * Restaura uma versão: o estado atual vira snapshot ("antes de restaurar vN")
 * e a pasta da skill é substituída pelos arquivos da versão escolhida.
 */
export function restoreCollectionVersion({ name, version, dir } = {}) {
  const skillDir = skillDirOf(name, dir);
  const vDir = path.join(versionsRootOf(name, dir), String(version));
  const files = inventory(vDir); // lança se a versão não existir
  if (!files.some((f) => f.rel === 'SKILL.md')) throw new Error(`versão ${version} de "${name}" não tem SKILL.md`);
  let snapshot = null;
  if (fs.existsSync(path.join(skillDir, 'SKILL.md'))) {
    snapshot = snapshotSkill({ name, dir, note: `antes de restaurar v${version}`, source: 'antes de restaurar' });
  }
  fs.rmSync(skillDir, { recursive: true, force: true });
  writeFiles(skillDir, files, (f) => fs.readFileSync(path.join(vDir, f.rel)));
  return { name: String(name), restored: Number(version), files: files.length, snapshotId: snapshot?.id ?? null };
}

// ---------- coleção ----------

/** Scan do root da coleção: `<nome>/SKILL.md` (dot-dirs como .versions ficam fora). */
function scanCollection(dir) {
  const root = collectionRoot(dir);
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out; // coleção ainda não existe
  }
  for (const entry of entries) {
    if (out.length >= MAX_SKILLS) break;
    if (entry.name.startsWith('.') || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
    const skillDir = path.join(root, entry.name);
    const file = path.join(skillDir, 'SKILL.md');
    let text;
    try {
      if (!fs.statSync(skillDir).isDirectory()) continue;
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const fm = parseFrontmatter(text);
    let mtime = null;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      // sem stat: segue sem data
    }
    const files = inventory(skillDir);
    out.push({
      name: (fm.name || entry.name).trim(),
      dirName: entry.name,
      dir: skillDir,
      description: (fm.description || '').trim(),
      managed: text.includes(MANAGED_MARKER),
      mtime,
      files,
      fileCount: files.length,
      bytes: files.reduce((n, f) => n + f.bytes, 0),
      signature: dirSignature(files),
    });
  }
  return out;
}

/**
 * Visão da coleção: skills, em quais harnesses estão instaladas, skills só com
 * versão (excluídas da coleção mas recuperáveis) e bundles na pasta de export.
 */
export async function listCollectionSkills({ dir, home } = {}) {
  const root = collectionRoot(dir);
  const items = scanCollection(dir);
  const byName = new Map(items.map((s) => [s.name, s]));

  const installed = new Map(); // name -> Set(harness)
  const copiesByname = new Map(); // name -> [{ harness, kind, path }]
  for (const loc of scanAllLocations(home)) {
    if (!installed.has(loc.name)) installed.set(loc.name, new Set());
    installed.get(loc.name).add(loc.harness);
    if (!copiesByname.has(loc.name)) copiesByname.set(loc.name, []);
    copiesByname.get(loc.name).push({ harness: loc.harness, kind: loc.kind, path: loc.file });
  }

  // skills que só existem em .versions (excluídas da coleção): recuperáveis
  const deleted = [];
  let versionEntries = [];
  try {
    versionEntries = await fsp.readdir(path.join(root, VERSIONS_DIRNAME), { withFileTypes: true });
  } catch {
    // sem .versions
  }
  for (const entry of versionEntries) {
    if (!entry.isDirectory() || byName.has(entry.name)) continue;
    const index = readVersionIndex(entry.name, dir);
    if (!index.versions.length) continue;
    deleted.push({
      name: entry.name,
      deleted: true,
      versions: index.versions.length,
      lastVersionAt: index.versions[index.versions.length - 1]?.createdAt || null,
    });
  }

  const skills = items.map((s) => ({
    name: s.name,
    description: s.description,
    managed: s.managed,
    files: s.fileCount,
    bytes: s.bytes,
    signature: s.signature,
    mtime: s.mtime,
    dir: s.dir,
    versions: readVersionIndex(s.name, dir).versions.length,
    installed: installed.has(s.name) ? [...installed.get(s.name)] : [],
    copies: copiesByname.get(s.name) || [],
    deleted: false,
  }));
  skills.sort((a, b) => a.name.localeCompare(b.name));
  deleted.sort((a, b) => a.name.localeCompare(b.name));

  const bundles = await listSkillsBundles({});
  return {
    dir: root,
    versionsRoot: path.join(root, VERSIONS_DIRNAME),
    skills,
    deleted,
    totals: { skills: skills.length, files: skills.reduce((n, s) => n + s.files, 0), bytes: skills.reduce((n, s) => n + s.bytes, 0) },
    harnesses: harnessTargets().map((t) => ({
      id: t.id,
      label: t.label,
      projectRoot: t.projectRoot,
      userRoot: t.roots.find((r) => r.kind === 'user')?.path || null,
    })),
    bundles,
  };
}

/**
 * Importa uma skill para a coleção. A origem pode ser:
 * - cópia de projeto (`ws` = diretório do workspace + `harness`): lê
 *   `<ws>/<projectRoot do harness>/<name>` com todos os recursos;
 * - cópia em disco de um harness (`harness` + `kind`);
 * - catálogo gerenciado (`kind: 'managed'`, só SKILL.md).
 * Importar por cima de uma skill que diverge cria snapshot do estado atual
 * antes de escrever.
 */
export async function importToCollection({ name, harness, kind, ws, dir, home, managed } = {}) {
  const destDir = skillDirOf(name, dir);
  let sourceFiles = null; // [{ rel, bytes, sha256 }] quando é cópia de diretório
  let content = null; // quando é só SKILL.md (catálogo)
  let sourceDir = null; // origem em disco, para ler o conteúdo na hora de escrever
  let sourceLabel;

  if (ws) {
    const targets = harnessTargets(home);
    const target = targets.find((t) => t.id === harness);
    if (!target) throw new Error(`harness desconhecido: ${harness || '(vazio)'} — use ${targets.map((t) => t.id).join(', ')}`);
    const base = assertUnderHome(ws, home);
    sourceDir = path.join(base, target.projectRoot, String(name));
    if (!fs.existsSync(path.join(sourceDir, 'SKILL.md'))) {
      throw new Error(`skill "${name}" não encontrada em ${base} (${harness})`);
    }
    sourceFiles = inventory(sourceDir);
    sourceLabel = `projeto ${path.basename(base)} · ${harness}`;
  } else if (kind === 'managed' || !harness) {
    const got = await getSkillContent({ name, home, managed });
    content = got.content;
    sourceLabel = got.source?.managed ? 'catálogo gerenciado do ai-memory' : `${got.source?.harness || '?'} · ${got.source?.kind || '?'}`;
  } else {
    const loc = findLocation({ name, harness, kind, home });
    if (loc) {
      const srcDir = path.dirname(loc.file);
      sourceFiles = inventory(srcDir);
      if (!sourceFiles.some((f) => f.rel === 'SKILL.md')) throw new Error(`origem sem SKILL.md: ${srcDir}`);
      sourceLabel = `${harness} · ${loc.kind}`;
      sourceDir = srcDir;
    } else {
      const got = await getSkillContent({ name, harness, kind, home, managed });
      content = got.content;
      sourceLabel = got.source?.managed ? 'catálogo gerenciado do ai-memory' : `${got.source?.harness || '?'} · ${got.source?.kind || '?'}`;
    }
  }

  const destFile = path.join(destDir, 'SKILL.md');
  const exists = fs.existsSync(destFile);
  let snapshot = null;

  if (sourceDir) {
    if (exists) {
      if (dirSignature(inventory(destDir)) === dirSignature(sourceFiles)) {
        return { name: String(name), action: 'igual', path: destFile, source: sourceLabel, skipped: true };
      }
      snapshot = snapshotSkill({ name, dir, note: `antes de importar de ${sourceLabel}`, source: 'antes de importar' });
    }
    writeFiles(destDir, sourceFiles, (f) => fs.readFileSync(path.join(sourceDir, f.rel)));
  } else {
    if (exists) {
      const current = fs.readFileSync(destFile, 'utf8');
      const same = current === content || sha256(current.replace(/\r?\n/g, '\n')) === sha256(content.replace(/\r?\n/g, '\n'));
      if (same) return { name: String(name), action: 'igual', path: destFile, source: sourceLabel, skipped: true };
      snapshot = snapshotSkill({ name, dir, note: `antes de importar de ${sourceLabel}`, source: 'antes de importar' });
    }
    writeFiles(destDir, [{ rel: 'SKILL.md', bytes: Buffer.byteLength(content), sha256: sha256(content) }], () => content);
  }

  return {
    name: String(name),
    action: snapshot ? 'atualizada' : 'criada',
    path: destFile,
    source: sourceLabel,
    snapshotId: snapshot?.id ?? null,
  };
}

/**
 * Skills disponíveis num harness para importar (todas as cópias em disco do
 * harness, deduplicadas por pasta real, + as só no catálogo gerenciado), cada
 * uma com o match contra a coleção: `exists` e `same` (conteúdo idêntico).
 */
export async function listHarnessSkills({ harness, dir, home, managed } = {}) {
  const targets = harnessTargets(home);
  const target = targets.find((t) => t.id === harness);
  if (!target) throw new Error(`harness desconhecido: ${harness || '(vazio)'} — use ${targets.map((t) => t.id).join(', ')}`);

  const existing = new Map(scanCollection(dir).map((s) => [s.name, s]));
  const byName = new Map();
  const seenRealDirs = new Set();

  for (const loc of scanAllLocations(home)) {
    if (loc.harness !== target.id) continue;
    const dirOfCopy = path.dirname(loc.file);
    let realDir = dirOfCopy;
    try {
      realDir = fs.realpathSync.native(dirOfCopy);
    } catch {
      // pasta inacessível: mantém o caminho aparente
    }
    if (seenRealDirs.has(realDir)) continue; // mesmo diretório visto por outro root (symlink)
    seenRealDirs.add(realDir);
    const files = inventory(dirOfCopy);
    if (!files.some((f) => f.rel === 'SKILL.md')) continue;
    const col = existing.get(loc.name);
    byName.set(loc.name, {
      name: loc.name,
      description: loc.description,
      kinds: [loc.kind],
      managed: loc.managed,
      managedOnly: false,
      fileCount: files.length,
      bytes: files.reduce((n, f) => n + f.bytes, 0),
      path: loc.file,
      exists: Boolean(col),
      same: col ? col.signature === dirSignature(files) : false,
    });
  }

  // skills só no catálogo do binário: importáveis de qualquer harness (só SKILL.md)
  const catalog = managed ?? (await fetchManagedCatalog());
  if (!catalog.error) {
    for (const [name, meta] of catalog.skills) {
      if (byName.has(name)) continue;
      const col = existing.get(name);
      let same = false;
      if (col) {
        try {
          const current = fs.readFileSync(path.join(col.dir, 'SKILL.md'), 'utf8');
          same = current.replace(/\r?\n/g, '\n') === meta.content.replace(/\r?\n/g, '\n');
        } catch {
          // sem SKILL.md legível: considera divergente
        }
      }
      byName.set(name, {
        name,
        description: meta.description || '',
        kinds: [],
        managed: true,
        managedOnly: true,
        fileCount: null,
        bytes: null,
        path: null,
        exists: Boolean(col),
        same,
      });
    }
  }

  const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { harness: target.id, label: target.label, skills };
}

/**
 * Importa um lote para a coleção; cada item falha sozinho. O catálogo é buscado
 * uma vez e reusado (importar várias gerenciadas não vira N chamadas ao MCP).
 */
export async function importToCollectionBatch({ items, dir, home } = {}) {
  const wanted = Array.isArray(items) ? items.filter((i) => i && typeof i === 'object' && i.name).slice(0, MAX_SKILLS) : [];
  if (!wanted.length) throw new Error('selecione ao menos uma skill');
  const catalog = await fetchManagedCatalog();
  const results = [];
  let created = 0;
  let updated = 0;
  let same = 0;
  let errors = 0;
  for (const item of wanted) {
    try {
      const out = await importToCollection({
        name: String(item.name),
        harness: item.harness ? String(item.harness) : undefined,
        kind: item.kind ? String(item.kind) : undefined,
        dir,
        home,
        managed: catalog,
      });
      results.push(out);
      if (out.skipped) same += 1;
      else if (out.action === 'criada') created += 1;
      else if (out.action === 'atualizada') updated += 1;
    } catch (err) {
      results.push({ name: String(item.name), action: 'erro', error: err.message });
      errors += 1;
    }
  }
  return { results, created, updated, same, errors };
}

/** Snapshot manual pedido pelo painel ("salvar versão"). */
export function saveCollectionVersion({ name, note, dir } = {}) {  const entry = snapshotSkill({ name, dir, note, source: 'manual' });
  return { name: String(name), version: entry.id, createdAt: entry.createdAt, files: entry.files, bytes: entry.bytes, pruned: entry.pruned };
}

/**
 * Instala uma skill da coleção em um harness (escopo global) ou projeto
 * (escopo projeto + projectDir). Copia a pasta inteira — SKILL.md e recursos.
 */
export async function installCollectionSkill({ name, harness, scope = 'global', projectDir, force = false, dir, home } = {}) {
  const skillDir = skillDirOf(name, dir);
  if (!fs.existsSync(path.join(skillDir, 'SKILL.md'))) {
    throw new Error(`skill "${name}" não está na coleção (${skillDir})`);
  }
  // catálogo irrelevante aqui: a origem é a coleção (evita chamar o MCP)
  return installSkill({ name, harness, scope, projectDir, force, home, managed: { error: null, skills: new Map() }, sourceDir: skillDir });
}

// ---------- bundle de skills ----------

function sanitizeBundleName(name) {
  const clean = String(name ?? '')
    .trim()
    .replace(/\.(tar\.gz|tgz)$/i, '')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return clean || null;
}

function defaultBundleName() {
  return `ai-memory-skills-${new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '')}`;
}

async function freeName(targetDir, base, ext) {
  await fsp.mkdir(targetDir, { recursive: true, mode: 0o755 });
  for (let i = 0; i < 50; i += 1) {
    const name = i === 0 ? `${base}${ext}` : `${base}-${i}${ext}`;
    if (!fs.existsSync(path.join(targetDir, name))) return name;
  }
  throw new Error('não consegui um nome livre na pasta de exports de skills');
}

function bundleReadme({ skills, files, exportedAt }) {
  return `# Bundle de skills do ai-memory-app

Exportado em ${exportedAt}: ${skills.length} skill(s), ${files} arquivo(s).

## Estrutura

\`\`\`
manifest.json           metadados de cada skill (nome, descrição, arquivos com sha256)
skills/<nome>/SKILL.md  as skills, como estão na coleção de origem
skills/<nome>/<recurso> scripts, referências e assets, se houver
\`\`\`

## Como importar

No painel de origem: menu **Skills → Coleção → Importar bundle**. O importador
lista as skills do arquivo, marca quais já existem na coleção (idênticas ou
divergentes) e importa as selecionadas — divergências viram uma nova versão
da skill existente em vez de perder o conteúdo atual.

Na mão: extraia \`skills/*\` dentro de \`~/.ai-memory-app/skills/\` (ou o
AIM_APP_SKILLS_DIR do painel de destino).
`;
}

/** Grava o bundle com todas as skills da coleção na pasta de exports. */
export async function exportSkillsBundle({ name, dir, exportsDir, log = () => {} } = {}) {
  const root = collectionRoot(dir);
  const items = scanCollection(dir);
  if (!items.length) throw new Error(`nenhuma skill na coleção (${root})`);

  const exportedAt = new Date().toISOString();
  const entries = [];
  const manifestSkills = [];
  let fileCount = 0;
  for (const s of items) {
    for (const f of s.files) {
      entries.push({ name: `skills/${s.name}/${f.rel}`, data: fs.readFileSync(path.join(s.dir, f.rel)) });
    }
    fileCount += s.fileCount;
    manifestSkills.push({
      name: s.name,
      description: s.description,
      files: s.files.map((f) => ({ rel: f.rel, bytes: f.bytes, sha256: f.sha256 })),
      bytes: s.bytes,
      versions: readVersionIndex(s.name, dir).versions.length,
    });
  }

  const manifest = {
    format: SKILLS_BUNDLE_FORMAT,
    version: SKILLS_BUNDLE_VERSION,
    exportedAt,
    generator: { app: 'ai-memory-app', version: '0.1.0' },
    origin: { skillsDir: root },
    totals: { skills: manifestSkills.length, files: fileCount, bytes: manifestSkills.reduce((n, s) => n + s.bytes, 0) },
    skills: manifestSkills,
  };

  const readme = bundleReadme({ skills: manifestSkills, files: fileCount, exportedAt });
  entries.unshift({ name: 'README.md', data: readme }, { name: 'manifest.json', data: `${JSON.stringify(manifest, null, 2)}\n` });

  const tar = createTarGz(entries);
  const targetDir = exportsDir ? path.resolve(exportsDir) : config.skillsExportsDir;
  const fileName = await freeName(targetDir, sanitizeBundleName(name) || defaultBundleName(), '.tar.gz');
  const file = path.join(targetDir, fileName);
  await fsp.writeFile(file, tar, { mode: 0o644 });
  log('out', `bundle gravado: ${file} (${tar.length} bytes)\n`);

  // verificação: relê o arquivo e confere contagem + sha256 de cada arquivo
  const check = await readSkillsBundle(file);
  const byKey = new Map(check.entries.map((e) => [`${e.skill}|${e.rel}`, e.sha256]));
  const bad = [];
  for (const s of manifestSkills) {
    for (const f of s.files) {
      const back = byKey.get(`${s.name}|${f.rel}`);
      if (back === undefined) bad.push(`${s.name}/${f.rel} (ausente)`);
      else if (back !== f.sha256) bad.push(`${s.name}/${f.rel} (sha256 difere)`);
    }
  }
  if (check.entries.length !== fileCount) bad.push(`contagem: ${check.entries.length} no bundle, ${fileCount} na coleção`);
  for (const item of bad.slice(0, 10)) log('err', `verificação falhou: ${item}\n`);
  log('sys', bad.length ? `bundle com ${bad.length} problema(s) de verificação\n` : `verificação ok: ${fileCount} arquivo(s) relidos do bundle\n`);

  return { file, fileName, bytes: tar.length, skills: manifestSkills.length, files: fileCount, manifestOk: bad.length === 0 };
}

/** Manifesto de um bundle de skills (listagem da pasta não precisa das entradas). */
async function peekSkillsBundle(file) {
  const out = { file: path.basename(file), path: file, bytes: 0, mtime: null, skills: null, files: null, exportedAt: null, origin: null, error: null };
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch (err) {
    out.error = err.message;
    return out;
  }
  out.bytes = stat.size;
  out.mtime = stat.mtimeMs;
  if (stat.size > MAX_BUNDLE_BYTES) {
    out.error = 'bundle grande demais para inspecionar na listagem';
    return out;
  }
  try {
    const raw = await fsp.readFile(file);
    const { entries } = readTarGz(raw, { only: new Set(['manifest.json']) });
    const found = entries.find((e) => e.name === 'manifest.json');
    if (found) {
      const manifest = JSON.parse(found.data.toString('utf8'));
      out.format = manifest.format || null;
      out.skills = Array.isArray(manifest.skills) ? manifest.skills.length : null;
      out.files = manifest.totals?.files ?? null;
      out.exportedAt = manifest.exportedAt || null;
      out.origin = manifest.origin?.skillsDir || null;
    }
  } catch (err) {
    out.error = err.message;
  }
  return out;
}

/** Bundles de skills na pasta de export (mais recentes primeiro). */
export async function listSkillsBundles({ exportsDir } = {}) {
  const targetDir = exportsDir ? path.resolve(exportsDir) : config.skillsExportsDir;
  let entries = [];
  try {
    entries = await fsp.readdir(targetDir, { withFileTypes: true });
  } catch {
    return { dir: targetDir, bundles: [] };
  }
  const bundles = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(tar\.gz|tgz)$/i.test(entry.name)) continue;
    bundles.push(await peekSkillsBundle(path.join(targetDir, entry.name)));
  }
  bundles.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  return { dir: targetDir, bundles };
}

/**
 * Resolve o bundle pedido: nome solto → pasta de export de skills; caminho →
 * sob o home ou dentro de uma das pastas de export. Nada fora daí é lido.
 */
export async function resolveSkillsBundlePath(input, { exportsDir } = {}) {
  const raw = String(input ?? '').trim();
  const targetDir = exportsDir ? path.resolve(exportsDir) : config.skillsExportsDir;
  if (!raw) throw new Error('informe o arquivo do bundle');
  if (!/\.(tar\.gz|tgz)$/i.test(raw)) throw new Error('bundle precisa ser um .tar.gz (ou .tgz)');
  if (!raw.includes('/') && !raw.includes('\\') && !raw.startsWith('.')) {
    for (const base of [targetDir, config.exportsDir]) {
      const file = path.join(base, raw);
      if (fs.existsSync(file)) return file;
    }
    throw new Error(`bundle não encontrado em ${targetDir}: ${raw}`);
  }
  const resolved = path.resolve(raw);
  let real;
  try {
    real = await fsp.realpath(resolved);
  } catch {
    throw new Error(`arquivo não encontrado: ${resolved}`);
  }
  const inside = (base) => {
    let realBase;
    try {
      realBase = fs.realpathSync.native(base);
    } catch {
      realBase = path.resolve(base);
    }
    return real === realBase || real.startsWith(realBase + path.sep);
  };
  if (!inside(targetDir) && !inside(config.exportsDir) && !inside(config.root)) {
    throw new Error('bundle restrito à pasta de exports de skills, de memórias ou ao próprio painel');
  }
  const stat = await fsp.stat(real);
  if (!stat.isFile()) throw new Error('não é um arquivo');
  return real;
}

/** Relê um bundle de skills: entradas planas { skill, rel, sha256 } para verificação. */
async function readSkillsBundle(fileOrBuffer) {
  const raw = Buffer.isBuffer(fileOrBuffer) ? fileOrBuffer : await fsp.readFile(fileOrBuffer);
  const { entries } = readTarGz(raw);
  const out = [];
  for (const entry of entries) {
    const m = /^skills\/([^/]+)\/(.+)$/.exec(entry.name);
    if (!m) continue;
    out.push({ skill: m[1], rel: m[2], sha256: sha256(entry.data) });
  }
  return { entries: out };
}

/** Agrupa as entradas `skills/<nome>/...` de um bundle lido do tar. */
function groupBundleEntries(entries) {  const warnings = [];
  const manifest = (() => {
    const found = entries.find((e) => e.name === 'manifest.json');
    if (!found) return null;
    try {
      return JSON.parse(found.data.toString('utf8'));
    } catch (err) {
      warnings.push(`manifest.json inválido: ${err.message}`);
      return null;
    }
  })();

  const groups = new Map(); // skill -> [{ rel, data, sha256 }]
  for (const entry of entries) {
    if (entry.name === 'manifest.json' || entry.name === 'README.md') continue;
    const m = /^skills\/([^/]+)\/(.+)$/.exec(entry.name);
    if (!m) {
      warnings.push(`entrada fora de skills/: ${entry.name}`);
      continue;
    }
    const [name, rel] = [m[1], m[2]];
    if (!NAME_RE.test(name) || !rel) {
      warnings.push(`nome de skill inválido no bundle: ${name}`);
      continue;
    }
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push({ rel, data: entry.data, sha256: sha256(entry.data) });
  }
  for (const [name, files] of groups) {
    if (!files.some((f) => f.rel === 'SKILL.md')) {
      groups.delete(name);
      warnings.push(`skill "${name}" sem SKILL.md no bundle`);
    }
  }
  return { manifest, groups, warnings };
}

/** Lê o bundle do disco e agrupa as entradas por skill (base de scan e import). */
async function readBundleGroups({ file, exportsDir } = {}) {
  const path_ = await resolveSkillsBundlePath(file, { exportsDir });
  const raw = await fsp.readFile(path_);
  if (raw.length > MAX_BUNDLE_BYTES) throw new Error(`bundle grande demais (${raw.length} bytes)`);
  const { entries, skipped } = readTarGz(raw);
  const { manifest, groups, warnings } = groupBundleEntries(entries);
  if (skipped.length) warnings.push(`${skipped.length} entrada(s) ignorada(s) no tar (${skipped.slice(0, 3).join(', ')}…)`);
  return { path_, manifest, groups, warnings };
}

/**
 * Lê um bundle de skills e compara com a coleção: para cada skill do arquivo,
 * se já existe na coleção e se o conteúdo é idêntico.
 */
export async function scanSkillsBundle({ file, dir, exportsDir } = {}) {
  const { path_, manifest, groups, warnings } = await readBundleGroups({ file, exportsDir });
  const existingByName = new Map(scanCollection(dir).map((s) => [s.name, s]));
  const manifestBySkill = new Map((Array.isArray(manifest?.skills) ? manifest.skills : []).map((s) => [s.name, s]));

  const skills = [...groups.entries()].map(([name, files]) => {
    const skillMd = files.find((f) => f.rel === 'SKILL.md');
    const fm = parseFrontmatter(skillMd.data.toString('utf8'));
    const existing = existingByName.get(name);
    const same = existing ? dirSignature(existing.files.map((f) => ({ rel: f.rel, hash: f.sha256 }))) === dirSignature(files) : false;
    return {
      name,
      description: (fm.description || manifestBySkill.get(name)?.description || '').trim(),
      files: files.length,
      bytes: files.reduce((n, f) => n + f.data.length, 0),
      exists: Boolean(existing),
      same,
      inManifest: manifestBySkill.has(name),
    };
  });
  skills.sort((a, b) => a.name.localeCompare(b.name));

  // skills no manifesto mas sem entradas no tar: aviso explícito
  for (const name of manifestBySkill.keys()) {
    if (!groups.has(name)) warnings.push(`"${name}" está no manifesto mas não tem arquivos no bundle`);
  }

  return { file: path_, manifest, skills, warnings };
}

/**
 * Importa as skills escolhidas do bundle para a coleção. Skill divergente
 * existente: com `update` o estado atual vira snapshot e o conteúdo do bundle
 * entra; sem `update` a skill é pulada.
 */
export async function importSkillsBundle({ file, names, update = true, dir, exportsDir, log = () => {} } = {}) {
  const wanted = Array.isArray(names) ? names.filter((n) => typeof n === 'string' && n).slice(0, MAX_SKILLS) : [];
  if (!wanted.length) throw new Error('selecione ao menos uma skill do bundle');
  const { groups, warnings } = await readBundleGroups({ file, exportsDir });
  for (const w of warnings.slice(0, 20)) log('sys', `aviso: ${w}\n`);

  const results = [];
  let created = 0;
  let updated = 0;
  let skipped = 0;
  for (const name of wanted) {
    const files = groups.get(name);
    if (!files) {
      results.push({ name, action: 'erro', error: 'não está no bundle' });
      continue;
    }
    try {
      const destDir = skillDirOf(name, dir);
      const destFile = path.join(destDir, 'SKILL.md');
      let snapshotId = null;
      if (fs.existsSync(destFile)) {
        const existing = inventory(destDir);
        if (dirSignature(existing) === dirSignature(files)) {
          results.push({ name, action: 'igual', skipped: true });
          skipped += 1;
          continue;
        }
        if (!update) {
          results.push({ name, action: 'divergente', skipped: true });
          skipped += 1;
          continue;
        }
        const snapshot = snapshotSkill({ name, dir, note: 'antes de importar bundle', source: 'antes de importar bundle' });
        snapshotId = snapshot.id;
      }
      writeFiles(destDir, files, (f) => f.data);
      results.push({ name, action: snapshotId ? 'atualizada' : 'criada', files: files.length, snapshotId });
      if (snapshotId) updated += 1;
      else created += 1;
      log('out', `${name}: ${snapshotId ? 'atualizada' : 'criada'} (${files.length} arquivo(s)${snapshotId ? `, versão ${snapshotId} do estado anterior` : ''})\n`);
    } catch (err) {
      results.push({ name, action: 'erro', error: err.message });
      log('err', `${name}: ${err.message}\n`);
    }
  }
  return { results, created, updated, skipped, errors: results.filter((r) => r.action === 'erro').length };
}
