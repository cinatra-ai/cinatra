// ---------------------------------------------------------------------------
// upload-archive.ts — browser-safe agent-archive reader for the ZIP upload
// form (cinatra#2643). No Node imports, no external dependencies; safe to
// bundle into the "use client" import form.
//
// WHY THIS EXISTS: agent export ships the STANDARDIZED published-package
// layout — package.json whose `cinatra.entrypoint` names the OAS Flow
// document (cinatra/oas.json), usually under a single top-level <slug>/
// folder — while the server-side importer (importAgentTemplateCore) consumes
// the legacy flat shape (agent.json at the archive root, documented in
// import-export-actions.ts). This module bridges the two AT THE UPLOAD
// BOUNDARY:
//   1. readZipEntries        — reads real-world ZIPs (stored AND
//                              deflate-compressed entries; the previous
//                              reader silently returned garbage for deflate).
//   2. resolveAgentArchive   — accepts the standardized layout (entrypoint
//                              from package.json), falls back to the legacy
//                              root agent.json, tolerates one top-level
//                              folder prefix and macOS zip junk.
//   3. buildCanonicalAgentZip— repacks the resolved files into the flat,
//                              STORED-method archive the server importer
//                              already understands (zip-helpers.readZipFiles
//                              handles stored entries only), so the server
//                              contract does not change.
// ---------------------------------------------------------------------------

// The D2 content digest (cinatra#3204). ONE implementation, shared with the
// server: the browser computes the digest over the tree it previewed and the
// server recomputes it over the tree it received, so a preview-to-install
// mismatch is DETECTED rather than assumed away. The import is on the pure
// provenance module, never the package root, so no server-only module reaches
// the client bundle.
import { computeExtensionTreeDigest } from "@cinatra-ai/extensions/extension-package-digest";

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;

/** License sidecars staged for the SPDX gate — MUST mirror the name list
 *  importAgentTemplateCore stages alongside agent.json. */
const LICENSE_SIDECAR_NAMES = ["LICENSE", "LICENSE.md", "COPYING", ".spdx"] as const;

// ---------------------------------------------------------------------------
// ZIP reading
// ---------------------------------------------------------------------------

/**
 * Inflate a raw-deflate payload under a HARD BYTE BUDGET.
 *
 * The budget is not decoration. A ZIP central directory is written by whoever
 * made the archive, so its `uncompressedSize` is a CLAIM, not a measurement: a
 * few hundred kilobytes of deflated zeroes declaring one unpacked byte inflate
 * to gigabytes. Reading the whole stream first and checking the length
 * afterwards would already have spent the memory. So the stream is consumed
 * chunk by chunk and abandoned the moment it passes what is still allowed.
 */
async function inflateRawBounded(
  data: Uint8Array,
  maxBytes: number,
  name: string,
): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error(
      "This archive uses compressed (deflate) entries, and this browser cannot decompress them. Use a current browser version.",
    );
  }
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(
        `Invalid archive: entry ${JSON.stringify(name)} unpacks to more than the ${maxBytes} bytes still accepted at that point in the archive.`,
      );
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

// ---------------------------------------------------------------------------
// HARDENED INTAKE (cinatra#3204, acceptance criterion 3)
//
// The reader below is the FIRST thing an uploaded archive meets, and it is the
// only place that decides which bytes exist at all. It therefore owns every
// structural refusal, and it makes each one BEFORE decompressing anything:
//
//   - PATH SAFETY. An entry name is refused when it is absolute, carries a
//     Windows drive letter, uses a backslash separator, contains a control
//     character, or holds a ".." segment. None of these can name a file inside
//     a package, and every one of them is a way to write outside the root once
//     the tree is materialized.
//   - SYMBOLIC LINKS. A ZIP records the unix mode in the high 16 bits of the
//     central-directory external attributes; an S_IFLNK entry is refused
//     outright. A symlink's "content" is a path, and a package that ships one
//     is asking the host to follow it.
//   - CAPS. Entry count, per-entry unpacked size and total unpacked size are
//     all capped. Pass one applies them to the sizes the CENTRAL DIRECTORY
//     DECLARES, so an archive that admits to being oversized is refused before
//     a single byte is inflated. Pass two applies them AGAIN to the bytes that
//     actually arrive, because a declaration is written by whoever built the
//     archive: a bomb declaring one unpacked byte would otherwise sail through
//     pass one and be inflated in full. An entry whose real size disagrees with
//     its declaration is refused outright — the disagreement is the finding.
//
// Two passes, deliberately: pass one reads the central directory and applies
// every refusal above (so the total-size refusal can name the WHOLE total, not
// the prefix that happened to exceed it); pass two extracts the entries that
// survived.
// ---------------------------------------------------------------------------

