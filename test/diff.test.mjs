import test from 'node:test';
import assert from 'node:assert/strict';
import { diffLines } from '../server/diff.mjs';

const hunkText = (hunk) => hunk.lines.map((l) => `${l.type === 'ctx' ? ' ' : l.type === 'add' ? '+' : '-'}${l.text}`).join('\n');

test('diffLines: textos iguais não geram hunks', () => {
  const out = diffLines('a\nb\nc\n', 'a\nb\nc\n');
  assert.equal(out.identical, true);
  assert.deepEqual(out.hunks, []);
  assert.deepEqual(out.stats, { added: 0, removed: 0 });
});

test('diffLines: alteração de uma linha fica no meio do contexto', () => {
  const out = diffLines('l1\nl2\nl3\nl4\nl5\n', 'l1\nl2\nX\nl4\nl5\n');
  assert.equal(out.identical, false);
  assert.equal(out.hunks.length, 1);
  assert.deepEqual(out.stats, { added: 1, removed: 1 });
  assert.equal(hunkText(out.hunks[0]), [' l1', ' l2', '-l3', '+X', ' l4', ' l5'].join('\n'));
  assert.deepEqual(
    out.hunks[0].lines.map((l) => [l.a, l.b]),
    [[1, 1], [2, 2], [3, null], [null, 3], [4, 4], [5, 5]],
  );
});

test('diffLines: inserção e remoção puras', () => {
  const ins = diffLines('a\nb\n', 'a\nnovo\nb\n');
  assert.deepEqual(ins.stats, { added: 1, removed: 0 });
  assert.equal(hunkText(ins.hunks[0]), [' a', '+novo', ' b'].join('\n'));

  const del = diffLines('a\nsome\nb\n', 'a\nb\n');
  assert.deepEqual(del.stats, { added: 0, removed: 1 });
  assert.equal(hunkText(del.hunks[0]), [' a', '-some', ' b'].join('\n'));
});

test('diffLines: mudanças distantes viram hunks separados', () => {
  const before = Array.from({ length: 40 }, (_, i) => `linha ${i}`).join('\n');
  const afterLines = before.split('\n');
  afterLines[2] = 'linha 2 editada';
  afterLines[30] = 'linha 30 editada';
  const out = diffLines(before, afterLines.join('\n'));
  assert.equal(out.hunks.length, 2);
  assert.equal(out.hunks[0].startA, 1);
  assert.equal(out.hunks[1].startA, 28);
  assert.equal(out.stats.removed, 2);
  assert.equal(out.stats.added, 2);
});

test('diffLines: arquivo vazio e texto só de um lado', () => {
  const fromEmpty = diffLines('', 'a\nb\n');
  assert.deepEqual(fromEmpty.stats, { added: 2, removed: 0 });
  const toEmpty = diffLines('a\nb\n', '');
  assert.deepEqual(toEmpty.stats, { added: 0, removed: 2 });
  assert.deepEqual(diffLines('', '').hunks, []);
});

test('diffLines: CRLF não conta como diferença de conteúdo', () => {
  const out = diffLines('a\r\nb\r\n', 'a\nb\n');
  assert.equal(out.identical, false); // texto bruto difere…
  assert.deepEqual(out.stats, { added: 0, removed: 0 }); // …mas as linhas são iguais
  assert.deepEqual(out.hunks, []);
});

test('diffLines: arquivo grande cai no diff grosseiro com prefixo/sufixo', () => {
  const big = Array.from({ length: 4000 }, (_, i) => `l${i}`);
  const other = [...big];
  other[2000] = 'alterada';
  const out = diffLines(big.join('\n'), other.join('\n'));
  assert.equal(out.coarse, true);
  assert.deepEqual(out.stats, { added: 1, removed: 1 });
  assert.equal(out.hunks.length, 1);
  assert.ok(out.hunks[0].lines.some((l) => l.type === 'del' && l.text === 'l2000'));
  assert.ok(out.hunks[0].lines.some((l) => l.type === 'add' && l.text === 'alterada'));
});

test('diffLines: limite de hunks marca truncated', () => {
  const a = Array.from({ length: 100 }, (_, i) => `l${i}`);
  const b = a.map((l, i) => (i % 10 === 0 ? `${l}!` : l));
  const out = diffLines(a.join('\n'), b.join('\n'), { context: 1, maxHunks: 3 });
  assert.equal(out.truncated, true);
  assert.equal(out.hunks.length, 3);
});
