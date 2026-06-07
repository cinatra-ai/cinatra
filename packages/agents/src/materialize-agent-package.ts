import "server-only";

// Materialize an extracted agent package tarball to the
// `agents/<vendor>/<slug>/` runtime mount so the WayFlow loader can discover
// it on the next reload.
//
// Without this, `installAgentFromPackage` leaves extension-installed agent
// packages invisible to the WayFlow container.
//
// Atomic write algorithm:
//   1. Validate packageName against the strict @vendor/slug whitelist.
//   2. Refuse anything that resolves outside agentInstallDir.
//   3. Refuse if the tarball lacks cinatra/oas.json.
//   4. Copy runtime files into `<vendorRoot>/.tmp-<slug>-<rand>/`.
//   5. If targetDir already exists: rename it aside to
//      `<vendorRoot>/.old-<slug>-<rand>/` (capture as priorDirBackup).
//   6. rename(<tmpDir>, targetDir). If this fails AND there is a priorDirBackup,
//      restore it back to targetDir before re-throwing.
//   7. Return { materialized: true, targetDir, priorDirBackup, wasReinstall }.
//      The CALLER is responsible for `rm -rf priorDirBackup` on commit
//      (success) or for restoring it on rollback (DB failure). This split
//      lets installAgentFromPackage own the materialize↔DB transaction
//      atomicity and rollback chain.

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Process-local re-entrant serialization of the install transaction for the
// SAME package. The transaction spans materialize → DB write → commit/rollback,
// AND any caller-supplied additional steps (e.g. extension-handler's
// registerSkillsFromPackage + its compensation block).
//
// extension-handler's compensation must run inside the install-from-package
// lock; otherwise a concurrent install can commit a newer state in the gap
// and then get clobbered by the first install's rollback. The lock is
// re-entrant (tracked via
// AsyncLocalStorage) so extension-handler can hold it across its WHOLE
// flow while install-from-package's nested acquire is a no-op.
// ---------------------------------------------------------------------------

const _installLocks: Map<string, Promise<unknown>> = new Map();
const _heldLocks = new AsyncLocalStorage<Set<string>>();

/**
 * Run `fn` inside a per-package install lock. The lock is re-entrant: if the
 * current async context already holds the lock for `packageName`, `fn` runs
 * inline without re-acquiring (no deadlock).
 *
 * Critical section serialized:
 *   - install-from-package.ts: materialize → DB → commit/rollback
 *   - extension-handler.ts: install + registerSkillsFromPackage + compensation
 *
 * Both lock at the same key (`packageName`); the outer (extension-handler)
 * call acquires the lock, the inner (install-from-package) call detects
 * re-entrance and runs `fn` inline.
 *
 * Cross-package operations run in parallel (separate lock keys).
 */
export async function withInstallLock<T>(
  packageName: string,
  fn: () => Promise<T>,
): Promise<T> {
  // The global extension-lifecycle lock is ALWAYS the outermost lock.
  // Acquiring it here (re-entrant: a no-op if this async context already
  // holds it) guarantees a single global→per-package acquisition order at
  // EVERY call site. This eliminates ABBA deadlocks between extension-handler
  // installs and the direct install path. withGlobalExtensionLifecycleLock is
  // a hoisted function declaration below — safe to reference here.
  return withGlobalExtensionLifecycleLock(() =>
    _withInstallLockInner(packageName, fn),
  );
}

async function _withInstallLockInner<T>(
  packageName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const currentlyHeld = _heldLocks.getStore();
  if (currentlyHeld && currentlyHeld.has(packageName)) {
    return fn();
  }
  let resolveOurDone!: () => void;
  const ourDone = new Promise<void>((res) => {
    resolveOurDone = res;
  });
  const prev = _installLocks.get(packageName);
  _installLocks.set(packageName, ourDone);
  if (prev) {
    await prev.catch(() => undefined);
  }
  const newHeld = new Set<string>(
    currentlyHeld ? Array.from(currentlyHeld) : [],
  );
  newHeld.add(packageName);
  try {
    return await _heldLocks.run(newHeld, fn);
  } finally {
    resolveOurDone();
    if (_installLocks.get(packageName) === ourDone) {
      _installLocks.delete(packageName);
    }
  }
}