export type ArchiveIntakeLimits = {
  /** Maximum number of entries an archive may declare. */
  maxEntries: number;
  /** Maximum UNPACKED size of a single entry, in bytes. */
  maxEntryUncompressedBytes: number;
  /** Maximum UNPACKED size of the whole archive, in bytes. */
  maxTotalUncompressedBytes: number;
};

/**
 * The caps the upload form enforces. Generous enough for every package the
 * pinned extension trees ship (the largest is a low single-digit number of
 * megabytes across a few hundred files) and small enough that a hostile archive
 * cannot exhaust the browser tab or the server that receives it.
 */
export const DEFAULT_ARCHIVE_INTAKE_LIMITS: ArchiveIntakeLimits = {
  maxEntries: 5000,
  maxEntryUncompressedBytes: 32 * 1024 * 1024,
  maxTotalUncompressedBytes: 128 * 1024 * 1024,
};

/** S_IFMT / S_IFLNK — a ZIP stores the unix mode in the high 16 bits. */
const S_IFMT = 0xf000;
const S_IFLNK = 0xa000;

/**
 * Refuse an entry name that cannot address a file inside the package root.
 * Throws; never normalizes. A name that has to be repaired before it is safe is
 * a name we do not accept.
 */
function assertSafeEntryName(name: string): void {
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      throw new Error(
        `Invalid archive: entry ${JSON.stringify(name)} contains a control character in its name.`,
      );
    }
  }
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
    throw new Error(
      `Invalid archive: entry ${JSON.stringify(name)} is an absolute path; only paths relative to the package root are accepted.`,
    );
  }
  if (name.includes("\\")) {
    throw new Error(
      `Invalid archive: entry ${JSON.stringify(name)} uses a backslash path separator; only "/" is accepted.`,
    );
  }
  if (name.split("/").some((segment) => segment === "..")) {
    throw new Error(`Invalid archive: entry ${JSON.stringify(name)} escapes the package root.`);
  }
}

type CentralEntry = {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  isDirectory: boolean;
};

/**
 * Read every file entry of a ZIP archive into raw bytes, applying the hardened
 * intake above.
 *
 * Supports compression method 0 (stored) and 8 (deflate). Directory entries are
 * skipped (their names are still checked — a directory entry named "../" is as
 * unacceptable as a file one). Throws on a buffer that is not a ZIP archive, on
 * unsupported compression methods, and on every refusal listed above, so the
 * form shows a real reason instead of a downstream "agent.json not found".
 */
