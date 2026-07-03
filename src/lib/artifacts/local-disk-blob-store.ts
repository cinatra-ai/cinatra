import "server-only";
import { randomUUID, createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  readdir,
  rename,
  rm,
  stat as fsStat,
  open as fsOpen,
  utimes,
} from "node:fs/promises";
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
import { resolveArtifactDataRoot } from "./artifact-data-root";

// Local-disk BlobStore. Bytes live ONLY here (never in objects.data).
// Storage keys are server-generated; client filenames are never on a path.
// The no-exec storage root (configurable, cinatra#926 — env > DB metadata >
// cwd-relative `data/artifacts` default) is served only via the authz'd
// serve route. The path is never a trust input — DB rows + the serving
// layer's authz are.
//
// KEY SHAPES (cinatra#926, epic #922):
//  - NEW writes are org-scoped + CONTENT-ADDRESSED:
//      `orgs/<orgId>/blobs/sha256/<aa>/<sha256>.bin`  (<aa> = first 2 hex)
//    mirroring the true dedupe identity (org_id, sha256). The org stays IN
//    the path (assertOrgPrefix defense-in-depth; no cross-org byte sharing);
//    the artifact-extension name is NEVER in the path (semantic type is a
//    mutable DB fact — same bytes can satisfy two extensions).
//  - LEGACY keys (`orgs/<org>/artifacts/<aid>/versions/<rev>/<blobId>.bin`)
//    stay readable FOREVER: every serve/read path is storage-key-keyed and
//    key-shape-agnostic. No migration, no key rewrites.
//
// SHARED-FINAL-FILE SAFETY: a content-addressed final path can be SHARED
// (a second same-bytes writer is answered with the existing file) and can
// exist before its `artifact_blobs` row commits. Therefore no failure or
// cleanup path may unlink a final content-addressed file directly:
//  (a) a writer's error cleanup removes ONLY its own `.staging/<uuid>` file;
//  (b) `deleteByStorageKey` on a content-addressed key is REACHABILITY-
//      GUARDED: it deletes only when no live `artifact_blobs` row references
//      the storage_key AND the file's mtime is older than a grace window
//      (covering the rename-committed-but-row-not-yet-committed writer, and
//      the keep-existing writer whose file mtime is refreshed on reuse).
//      Legacy per-revision keys keep today's direct-delete semantics.

// Lazy (not a module-load const) so it tracks the configured root and is
// deterministically testable.
function blobRoot(): string {
  return resolveArtifactDataRoot();
}

/** Same-FS staging dir under the root (EXDEV-safe atomic tmp+rename). */
export const ARTIFACT_STAGING_DIR_NAME = ".staging";

function stagingDir(): string {
  return path.join(blobRoot(), ARTIFACT_STAGING_DIR_NAME);
}

// ---------------------------------------------------------------------------
// Env-tunable ops knobs (cinatra#926). WARN-first defaults: an unset quota
// env disables that check entirely; `enforce` mode must be opted into.
// ---------------------------------------------------------------------------

/** Per-org byte quota (sum over artifact_blobs.size_bytes). Unset/0 = off. */
export const ARTIFACT_ORG_QUOTA_BYTES_ENV = "CINATRA_ARTIFACT_ORG_QUOTA_BYTES";
/** Staging-dir residency cap in bytes. Unset/0 = off. */
export const ARTIFACT_STAGING_CAP_BYTES_ENV = "CINATRA_ARTIFACT_STAGING_CAP_BYTES";
/** "warn" (default) logs and proceeds; "enforce" rejects the put. */
export const ARTIFACT_QUOTA_MODE_ENV = "CINATRA_ARTIFACT_QUOTA_MODE";
/** Grace window before an unreferenced content-addressed file may be deleted. */
export const ARTIFACT_DELETE_GRACE_MS_ENV = "CINATRA_ARTIFACT_DELETE_GRACE_MS";
export const DEFAULT_ARTIFACT_DELETE_GRACE_MS = 15 * 60 * 1000;

export class ArtifactQuotaExceededError extends Error {
  constructor(
    public readonly kind: "org-quota" | "staging-cap",
    public readonly limitBytes: number,
    public readonly usedBytes: number,
  ) {
    super(`artifact ${kind} exceeded: ${usedBytes} bytes used, limit ${limitBytes}`);
    this.name = "ArtifactQuotaExceededError";
  }
}