// ---------------------------------------------------------------------------
// GLOBAL extension-lifecycle lock. The per-package withInstallLock cannot
// serialize a dependency-tree install that extracts/stages a package and
// inserts its *dependent root* around a concurrent purge of the dependency.
// This single global queue
// serializes EVERY install/update/uninstall/purge across ALL packages, so a
// purge and any install are strictly ordered (an install either fully
// completes before purge, or waits and then resolves against the purged
// state as a normal "missing dependency" — never a half-done dependent).
// Re-entrant via ALS so nested calls (install → materialize → withInstallLock,
// purge → dbPurge) do not self-deadlock.
let _globalLifecycleChain: Promise<void> = Promise.resolve();
const _globalLifecycleHeld = new AsyncLocalStorage<boolean>();

export async function withGlobalExtensionLifecycleLock<T>(
  fn: () => Promise<T>,
): Promise<T> {
  if (_globalLifecycleHeld.getStore()) {
    return fn(); // already holding it in this async context — re-entrant
  }
  let release!: () => void;
  const ourDone = new Promise<void>((res) => {
    release = res;
  });
  const prev = _globalLifecycleChain;
  _globalLifecycleChain = ourDone;
  await prev.catch(() => undefined);
  try {
    return await _globalLifecycleHeld.run(true, fn);
  } finally {
    release();
  }
}

