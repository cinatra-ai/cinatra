/**
 * Deterministic content hash over a catalog skill's `SKILL.md` + its bundled
 * directory.
 *
 * The hash is the drift signal: any change to SKILL.md bytes, any bundled
 * file's bytes, OR the bundled file SET (add/remove/rename) MUST produce a
 * different hash so the sync engine creates a NEW immutable Anthropic version
 * (`POST /v1/skills/{id}/versions`) — never mutating or deleting an existing
 * one.
 *
 * Pure: no fs, no network. The caller supplies already-read raw bytes so this
 * module is trivially unit-testable and has zero `src/lib` import (correct
 * dependency direction; standing invariant — this lives in
 * `@cinatra-ai/llm`).
 *
 * Canonicalization:
 * - Bundled file paths are POSIX-normalized (`\` → `/`, collapse `./`).
 * - Absolute paths and any `..` traversal segment are REJECTED (throw) — a
 *   bundled file must be strictly under the skill's source directory.
 * - Duplicate normalized paths are REJECTED (throw) — non-deterministic input.
 * - Entries are sorted bytewise by normalized path before framing.
 * - RAW bytes are hashed (no text decode, no CRLF rewrite). Directories /
 *   empty dirs are not entries (the caller passes files only; symlinks are
 *   excluded by the caller's walk).
 * - Length-prefixed, NUL-delimited framing makes the path/byte boundaries
 *   unambiguous so two different file sets can never frame to the same bytes.
 */

import { createHash } from "node:crypto";

export type SkillBundledFile = {
  /** Path relative to the skill's source directory (POSIX or native). */
  relPath: string;
  /** Raw file bytes. */
  bytes: Buffer;
};

/**
 * Normalize a relative bundled-file path to POSIX form and reject anything
 * that escapes the skill source directory or is non-deterministic.
 */
export function normalizeBundledRelPath(relPath: string): string {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new Error(`[anthropic-skill-content-hash] empty bundled file path`);
  }
  const posix = relPath.replaceAll("\\", "/");
  if (posix.startsWith("/")) {
    throw new Error(
      `[anthropic-skill-content-hash] absolute bundled path rejected: ${relPath}`,
    );
  }
  const segments = posix.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segments.some((s) => s === "..")) {
    throw new Error(
      `[anthropic-skill-content-hash] path traversal ('..') rejected: ${relPath}`,
    );
  }
  if (segments.length === 0) {
    throw new Error(
      `[anthropic-skill-content-hash] bundled path resolves to empty: ${relPath}`,
    );
  }
  return segments.join("/");
}

function frame(hash: ReturnType<typeof createHash>, label: string, value: Buffer) {
  // label\0<len>\0<bytes> — unambiguous boundaries.
  hash.update(label);
  hash.update("\0");
  hash.update(String(value.length));
  hash.update("\0");
  hash.update(value);
}

/**
 * Compute the deterministic SHA-256 hex digest over the SKILL.md body and the
 * bundled file set. Pure + order-independent in input (sorted internally).
 *
 * @throws on absolute / `..` / duplicate normalized bundled paths.
 */
export function computeSkillContentHash(
  skillMd: Buffer,
  bundledFiles: SkillBundledFile[],
): string {
  const normalized = bundledFiles.map((f) => ({
    relPath: normalizeBundledRelPath(f.relPath),
    bytes: f.bytes,
  }));

  const seen = new Set<string>();
  for (const f of normalized) {
    if (seen.has(f.relPath)) {
      throw new Error(
        `[anthropic-skill-content-hash] duplicate normalized bundled path: ${f.relPath}`,
      );
    }
    seen.add(f.relPath);
  }

  normalized.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  const hash = createHash("sha256");
  // Version tag so a future framing change is itself a drift (defensive).
  hash.update("anthropic-skill-content-hash:v1\0");
  frame(hash, "SKILLMD", skillMd);
  hash.update(String(normalized.length));
  hash.update("\0");
  for (const f of normalized) {
    frame(hash, "PATH", Buffer.from(f.relPath, "utf8"));
    frame(hash, "FILE", f.bytes);
  }
  return hash.digest("hex");
}

