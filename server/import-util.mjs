import crypto from 'node:crypto';
import path from 'node:path';

// Helpers puros do importador: classificação de páginas, normalização de corpo
// e resolução de destino (path de origem → workspace/projeto vinculado).

/** `Título da seção!` → `titulo-da-secao`. */
export function slugify(text, { max = 60 } = {}) {
  const slug = String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (slug || 'sem-titulo').slice(0, max).replace(/-+$/, '');
}

const RULE_RE = /(\bregra\b|\bnunca\b|\bsempre\b|\balways\b|\bnever\b|\bprefer[êe]nc|\bprefer\b|\bestilo\b|\bconven[çc]|\bpol[íi]tica\b|\bpolicy\b|\bworkflow\b|\bfluxo\b|\bconvention\b|\bconvenções\b)/i;
const GOTCHA_RE = /(\bgotcha\b|\bbug\b|\berro\b|\berrors?\b|\bfalha\b|\bfails?\b|n[ãa]o funciona|quebrad|\bworkaround\b|\bis a directory\b)/i;

/**
 * Decide onde a página aterrissa: regras em `_rules/` (pinadas), problemas em
 * `gotchas/`, o resto em `notes/imported/<fonte>/`. Heurística por título e
 * corpo — o usuário pode rejeitar o item na tela.
 */
export function classify({ title, body = '', sourceSlug }) {
  const head = `${title}\n${String(body).slice(0, 400)}`;
  const slug = slugify(title);
  if (RULE_RE.test(head)) {
    return { path: `_rules/${slug}.md`, kind: 'rule', tier: 'procedural', pinned: true };
  }
  if (GOTCHA_RE.test(head)) {
    return { path: `gotchas/${slug}.md`, kind: 'gotcha', tier: 'semantic', pinned: false };
  }
  return { path: `notes/imported/${sourceSlug}/${slug}.md`, kind: 'fact', tier: 'semantic', pinned: false };
}

/** Corpo canônico para comparar versões (que fim de linha/quebras nas pontas não conta). */
export function normalizeBody(body) {
  return String(body ?? '').replace(/\r\n?/g, '\n').trim();
}

export function fingerprint(body) {
  return crypto.createHash('sha256').update(normalizeBody(body), 'utf8').digest('hex');
}

/** Frontmatter YAML raso (`---` … `---`): valores escalares e `[a, b]`. */
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text || '');
  if (!m) return { meta: {}, body: text || '' };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let value = kv[2].trim().replace(/^["']+|["']+$/g, '');
    if (/^\[.*\]$/.test(value)) {
      value = value.slice(1, -1).split(',').map((v) => v.trim().replace(/^["']+|["']+$/g, '')).filter(Boolean);
    }
    meta[kv[1].toLowerCase()] = value;
  }
  return { meta, body: (text || '').slice(m[0].length) };
}

/** Divide markdown em seções de nível 2 (`## `), preservando o conteúdo. */
export function splitH2(body) {
  const lines = String(body ?? '').split('\n');
  const sections = [];
  let current = null;
  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = { title: heading[1], lines: [] };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  return sections.map((s) => ({ title: s.title, body: s.lines.join('\n').trim() }));
}

/** Primeiro heading `# …` do markdown (título preferido da página). */
export function firstHeading(body) {
  const m = /^#\s+(.+?)\s*$/m.exec(String(body ?? ''));
  return m ? m[1].trim() : null;
}

/** `YYYY-MM-DD` de um timestamp ISO (ou dos 10 primeiros chars). */
export function isoDay(value) {
  const s = String(value ?? '');
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : 'sem-data';
}

const normPath = (p) => path.resolve(String(p)).replace(/\/+$/, '');

/**
 * Destino de um caminho absoluto da origem: o link do client-projects.json cujo
 * `path` é o prefixo mais longo. Sem link correspondente → null (o usuário escolhe).
 */
export function resolveTargetByPath(absPath, links = []) {
  if (!absPath) return null;
  const target = normPath(absPath);
  let best = null;
  for (const link of links) {
    if (!link?.path || !link.workspace || !link.project) continue;
    const base = normPath(link.path);
    if (target === base || target.startsWith(`${base}/`)) {
      if (!best || base.length > best.base.length) best = { base, link };
    }
  }
  if (!best) return null;
  return {
    workspace: best.link.workspace,
    project: best.link.project,
    reason: `vinculado a ${best.base}`,
  };
}

/** Um item "cru" (transcrição/histórico) entra no scan mas desmarcado na tela. */

/** Casamento por nome: `exemplo-workspace` ↔ link de projeto/path que contém o slug. */
export function matchSlugToLinks(slug, links = []) {
  const needle = String(slug || '').toLowerCase();
  if (!needle) return null;
  let best = null;
  for (const link of links) {
    if (!link?.path) continue;
    const projectName = String(link.project || '').toLowerCase();
    const haystack = String(link.path).toLowerCase();
    let score = 0;
    if (projectName === needle) score = 3;
    else if (projectName.includes(needle) || needle.includes(projectName)) score = 2;
    else if (haystack.includes(`/${needle}`)) score = 1;
    if (!score) continue;
    if (!best || score > best.score) best = { score, link };
  }
  if (!best) return null;
  return { workspace: best.link.workspace, project: best.link.project, reason: `slug "${slug}" casado com ${best.link.path}` };
}
