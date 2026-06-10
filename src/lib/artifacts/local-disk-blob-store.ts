import "server-only";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm, stat as fsStat, open as fsOpen } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type {
  BlobReadHandle,
  BlobRecord,
  BlobScope,
  BlobStore,
  BlobPutInput,
} from "@cinatra-ai/artifacts";
import { BlobTooLargeError } from "@cinatra-ai/artifacts";

// Local-disk BlobStore. Bytes live ONLY here (never in objects.data).
// Storage keys are server-generated and strictly scope-derived; client
// filenames are never on a path. No-exec storage root (`data/artifacts`)
// is served only via the authz'd serve route.

// Lazy (not a module-load const) so it tracks process.cwd() and is
// deterministically testable.
function blobRoot(): string {
  return path.join(process.cwd(), "data", "artifacts");
}

// Reject anything that could escape the scope-derived path. Scope ids are
// server-issued (org id, artifact id, version id, blob id) — defensive only.
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
function safe(seg: string, label: string): string {
  if (!seg || seg === "." || seg === ".." || !SAFE_SEGMENT.test(seg)) {
    throw new Error(`unsafe ${label} segment: ${JSON.stringify(seg)}`);
  }
  return seg;
}

function keyFor(scope: BlobScope, blobId: string): string {
  // `scope.representationRevisionId` is the semantic contract name; the
  // on-disk path segment stays "versions" so existing dev/test fixtures
  // and clones don't need a file-system migration.
  return path.posix.join(
    "orgs",
    safe(scope.orgId, "orgId"),
    "artifacts",
    safe(scope.artifactId, "artifactId"),
    "versions",
    safe(scope.representationRevisionId, "representationRevisionId"),
    `${safe(blobId, "blobId")}.bin`,
  );
}

function absFor(storageKey: string): string {
  const root = blobRoot();
  const abs = path.join(root, storageKey);
  // Containment guard: resolved path must stay under the storage root.
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error("blob path escapes storage root");
  }
  return abs;
}

// Minimal dependency-free magic-byte sniff (no new deps per repo constraint).
// Common types only; unknown → declaredMime (if safe) → octet-stream.
function sniffMime(head: Uint8Array, declared?: string): string {
  const b = head;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    return "image/jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46)
    return "image/gif";
  if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46)
    return "application/pdf";
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05))
    return "application/zip";
  // Media containers. These MUST be sniffed before the UTF-8 text
  // heuristic: several (WebM/EBML, RIFF, bare-frame MP3) can have a
  // NUL-free 16-byte head and would otherwise mis-sniff as text/plain,
  // which both mislabels the artifact and routes playable media to the
  // text preview handler.
  //
  // ISO-BMFF (`....ftyp`): container is shared by video/mp4, audio/mp4
  // and audio/x-m4a — magic alone cannot pick the declared use, so a
  // plausible media declaration wins; default video/mp4.
  // QuickTime major brand `qt  ` is identified positively: the container
  // IS QuickTime, which is deliberately NOT preview-allowlisted. Without
  // this branch a .mov uploaded with a generic/missing declared MIME would
  // be promoted to video/mp4 and ride the inline preview path the
  // exclusion decision keeps it off.
  if (b.length >= 8 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    if (b.length >= 12 && b[8] === 0x71 && b[9] === 0x74 && b[10] === 0x20 && b[11] === 0x20)
      return "video/quicktime";
    return declared && /^(video|audio)\/[\w.+-]+$/.test(declared)
      ? declared
      : "video/mp4";
  }
  // EBML (WebM / Matroska). video/webm vs audio/webm is declared-use.
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3)
    return declared === "audio/webm" || declared === "video/x-matroska"
      ? declared
      : "video/webm";
  // RIFF containers: WAVE → wav, WEBP → webp, "AVI " → avi.
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) {
    if (b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45)
      return "audio/wav";
    if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50)
      return "image/webp";
    if (b[8] === 0x41 && b[9] === 0x56 && b[10] === 0x49 && b[11] === 0x20)
      return "video/x-msvideo";
  }
  // MPEG audio: ID3 tag, or a bare frame sync (0xFF Ex/Fx) confirmed by
  // the declared MIME (the 2-byte sync alone is too weak a signature to
  // overrule an arbitrary declaration).
  if (b.length >= 3 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33)
    return "audio/mpeg";
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && declared === "audio/mpeg")
    return "audio/mpeg";
  // AAC in ADTS framing (0xFFF sync, layer 00), confirmed by the declared
  // MIME — same weak-signature rule as bare-frame MP3 above. Without this,
  // a NUL-free ADTS head declared audio/aac falls through to the UTF-8
  // text heuristic and is stored as text/plain (mislabel + wrong handler).
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xf6) === 0xf0 && declared === "audio/aac")
    return "audio/aac";
  // FLAC (`fLaC`).
  if (b.length >= 4 && b[0] === 0x66 && b[1] === 0x4c && b[2] === 0x61 && b[3] === 0x43)
    return "audio/flac";
  // Ogg (`OggS`): container is shared by audio/ogg + video/ogg.
  if (b.length >= 4 && b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53)
    return declared === "video/ogg" ? declared : "audio/ogg";
  // Heuristic UTF-8 text: no NUL in the head window.
  if (b.length > 0 && !b.includes(0)) {
    if (declared && /^text\/|application\/(json|markdown|xml|csv)/.test(declared))
      return declared;
    return "text/plain";
  }
  return declared && /^[\w.+-]+\/[\w.+-]+$/.test(declared)
    ? declared
    : "application/octet-stream";
}