// ===========================================================================
// Canonical upload artifact — the SAME bundle framed as the single ZIP the
// Anthropic Skills API accepts. Co-located with the drift hash (and its shared
// `normalizeBundledRelPath`) so the two canonical framings of one bundle agree
// on the file set, and so this leaf carries no separate module.
//
// The Skills API (`POST /v1/skills`, skills-2025-10-02) requires every uploaded
// file to live under a common root directory whose name matches the SKILL.md
// frontmatter `name`; the docs let you upload that directory as a single ZIP
// (`files[]=@example_skill.zip`). The previous client sent a bare `SKILL.md`
// plus raw relative paths with NO common root, which violated the contract.
// ===========================================================================

/**
 * Anthropic Custom Skills upload boundary — REJECT at or above this value,
 * measured against BOTH the archive bytes AND the uncompressed file total.
 *
 * The docs say uploads must be "under 30 MB". This constant read that as
 * decimal MB (30,000,000) until the S7 live acceptance measured the real
 * boundary, which is the ONLY sanctioned trigger for moving it.
 *
 * ## Why 31,457,280 (= 30 × 1024 × 1024)
 *
 * The S7 live conformance run (check **C10**,
 * `evidence/2094-s7-acceptance/live-results.json`) uploaded a rooted canonical
 * zip of **30,000,505 archive bytes / 30,000,169 uncompressed** to the real
 * `POST /v1/skills` and the API **ACCEPTED it with HTTP 200**, minting a skill
 * that the run then reclaimed. That refutes the decimal reading outright: the
 * server's true bound is strictly greater than 30,000,505, so the old constant
 * was a confirmed client-side FALSE REJECTION.
 *
 * The narrowest reading of the same "under 30 MB" prose that is consistent with
 * that observation is binary MB — 30 MiB = 31,457,280 — and 30,000,505 sits
 * comfortably inside it. Independently, the API's documented request-size
 * ceiling is 32 MB (`413 request_too_large`), so 30 MiB also leaves headroom
 * for the multipart envelope that wraps these bytes on the wire under either
 * reading of that 32.
 *
 * ## What the evidence does NOT establish
 *
 * Only a LOWER bound. A bundle between 30,000,505 and 31,457,280 bytes has not
 * been observed in either direction, and no upper bound was probed to a
 * rejection, so this stays a deliberately conservative client-side gate rather
 * than a mirror of a known server limit. It is raised to the narrowest
 * defensible value, not to the transport ceiling. Moving it again requires the
 * same thing this move required: a live measurement, recorded.
 */
export const ANTHROPIC_SKILL_MAX_UPLOAD_BYTES = 31_457_280;

/** A bundled file: path relative to the skill source dir + raw bytes. */
export type SkillZipFile = { relPath: string; bytes: Buffer };

/** The canonical upload artifact + its two measured size dimensions. */
export type CanonicalSkillZip = {
  /** Common root directory the archive is rooted at (frontmatter name). */
  rootDir: string;
  /** The deterministic STORE zip bytes — the single uploaded artifact. */
  zipBytes: Buffer;
  /** Byte length of the archive itself. */
  archiveBytes: number;
  /** Sum of the uncompressed entry byte lengths (SKILL.md + bundled files). */
  uncompressedTotal: number;
  /** Sorted in-archive entry paths (each rooted under `rootDir`). */
  entryPaths: string[];
};

/**
 * Derive the archive root directory. The Anthropic contract requires it to
 * EXACTLY match the SKILL.md frontmatter `name`, so we read that first; only
 * when the frontmatter has no usable `name` do we fall back to a normalized
 * form of the catalog display name (defensive — S2 enforces a clean
 * frontmatter `name` at publish/CI time). Never empty.
 */
export function deriveSkillRootDir(skillMd: Buffer, fallbackName: string): string {
  const fmName = readTopLevelFrontmatterName(skillMd.toString("utf8"));
  if (fmName) return fmName;
  return normalizeRootFallback(fallbackName);
}

/**
 * Read the TOP-LEVEL `name:` scalar from the SKILL.md YAML frontmatter (between
 * the first two `---` fences). Deliberately line-based and column-0-anchored so
 * a `name:` nested under `metadata:` (indented) is never picked up, and so this
 * module needs no YAML dependency. Anthropic's frontmatter `name` is a simple
 * scalar slug, so this is sufficient; the full validator lives in the skills
 * package (S2 enforces frontmatter cleanliness). Returns "" when absent.
 */
