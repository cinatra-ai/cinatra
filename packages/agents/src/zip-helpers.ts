// ---------------------------------------------------------------------------
// ZIP helpers — pure Node.js module, no "use server", no external dependencies.
// Safe to import from instrumentation context (ensureAgentPackage).
// Stores files uncompressed (method 0).
// ---------------------------------------------------------------------------

function buildCrc32Table(): Uint32Array {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
}

const CRC32_TABLE = buildCrc32Table();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff];
  return ((crc ^ 0xffffffff) >>> 0);
}

export function createZipBuffer(files: { name: string; content: string }[]): Buffer {
  const encoded = files.map((f) => ({ name: Buffer.from(f.name, "utf8"), data: Buffer.from(f.content, "utf8") }));
  const chunks: Buffer[] = [];
  const localOffsets: number[] = [];
  let offset = 0;
  for (const { name, data } of encoded) {
    localOffsets.push(offset);
    const c = crc32(data);
    const h = Buffer.alloc(30 + name.length);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0, 6); h.writeUInt16LE(0, 8);
    h.writeUInt16LE(0, 10); h.writeUInt16LE(0, 12); h.writeUInt32LE(c, 14);
    h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
    name.copy(h, 30);
    chunks.push(h, data);
    offset += h.length + data.length;
  }
  const centralStart = offset;
  for (let i = 0; i < encoded.length; i++) {
    const { name, data } = encoded[i];
    const c = crc32(data);
    const e = Buffer.alloc(46 + name.length);
    e.writeUInt32LE(0x02014b50, 0); e.writeUInt16LE(20, 4); e.writeUInt16LE(20, 6); e.writeUInt16LE(0, 8);
    e.writeUInt16LE(0, 10); e.writeUInt16LE(0, 12); e.writeUInt16LE(0, 14); e.writeUInt32LE(c, 16);
    e.writeUInt32LE(data.length, 20); e.writeUInt32LE(data.length, 24); e.writeUInt16LE(name.length, 28);
    e.writeUInt16LE(0, 30); e.writeUInt16LE(0, 32); e.writeUInt16LE(0, 34); e.writeUInt16LE(0, 36);
    e.writeUInt32LE(0, 38); e.writeUInt32LE(localOffsets[i], 42);
    name.copy(e, 46);
    chunks.push(e);
    offset += e.length;
  }
  const centralSize = offset - centralStart;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(encoded.length, 8); eocd.writeUInt16LE(encoded.length, 10);
  eocd.writeUInt32LE(centralSize, 12); eocd.writeUInt32LE(centralStart, 16); eocd.writeUInt16LE(0, 20);
  chunks.push(eocd);
  return Buffer.concat(chunks);
}

export function readZipFiles(buf: Buffer): Map<string, string> {
  const result = new Map<string, string>();
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocdOffset = i; break; }
  }
  if (eocdOffset < 0) return result;
  const numEntries = buf.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = buf.readUInt32LE(eocdOffset + 16);
  let pos = centralDirOffset;
  for (let i = 0; i < numEntries; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;
    const filenameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);
    const filename = buf.subarray(pos + 46, pos + 46 + filenameLen).toString("utf8");
    const lfhFilenameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const lfhExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataOffset = localHeaderOffset + 30 + lfhFilenameLen + lfhExtraLen;
    result.set(filename, buf.subarray(dataOffset, dataOffset + compressedSize).toString("utf8"));
    pos += 46 + filenameLen + extraLen + commentLen;
  }
  return result;
}
