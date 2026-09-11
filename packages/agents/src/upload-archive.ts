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
//
// cinatra#3204 D3 — the reader is now KIND-AWARE and HARDENED:
//   4. readZipEntries        — refuses a traversing or absolute path, a symlink
//                              entry, and an archive over the entry-count /
//                              per-entry / total-size caps, BEFORE decompressing
//                              or returning anything;
//   5. resolveSuppliedArchive— reads the DECLARED `cinatra.kind`, resolves the
//                              payload that kind requires, validates name /
//                              version / kind against the archive contents, and
//                              computes the content digest over the delivered
//                              tree. It accepts all four live kinds — agent,
//                              skill, connector, artifact — and refuses an
//                              undeclared kind, an unknown kind and the retired
//                              `workflow` kind by name.
//
// NOTHING HERE EXECUTES PACKAGE CODE. The reader parses JSON and compares
// strings; it never imports, evaluates or spawns anything from the archive, on
// any path, for any kind. That is a property of the module, not of a caller
// remembering to be careful: there is no dynamic import, no `eval`, no `new
// Function` and no process API in this file at all.
// ---------------------------------------------------------------------------

import {
  MAX_SUPPLIED_ENTRY_BYTES,
  MAX_SUPPLIED_TREE_BYTES,
  MAX_SUPPLIED_TREE_ENTRIES,
  SUPPLIED_ARCHIVE_SUBJECT,
  SUPPLIED_PACKAGE_KINDS,
  computeContentDigest,
  resolveSuppliedPackageTree,
  suppliedEntryNameRefusal,
  type ResolvedSuppliedPackageTree,
  type SuppliedPackageKind,
} from "@cinatra-ai/extension-types";

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;

/** License sidecars staged for the SPDX gate — MUST mirror the name list
 *  importAgentTemplateCore stages alongside agent.json. */
const LICENSE_SIDECAR_NAMES = ["LICENSE", "LICENSE.md", "COPYING", ".spdx"] as const;

// ---------------------------------------------------------------------------
// Intake caps + entry-name policy (cinatra#3204 criterion 3)
// ---------------------------------------------------------------------------

/**
 * The caps. They are generous for a real extension package and ruinous for a
 * decompression bomb, which is the whole trade: a package that legitimately
 * needs more than this is a packaging problem worth a conversation, while an
 * archive that expands to gigabytes is an attack on the machine reading it.
 * Enforced on the CENTRAL DIRECTORY's declared sizes, so the refusal happens
 * before a single byte is inflated.
 */
export const MAX_ARCHIVE_ENTRIES = MAX_SUPPLIED_TREE_ENTRIES;
export const MAX_ARCHIVE_ENTRY_BYTES = MAX_SUPPLIED_ENTRY_BYTES;
export const MAX_ARCHIVE_TOTAL_BYTES = MAX_SUPPLIED_TREE_BYTES;

/** Unix file-type bits carried in a ZIP central directory's external attributes. */
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/**
 * Refuse an entry name that could write outside the extraction root.
 *
 * Three shapes, all refused: an ABSOLUTE path (`/etc/...`, or a Windows drive
 * or UNC path), any `..` PATH SEGMENT, and a BACKSLASH anywhere. The backslash
 * rule is not paranoia about Windows — it is that a name containing one is
 * ambiguous about where its segments divide, and an ambiguous path is exactly
 * what a traversal check has to be certain about.
 *
 * The reader itself writes nothing, so this is not the last line of defence; it
 * is the FIRST, and it is here so that no consumer of these entries can be the
 * first to notice.
 */
export const archiveEntryNameRefusal = suppliedEntryNameRefusal;

// ---------------------------------------------------------------------------
// ZIP reading
// ---------------------------------------------------------------------------

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error(
      "This archive uses compressed (deflate) entries, and this browser cannot decompress them. Use a current browser version.",
    );
  }
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Read every file entry of a ZIP archive into raw bytes.
 *
 * Supports compression method 0 (stored) and 8 (deflate). Directory entries
 * are skipped. Throws on a buffer that is not a ZIP archive and on
 * unsupported compression methods, so the form shows a real reason instead
 * of a downstream "agent.json not found".
 */
