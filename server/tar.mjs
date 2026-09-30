import zlib from 'node:zlib';

// tar (ustar) + gzip sem dependência externa: o painel empacota o bundle em
// memória e lê o bundle de volta para importar. Só arquivos regulares interessam
// — links, diretórios e pax são ignorados na leitura (o bundle é dado, não
// sistema de arquivos).

const BLOCK = 512;
const ZERO_BLOCK = Buffer.alloc(BLOCK);

/** `..`/absoluto/barra invertida não podem entrar no bundle (nem sair dele). */
export function isSafeEntryName(name) {
  const n = String(name ?? '');
  if (!n || n.length > 4096) return false;
  if (n.startsWith('/') || n.includes('\\') || n.includes('\0')) return false;
  return !n.split('/').some((seg) => seg === '..' || seg === '');
}

function octal(value, size) {
  const text = Math.max(0, Math.floor(Number(value) || 0)).toString(8);
  if (text.length > size - 1) throw new Error(`tar: valor ${value} não cabe em ${size} bytes`);
  return `${text.padStart(size - 1, '0')}\0`;
}

function header(entry) {
  const name = String(entry.name);
  if (!isSafeEntryName(name)) throw new Error(`tar: nome inválido no bundle: ${name}`);
  const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ''), 'utf8');
  const buf = Buffer.alloc(BLOCK);
  // ustar divide nomes longos em prefix (155) + name (100) no último "/" possível
  let short = name;
  let prefix = '';
  if (Buffer.byteLength(name, 'utf8') > 100) {
    const cut = name.lastIndexOf('/', 155);
    if (cut > 0 && Buffer.byteLength(name.slice(0, cut), 'utf8') <= 155) {
      prefix = name.slice(0, cut);
      short = name.slice(cut + 1);
    }
    if (Buffer.byteLength(short, 'utf8') > 100) throw new Error(`tar: nome longo demais: ${name}`);
  }
  buf.write(short, 0, 100, 'utf8');
  buf.write(octal(entry.mode ?? 0o644, 8), 100, 8, 'ascii');
  buf.write(octal(0, 8), 108, 8, 'ascii'); // uid
  buf.write(octal(0, 8), 116, 8, 'ascii'); // gid
  buf.write(octal(data.length, 12), 124, 12, 'ascii');
  buf.write(octal(entry.mtime ?? Math.floor(Date.now() / 1000), 12), 136, 12, 'ascii');
  buf.write('        ', 148, 8, 'ascii'); // chksum em branco para o cálculo
  buf.write('0', 156, 1, 'ascii'); // typeflag: arquivo regular
  buf.write('ustar\0', 257, 6, 'ascii');
  buf.write('00', 263, 2, 'ascii');
  buf.write(prefix, 345, 155, 'utf8');

  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return { header: buf, data };
}

/** Empacota `[{ name, data, mtime?, mode? }]` num .tar.gz pronto para gravar. */
export function createTarGz(entries) {
  const blocks = [];
  for (const entry of entries) {
    const { header: head, data } = header(entry);
    blocks.push(head, data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(ZERO_BLOCK, ZERO_BLOCK);
  return zlib.gzipSync(Buffer.concat(blocks), { level: 9 });
}

function readOctal(buf, offset, size) {
  // GNU usa base-256 (bit alto) para valores que não cabem no octal
  if (buf[offset] & 0x80) {
    let value = buf[offset] & 0x7f;
    for (let i = 1; i < size; i += 1) value = value * 256 + buf[offset + i];
    return value;
  }
  const text = buf.toString('ascii', offset, offset + size).replace(/\0.*$/, '').trim();
  return text ? parseInt(text, 8) || 0 : 0;
}

function cString(buf, offset, size) {
  return buf.toString('utf8', offset, offset + size).replace(/\0.*$/, '');
}

function verifyChecksum(buf, offset) {
  const stored = readOctal(buf, offset + 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) {
    sum += i >= 148 && i < 156 ? 0x20 : buf[offset + i];
  }
  if (sum !== stored) throw new Error('tar: cabeçalho corrompido (checksum não confere)');
}

/**
 * Desempacota um .tar.gz (ou .tar) em memória. Devolve os arquivos regulares e
 * a lista de entradas descartadas (links, diretórios, nomes inseguros) — nada é
 * extraído para o disco, então uma entrada estranha nunca vira arquivo.
 * `only` limita a cópia a alguns nomes (listagem de bundles só quer o manifesto).
 */
export function readTarGz(input, { only = null } = {}) {
  const raw = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const isGzip = raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b;
  const buf = isGzip ? zlib.gunzipSync(raw) : raw;

  const entries = [];
  const skipped = [];
  let longName = null;
  let paxPath = null;

  for (let offset = 0; offset + BLOCK <= buf.length; ) {
    if (buf.subarray(offset, offset + BLOCK).equals(ZERO_BLOCK)) break;
    verifyChecksum(buf, offset);
    const size = readOctal(buf, offset + 124, 12);
    const type = String.fromCharCode(buf[offset + 156]);
    const prefix = cString(buf, offset + 345, 155);
    const name = prefix ? `${prefix}/${cString(buf, offset, 100)}` : cString(buf, offset, 100);
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > buf.length) throw new Error('tar: arquivo truncado');
    const data = buf.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === 'L') { // GNU longname: vale para a próxima entrada
      longName = data.toString('utf8').replace(/\0.*$/, '');
      continue;
    }
    if (type === 'K') continue; // longlink: links não entram no bundle
    if (type === 'x' || type === 'X') { // pax: só o "path=" interessa
      for (const line of data.toString('utf8').split('\n')) {
        const m = /^\d+ path=(.*)$/.exec(line);
        if (m) paxPath = m[1];
      }
      continue;
    }
    const finalName = paxPath || longName || name;
    paxPath = null;
    longName = null;
    if (type !== '0' && type !== '\0' && type !== '') {
      skipped.push(finalName); // diretório, symlink, char device…
      continue;
    }
    if (!isSafeEntryName(finalName)) {
      skipped.push(finalName);
      continue;
    }
    if (only && !only.has(finalName)) continue;
    entries.push({ name: finalName, size, data: Buffer.from(data) });
  }

  return { entries, skipped };
}