export function createLocalDiskBlobStore(): BlobStore {
  return {
    async put(input: BlobPutInput): Promise<BlobRecord> {
      const blobId = crypto.randomUUID();
      const storageKey = keyFor(input, blobId);
      const finalPath = absFor(storageKey);
      const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
      await mkdir(path.dirname(finalPath), { recursive: true });

      const hash = createHash("sha256");
      let size = 0;
      let head: Uint8Array = new Uint8Array(0);
      const fh = await fsOpen(tmpPath, "wx");
      try {
        for await (const chunk of input.stream) {
          size += chunk.length;
          if (size > input.maxBytes) {
            await fh.close();
            await rm(tmpPath, { force: true });
            throw new BlobTooLargeError(input.maxBytes);
          }
          hash.update(chunk);
          if (head.length < 16) {
            // Copy only the needed prefix, never the whole (possibly huge)
            // first chunk.
            const slice = chunk.subarray(0, 16 - head.length);
            const merged = new Uint8Array(head.length + slice.length);
            merged.set(head);
            merged.set(slice, head.length);
            head = merged;
          }
          await fh.write(chunk);
        }
      } finally {
        await fh.close().catch(() => {});
      }
      // Write+rename file FIRST, DB commit by caller AFTER. Orphan file on
      // later DB failure is preferable to a DB row pointing at a missing
      // blob; orphan GC sweeps these.
      await rename(tmpPath, finalPath);
      return {
        blobId,
        storageKey,
        sha256: hash.digest("hex"),
        sizeBytes: size,
        mimeDetected: sniffMime(head, input.declaredMime),
      };
    },

    async open(scope: BlobScope & { blobId: string }): Promise<BlobReadHandle> {
      const abs = absFor(keyFor(scope, scope.blobId));
      const st = await fsStat(abs);
      return {
        sizeBytes: st.size,
        mimeDetected: "application/octet-stream",
        stream: Readable.toWeb(
          createReadStream(abs),
        ) as unknown as AsyncIterable<Uint8Array>,
      };
    },

    async openRange(
      scope: BlobScope & { blobId: string; start: number; end: number },
    ): Promise<BlobReadHandle & { totalSize: number }> {
      const abs = absFor(keyFor(scope, scope.blobId));
      const st = await fsStat(abs);
      const total = st.size;
      const start = Math.max(0, Math.min(scope.start, total === 0 ? 0 : total - 1));
      const end = Math.max(start, Math.min(scope.end, total - 1));
      return {
        totalSize: total,
        sizeBytes: end - start + 1,
        mimeDetected: "application/octet-stream",
        stream: Readable.toWeb(
          createReadStream(abs, { start, end }),
        ) as unknown as AsyncIterable<Uint8Array>,
      };
    },

    async stat(scope: BlobScope & { blobId: string }) {
      try {
        const st = await fsStat(absFor(keyFor(scope, scope.blobId)));
        return {
          sizeBytes: st.size,
          mimeDetected: "application/octet-stream",
          sha256: "",
        };
      } catch {
        return null;
      }
    },

    async deleteBlob(scope: BlobScope & { blobId: string }): Promise<void> {
      await rm(absFor(keyFor(scope, scope.blobId)), { force: true });
    },

    // Storage-key-keyed accessors for the semantic serve path. Two layers
    // of defense:
    //  (1) `assertOrgPrefix` rejects any storage_key not under
    //      `orgs/<orgId>/` (DB-carried keys are server-generated by
    //      `keyFor()`, but a compromised DB row or test fixture could
    //      try to escape the tenant);
    //  (2) `absFor` enforces the containment guard against the storage
    //      root (defense in depth).

    async openByStorageKey({
      orgId,
      storageKey,
    }: {
      orgId: string;
      storageKey: string;
    }): Promise<BlobReadHandle> {
      assertOrgPrefix(orgId, storageKey);
      const abs = absFor(storageKey);
      const st = await fsStat(abs);
      return {
        sizeBytes: st.size,
        mimeDetected: "application/octet-stream",
        stream: Readable.toWeb(
          createReadStream(abs),
        ) as unknown as AsyncIterable<Uint8Array>,
      };
    },

    async openRangeByStorageKey({
      orgId,
      storageKey,
      start,
      end,
    }: {
      orgId: string;
      storageKey: string;
      start: number;
      end: number;
    }): Promise<BlobReadHandle & { totalSize: number }> {
      assertOrgPrefix(orgId, storageKey);
      const abs = absFor(storageKey);
      const st = await fsStat(abs);
      const total = st.size;
      const clampedStart = Math.max(0, Math.min(start, total === 0 ? 0 : total - 1));
      const clampedEnd = Math.max(clampedStart, Math.min(end, total - 1));
      return {
        totalSize: total,
        sizeBytes: clampedEnd - clampedStart + 1,
        mimeDetected: "application/octet-stream",
        stream: Readable.toWeb(
          createReadStream(abs, { start: clampedStart, end: clampedEnd }),
        ) as unknown as AsyncIterable<Uint8Array>,
      };
    },

    async deleteByStorageKey({
      orgId,
      storageKey,
    }: {
      orgId: string;
      storageKey: string;
    }): Promise<void> {
      assertOrgPrefix(orgId, storageKey);
      await rm(absFor(storageKey), { force: true });
    },
  };
}