export async function readZipArchive(
  buf: ArrayBuffer,
  limits: Partial<ArchiveIntakeLimits> = {},
): Promise<Map<string, Uint8Array>> {
  const caps: ArchiveIntakeLimits = { ...DEFAULT_ARCHIVE_INTAKE_LIMITS, ...limits };
  const view = new DataView(buf);
  const len = buf.byteLength;

  let eocdOffset = -1;
  for (let i = len - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error("Invalid archive: not a ZIP file.");
  }

  const numEntries = view.getUint16(eocdOffset + 10, true);
  if (numEntries > caps.maxEntries) {
    throw new Error(
      `Invalid archive: it declares ${numEntries} entries, more than the ${caps.maxEntries} accepted.`,
    );
  }
  const centralDirOffset = view.getUint32(eocdOffset + 16, true);

  // ---- pass 1: the central directory, and every structural refusal ----
  const td = new TextDecoder("utf-8");
  const central: CentralEntry[] = [];
  let totalUncompressed = 0;
  let pos = centralDirOffset;
  for (let i = 0; i < numEntries; i++) {
    if (pos + 46 > len || view.getUint32(pos, true) !== CENTRAL_SIG) break;
    const method = view.getUint16(pos + 10, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const uncompressedSize = view.getUint32(pos + 24, true);
    const filenameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const externalAttrs = view.getUint32(pos + 38, true);
    const localHeaderOffset = view.getUint32(pos + 42, true);
    if (pos + 46 + filenameLen > len) {
      throw new Error("Invalid archive: truncated ZIP central directory.");
    }
    const name = td.decode(new Uint8Array(buf, pos + 46, filenameLen));
    pos += 46 + filenameLen + extraLen + commentLen;

    assertSafeEntryName(name);

    const unixMode = (externalAttrs >>> 16) & 0xffff;
    if ((unixMode & S_IFMT) === S_IFLNK) {
      throw new Error(
        `Invalid archive: entry ${JSON.stringify(name)} is a symbolic link; symbolic links are not accepted.`,
      );
    }

    const isDirectory = name.endsWith("/");
    if (!isDirectory) {
      if (uncompressedSize > caps.maxEntryUncompressedBytes) {
        throw new Error(
          `Invalid archive: entry ${JSON.stringify(name)} unpacks to ${uncompressedSize} bytes, ` +
            `more than the ${caps.maxEntryUncompressedBytes} accepted.`,
        );
      }
      totalUncompressed += uncompressedSize;
    }
    central.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset, isDirectory });
  }

  if (totalUncompressed > caps.maxTotalUncompressedBytes) {
    throw new Error(
      `Invalid archive: it unpacks to ${totalUncompressed} bytes in total, ` +
        `more than the ${caps.maxTotalUncompressedBytes} accepted.`,
    );
  }

  // ---- pass 2: extraction ----
  const result = new Map<string, Uint8Array>();
  // The MEASURED total, kept apart from the declared one: the caps are enforced
  // against both, and it is this one that bounds the memory actually spent.
  let actualTotal = 0;
  for (const entry of central) {
    if (entry.isDirectory) continue;
    if (entry.localHeaderOffset + 30 > len) {
      throw new Error(
        `Invalid archive: entry ${JSON.stringify(entry.name)} has a truncated local header.`,
      );
    }
    const lfhFilenameLen = view.getUint16(entry.localHeaderOffset + 26, true);
    const lfhExtraLen = view.getUint16(entry.localHeaderOffset + 28, true);
    const dataOffset = entry.localHeaderOffset + 30 + lfhFilenameLen + lfhExtraLen;
    if (dataOffset + entry.compressedSize > len) {
      throw new Error(`Invalid archive: entry ${JSON.stringify(entry.name)} is truncated.`);
    }
    const raw = new Uint8Array(buf, dataOffset, entry.compressedSize);

    let bytes: Uint8Array;
    if (entry.method === 0) {
      // A stored entry IS its own unpacked form, so the two declared sizes must
      // agree. When they do not, one of them is a lie, and the reader refuses
      // to guess which — a stored entry declaring one unpacked byte and a
      // gigabyte of stored payload is exactly the shape pass one would admit.
      if (entry.compressedSize !== entry.uncompressedSize) {
        throw new Error(
          `Invalid archive: entry ${JSON.stringify(entry.name)} is stored uncompressed but declares ` +
            `${entry.compressedSize} stored bytes against ${entry.uncompressedSize} unpacked bytes.`,
        );
      }
      bytes = raw;
    } else if (entry.method === 8) {
      // What is still allowed HERE: never more than one entry's cap, and never
      // more than the whole archive has left.
      const budget = Math.min(
        caps.maxEntryUncompressedBytes,
        caps.maxTotalUncompressedBytes - actualTotal,
      );
      bytes = await inflateRawBounded(raw, Math.max(budget, 0), entry.name);
    } else {
      throw new Error(
        `Invalid archive: entry ${JSON.stringify(entry.name)} uses unsupported compression method ${entry.method}.`,
      );
    }

    if (bytes.byteLength !== entry.uncompressedSize) {
      throw new Error(
        `Invalid archive: entry ${JSON.stringify(entry.name)} declares ${entry.uncompressedSize} unpacked ` +
          `bytes but produced ${bytes.byteLength}.`,
      );
    }
    actualTotal += bytes.byteLength;
    if (actualTotal > caps.maxTotalUncompressedBytes) {
      throw new Error(
        `Invalid archive: it unpacks to more than the ${caps.maxTotalUncompressedBytes} bytes accepted in total.`,
      );
    }
    result.set(entry.name, bytes);
  }
  return result;
}