export async function readZipEntries(buf: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const view = new DataView(buf);
  const len = buf.byteLength;
  const result = new Map<string, Uint8Array>();

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
  const centralDirOffset = view.getUint32(eocdOffset + 16, true);

  // ENTRY-COUNT CAP (cinatra#3204 criterion 3) — read off the central directory
  // header, so an archive declaring hundreds of thousands of entries is refused
  // before the loop that would walk them.
  if (numEntries > MAX_ARCHIVE_ENTRIES) {
    throw new Error(
      `Invalid archive: it declares ${numEntries} entries, over the ${MAX_ARCHIVE_ENTRIES} limit.`,
    );
  }

  const td = new TextDecoder("utf-8");
  let pos = centralDirOffset;
  let totalUncompressed = 0;
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
    // Bounds checks: a truncated or crafted archive must fail with a real
    // reason, not a RangeError from an out-of-bounds typed-array view.
    if (pos + 46 + filenameLen > len) {
      throw new Error("Invalid archive: truncated ZIP central directory.");
    }
    const filename = td.decode(new Uint8Array(buf, pos + 46, filenameLen));
    pos += 46 + filenameLen + extraLen + commentLen;

    if (filename.endsWith("/")) continue; // directory entry

    // SYMLINK ENTRIES (criterion 3). A ZIP symlink is a regular entry whose
    // stored "content" is a target path and whose unix mode says S_IFLNK. It is
    // refused HERE, at the reader, because by the time anything extracts it the
    // damage is a link pointing wherever its content says — which is the escape
    // this whole gate exists to prevent. Refused for every archive, not only for
    // links that happen to point outside: a link that points inside today points
    // outside after one rename.
    if ((externalAttrs >>> 16 & S_IFMT) === S_IFLNK) {
      throw new Error(`Invalid archive: entry "${filename}" is a symlink, which is not allowed.`);
    }

    // ENTRY-NAME POLICY (criterion 3): traversal, absolute and ambiguous names.
    const nameRefusal = archiveEntryNameRefusal(filename);
    if (nameRefusal !== null) {
      throw new Error(`Invalid archive: ${nameRefusal}.`);
    }

    // SIZE CAPS (criterion 3) — checked against the DECLARED uncompressed sizes
    // before inflating, so a small archive that claims to expand to gigabytes is
    // refused instead of being inflated to find out.
    if (uncompressedSize > MAX_ARCHIVE_ENTRY_BYTES) {
      throw new Error(
        `Invalid archive: entry "${filename}" declares ${uncompressedSize} bytes, over the ${MAX_ARCHIVE_ENTRY_BYTES}-byte per-entry limit.`,
      );
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_ARCHIVE_TOTAL_BYTES) {
      throw new Error(
        `Invalid archive: its entries declare more than the ${MAX_ARCHIVE_TOTAL_BYTES}-byte total limit.`,
      );
    }

    if (localHeaderOffset + 30 > len) {
      throw new Error(`Invalid archive: entry "${filename}" has a truncated local header.`);
    }
    const lfhFilenameLen = view.getUint16(localHeaderOffset + 26, true);
    const lfhExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataOffset = localHeaderOffset + 30 + lfhFilenameLen + lfhExtraLen;
    if (dataOffset + compressedSize > len) {
      throw new Error(`Invalid archive: entry "${filename}" is truncated.`);
    }
    const raw = new Uint8Array(buf, dataOffset, compressedSize);

    if (method === 0) {
      result.set(filename, raw);
    } else if (method === 8) {
      result.set(filename, await inflateRaw(raw));
    } else {
      throw new Error(
        `Invalid archive: entry "${filename}" uses unsupported compression method ${method}.`,
      );
    }
  }
  return result;
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
      // The AGENT-NARROWED view (cinatra#3204 D3). `resolveSuppliedArchive`
      // above accepts all four live kinds; this reader is the agent-only lens
      // the agent import road still uses, so it still refuses a non-agent
      // package — but it now says which road does accept one instead of leaving
      // the operator with a dead end.
      throw new Error(
        `Invalid archive: this is a "${String(kind)}" extension package, not an agent package. ` +
          `A supplied package of any live kind is read by resolveSuppliedArchive.`,
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
// KIND-AWARE RESOLUTION (cinatra#3204 D3)
// ---------------------------------------------------------------------------

/**
 * The four kinds the product can actually install, and the reader's own names
 * for the SHARED resolution. Both are re-exports, not copies: the kind list, the
 * refusal set and the payload rules live in the dependency-free leaf
 * (`@cinatra-ai/extension-types`) so the repository intake (cinatra#3204 leg 2)
 * resolves through the SAME implementation this reader does. A kind added on one
 * road is added on both, because there is only one road for that decision.
 */
export const SUPPLIED_ARCHIVE_KINDS = SUPPLIED_PACKAGE_KINDS;
export type SuppliedArchiveKind = SuppliedPackageKind;
export type ResolvedSuppliedArchive = ResolvedSuppliedPackageTree;

/**
 * Read a SUPPLIED package ARCHIVE of any of the four live kinds.
 *
 * Everything specific to a ZIP happens HERE — the macOS junk entries a zipper
 * adds are dropped before the tree is read — and everything that is about the
 * PACKAGE happens in the shared resolver: the declared kind, the identity, the
 * kind's required payload, and the content digest over the delivered tree.
 *
 * REFUSALS, each by name: no declared kind; an unknown kind; the retired
 * `workflow` kind; a missing or unparseable package.json; a missing `name` or
 * `version`; a name that disagrees with the archive's own top-level folder; and
 * the kind's missing payload. Every one of them happens before anything is
 * written anywhere — the reader has no filesystem, no network and no execution,
 * so a refusal here cannot have left a trace.
 */
export async function resolveSuppliedArchive(
  entries: Map<string, Uint8Array>,
): Promise<ResolvedSuppliedArchive> {
  const raw = new Map<string, Uint8Array>();
  for (const [name, bytes] of entries) {
    if (isJunkEntry(name)) continue;
    raw.set(name, bytes);
  }
  return resolveSuppliedPackageTree(raw, SUPPLIED_ARCHIVE_SUBJECT);
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
export function buildCanonicalAgentZip(resolved: ResolvedAgentArchive): Uint8Array {
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
  return buildStoredZip(files);
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