/** Tenant-prefix guard for DB-carried storage keys. Server-generated keys
 *  always begin with `orgs/<orgId>/` — any deviation is rejected before
 *  path resolution.
 *
 *  A string-prefix check alone is bypassable by `..` segments
 *  (`orgs/org1/../../orgs/org2/...` matches the prefix yet normalizes into
 *  org2). Defense in two layers:
 *    (1) reject any `..` or `.` segment in the key (server-generated
 *        keys never contain them — they're a server-derived shape);
 *    (2) AFTER `absFor` resolves the absolute path, assert it stays
 *        under `data/artifacts/orgs/<orgId>/` (not just the storage
 *        root). The downstream caller still calls `absFor()` for
 *        containment under the storage root as a third layer. */
function assertOrgPrefix(orgId: string, storageKey: string): void {
  const safeOrg = safe(orgId, "orgId");
  const expectedPrefix = `orgs/${safeOrg}/`;
  if (!storageKey.startsWith(expectedPrefix)) {
    throw new Error(
      `storage_key does not belong to org ${JSON.stringify(orgId)}`,
    );
  }
  // Layer 1: reject any traversal segment in the raw key.
  const segments = storageKey.split("/");
  for (const seg of segments) {
    if (seg === "." || seg === "..") {
      throw new Error(
        `storage_key contains path-traversal segment ${JSON.stringify(seg)}`,
      );
    }
  }
  // Layer 2: assert the RESOLVED absolute path stays under the per-org
  // root. `absFor()` enforces containment under the storage root, but a
  // key crafted as `orgs/org1/segment-that-is-NOT-..-but-suspicious`
  // could still smuggle bytes inside the org tree; this stricter check
  // pins the tenant boundary at the org directory level.
  const root = blobRoot();
  const orgRoot = path.join(root, "orgs", safeOrg);
  const abs = path.join(root, storageKey);
  if (abs !== orgRoot && !abs.startsWith(orgRoot + path.sep)) {
    throw new Error(
      `storage_key resolves outside org root ${JSON.stringify(orgId)}`,
    );
  }
}