/**
 * Back-compatible name for {@link readZipArchive} at the default caps — the
 * shape every pre-#3204 caller uses.
 */
export async function readZipEntries(buf: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  return readZipArchive(buf);
}

// ---------------------------------------------------------------------------
// Layout resolution
// ---------------------------------------------------------------------------

export type ResolvedAgentArchive = {
  /** The OAS Flow document text (entrypoint file or legacy root agent.json). */
  agentJson: string;
  /** manifest.json text when the archive carries one (legacy exports). */
  manifestJson: string | null;
  /** package.json text when the archive carries one. */
  packageJson: string | null;
  /** License sidecars present at the package root, by canonical name. */
  licenseFiles: Map<string, string>;
  /** "standard" = package.json cinatra.entrypoint; "legacy" = root agent.json. */
  layout: "standard" | "legacy";
  /** The single top-level folder that was stripped, or null. */
  strippedPrefix: string | null;
};

/** macOS zip tooling junk that must not defeat prefix detection. */
function isJunkEntry(name: string): boolean {
  if (name.startsWith("__MACOSX/")) return true;
  const base = name.split("/").pop() ?? name;
  return base === ".DS_Store";
}

function decodeEntries(entries: Map<string, Uint8Array>): Map<string, string> {
  const td = new TextDecoder("utf-8");
  const out = new Map<string, string>();
  for (const [name, data] of entries) {
    if (isJunkEntry(name)) continue;
    out.set(name, td.decode(data));
  }
  return out;
}

type RootResolution = Omit<ResolvedAgentArchive, "strippedPrefix"> | null;