function readTopLevelFrontmatterName(content: string): string {
  // Frontmatter block = between a leading `---\n` and the next `\n---`. Located
  // with indexOf (linear, no regex on the input bytes).
  if (!content.startsWith("---\n")) return "";
  const end = content.indexOf("\n---", 4);
  if (end < 0) return "";
  const block = content.slice(4, end);
  for (const line of block.split("\n")) {
    // Top-level key only: exactly `name:` at column 0 (an indented `name:`
    // nested under `metadata:` is skipped). String ops only — no backtracking
    // regex on the SKILL.md bytes (ReDoS-safe).
    if (!line.startsWith("name:")) continue;
    let value = line.slice("name:".length).trim();
    // Strip an inline comment on an UNQUOTED scalar (YAML requires whitespace
    // before `#`). Linear scan for the first whitespace-preceded `#`.
    if (value && value[0] !== '"' && value[0] !== "'") {
      for (let i = 1; i < value.length; i++) {
        const prev = value[i - 1];
        if (value[i] === "#" && (prev === " " || prev === "\t")) {
          value = value.slice(0, i).trimEnd();
          break;
        }
      }
    }
    // Strip matching surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value.trim();
  }
  return "";
}

/** Normalize a fallback name to a non-empty single-segment slug. */
function normalizeRootFallback(name: string): string {
  const slug = (typeof name === "string" ? name : "")
    .trim()
    .toLowerCase()
    // Collapse every run of non-alphanumerics to ONE dash — so the result can
    // never contain `--`, which lets the leading/trailing strip below use a
    // single-character (non-quantified, ReDoS-safe) pattern.
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-/, "")
    .replace(/-$/, "");
  return slug || "skill";
}

// --- CRC-32 (IEEE 802.3), table-based ---------------------------------------

