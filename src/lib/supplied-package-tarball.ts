// ---------------------------------------------------------------------------
// supplied-package-tarball.ts — pack a DELIVERED TREE into the npm-layout
// tarball the store already knows how to materialize (cinatra#3204 leg 2).
//
// WHY THIS EXISTS: leg 1 made the install pipeline source-agnostic by taking
// `tarball: Uint8Array` — an npm-layout gzip tarball — and every gate downstream
// of it (SRI over the exact bytes, hardened extraction with `package/` stripped,
// the content-digest re-verification over what landed) is written against that
// one shape. The repository road does not receive a tarball; it receives a tree
// of paths and bytes. Something has to turn one into the other, and the honest
// place for it is here, next to the store that consumes it, rather than inside
// the intake — which stays free of every filesystem and compression concern.
//
// The writer is DETERMINISTIC on purpose: mode, owner, group and timestamp are
// fixed, and entries are emitted in sorted path order. Two packs of the same
// tree are byte-identical, so the tarball's own SRI is a function of the tree
// and of nothing else — no clock, no locale, no filesystem.
//
// It emits FILE entries only (no directory headers): node-tar creates parents,
// and the store's hardened extractor accepts File and Directory alone, so the
// smallest tarball that satisfies it is also the one with the least to refuse.
// ---------------------------------------------------------------------------

import { gzipSync } from "node:zlib";

/** The npm layout's single top-level segment; the store's extractor strips it. */
export const NPM_TARBALL_ROOT = "package";

const BLOCK = 512;
/** ustar name field. A longer path must be split into prefix + name. */
const NAME_FIELD = 100;
/** ustar prefix field. */
const PREFIX_FIELD = 155;

const UTF8 = new TextEncoder();

/**
 * Write raw BYTES into a fixed-width header field, NUL-padded.
 *
 * Header fields are byte fields, not character fields. Writing them from
 * `charCodeAt` masked to a byte silently mistranslates every non-ASCII name —
 * U+012E masks to 0x2E, the ASCII dot, so a legitimate path could be written
 * into the archive as a traversing one. Names are therefore encoded to UTF-8
 * once and measured, split and written in BYTES from there on.
 */
function writeBytes(block: Uint8Array, offset: number, length: number, value: Uint8Array): void {
  if (value.byteLength > length) {
    throw new Error(
      `[supplied-tarball] a ${value.byteLength}-byte value does not fit the ${length}-byte tar header field ` +
        `at offset ${offset} — refusing to write a truncated header.`,
    );
  }
  block.set(value, offset);
  for (let i = value.byteLength; i < length; i += 1) block[offset + i] = 0;
}

/** ASCII-only header literals (magic, version, checksum digits). */
function writeAscii(block: Uint8Array, offset: number, length: number, value: string): void {
  writeBytes(block, offset, length, UTF8.encode(value));
}

/** ustar numeric field: zero-padded octal, NUL-terminated. */
function writeOctal(block: Uint8Array, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, "0");
  writeAscii(block, offset, length, text);
  block[offset + length - 1] = 0;
}

/**
 * Split a path across the ustar prefix/name fields, or refuse it.
 *
 * A path that fits neither is not silently truncated: a truncated entry name is
 * a file written under the wrong name, which is exactly the class of surprise an
 * intake exists to prevent.
 */
function splitUstarPath(fullPath: string): { name: Uint8Array; prefix: Uint8Array } {
  const encoded = UTF8.encode(fullPath);
  if (encoded.byteLength <= NAME_FIELD) return { name: encoded, prefix: new Uint8Array(0) };
  // The SHORTEST prefix that leaves a name the name field can hold, measured in
  // BYTES. A "/" is 0x2f and can never occur inside a multi-byte UTF-8 sequence,
  // so splitting on that byte always lands on a character boundary.
  for (let i = Math.max(0, encoded.byteLength - NAME_FIELD - 1); i < encoded.byteLength - 1; i += 1) {
    if (encoded[i] !== 0x2f) continue;
    const prefix = encoded.subarray(0, i);
    const name = encoded.subarray(i + 1);
    if (prefix.byteLength <= PREFIX_FIELD && name.byteLength <= NAME_FIELD && name.byteLength > 0) {
      return { name, prefix };
    }
  }
  throw new Error(
    `[supplied-tarball] the path "${fullPath}" is too long for the tar header (${NAME_FIELD}-byte name, ` +
      `${PREFIX_FIELD}-byte prefix, measured in UTF-8 bytes) — refusing to pack it rather than writing it ` +
      `under a truncated name.`,
  );
}

function header(fullPath: string, size: number): Uint8Array {
  const block = new Uint8Array(BLOCK);
  const { name, prefix } = splitUstarPath(fullPath);
  writeBytes(block, 0, NAME_FIELD, name);
  writeOctal(block, 100, 8, 0o644); // mode
  writeOctal(block, 108, 8, 0); // uid
  writeOctal(block, 116, 8, 0); // gid
  writeOctal(block, 124, 12, size);
  writeOctal(block, 136, 12, 0); // mtime — fixed, so the pack is reproducible
  writeAscii(block, 148, 8, "        "); // checksum placeholder: eight spaces
  block[156] = "0".charCodeAt(0); // typeflag: regular file
  writeAscii(block, 257, 6, "ustar");
  block[262] = 0;
  writeAscii(block, 263, 2, "00");
  writeBytes(block, 345, PREFIX_FIELD, prefix);

  let checksum = 0;
  for (const byte of block) checksum += byte;
  const octal = checksum.toString(8).padStart(6, "0");
  writeAscii(block, 148, 6, octal);
  block[154] = 0;
  block[155] = 0x20;
  return block;
}

/**
 * Pack a delivered tree into an npm-layout gzip tarball.
 *
 * `entries` are DELIVERY-RELATIVE paths (the digest's own paths). Each is
 * emitted at `package/<path>`, which is precisely what the store's extractor
 * strips — so the tree that comes back out of the store is the tree the digest
 * was computed over, and leg 1's re-verification compares like with like.
 */
export function buildNpmLayoutTarball(entries: Iterable<readonly [string, Uint8Array]>): Uint8Array {
  const sorted = [...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const chunks: Uint8Array[] = [];
  for (const [relativePath, bytes] of sorted) {
    if (relativePath.length === 0) {
      throw new Error("[supplied-tarball] refusing to pack an entry with an empty path.");
    }
    chunks.push(header(`${NPM_TARBALL_ROOT}/${relativePath}`, bytes.byteLength));
    chunks.push(bytes);
    const padding = (BLOCK - (bytes.byteLength % BLOCK)) % BLOCK;
    if (padding > 0) chunks.push(new Uint8Array(padding));
  }
  // Two zero blocks close a tar archive.
  chunks.push(new Uint8Array(BLOCK * 2));

  const total = chunks.reduce((n, chunk) => n + chunk.length, 0);
  const tar = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    tar.set(chunk, cursor);
    cursor += chunk.length;
  }
  // Node writes a zero MTIME into the gzip header, so the envelope is
  // reproducible too — the same tree packs to the same bytes on every host, on
  // every day. The determinism test is what holds that claim, not this comment.
  const gzipped = gzipSync(tar, { level: 9 });
  return new Uint8Array(gzipped.buffer, gzipped.byteOffset, gzipped.byteLength);
}