function resolveAtRoot(files: Map<string, string>, prefix: string): RootResolution {
  const get = (name: string) => files.get(prefix + name);

  const packageJson = get("package.json") ?? null;
  const manifestJson = get("manifest.json") ?? null;
  const licenseFiles = new Map<string, string>();
  for (const name of LICENSE_SIDECAR_NAMES) {
    const content = get(name);
    if (content !== undefined) licenseFiles.set(name, content);
  }

  if (packageJson !== null) {
    let pkg: { cinatra?: { kind?: unknown; entrypoint?: unknown } };
    try {
      pkg = JSON.parse(packageJson) as typeof pkg;
    } catch {
      throw new Error("Invalid archive: package.json is not valid JSON.");
    }
    const kind = pkg.cinatra?.kind;
    if (kind !== undefined && kind !== "agent") {
      throw new Error(
        `Invalid archive: this is a "${String(kind)}" extension package, not an agent package.`,
      );
    }
    const entrypoint = pkg.cinatra?.entrypoint;
    if (typeof entrypoint === "string" && entrypoint.length > 0) {
      const normalized = entrypoint.replace(/^\.\//, "");
      const agentJson = get(normalized);
      if (agentJson === undefined) {
        throw new Error(
          `Invalid archive: entrypoint "${entrypoint}" (from package.json) not found in the archive.`,
        );
      }
      return { agentJson, manifestJson, packageJson, licenseFiles, layout: "standard" };
    }
    // package.json without a cinatra.entrypoint — fall through to the
    // CONVENTIONAL payload path, then the legacy root agent.json.
  }

  // Conventional payload path: the format every published @cinatra-ai/*-agent
  // package ships. Same resolution order as the marketplace read
  // (readAgentPayloadFromExtractedPackage in packages/registries):
  // cinatra/oas.json first, root agent.json as the legacy fallback.
  const conventional = get("cinatra/oas.json");
  if (conventional !== undefined) {
    return { agentJson: conventional, manifestJson, packageJson, licenseFiles, layout: "standard" };
  }

  const agentJson = get("agent.json");
  if (agentJson !== undefined) {
    return { agentJson, manifestJson, packageJson, licenseFiles, layout: "legacy" };
  }
  return null;
}

/**
 * Resolve an uploaded agent archive into its importable parts.
 *
 * Acceptance, in order (cinatra#2643):
 *   1. Standardized package layout — package.json with `cinatra.entrypoint`
 *      naming the OAS Flow document (e.g. "cinatra/oas.json").
 *   2. Conventional payload path — cinatra/oas.json, the format every
 *      published @cinatra-ai/*-agent package ships (mirrors the marketplace
 *      read order in packages/registries).
 *   3. Legacy flat layout — agent.json at the root.
 * All are also accepted under a SINGLE top-level folder prefix (the export
 * wraps everything in <slug>/), with macOS zip junk ignored.
 */
export function resolveAgentArchive(entries: Map<string, Uint8Array>): ResolvedAgentArchive {
  const files = decodeEntries(entries);
  if (files.size === 0) {
    throw new Error("Invalid archive: the ZIP file contains no files.");
  }

  const atRoot = resolveAtRoot(files, "");
  if (atRoot) return { ...atRoot, strippedPrefix: null };

  // Single top-level folder tolerance: strip "<slug>/" when EVERY entry
  // lives under the same first path segment.
  const topSegments = new Set<string>();
  for (const name of files.keys()) {
    const slash = name.indexOf("/");
    topSegments.add(slash < 0 ? "" : name.slice(0, slash));
  }
  if (topSegments.size === 1) {
    const [segment] = topSegments;
    if (segment !== "") {
      const prefixed = resolveAtRoot(files, `${segment}/`);
      if (prefixed) return { ...prefixed, strippedPrefix: segment };
    }
  }

  throw new Error(
    "Invalid archive: no agent definition found. Expected a package.json with cinatra.entrypoint or a cinatra/oas.json payload (standard agent package), or a root agent.json (legacy export).",
  );
}

// ---------------------------------------------------------------------------
// KIND-AWARE RESOLUTION (cinatra#3204, acceptance criteria 1, 2, 4, 5)
//
// The File road used to resolve AGENT archives only: `resolveAtRoot` refused any
// declared `cinatra.kind` other than "agent" by name, so an artifact, a skill or
// a connector package was rejected at the door and the submit button stayed
// dead. `resolveAgentArchive` below KEEPS that behaviour, because it is the
// agent-payload extractor the canonical repack feeds; what changed is that the
// FORM no longer calls it directly. It calls
// `resolveUploadedExtensionArchive`, which reads the declared kind first and
// then resolves the payload THAT kind requires.
//
// The RULES for what a declared kind means, and what backs it up, live in
// ./extension-package-manifest.ts — shared verbatim with the GitHub road, so
// the same package is admitted or refused identically whichever tab an operator
// opens, with the same wording. What stays HERE is everything specific to a ZIP:
// the wrapper-folder strip, the license sidecars, the legacy flat export, and
// the digest over the delivered tree.
// ---------------------------------------------------------------------------

export {
  UPLOADABLE_EXTENSION_KINDS,
  type UploadableExtensionKind,
} from "./extension-package-manifest";
import {
  ACCEPTED_KINDS_SENTENCE,
  readExtensionPackageIdentity,
  resolveExtensionPackagePayload,
  type UploadableExtensionKind as UploadKind,
} from "./extension-package-manifest";

export type ResolvedExtensionArchive = {
  /** The kind read from the package, never assumed. */
  kind: UploadKind;
  /** package.json `name`; null only for the legacy flat agent export. */
  packageName: string | null;
  /** package.json `version`; null only for the legacy flat agent export. */
  packageVersion: string | null;
  /** The parsed package.json — the exact object each kind's `validate()` takes. */
  manifest: Record<string, unknown> | null;
  /** package.json text, when the archive carries one. */
  packageJson: string | null;
  /** The DELIVERED TREE: every file, with the wrapper folder and packaging junk
   *  removed. This is what is digested, and what an install materializes. */
  files: Map<string, Uint8Array>;
  /** The single top-level folder that was stripped, or null. */
  strippedPrefix: string | null;
  /** License sidecars present at the package root, by canonical name. */
  licenseFiles: Map<string, string>;
  /** The D2 content digest over `files`. */
  contentDigest: string;
  /** The OAS Flow document — kind "agent" only; null for every other kind. */
  agentJson: string | null;
  /** manifest.json text when the archive carries one (legacy exports). */
  manifestJson: string | null;
  layout: "standard" | "legacy";
};

/** Find the prefix every entry shares, when there is exactly one. */
function singleTopLevelPrefix(names: Iterable<string>): string | null {
  const segments = new Set<string>();
  for (const name of names) {
    const slash = name.indexOf("/");
    segments.add(slash < 0 ? "" : name.slice(0, slash));
  }
  if (segments.size !== 1) return null;
  const [segment] = segments;
  return segment === "" ? null : segment;
}

/**
 * Resolve an uploaded package archive of ANY live installable kind.
 *
 * Ordering is deliberate: structure, then identity, then kind, then payload.
 * Each stage refuses with a message naming what it found, so an operator holding
 * the wrong file is told which file they are holding — not merely that the
 * button is dead.
 */
export async function resolveUploadedExtensionArchive(
  entries: Map<string, Uint8Array>,
): Promise<ResolvedExtensionArchive> {
  const clean = new Map<string, Uint8Array>();
  for (const [name, data] of entries) {
    if (isJunkEntry(name)) continue;
    clean.set(name, data);
  }
  if (clean.size === 0) {
    throw new Error("Invalid archive: the ZIP file contains no files.");
  }

  // The single wrapper folder the export shipping convention adds is PACKAGING,
  // not content: strip it before anything else, so the resolved tree, the
  // digest and the materialized install all describe the same file set.
  const rootMarked = clean.has("package.json") || clean.has("agent.json");
  const prefix = rootMarked ? null : singleTopLevelPrefix(clean.keys());
  const files = new Map<string, Uint8Array>();
  if (prefix === null) {
    for (const [name, data] of clean) files.set(name, data);
  } else {
    for (const [name, data] of clean) files.set(name.slice(prefix.length + 1), data);
  }

  const td = new TextDecoder("utf-8");
  const read = (name: string): string | null => {
    const data = files.get(name);
    return data === undefined ? null : td.decode(data);
  };

  const packageJson = read("package.json");
  const manifestJson = read("manifest.json");
  const licenseFiles = new Map<string, string>();
  for (const name of LICENSE_SIDECAR_NAMES) {
    const content = read(name);
    if (content !== null) licenseFiles.set(name, content);
  }

  const contentDigest = await computeExtensionTreeDigest(files);

  // LEGACY FLAT AGENT EXPORT — agent.json at the root and no package.json. It
  // predates the published-package layout entirely; its identity is derived from
  // the OAS document by the server importer, so there is no name or version to
  // read here. Kept working rather than refused: it is the shape the app's own
  // older exports produce.
  if (packageJson === null) {
    const legacyAgent = read("agent.json");
    if (legacyAgent !== null) {
      return {
        kind: "agent",
        packageName: null,
        packageVersion: null,
        manifest: null,
        packageJson: null,
        files,
        strippedPrefix: prefix,
        licenseFiles,
        contentDigest,
        agentJson: legacyAgent,
        manifestJson,
        layout: "legacy",
      };
    }
    throw new Error(
      "Invalid archive: no package.json at the package root, and no legacy root agent.json either — " +
        "there is nothing that says what this package is. " +
        `Accepted kinds are ${ACCEPTED_KINDS_SENTENCE}.`,
    );
  }

  const identity = readExtensionPackageIdentity(packageJson, "archive");
  const payload = resolveExtensionPackagePayload(
    identity,
    { paths: () => files.keys(), read },
    "archive",
  );

  return {
    kind: identity.kind,
    packageName: identity.packageName,
    packageVersion: identity.packageVersion,
    manifest: identity.manifest,
    packageJson,
    files,
    strippedPrefix: prefix,
    licenseFiles,
    contentDigest,
    agentJson: payload.agentJson,
    manifestJson,
    layout: payload.layout,
  };
}

// ---------------------------------------------------------------------------
// Canonical repack (stored-method ZIP writer)
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

function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of buf) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Build a flat, stored-method (no compression) ZIP — the browser-side twin of
 * zip-helpers.createZipBuffer, byte-layout compatible with the server's
 * readZipFiles.
 */
