// One internal home for the security-critical file-safety primitives shared by
// the extension install / materialize / dynamic-import surfaces (cinatra#798).
//
// Outcome of the `openclaw/fs-safe` evaluation (codex-converged): do NOT take an
// external fs-safety dependency on the RCE-adjacent extension paths — Cinatra's
// bespoke guards already cover the threat model and carry a DB-anchored trust
// root. The only real win was DEDUPLICATION, captured here: the tar-header
// entry-type allowlist, the walk-time symlink/special-file rejection, the
// realpath-bound containment predicate, and the EXDEV-safe atomic replace-dir
// swap now live in exactly ONE module consumed by every TS surface
// (`extension-package-store.ts`, `extension-materialization-plan-executor.ts`,
// `runtime-package-loader.ts`; the sync boot materializer feeds in via
// cinatra#846). Behavior is moved VERBATIM — including the existing
// `[package-store]` error-message prefixes — so this is a pure consolidation
// with no fail-closed semantic changed.
//
// This module has NO `server-only` pragma: it imports only Node builtins and is
// consumed by both `server-only` runtime modules AND the boot-time materializer.
// It must NEVER be imported from a Client Component (only server code touches
// the extension store on disk).
//
// The CLI acquisition helper (`packages/cli/src/prod-extension-acquisition.mjs`)
// is a SEPARATE private ESM package (`@cinatra-ai/cli`) that cannot import the
// app's `@/lib/*` graph; it keeps its own parallel implementation (which is in
// fact STRICTER — it additionally rejects setuid/setgid/sticky mode bits at the
// tar header). It cross-references THIS module as the canonical spec for the
// shared invariants; the two are kept behavior-parallel by review, not by a
// build-time bridge (a cross-package bridge would need a new shared workspace
// package + build step — out of scope for a no-behavior-change dedup).

import { cp, readdir, rename, rm, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

// ---------------------------------------------------------------------------
// Tar-header entry-type allowlist
// ---------------------------------------------------------------------------

/**
 * tar entry types accepted by the HARDENED extraction filter. Everything else
 * — SymbolicLink, Link (hardlink), CharacterDevice, BlockDevice, FIFO,
 * GNUDumpDir, … — is refused AT THE HEADER, before any byte is written.
 * (A walk-time `isFile()` check passes a hardlinked entry — node-tar
 * materializes it as a hardlink to a previously extracted path — so the
 * header is the only reliable refusal point for the Link type.)
 *
 * Frozen + module-private so no importer can widen the accepted set: consumers
 * call the `isAcceptedTarEntryType` predicate, never mutate a shared `Set`.
 */
const ACCEPTED_TAR_ENTRY_TYPES: ReadonlySet<string> = new Set(["File", "Directory"]);

/**
 * True iff `entryType` (a node-tar entry `type` string) is an accepted regular
 * File or Directory header — the single source of truth for the entry-type
 * refusal on every hardened extraction path.
 */
export function isAcceptedTarEntryType(entryType: string): boolean {
  return ACCEPTED_TAR_ENTRY_TYPES.has(entryType);
}

// ---------------------------------------------------------------------------
// Realpath-bound containment
// ---------------------------------------------------------------------------

/**
 * True iff the already-`realpath`-resolved `realEntry` is contained within the
 * already-`realpath`-resolved `realRoot` — i.e. it IS the root or lives under
 * `realRoot + "/"`. Callers resolve both sides with `realpath` first (following
 * every filesystem link) and refuse the import/extraction when this returns
 * false — the defense beyond string-based path guards and the post-extract
 * symlink rejection.
 *
 * The `+ "/"` boundary is load-bearing: a sibling like `<root>-evil` must NOT
 * be treated as contained. Keep this as an exact prefix-string test — never
 * "improve" it with `path.relative` / `path.sep`, whose platform-specific
 * semantics would change the guard.
 */
export function isContainedRealpath(realEntry: string, realRoot: string): boolean {
  return realEntry === realRoot || realEntry.startsWith(realRoot + "/");
}

// ---------------------------------------------------------------------------
// fs helpers
// ---------------------------------------------------------------------------

export async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reject symlinks / hardlinked-out / special files anywhere under `dir`. tar
 * already strips `..` + absolute paths, but a bundled SYMLINK would let a
 * `file://` import (which follows links) and the content hash escape the
 * integrity-verified package dir, so we refuse any non-regular-file/non-dir.
 */
export async function assertNoUnsafeEntries(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isSymbolicLink()) {
      throw new Error(`[package-store] refusing extracted symlink "${e.name}" (escape vector)`);
    }
    if (e.isDirectory()) {
      await assertNoUnsafeEntries(path.join(dir, e.name));
    } else if (!e.isFile()) {
      throw new Error(`[package-store] refusing non-regular file "${e.name}" in extracted package`);
    }
  }
}