const PACKAGE_NAME_RE = /^@([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)$/;

export type MaterializeInput = {
  /** Path to the directory that `extractAgentPackage` populated (tempDir). */
  extractedTempDir: string;
  /** Canonical package name in the form `@vendor/slug`. Validated. */
  packageName: string;
  /** Absolute path to the agents install root (mount point). */
  agentInstallDir: string;
};

export type MaterializeResult =
  | {
      materialized: true;
      targetDir: string;
      /** Path of the prior dir renamed aside (caller must rm on commit, restore on rollback). */
      priorDirBackup: string | null;
      /** True when targetDir existed before this call. */
      wasReinstall: boolean;
    }
  | { materialized: false; reason: string };

/**
 * Materialize the tarball's runtime-relevant files into the agents mount.
 *
 * Files copied (best-effort, in this order):
 *   - cinatra/oas.json   — REQUIRED. Missing → returns `{materialized: false}`.
 *   - skills/            — optional (skill-bundle dir).
 *   - package.json       — required-ish (kept verbatim if present).
 *   - README.md          — optional.
 *
 * On any error after the .old rename step, the .old dir is restored back
 * to targetDir BEFORE the error is re-thrown — so a failed materialize
 * cannot orphan the runtime mount.
 *
 * Caller contract: on success, call `commitMaterialize(result)` after the
 * subsequent DB write succeeds (cleans up the .old dir). On DB failure,
 * call `rollbackMaterialize(result)` (restores the .old dir).
 */
export async function materializeAgentPackageToDisk(
  input: MaterializeInput,
): Promise<MaterializeResult> {
  // Path-safety gate #1: strict whitelist on the package name.
  const match = PACKAGE_NAME_RE.exec(input.packageName);
  if (!match) {
    return {
      materialized: false,
      reason: `packageName ${JSON.stringify(input.packageName)} does not match strict @vendor/slug pattern`,
    };
  }
  // The install transaction (materialize → DB → commit/rollback) is
  // serialized by the caller via acquireInstallLock(packageName). This
  // function does not take the lock internally because commit/rollback runs
  // outside the materialize call.
  const [, vendor, slug] = match;

  const agentsRoot = path.resolve(input.agentInstallDir);
  const vendorRoot = path.resolve(agentsRoot, vendor);
  const targetDir = path.resolve(vendorRoot, slug);

  // Path-safety gate #2: belt-and-suspenders containment check.
  if (
    !targetDir.startsWith(agentsRoot + path.sep) &&
    targetDir !== agentsRoot
  ) {
    return {
      materialized: false,
      reason: `target path ${targetDir} escapes agentInstallDir ${agentsRoot}`,
    };
  }

  // Tarball must contain cinatra/oas.json.
  const sourceOasPath = path.join(input.extractedTempDir, "cinatra", "oas.json");
  try {
    const st = await stat(sourceOasPath);
    if (!st.isFile()) {
      return {
        materialized: false,
        reason: `extracted tempDir cinatra/oas.json is not a regular file`,
      };
    }
  } catch {
    return {
      materialized: false,
      reason: `extracted tempDir is missing cinatra/oas.json (publishAgentPackage path?)`,
    };
  }

  await mkdir(vendorRoot, { recursive: true });

  const randSuffix = randomBytes(8).toString("hex");
  const tmpDir = path.join(vendorRoot, `.tmp-${slug}-${randSuffix}`);
  const oldDir = path.join(vendorRoot, `.old-${slug}-${randSuffix}`);

  // Step 1: stage the new contents in the tmp dir.
  await mkdir(tmpDir, { recursive: true });
  await _copyRuntimeFiles(input.extractedTempDir, tmpDir);

  // Emit the published marker INSIDE the tmp dir so it rides through the
  // atomic rename. The marker says "this dir was just published with this
  // oas.json hash"; the wayflow loader gates mounting on the marker's
  // existence + hash match. See `docker/wayflow/agent_loader.py`
  // (`_inspect_published_marker`, `_read_published_marker`) for the
  // consuming side.
  await _writePublishedMarker({
    tmpDir,
    packageName: input.packageName,
  });

  // Step 2: detect a pre-existing target dir and rename aside.
  let wasReinstall = false;
  let priorDirBackup: string | null = null;
  try {
    const targetStat = await stat(targetDir);
    if (targetStat.isDirectory()) {
      wasReinstall = true;
      await rename(targetDir, oldDir);
      priorDirBackup = oldDir;
    }
  } catch {
    // targetDir doesn't exist — fresh install. Leave priorDirBackup null.
  }

  // Step 3: promote tmp → target. On failure, restore .old → target before throwing.
  try {
    await rename(tmpDir, targetDir);
  } catch (err) {
    // Best-effort: clean up the tmp dir.
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    // Critical: restore the prior dir so we don't unmount the agent on disk.
    if (priorDirBackup !== null) {
      try {
        await rename(priorDirBackup, targetDir);
      } catch {
        // Last-ditch: if restore fails, log + continue. The .old dir is still
        // on disk for forensics; the original dir is gone, which mirrors a
        // disk-level corruption case unrelated to this code path.
        console.error(
          `[materialize] CRITICAL: failed to restore prior dir ${priorDirBackup} → ${targetDir} after rename failure:`,
          err,
        );
      }
    }
    throw err;
  }

  return {
    materialized: true,
    targetDir,
    priorDirBackup,
    wasReinstall,
  };
}

/**
 * Commit a materialize result — deletes the prior-dir backup, finalizing the
 * install. Call this AFTER the dependent DB write succeeds.
 */
export async function commitMaterialize(result: MaterializeResult): Promise<void> {
  if (!result.materialized) return;
  if (result.priorDirBackup !== null) {
    await rm(result.priorDirBackup, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

/**
 * Roll back a materialize result — restores the prior dir (if any) and deletes
 * the newly-installed target. Call this when a dependent DB write fails.
 */
export async function rollbackMaterialize(result: MaterializeResult): Promise<void> {
  if (!result.materialized) return;
  await rm(result.targetDir, { recursive: true, force: true }).catch(
    () => undefined,
  );
  if (result.priorDirBackup !== null) {
    await rename(result.priorDirBackup, result.targetDir).catch(
      () => undefined,
    );
  }
}

async function _copyRuntimeFiles(srcRoot: string, dstRoot: string): Promise<void> {
  // cinatra/oas.json is required (checked by caller). Copy the whole cinatra/
  // dir verbatim so any sidecar metadata is preserved.
  // Carry agent-source legal/notice files through the materializer. Without
  // these, the LICENSE/NOTICE files tracked at the agent's source dir disappear
  // on the first reinstall after publish — the materializer atomically replaces
  // the source dir with the materialized one, so anything not in this allowlist
  // is lost. Conservative allowlist (vs "copy every top-level file") keeps the
  // runtime install surface narrow. LICENSE/LICENSE.md/COPYING/.spdx are
  // license-detection inputs (packages/extensions/src/license-detection.ts);
  // NOTICE/NOTICE.md are preserved as standard legal-metadata accompaniment.
  const sourcesToCopy: Array<{ rel: string; recursive: boolean; required: boolean }> = [
    { rel: "cinatra", recursive: true, required: true },
    { rel: "skills", recursive: true, required: false },
    { rel: "package.json", recursive: false, required: false },
    { rel: "README.md", recursive: false, required: false },
    { rel: "LICENSE", recursive: false, required: false },
    { rel: "LICENSE.md", recursive: false, required: false },
    { rel: "COPYING", recursive: false, required: false },
    { rel: ".spdx", recursive: false, required: false },
    { rel: "NOTICE", recursive: false, required: false },
    { rel: "NOTICE.md", recursive: false, required: false },
  ];
  for (const entry of sourcesToCopy) {
    const src = path.join(srcRoot, entry.rel);
    const dst = path.join(dstRoot, entry.rel);
    try {
      await stat(src);
    } catch {
      if (entry.required) {
        throw new Error(`materialize: required path ${entry.rel} missing in tempDir`);
      }
      continue;
    }
    // Reject ANY symlink in the extracted tree before copying. Without this
    // guard, a crafted tarball can include a symlink at e.g.
    // cinatra/oas.json that resolves outside agents_root; fs.cp would follow
    // it and write to an attacker-chosen path. The walker uses lstat (NOT
    // stat) so symlinks are visible.
    await _refuseSymlinksUnder(src);
    await cp(src, dst, { recursive: entry.recursive, force: true });
  }
}

async function _refuseSymlinksUnder(p: string): Promise<void> {
  const st = await lstat(p);
  if (st.isSymbolicLink()) {
    throw new Error(`materialize: refusing to copy symlink at ${p}`);
  }
  if (!st.isDirectory()) return;
  for (const entry of await readdir(p)) {
    await _refuseSymlinksUnder(path.join(p, entry));
  }
}

// ---------------------------------------------------------------------------
// Published marker
//
// The wayflow runtime's `docker/wayflow/agent_loader.py` gates discovery on
// `<agentDir>/.cinatra-published.json`. Without a marker (or with a stale
// marker whose `oasSha256` doesn't match the current `cinatra/oas.json`),
// the loader treats the dir as a draft and skips mounting.
//
// `materializeAgentPackageToDisk` writes the marker into the temp-sibling
// dir BEFORE the rename, so the marker is atomic with the rest of the
// runtime files. Rollback / commit need no changes: removing the dir also
// removes the marker; restoring `.old` brings back its prior marker.
//
// Schema mirrors the Python side exactly. `packageVersion` cascades:
//   1. `<tmpDir>/package.json::version`
//   2. `<tmpDir>/cinatra/oas.json::metadata.cinatra.packageVersion`
//   3. literal "0.0.0-unknown"
//
// `package.json` remains optional in `_copyRuntimeFiles`;
// the cascade above ensures the marker write doesn't fail when it's
// absent.
// ---------------------------------------------------------------------------

export const PUBLISHED_MARKER_FILENAME = ".cinatra-published.json";

// ---------------------------------------------------------------------------
// Backfill markers from the TS side.
//
// The wayflow container mounts `./agents:/agents:ro` (read-only by design)
// so backfill cannot run there. Instead the Cinatra TS app — which has
// write access to `<repo>/agents/` — runs backfill at boot from
// `instrumentation.node.ts` BEFORE the wayflow container's loader scans.
// Idempotent: any agent dir that already has a marker is left untouched.
//
// Mirrors `_backfill_missing_markers` in `docker/wayflow/agent_loader.py`
// exactly so the two sides agree on the marker schema.
// ---------------------------------------------------------------------------

const PACKAGE_DIR_RE = /^[a-z0-9][a-z0-9-]*$/;
const IN_PROGRESS_MARKER_FILENAME = ".cinatra-in-progress.json";

export type BackfillResult = {
  scanned: number;
  /** Markers freshly created where no marker existed before. */
  written: number;
  /**
   * Markers REWRITTEN because the existing on-disk marker is stale
   * (oasSha256 mismatched the actual oas.json bytes, or the marker JSON was
   * malformed / missing required fields). Counted separately from `written`
   * so callers can log + decide on a wayflow reload trigger without false
   * positives on every boot.
   */
  rewritten: number;
  skipped: number;
  errors: Array<{ path: string; reason: string }>;
};

/**
 * Walk `<agentInstallDir>/<vendor>/<slug>/cinatra/oas.json` and ensure
 * each agent dir has a valid `.cinatra-published.json` marker.
 *
 * Behavior:
 * - Marker MISSING → compute sha256, write marker (counted as `written`).
 * - Marker present + matching sha256 → skip (counted as `skipped`).
 * - Marker present + stale sha256 / malformed JSON / missing required
 *   keys → REWRITE the marker with fresh hash + packageVersion
 *   (counted as `rewritten`). This auto-repairs the hash_mismatch class
 *   of failure that can occur after pulling source OAS edits.
 *
 * **In-progress draft guard:** if the slug dir carries a
 * `.cinatra-in-progress.json` marker (written by `agent_source_write`),
 * the hash mismatch is intentional — the chat-authoring path is mid-
 * draft and a future `agent_source_publish` will atomically replace
 * the slug dir. Backfill MUST skip such dirs entirely; otherwise it
 * would silently "publish" the draft by minting a fresh
 * `.cinatra-published.json` for the in-progress sha, bypassing the
 * review/publish flow.
 *
 * Strict whitelist on vendor/slug dir names (same regex as packageName
 * gate in materialize) keeps this helper from materializing files into
 * arbitrary-named directories.
 *
 * Asymmetry vs Python (`docker/wayflow/agent_loader.py:
 * _backfill_missing_markers`): the Python side stays MISSING-ONLY
 * because the wayflow container mounts `./agents:/agents:ro` and
 * cannot write. The TS backfill runs first at boot (from
 * `src/instrumentation.node.ts`), so by the time wayflow scans, any
 * stale markers have already been repaired host-side. The two sides
 * still share the marker SCHEMA verbatim.
 */
export async function backfillPublishedMarkers(
  agentInstallDir: string,
): Promise<BackfillResult> {
  const result: BackfillResult = {
    scanned: 0,
    written: 0,
    rewritten: 0,
    skipped: 0,
    errors: [],
  };
  const root = path.resolve(agentInstallDir);
  let topEntries: string[];
  try {
    topEntries = await readdir(root);
  } catch {
    return result; // agents dir absent — nothing to backfill
  }
  for (const vendorName of topEntries) {
    if (vendorName.startsWith(".") || !PACKAGE_DIR_RE.test(vendorName)) continue;
    const vendorDir = path.join(root, vendorName);
    let vendorStat;
    try {
      vendorStat = await stat(vendorDir);
    } catch {
      continue;
    }
    if (!vendorStat.isDirectory()) continue;
    let slugEntries: string[];
    try {
      slugEntries = await readdir(vendorDir);
    } catch {
      continue;
    }
    for (const slugName of slugEntries) {
      if (slugName.startsWith(".") || !PACKAGE_DIR_RE.test(slugName)) continue;
      const slugDir = path.join(vendorDir, slugName);
      const oasPath = path.join(slugDir, "cinatra", "oas.json");
      let oasStat;
      try {
        oasStat = await stat(oasPath);
        if (!oasStat.isFile()) continue;
      } catch {
        continue;
      }
      result.scanned += 1;
      // In-progress draft guard. The chat-authoring flow writes
      // `.cinatra-in-progress.json` at the slug dir and the wayflow loader
      // treats hash_mismatch as `marker_in_progress_draft` instead of an
      // error. Backfill must NOT rewrite the published marker for such
      // slugs — doing so would promote an in-progress draft to "published"
      // without going through agent_source_publish.
      const inProgressPath = path.join(slugDir, IN_PROGRESS_MARKER_FILENAME);
      try {
        const ipStat = await stat(inProgressPath);
        if (ipStat.isFile()) {
          result.skipped += 1;
          continue;
        }
      } catch {
        // in-progress marker absent — proceed
      }
      const markerPath = path.join(slugDir, PUBLISHED_MARKER_FILENAME);
      const existingMarkerCheck = await _readPublishedMarker(markerPath);
      try {
        const oasBytes = await readFile(oasPath);
        const oasSha256 = createHash("sha256").update(oasBytes).digest("hex");
        if (
          existingMarkerCheck.kind === "valid" &&
          existingMarkerCheck.marker.oasSha256 === oasSha256
        ) {
          result.skipped += 1;
          continue;
        }
        let parsedOas: Record<string, unknown>;
        try {
          parsedOas = JSON.parse(oasBytes.toString("utf-8")) as Record<
            string,
            unknown
          >;
        } catch (parseErr) {
          // Python `_backfill_missing_markers` SKIPS when oas.json fails to
          // parse (it cannot legitimately be published with malformed JSON).
          // Match that behavior here — emit an error and do NOT write a marker
          // that would falsely bless an unparseable file as "published". The
          // loader still refuses to mount it, but the marker semantics would
          // be wrong.
          //
          // Preserve the existing on-disk marker on a parse failure; do not
          // blow away the operator's record of a last-known-good publish just
          // because the current file contains a typo.
          result.errors.push({
            path: oasPath,
            reason: `oas.json parse failed — ${
              parseErr instanceof Error ? parseErr.message : String(parseErr)
            }`,
          });
          continue;
        }
        const metaCinatra = (
          (parsedOas.metadata as Record<string, unknown> | undefined)
            ?.cinatra as Record<string, unknown> | undefined
        ) ?? {};
        const oasPkgName = metaCinatra.packageName;
        const packageName =
          typeof oasPkgName === "string" && oasPkgName.startsWith("@")
            ? oasPkgName
            : `@${vendorName}/${slugName}`;
        const packageVersion = await _resolvePackageVersionForBackfill(
          slugDir,
          parsedOas,
        );
        const mtime = oasStat.mtime instanceof Date ? oasStat.mtime : new Date();
        const marker = {
          packageName,
          packageVersion,
          oasSha256,
          publishedAt: mtime.toISOString(),
        };
        await _writeMarkerAtomic(markerPath, marker);
        if (existingMarkerCheck.kind === "missing") {
          result.written += 1;
        } else {
          result.rewritten += 1;
        }
      } catch (err) {
        result.errors.push({
          path: oasPath,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return result;
}

type ReadMarkerResult =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "valid"; marker: { oasSha256: string } };

/**
 * Required keys for a marker to be considered well-formed.
 *
 * Must stay in sync with the wayflow loader's `_check_marker_for`
 * (docker/wayflow/agent_loader.py:1821) which gates the published
 * status on the same key set. A marker that carries `oasSha256` but omits
 * `packageName` / `packageVersion` / `publishedAt` would be classified
 * `valid` by the TS side (so backfill skipped it) but `malformed` by Python
 * at runtime — leaving the agent gated. Aligning both sides on the same
 * required-key set repairs that mismatch on the next boot.
 */
const REQUIRED_MARKER_KEYS = ["packageName", "packageVersion", "oasSha256", "publishedAt"] as const;

/**
 * Read + classify a `.cinatra-published.json` marker. Returns one of:
 * - `missing` — file doesn't exist (rewrite path = "written").
 * - `invalid` — file exists but doesn't parse / is wrong shape / is
 *   missing any required key from `REQUIRED_MARKER_KEYS` (rewrite path
 *   = "rewritten" — a broken marker is as good as a stale one).
 * - `valid` — file exists, parses cleanly, has all required keys with
 *   the expected string types (caller compares `oasSha256` to the
 *   actual hash to decide skip vs rewrite).
 */
async function _readPublishedMarker(markerPath: string): Promise<ReadMarkerResult> {
  let raw: string;
  try {
    raw = await readFile(markerPath, "utf-8");
  } catch {
    return { kind: "missing" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "invalid" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "invalid" };
  }
  const obj = parsed as Record<string, unknown>;
  // Every required key must be a non-empty string — mirrors
  // _check_marker_for in agent_loader.py which classifies any missing
  // key as `malformed` and refuses to mount.
  for (const key of REQUIRED_MARKER_KEYS) {
    const value = obj[key];
    if (typeof value !== "string" || value.length === 0) {
      return { kind: "invalid" };
    }
  }
  return { kind: "valid", marker: { oasSha256: obj.oasSha256 as string } };
}

/**
 * Atomic marker write: write to a same-directory temp file then `rename` into
 * place. POSIX `rename(2)` within the same filesystem is atomic, so the
 * wayflow loader (which polls the marker file from a read-only mount) never
 * observes a torn JSON read. Multiple Next.js worker threads can race this
 * without producing corrupted markers — the last `rename` wins with valid
 * content because the temp file name carries a random suffix.
 */
async function _writeMarkerAtomic(
  markerPath: string,
  marker: Record<string, unknown>,
): Promise<void> {
  const tempPath = `${markerPath}.tmp-${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(tempPath, JSON.stringify(marker, null, 2) + "\n", "utf-8");
    await rename(tempPath, markerPath);
  } catch (err) {
    // Best-effort cleanup of the temp file; the underlying error is
    // surfaced to the caller via the wrapping try/catch.
    try {
      await rm(tempPath, { force: true });
    } catch {
      // ignore
    }
    throw err;
  }
}

async function _resolvePackageVersionForBackfill(
  slugDir: string,
  parsedOas: Record<string, unknown>,
): Promise<string> {
  // Cascade 1: sibling package.json.
  try {
    const pkgRaw = await readFile(
      path.join(slugDir, "package.json"),
      "utf-8",
    );
    const pkg = JSON.parse(pkgRaw) as { version?: unknown };
    if (typeof pkg.version === "string" && pkg.version.trim().length > 0) {
      return pkg.version.trim();
    }
  } catch {
    // absent / unparseable — fall through
  }
  // Cascade 2: oas.json metadata.cinatra.packageVersion.
  const meta = (parsedOas.metadata as Record<string, unknown> | undefined)
    ?.cinatra as Record<string, unknown> | undefined;
  const v = meta?.packageVersion;
  if (typeof v === "string" && v.trim().length > 0) {
    return v.trim();
  }
  // Cascade 3: literal fallback. Matches the Python side's literal so
  // markers produced by either side agree on the "unknown" sentinel.
  return "0.0.0-backfill";
}

// Stat needs to also expose oasStat for the backfill mtime read above.
// Existing local `stat` import already covers it. No new imports needed.

// (Below: the existing _writePublishedMarker that materialize uses on every
// publish — independent from the backfill helper above.)

async function _writePublishedMarker(args: {
  tmpDir: string;
  packageName: string;
}): Promise<void> {
  const oasPath = path.join(args.tmpDir, "cinatra", "oas.json");
  const oasBytes = await readFile(oasPath);
  const oasSha256 = createHash("sha256").update(oasBytes).digest("hex");
  const packageVersion = await _resolvePackageVersionFromTmpDir(
    args.tmpDir,
    oasBytes,
  );
  const marker = {
    packageName: args.packageName,
    packageVersion,
    oasSha256,
    publishedAt: new Date().toISOString(),
  };
  const markerPath = path.join(args.tmpDir, PUBLISHED_MARKER_FILENAME);
  await writeFile(markerPath, JSON.stringify(marker, null, 2) + "\n", "utf-8");
}

async function _resolvePackageVersionFromTmpDir(
  tmpDir: string,
  oasBytes: Buffer,
): Promise<string> {
  // Cascade 1: sibling package.json.
  try {
    const pkgRaw = await readFile(path.join(tmpDir, "package.json"), "utf-8");
    const pkg = JSON.parse(pkgRaw) as { version?: unknown };
    if (typeof pkg.version === "string" && pkg.version.trim().length > 0) {
      return pkg.version.trim();
    }
  } catch {
    // package.json absent or unparseable — fall through.
  }
  // Cascade 2: oas.json metadata.cinatra.packageVersion.
  try {
    const oas = JSON.parse(oasBytes.toString("utf-8")) as Record<string, unknown>;
    const meta = (oas.metadata as Record<string, unknown> | undefined)?.cinatra as
      | Record<string, unknown>
      | undefined;
    const v = meta?.packageVersion;
    if (typeof v === "string" && v.trim().length > 0) {
      return v.trim();
    }
  } catch {
    // Unlikely — caller already parsed this earlier — but keep defensive.
  }
  // Cascade 3: fallback.
  return "0.0.0-unknown";
}