export function buildStoredZip(files: { name: string; content: string }[]): Uint8Array {
  const te = new TextEncoder();
  const encoded = files.map((f) => ({ name: te.encode(f.name), data: te.encode(f.content) }));
  const chunks: Uint8Array[] = [];
  const localOffsets: number[] = [];
  let offset = 0;

  for (const { name, data } of encoded) {
    localOffsets.push(offset);
    const c = crc32(data);
    const h = new Uint8Array(30 + name.length);
    const v = new DataView(h.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true);
    v.setUint32(14, c, true);
    v.setUint32(18, data.length, true);
    v.setUint32(22, data.length, true);
    v.setUint16(26, name.length, true);
    h.set(name, 30);
    chunks.push(h, data);
    offset += h.length + data.length;
  }

  const centralStart = offset;
  for (let i = 0; i < encoded.length; i++) {
    const { name, data } = encoded[i];
    const c = crc32(data);
    const e = new Uint8Array(46 + name.length);
    const v = new DataView(e.buffer);
    v.setUint32(0, CENTRAL_SIG, true);
    v.setUint16(4, 20, true);
    v.setUint16(6, 20, true);
    v.setUint32(16, c, true);
    v.setUint32(20, data.length, true);
    v.setUint32(24, data.length, true);
    v.setUint16(28, name.length, true);
    v.setUint32(42, localOffsets[i], true);
    e.set(name, 46);
    chunks.push(e);
    offset += e.length;
  }

  const centralSize = offset - centralStart;
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, EOCD_SIG, true);
  ev.setUint16(8, encoded.length, true);
  ev.setUint16(10, encoded.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralStart, true);
  chunks.push(eocd);

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const c of chunks) {
    out.set(c, cursor);
    cursor += c.length;
  }
  return out;
}