const CRC_TABLE: number[] = (() => {
  const t = new Array<number>(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Fixed DOS date/time = 1980-01-01 00:00:00 (the zip epoch) for determinism. */
const DOS_DATE = 0x0021; // year 1980, month 1, day 1
const DOS_TIME = 0x0000;
/**
 * General-purpose bit 11 — declares the filename is UTF-8 so a strict reader
 * decodes non-ASCII paths correctly (bit 0 = STORE has no other flags).
 */
const UTF8_FLAG = 0x0800;
/** Classic (non-ZIP64) 16-bit field ceilings. */
const MAX_UINT16 = 0xffff;

type ZipEntry = { path: string; bytes: Buffer; crc: number };

/**
 * Build the canonical STORE zip for a skill bundle. Bundled paths are
 * normalized + de-duplicated by {@link normalizeBundledRelPath} (throws on
 * absolute / `..` / duplicate paths — the same rejection the drift hash makes),
 * so the archive can never carry a path the hash would refuse.
 *
 * @throws when a bundled path is absolute, escapes the root, or collides.
 */
export function buildCanonicalSkillZip(input: {
  skillMd: Buffer;
  bundledFiles: SkillZipFile[];
  rootDir: string;
}): CanonicalSkillZip {
  const rootDir = input.rootDir;
  if (!rootDir || rootDir.includes("\0")) {
    throw new Error(`[anthropic-skill-bundle-zip] invalid root directory: ${JSON.stringify(rootDir)}`);
  }

  const seen = new Set<string>();
  const entries: ZipEntry[] = [];
  const addEntry = (relInRoot: string, bytes: Buffer) => {
    const path = `${rootDir}/${relInRoot}`;
    if (seen.has(path)) {
      throw new Error(`[anthropic-skill-bundle-zip] duplicate archive path: ${path}`);
    }
    seen.add(path);
    entries.push({ path, bytes, crc: crc32(bytes) });
  };

  addEntry("SKILL.md", input.skillMd);
  for (const f of input.bundledFiles) {
    addEntry(normalizeBundledRelPath(f.relPath), f.bytes);
  }

  // Deterministic order: sort every entry bytewise by its in-archive path.
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // Classic-ZIP 16-bit ceilings — reject explicitly rather than let a later
  // writeUInt16LE throw a raw RangeError mid-build (we emit STORE, not ZIP64).
  if (entries.length > MAX_UINT16) {
    throw new Error(
      `[anthropic-skill-bundle-zip] too many bundle entries (${entries.length} > ${MAX_UINT16}); ` +
        `split or shrink the skill bundle`,
    );
  }

  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;
  let uncompressedTotal = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.path, "utf8");
    if (nameBuf.length > MAX_UINT16) {
      throw new Error(
        `[anthropic-skill-bundle-zip] entry path too long (${nameBuf.length} bytes > ${MAX_UINT16}): ${e.path}`,
      );
    }
    uncompressedTotal += e.bytes.length;

    // Local file header (30 bytes + name), STORE, sizes known up front.
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(UTF8_FLAG, 6); // general purpose flag (UTF-8 names)
    local.writeUInt16LE(0, 8); // method = store
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(e.crc, 14);
    local.writeUInt32LE(e.bytes.length, 18); // compressed size (== uncompressed, store)
    local.writeUInt32LE(e.bytes.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    localChunks.push(local, nameBuf, e.bytes);

    // Central directory header (46 bytes + name).
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(UTF8_FLAG, 8); // flags (UTF-8 names)
    central.writeUInt16LE(0, 10); // method
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(e.crc, 16);
    central.writeUInt32LE(e.bytes.length, 20);
    central.writeUInt32LE(e.bytes.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42); // local header offset
    centralChunks.push(central, nameBuf);

    offset += local.length + nameBuf.length + e.bytes.length;
  }

  const centralDir = Buffer.concat(centralChunks);
  const centralSize = centralDir.length;
  const centralOffset = offset;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // central dir start disk
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  const zipBytes = Buffer.concat([...localChunks, centralDir, eocd]);

  return {
    rootDir,
    zipBytes,
    archiveBytes: zipBytes.length,
    uncompressedTotal,
    entryPaths: entries.map((e) => e.path),
  };
}

/** A boundary-check outcome over the canonical artifact's two dimensions. */
export type SkillBoundaryCheck =
  | { exceeded: false }
  | { exceeded: true; dimension: "archive" | "uncompressed"; bytes: number };

/**
 * Reject when EITHER the archive bytes OR the uncompressed file total reaches
 * `maxBytes` (default {@link ANTHROPIC_SKILL_MAX_UPLOAD_BYTES}). `>=` — at the
 * boundary is rejected (the docs say "under 30 MB", read as 30 MiB).
 */
export function checkSkillBoundary(
  zip: CanonicalSkillZip,
  maxBytes: number = ANTHROPIC_SKILL_MAX_UPLOAD_BYTES,
): SkillBoundaryCheck {
  if (zip.uncompressedTotal >= maxBytes) {
    return { exceeded: true, dimension: "uncompressed", bytes: zip.uncompressedTotal };
  }
  if (zip.archiveBytes >= maxBytes) {
    return { exceeded: true, dimension: "archive", bytes: zip.archiveBytes };
  }
  return { exceeded: false };
}

/**
 * Stable, workspace-unique, non-sensitive `display_title` for a catalog skill.
 *
 * Anthropic requires an explicitly-passed `display_title` to be unique among a
 * workspace's custom skills. The title must ALSO be STABLE for the same local
 * skill across retries and re-baselines — a lost create response or a re-run
 * must never mint a duplicate remote identity — so it is derived from the
 * immutable `catalogSkillId`, NOT from content (content changes create new
 * versions, never a new title) and NOT from any secret (the discriminator is a
 * hash of the public catalog id, never the API key / fingerprint).
 *
 * Two distinct catalog skills whose display names collide get distinct titles
 * because the discriminator differs; the same catalog skill always maps to the
 * one title, so create-time collision reconciliation can adopt the existing
 * remote skill instead of duplicating it.
 */
export function deriveAnthropicDisplayTitle(name: string, catalogSkillId: string): string {
  const raw = typeof name === "string" && name.trim() ? name.trim() : catalogSkillId;
  // Bound the human-readable prefix so the title stays a sane length.
  const base = raw.length > 90 ? raw.slice(0, 90).trimEnd() : raw;
  const disc = createHash("sha256")
    .update(`anthropic-display-title:v1\0${catalogSkillId}`)
    .digest("hex")
    .slice(0, 12);
  return `${base} [${disc}]`;
}