/**
 * Recursively compare two directory trees by their relative file-path sets (a
 * stronger post-copy verify than a top-level child count). Throws on any mismatch.
 */
export async function assertDirTreesMatch(a: string, b: string): Promise<void> {
  const collect = async (root: string): Promise<Set<string>> => {
    const out = new Set<string>();
    const walk = async (dir: string, rel: string): Promise<void> => {
      for (const ent of await readdir(dir, { withFileTypes: true })) {
        const childRel = rel ? `${rel}/${ent.name}` : ent.name;
        if (ent.isDirectory()) {
          await walk(path.join(dir, ent.name), childRel);
        } else {
          out.add(childRel);
        }
      }
    };
    await walk(root, "");
    return out;
  };
  const [aset, bset] = await Promise.all([collect(a), collect(b)]);
  if (aset.size !== bset.size) {
    throw new Error(`EXDEV copy verify failed: source has ${aset.size} files, target has ${bset.size}`);
  }
  for (const rel of aset) {
    if (!bset.has(rel)) throw new Error(`EXDEV copy verify failed: target is missing ${rel}`);
  }
}

// ---------------------------------------------------------------------------
// EXDEV-safe atomic replace-dir
// ---------------------------------------------------------------------------

/**
 * Atomically replace `targetDir` with `sourceDir` via rename. If a prior dir
 * exists, it is renamed aside first and restored on failure (mirrors the agent
 * materializer's temp-sibling-rename + rollback chain).
 *
 * cinatra#158 EXDEV FALLBACK (defense-in-depth — the primary fix stages the source
 * on the target's filesystem). If `rename(sourceDir, targetDir)` throws EXDEV (a
 * cross-filesystem move on a container+volume topology), fall back to: recursive
 * COPY into a SAME-PARENT staging dir (`${targetDir}.staging-<rand>`, guaranteed
 * intra-fs with `targetDir`), recursively VERIFY the copied tree, then an atomic
 * intra-fs `rename(staging, targetDir)`, then remove the original source. We NEVER
 * copy straight into `targetDir` (a crash mid-copy would expose a partial target);
 * the verified staging dir is swapped in atomically. The prior-backup rename
 * (`targetDir` → `${targetDir}.old`) is always same-parent → never EXDEV.
 * Mirrors `packages/skills/src/relocate-worker.ts:249`.
 */
export async function atomicReplaceDir(sourceDir: string, targetDir: string): Promise<void> {
  const suffix = randomBytes(4).toString("hex");
  let priorBackup: string | null = null;
  if (await pathExists(targetDir)) {
    priorBackup = `${targetDir}.old-${suffix}`;
    await rename(targetDir, priorBackup);
  }
  try {
    try {
      await rename(sourceDir, targetDir);
    } catch (renameErr) {
      if ((renameErr as NodeJS.ErrnoException).code !== "EXDEV") throw renameErr;
      // Cross-filesystem: copy → verify → atomic intra-fs swap → drop source.
      const staging = `${targetDir}.staging-${suffix}`;
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      try {
        await cp(sourceDir, staging, { recursive: true, preserveTimestamps: true });
        await assertDirTreesMatch(sourceDir, staging);
        await rename(staging, targetDir); // same parent → intra-fs, atomic.
      } catch (copyErr) {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
        throw copyErr;
      }
      await rm(sourceDir, { recursive: true, force: true }).catch(() => undefined);
    }
  } catch (error) {
    if (priorBackup) {
      await rename(priorBackup, targetDir).catch((restoreErr) => {
        console.error(
          `[package-store] CRITICAL: failed to restore ${priorBackup} -> ${targetDir} after rename failure:`,
          restoreErr,
        );
      });
    }
    throw error;
  }
  if (priorBackup) {
    await rm(priorBackup, { recursive: true, force: true }).catch(() => undefined);
  }
}