/**
 * Repack a resolved archive into the flat shape importAgentTemplateCore
 * consumes: agent.json at the root plus the manifest / package.json / license
 * sidecars it stages. Always stored-method, so the server's reader needs no
 * inflate support.
 */
export function canonicalAgentZipFiles(
  resolved: ResolvedAgentArchive,
): { name: string; content: string }[] {
  const files: { name: string; content: string }[] = [
    { name: "agent.json", content: resolved.agentJson },
  ];
  if (resolved.manifestJson !== null) {
    files.push({ name: "manifest.json", content: resolved.manifestJson });
  }
  if (resolved.packageJson !== null) {
    files.push({ name: "package.json", content: resolved.packageJson });
  }
  for (const [name, content] of resolved.licenseFiles) {
    files.push({ name, content });
  }
  return files;
}

/**
 * The digest of the tree that is actually SENT — the canonical repack, not the
 * archive the operator picked.
 *
 * The two are not the same set of files, and that is the whole point of this
 * function existing. The preview digests the delivered tree so the operator is
 * told what they handed over; the request carries THIS digest, over the exact
 * files the server will receive, so the server can recompute it from the bytes
 * in its own hands and refuse a substitution. A digest over a tree the server
 * never sees could not be checked by anyone, and a recorded attestation nobody
 * can check is worse than none.
 */
export async function computeCanonicalAgentZipDigest(
  resolved: ResolvedAgentArchive,
): Promise<string> {
  const te = new TextEncoder();
  return computeExtensionTreeDigest(
    canonicalAgentZipFiles(resolved).map(
      ({ name, content }) => [name, te.encode(content)] as const,
    ),
  );
}

export function buildCanonicalAgentZip(resolved: ResolvedAgentArchive): Uint8Array {
  return buildStoredZip(canonicalAgentZipFiles(resolved));
}

/** Base64-encode bytes without blowing the argument-spread limit. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
