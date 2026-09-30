// Diff de linhas próprio (Myers) para comparar cópias de skills.
// Sem dependências e com custo limitado: arquivos gigantes caem num diff
// grosseiro (prefixo/sufixo + miolo trocado) em vez de estourar o tempo.

const MAX_LINES = 6000; // soma das linhas dos dois lados

function toLines(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Script de edição mínimo entre duas listas de linhas (Myers guloso + trace). */
function editScript(a, b) {
  const n = a.length;
  const m = b.length;
  if (!n) return b.map((line) => ({ type: 'add', line }));
  if (!m) return a.map((line) => ({ type: 'del', line }));

  const v = new Map([[1, 0]]);
  const trace = [];
  let end = -1;
  for (let d = 0; d <= n + m && end < 0; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      const down = v.get(k + 1);
      const right = v.get(k - 1);
      let x;
      if (k === -d || (k !== d && (right ?? -1) < (down ?? -1))) x = down ?? 0;
      else x = (right ?? -1) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1; }
      v.set(k, x);
      if (x >= n && y >= m) { end = d; break; }
    }
  }

  const ops = [];
  let x = n;
  let y = m;
  for (let d = end; d >= 0; d--) {
    const vd = trace[d];
    const k = x - y;
    const down = vd.get(k + 1);
    const right = vd.get(k - 1);
    const prevK = k === -d || (k !== d && (right ?? -1) < (down ?? -1)) ? k + 1 : k - 1;
    const prevX = vd.get(prevK) ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push({ type: 'same', line: a[x - 1] }); x -= 1; y -= 1; }
    if (d > 0) {
      // o passo de edição da rodada d: desceu (inserção) ou andou (remoção)
      if (x === prevX) { ops.push({ type: 'add', line: b[y - 1] }); y -= 1; }
      else { ops.push({ type: 'del', line: a[x - 1] }); x -= 1; }
    }
  }
  while (x > 0) { ops.push({ type: 'del', line: a[x - 1] }); x -= 1; }
  while (y > 0) { ops.push({ type: 'add', line: b[y - 1] }); y -= 1; }
  ops.reverse();
  return ops;
}

function statsOf(ops) {
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === 'add') added += 1;
    else if (op.type === 'del') removed += 1;
  }
  return { added, removed };
}

/** Converte o script de edição em hunks com contexto (formato unificado). */
function toHunks(ops, context, maxHunks) {
  const keep = new Array(ops.length).fill(false);
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].type === 'same') continue;
    for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep[k] = true;
  }

  const hunks = [];
  let truncated = false;
  let lineA = 1;
  let lineB = 1;
  let i = 0;
  while (i < ops.length) {
    if (!keep[i]) {
      if (ops[i].type === 'same') { lineA += 1; lineB += 1; }
      i += 1;
      continue;
    }
    if (hunks.length >= maxHunks) { truncated = true; break; }
    const startA = lineA;
    const startB = lineB;
    const lines = [];
    while (i < ops.length && keep[i]) {
      const op = ops[i];
      if (op.type === 'same') {
        lines.push({ type: 'ctx', a: lineA, b: lineB, text: op.line });
        lineA += 1;
        lineB += 1;
      } else if (op.type === 'del') {
        lines.push({ type: 'del', a: lineA, b: null, text: op.line });
        lineA += 1;
      } else {
        lines.push({ type: 'add', a: null, b: lineB, text: op.line });
        lineB += 1;
      }
      i += 1;
    }
    hunks.push({ startA, startB, lines });
  }
  return { hunks, truncated };
}

/** Diff grosseiro para arquivos acima do limite: prefixo/sufixo iguais + miolo. */
function coarseHunks(a, b, context, maxHunks) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre += 1;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf += 1;

  const ops = [
    ...a.slice(0, pre).map((line) => ({ type: 'same', line })),
    ...a.slice(pre, a.length - suf).map((line) => ({ type: 'del', line })),
    ...b.slice(pre, b.length - suf).map((line) => ({ type: 'add', line })),
    ...a.slice(a.length - suf).map((line) => ({ type: 'same', line })),
  ];
  const out = toHunks(ops, context, maxHunks);
  return { ...out, stats: { added: b.length - pre - suf, removed: a.length - pre - suf }, coarse: true };
}

/**
 * Diff entre dois textos. Devolve hunks com contexto e estatísticas;
 * `identical` indica que os textos são iguais.
 */
export function diffLines(aText, bText, { context = 3, maxHunks = 150 } = {}) {
  const a = toLines(aText);
  const b = toLines(bText);
  const stats = { added: 0, removed: 0 };

  if (aText === bText) return { identical: true, hunks: [], stats, truncated: false, coarse: false };

  if (a.length + b.length > MAX_LINES) {
    const coarse = coarseHunks(a, b, context, maxHunks);
    return {
      identical: false,
      hunks: coarse.hunks,
      stats: coarse.stats,
      truncated: coarse.truncated,
      coarse: true,
    };
  }

  const ops = editScript(a, b);
  const { hunks, truncated } = toHunks(ops, context, maxHunks);
  return { identical: false, hunks, stats: statsOf(ops), truncated, coarse: false };
}
