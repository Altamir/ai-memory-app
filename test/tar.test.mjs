import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createTarGz, isSafeEntryName, readTarGz } from '../server/tar.mjs';

// tar/gzip próprio (sem dependência): o bundle é escrito e relido por este
// módulo, então o round-trip é a garantia mínima — e nomes perigosos não podem
// entrar nem sair de um bundle.

const BLOCK = 512;

/** Cabeçalho ustar cru, para montar casos que o writer recusa de propósito. */
function rawHeader(name, { size = 0, type = '0', prefix = '' } = {}) {
  const buf = Buffer.alloc(BLOCK);
  buf.write(name, 0, 100, 'utf8');
  buf.write('0000644\0', 100, 8, 'ascii');
  buf.write('0000000\0', 108, 8, 'ascii');
  buf.write('0000000\0', 116, 8, 'ascii');
  buf.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  buf.write('00000000000\0', 136, 12, 'ascii');
  buf.write('        ', 148, 8, 'ascii');
  buf.write(type, 156, 1, 'ascii');
  buf.write('ustar\0', 257, 6, 'ascii');
  buf.write('00', 263, 2, 'ascii');
  if (prefix) buf.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return buf;
}

const rawTar = (parts) => {
  const body = [];
  for (const part of parts) {
    if (part.raw) { body.push(part.raw); continue; }
    const data = Buffer.from(part.data ?? '', 'utf8');
    body.push(rawHeader(part.name, { size: data.length, type: part.type || '0' }), data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad) body.push(Buffer.alloc(pad));
  }
  body.push(Buffer.alloc(BLOCK), Buffer.alloc(BLOCK));
  return Buffer.concat(body);
};

test('round-trip: nomes, conteúdo, unicode e subdiretórios', () => {
  const entries = [
    { name: 'manifest.json', data: '{"format":"ai-memory-bundle"}\n' },
    { name: 'README.md', data: '# Bundle\n' },
    { name: 'scopes/default/proj-a/notes/deploy.md', data: '# Deploy\n\nacentuação e emoji 🚀\n' },
    { name: 'scopes/default/_global/_rules/z.md', data: '' },
  ];
  const { entries: back, skipped } = readTarGz(createTarGz(entries));
  assert.deepEqual(skipped, []);
  assert.deepEqual(back.map((e) => e.name), entries.map((e) => e.name));
  assert.equal(back[2].data.toString('utf8'), entries[2].data);
  assert.equal(back[3].data.length, 0);
});

test('nome longo (>100) vai em prefix/name e volta inteiro', () => {
  const name = `scopes/default/proj-a/${'a'.repeat(90)}/${'b'.repeat(40)}.md`;
  assert.ok(Buffer.byteLength(name) > 100);
  const { entries } = readTarGz(createTarGz([{ name, data: 'x' }]));
  assert.deepEqual(entries.map((e) => e.name), [name]);
});

test('GNU longname (type L) é lido antes da entrada', () => {
  // o tar do GNU põe o nome completo num bloco 'L' que antecede o arquivo:
  // vale para a entrada seguinte (o header dela trunca o nome)
  const longName = `scopes/default/proj/${'c'.repeat(180)}.md`;
  const nameBuf = Buffer.from(`${longName}\0`, 'utf8');
  const tar = rawTar([
    { raw: rawHeader('././@LongLink', { size: nameBuf.length, type: 'L' }) },
    { raw: nameBuf },
    { raw: Buffer.alloc((BLOCK - (nameBuf.length % BLOCK)) % BLOCK) },
    { name: longName.slice(0, 100), data: 'conteúdo' },
  ]);
  const { entries } = readTarGz(zlib.gzipSync(tar));
  assert.deepEqual(entries.map((e) => e.name), [longName]);
  assert.equal(entries[0].data.toString('utf8'), 'conteúdo');
});

test('diretórios e links são descartados (nada é extraído)', () => {
  const tar = rawTar([
    { name: 'notes/', type: '5' },
    { name: 'notes/a.md', data: 'ok' },
    { name: 'link.md', type: '2' },
  ]);
  const { entries, skipped } = readTarGz(tar); // tar puro, sem gzip
  assert.deepEqual(entries.map((e) => e.name), ['notes/a.md']);
  assert.deepEqual(skipped, ['notes/', 'link.md']);
});

test('nome perigoso não entra no bundle nem sai dele', () => {
  assert.equal(isSafeEntryName('notes/a.md'), true);
  assert.equal(isSafeEntryName('../etc/passwd'), false);
  assert.equal(isSafeEntryName('/etc/passwd'), false);
  assert.equal(isSafeEntryName('a/../../b.md'), false);
  assert.equal(isSafeEntryName('a//b.md'), false);
  assert.equal(isSafeEntryName('a\\b.md'), false);
  assert.throws(() => createTarGz([{ name: '../fuga.md', data: 'x' }]), /nome inválido/);

  const tar = rawTar([{ name: '../fuga.md', data: 'x' }, { name: 'ok.md', data: 'ok' }]);
  const { entries, skipped } = readTarGz(tar);
  assert.deepEqual(entries.map((e) => e.name), ['ok.md']);
  assert.deepEqual(skipped, ['../fuga.md']);
});

test('cabeçalho corrompido é recusado', () => {
  const tar = createTarGz([{ name: 'a.md', data: 'x' }]);
  const broken = zlib.gunzipSync(tar);
  broken[300] = 0x7a; // mexe no conteúdo do cabeçalho sem corrigir o checksum
  assert.throws(() => readTarGz(zlib.gzipSync(broken)), /checksum/);
});

test('tamanho que não cabe no arquivo é recusado', () => {
  const tar = Buffer.concat([rawHeader('a.md', { size: 4096 }), Buffer.from('curto')]);
  assert.throws(() => readTarGz(tar), /truncado/);
});