function envBytes(name: string): number {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function quotaMode(): "warn" | "enforce" {
  return (process.env[ARTIFACT_QUOTA_MODE_ENV] ?? "").trim().toLowerCase() === "enforce"
    ? "enforce"
    : "warn";
}

function deleteGraceMs(): number {
  const n = envBytes(ARTIFACT_DELETE_GRACE_MS_ENV);
  return n > 0 ? n : DEFAULT_ARTIFACT_DELETE_GRACE_MS;
}

/** Content-addressed new-write key shape (see module header). */
export function isContentAddressedStorageKey(storageKey: string): boolean {
  return /^orgs\/[A-Za-z0-9._-]+\/blobs\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}\.bin$/.test(
    storageKey,
  );
}

/** The sha256 embedded in a content-addressed key, or null. */
export function sha256FromContentAddressedKey(storageKey: string): string | null {
  const m = /\/sha256\/[a-f0-9]{2}\/([a-f0-9]{64})\.bin$/.exec(storageKey);
  return m ? m[1] : null;
}

function contentAddressedKeyFor(orgId: string, sha256hex: string): string {
  if (!/^[a-f0-9]{64}$/.test(sha256hex)) {
    throw new Error(`invalid sha256 for content-addressed key: ${JSON.stringify(sha256hex)}`);
  }
  return path.posix.join(
    "orgs",
    safe(orgId, "orgId"),
    "blobs",
    "sha256",
    sha256hex.slice(0, 2),
    `${sha256hex}.bin`,
  );
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

// LEGACY key derivation — retained ONLY so the scope-keyed accessors keep
// reading files written before the content-addressed cutover (cinatra#926).
// New writes NEVER produce this shape.
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

/** Injectable seams (unit tests / future backends). All optional; the
 *  defaults are the production DB-backed implementations. */
export type LocalDiskBlobStoreOptions = {
  /** Is this storage_key referenced by any live `artifact_blobs` row?
   *  Used by the reachability-guarded content-addressed delete. The
   *  default queries the DB and FAILS SAFE (treats errors as referenced). */
  isStorageKeyReferenced?: (orgId: string, storageKey: string) => Promise<boolean> | boolean;
  /** Current org byte usage for the quota check. Default sums
   *  `artifact_blobs.size_bytes` for the org; errors skip the check. */
  getOrgUsageBytes?: (orgId: string) => Promise<number | null> | number | null;
};

// Default reachability probe: any live artifact_blobs row carrying this
// storage_key keeps the bytes. Dynamic imports keep the DB modules out of
// the unit-test module graph; ANY failure returns `true` (fail-safe: when
// we cannot prove unreachability, we keep the file — the verifier reports
// residual orphans instead).
async function defaultIsStorageKeyReferenced(
  orgId: string,
  storageKey: string,
): Promise<boolean> {
  try {
    const { runPostgresQueriesSync } = await import("@/lib/postgres-sync");
    const { getPostgresConnectionString, postgresSchema } = await import(
      "@/lib/postgres-config"
    );
    const schema = postgresSchema.replaceAll('"', '""');
    const [res] = runPostgresQueriesSync({
      connectionString: getPostgresConnectionString(),
      queries: [
        {
          text: `SELECT 1 FROM "${schema}"."artifact_blobs"
WHERE org_id = $1 AND storage_key = $2 LIMIT 1`,
          values: [orgId, storageKey],
        },
      ],
    });
    return (res?.rows?.length ?? 0) > 0;
  } catch {
    return true;
  }
}

async function defaultGetOrgUsageBytes(orgId: string): Promise<number | null> {
  try {
    const { runPostgresQueriesSync } = await import("@/lib/postgres-sync");
    const { getPostgresConnectionString, postgresSchema } = await import(
      "@/lib/postgres-config"
    );
    const schema = postgresSchema.replaceAll('"', '""');
    const [res] = runPostgresQueriesSync({
      connectionString: getPostgresConnectionString(),
      queries: [
        {
          text: `SELECT COALESCE(SUM(size_bytes), 0)::bigint AS total
FROM "${schema}"."artifact_blobs" WHERE org_id = $1`,
          values: [orgId],
        },
      ],
    });
    const raw = res?.rows?.[0] as { total?: string | number } | undefined;
    if (raw === undefined || raw.total === undefined) return null;
    const n = typeof raw.total === "number" ? raw.total : Number(raw.total);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function stagingResidencyBytes(): Promise<number> {
  let total = 0;
  let entries: string[];
  try {
    entries = await readdir(stagingDir());
  } catch {
    return 0; // no staging dir yet
  }
  for (const name of entries) {
    try {
      const st = await fsStat(path.join(stagingDir(), name));
      if (st.isFile()) total += st.size;
    } catch {
      // raced with a concurrent finalize/cleanup — skip
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Per-storage-key critical section (codex round 2, cinatra#926).
//
// A content-addressed final file is SHARED: put()'s reuse/publish decision
// and deleteByStorageKey()'s stale→probe→unlink sequence race on the same
// path, and no mtime re-checking fully closes the interleaving where a
// writer confirms reuse and discards its staged copy right before the
// unlink lands (reachable via runResourceBlobGc, which deletes the rows
// BEFORE the disk delete). Both sequences therefore run under a per-key
// in-process mutex: whichever enters second observes the other's outcome
// (file unlinked ⇒ the writer publishes its staged copy; mtime refreshed ⇒
// the deleter keeps the file). Cross-process writers remain covered by the
// grace window + the verifier backstop, matching the design's best-effort
// contract there.
// ---------------------------------------------------------------------------
const storageKeyLocks = new Map<string, Promise<void>>();

async function withStorageKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = storageKeyLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prev.then(() => done);
  storageKeyLocks.set(key, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    // Drop the map entry when no waiter queued behind us (bounded memory).
    if (storageKeyLocks.get(key) === tail) storageKeyLocks.delete(key);
  }
}

/** WARN-first quota gate: logs in warn mode, throws in enforce mode. */
function applyQuotaVerdict(
  kind: "org-quota" | "staging-cap",
  usedBytes: number,
  limitBytes: number,
): void {
  if (usedBytes < limitBytes) return;
  if (quotaMode() === "enforce") {
    throw new ArtifactQuotaExceededError(kind, limitBytes, usedBytes);
  }
  console.warn(
    `[artifact-blob-store] ${kind} at/over limit (used=${usedBytes}, limit=${limitBytes}) — ` +
      `proceeding (mode=warn; set ${ARTIFACT_QUOTA_MODE_ENV}=enforce to reject)`,
  );
}

export function createLocalDiskBlobStore(
  options?: LocalDiskBlobStoreOptions,
): BlobStore {
  const isReferenced =
    options?.isStorageKeyReferenced ?? defaultIsStorageKeyReferenced;
  const orgUsageBytes = options?.getOrgUsageBytes ?? defaultGetOrgUsageBytes;

  return {
    async put(input: BlobPutInput): Promise<BlobRecord> {
      // The blobId stays a fresh UUID (it is the artifact_blobs row id);
      // it is no longer part of the on-disk path for new writes.
      const blobId = randomUUID();
      safe(input.orgId, "orgId"); // reject traversal BEFORE any disk I/O

      // WARN-first ops caps (cinatra#926). Both checks are skipped
      // entirely when their env knob is unset; the org-usage read is
      // fail-soft (a DB hiccup never blocks a write). In `enforce` mode the
      // quota also bounds the INCOMING stream: the pre-check alone would let
      // an org just under quota land an arbitrarily large blob, so the
      // remaining headroom is enforced during streaming like maxBytes.
      let enforcedRemainingBytes = Infinity;
      const orgQuota = envBytes(ARTIFACT_ORG_QUOTA_BYTES_ENV);
      if (orgQuota > 0) {
        const used = await orgUsageBytes(input.orgId);
        if (typeof used === "number") {
          applyQuotaVerdict("org-quota", used, orgQuota);
          if (quotaMode() === "enforce") {
            enforcedRemainingBytes = Math.max(0, orgQuota - used);
          }
        }
      }
      const stagingCap = envBytes(ARTIFACT_STAGING_CAP_BYTES_ENV);
      if (stagingCap > 0) {
        applyQuotaVerdict("staging-cap", await stagingResidencyBytes(), stagingCap);
      }

      // Stream to a same-FS staging file first (the final path is content-
      // addressed, so it is unknowable until the stream is fully hashed).
      const stagedPath = path.join(stagingDir(), randomUUID());
      await mkdir(stagingDir(), { recursive: true });

      const hash = createHash("sha256");
      let size = 0;
      let head: Uint8Array = new Uint8Array(0);
      const fh = await fsOpen(stagedPath, "wx");
      try {
        for await (const chunk of input.stream) {
          size += chunk.length;
          if (size > input.maxBytes) {
            throw new BlobTooLargeError(input.maxBytes);
          }
          if (size > enforcedRemainingBytes) {
            throw new ArtifactQuotaExceededError(
              "org-quota",
              orgQuota,
              orgQuota - enforcedRemainingBytes + size,
            );
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
        // Durability: fsync the staged bytes BEFORE the rename publishes
        // them under the content-addressed key.
        await fh.sync().catch(() => {});
      } catch (err) {
        // Error cleanup removes ONLY our own staged file — NEVER a final
        // path (a content-addressed final file can be shared).
        await fh.close().catch(() => {});
        await rm(stagedPath, { force: true }).catch(() => {});
        throw err;
      } finally {
        await fh.close().catch(() => {});
      }

      const sha256 = hash.digest("hex");
      const storageKey = contentAddressedKeyFor(input.orgId, sha256);
      const finalPath = absFor(storageKey);
      const record: BlobRecord = {
        blobId,
        storageKey,
        sha256,
        sizeBytes: size,
        mimeDetected: sniffMime(head, input.declaredMime),
      };

      try {
        // Reuse-or-publish runs under the per-storage-key critical section,
        // serialized against the guarded delete's stale→probe→unlink (see
        // the storageKeyLocks header): entering second means observing the
        // delete's outcome, never losing the caller's bytes.
        return await withStorageKeyLock(storageKey, async () => {
          await mkdir(path.dirname(finalPath), { recursive: true });
          let alreadyExists = false;
          try {
            await fsStat(finalPath);
            alreadyExists = true;
          } catch {
            alreadyExists = false;
          }
          if (alreadyExists) {
            // Same org + same sha ⇒ same bytes already on disk. REFRESH the
            // existing file's mtime FIRST so the reachability-guarded
            // delete's grace window also covers THIS writer's
            // not-yet-committed row, then VERIFY the file still exists
            // before discarding the staged duplicate. A cross-process
            // deleter could still unlink between stat and utimes — on any
            // failure fall through and publish our staged copy instead: the
            // caller's row must never point at missing bytes.
            const now = new Date();
            let reuseConfirmed = false;
            try {
              await utimes(finalPath, now, now);
              await fsStat(finalPath);
              reuseConfirmed = true;
            } catch {
              reuseConfirmed = false; // vanished under us — publish our copy
            }
            if (reuseConfirmed) {
              await rm(stagedPath, { force: true }).catch(() => {});
              return record;
            }
          }
          // Atomic same-FS publish. A concurrent same-bytes racer that also
          // renames to this path is benign: identical bytes, atomic replace.
          await rename(stagedPath, finalPath);
          // Durability: fsync the parent dir so the rename itself survives a
          // crash (best-effort; not all platforms allow dir fsync).
          try {
            const dh = await fsOpen(path.dirname(finalPath), "r");
            await dh.sync().catch(() => {});
            await dh.close().catch(() => {});
          } catch {
            // best-effort only
          }
          // File published FIRST, DB commit by caller AFTER. An orphan file
          // on later DB failure is preferable to a DB row pointing at a
          // missing blob; the verifier reports residual orphans.
          return record;
        });
      } catch (err) {
        await rm(stagedPath, { force: true }).catch(() => {});
        throw err;
      }
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
      const abs = absFor(storageKey);
      if (isContentAddressedStorageKey(storageKey)) {
        // REACHABILITY-GUARDED delete (cinatra#926): a content-addressed
        // final file can back several resources/blobs rows and can exist
        // before its row commits. Delete ONLY when
        //  (1) the file's mtime is older than the grace window (covers the
        //      rename-committed-but-row-not-yet-committed writer; the
        //      keep-existing put() path refreshes mtime on reuse), AND
        //  (2) no live artifact_blobs row references the storage_key
        //      (fail-safe: an unanswerable probe keeps the file).
        // The whole stale→probe→re-check→unlink sequence runs under the
        // per-storage-key critical section, serialized against put()'s
        // reuse/publish (see the storageKeyLocks header) — an in-process
        // same-bytes writer can never confirm reuse between our probe and
        // our unlink. A skipped delete leaves an orphan the verifier
        // reports; GC stays DB-reachability-only.
        await withStorageKeyLock(storageKey, async () => {
          let st;
          try {
            st = await fsStat(abs);
          } catch {
            return; // nothing on disk — nothing to delete
          }
          if (Date.now() - st.mtimeMs < deleteGraceMs()) return;
          if (await isReferenced(orgId, storageKey)) return;
          // Re-check the mtime AFTER the (potentially slow) reachability
          // probe: a CROSS-PROCESS put() that reused this file refreshes
          // its mtime before committing a row — a young mtime here means a
          // writer claimed the file while we probed, so keep it.
          try {
            const st2 = await fsStat(abs);
            if (Date.now() - st2.mtimeMs < deleteGraceMs()) return;
          } catch {
            return; // already gone
          }
          await rm(abs, { force: true });
        });
        return;
      }
      await rm(abs, { force: true });
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
