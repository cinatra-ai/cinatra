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

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;

/** License sidecars staged for the SPDX gate — MUST mirror the name list
 *  importAgentTemplateCore stages alongside agent.json. */
const LICENSE_SIDECAR_NAMES = ["LICENSE", "LICENSE.md", "COPYING", ".spdx"] as const;

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

  const td = new TextDecoder("utf-8");
  let pos = centralDirOffset;
  for (let i = 0; i < numEntries; i++) {
    if (pos + 46 > len || view.getUint32(pos, true) !== CENTRAL_SIG) break;
    const method = view.getUint16(pos + 10, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const filenameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localHeaderOffset = view.getUint32(pos + 42, true);
    // Bounds checks: a truncated or crafted archive must fail with a real
    // reason, not a RangeError from an out-of-bounds typed-array view.
    if (pos + 46 + filenameLen > len) {
      throw new Error("Invalid archive: truncated ZIP central directory.");
    }
    const filename = td.decode(new Uint8Array(buf, pos + 46, filenameLen));
    pos += 46 + filenameLen + extraLen + commentLen;

    if (filename.endsWith("/")) continue; // directory entry

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
