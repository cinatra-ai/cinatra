// ---------------------------------------------------------------------------
// Zero-dependency store-only ZIP codec for the CLI agent-transfer endpoints
// (cinatra#255 G2).
//
// Stores files UNCOMPRESSED (method 0) — byte-compatible with the CLI's own
// codec (packages/cli/src/index.mjs `createZipBufferCli` / `readZipFilesCli`)
// so a ZIP produced by either side is readable by the other. This is the same
// algorithm `@cinatra-ai/agents/zip-helpers` uses; duplicated locally to keep
// the `/api/cli/*` surface self-contained (no cross-package surface widening).
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
  return (crc ^ 0xffffffff) >>> 0;
}

export function createZipBuffer(files: { name: string; content: string }[]): Buffer {
  const encoded = files.map((f) => ({
    name: Buffer.from(f.name, "utf8"),
    data: Buffer.from(f.content, "utf8"),
  }));
  const chunks: Buffer[] = [];
  const localOffsets: number[] = [];
  let offset = 0;
  for (const { name, data } of encoded) {
    localOffsets.push(offset);
    const crc = crc32(data);
    const h = Buffer.alloc(30 + name.length);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0, 6);
    h.writeUInt16LE(0, 8);
    h.writeUInt16LE(0, 10);
    h.writeUInt16LE(0, 12);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(data.length, 18);
    h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(name.length, 26);
    h.writeUInt16LE(0, 28);
    name.copy(h, 30);
    chunks.push(h, data);
    offset += h.length + data.length;
  }
  const centralStart = offset;
  for (let i = 0; i < encoded.length; i++) {
    const { name, data } = encoded[i];
    const crc = crc32(data);
    const e = Buffer.alloc(46 + name.length);
    e.writeUInt32LE(0x02014b50, 0);
    e.writeUInt16LE(20, 4);
    e.writeUInt16LE(20, 6);
    e.writeUInt16LE(0, 8);
    e.writeUInt16LE(0, 10);
    e.writeUInt16LE(0, 12);
    e.writeUInt16LE(0, 14);
    e.writeUInt32LE(crc, 16);
    e.writeUInt32LE(data.length, 20);
    e.writeUInt32LE(data.length, 24);
    e.writeUInt16LE(name.length, 28);
    e.writeUInt16LE(0, 30);
    e.writeUInt16LE(0, 32);
    e.writeUInt16LE(0, 34);
    e.writeUInt16LE(0, 36);
    e.writeUInt32LE(0, 38);
    e.writeUInt32LE(localOffsets[i], 42);
    name.copy(e, 46);
    chunks.push(e);
    offset += e.length;
  }
  const centralSize = offset - centralStart;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(encoded.length, 8);
  eocd.writeUInt16LE(encoded.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);
  chunks.push(eocd);
  return Buffer.concat(chunks);
}

/**
 * Read a store-only ZIP into a `name → utf8 content` map.
 *
 * HARDENED against hostile/truncated input: every `Buffer.read*` is preceded by
 * a bounds check, so a malformed archive returns whatever entries parsed cleanly
 * up to the first inconsistency rather than throwing a RangeError on an
 * out-of-bounds read. (The /api/cli/agents/import route additionally wraps this
 * call and validates the resulting entries, so a bad upload is a clean 400.)
 */
export function readZipFiles(buf: Buffer): Map<string, string> {
  const result = new Map<string, string>();
  // EOCD is at least 22 bytes; nothing smaller can be a valid ZIP.
  if (buf.length < 22) return result;

  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) return result;
  if (eocdOffset + 20 > buf.length) return result;

  const numEntries = buf.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = buf.readUInt32LE(eocdOffset + 16);
  let pos = centralDirOffset;
  for (let i = 0; i < numEntries; i++) {
    // Central directory file header is 46 bytes before its variable fields.
    if (pos < 0 || pos + 46 > buf.length) break;
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;
    const filenameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);
    if (pos + 46 + filenameLen > buf.length) break;
    const filename = buf
      .subarray(pos + 46, pos + 46 + filenameLen)
      .toString("utf8");
    // Local file header is 30 bytes before its variable fields.
    if (localHeaderOffset < 0 || localHeaderOffset + 30 > buf.length) break;
    const lfhFilenameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const lfhExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataOffset = localHeaderOffset + 30 + lfhFilenameLen + lfhExtraLen;
    if (
      dataOffset < 0 ||
      compressedSize < 0 ||
      dataOffset + compressedSize > buf.length
    ) {
      break;
    }
    result.set(
      filename,
      buf.subarray(dataOffset, dataOffset + compressedSize).toString("utf8"),
    );
    pos += 46 + filenameLen + extraLen + commentLen;
  }
  return result;
}
