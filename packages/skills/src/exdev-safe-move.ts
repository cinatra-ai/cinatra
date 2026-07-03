import { randomBytes } from "node:crypto";
import { cp, open, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// EXDEV-safe directory move — @cinatra-ai/skills package-local copy (cinatra#873)
// ---------------------------------------------------------------------------
//
// Promoting a staged directory to its final on-disk location with a plain
// `rename` throws EXDEV when the source and destination are on DIFFERENT mounted
// filesystems (e.g. an `os.tmpdir()` extract dir → the persistent `data/skills`
// mount). That crash-loops the skill install/boot path — the SAME failure class
// as cinatra#846 (required-extension materialize) and cinatra#158
// (extension-package-store publish). This is the defense-in-depth CODE fix so a
// mis-mounted or differently-provisioned instance never crash-loops on it.
//
// DELIBERATE DUPLICATE (cinatra#798): this is a faithful package-local mirror of
// `packages/agents/src/exdev-safe-move.ts` `moveDirExdevSafe`. This package
// CANNOT import that helper — `@cinatra-ai/agents` already depends on
// `@cinatra-ai/skills`, so `skills → agents` would be a workspace dependency
// CYCLE — nor the app's `src/lib/fs-safety.ts` `atomicReplaceDir` (packages must
// not depend on the host app's `src/lib`). The stronger form is copied here
// verbatim rather than the weaker inline copy that also lives in this package's
// `relocate-worker.ts` (top-level child-count verify, copies straight into the
// target). Folding all of these into ONE shared leaf module is the remaining
// cinatra#798 cross-package consolidation; kept cross-linked so the copies don't
// silently drift. The `scripts/audit/exdev-rename-gate.mjs` ratchet (cinatra#874)
// pins this module as a sanctioned raw-rename site and fails any NEW bare rename
// on the install/materialize surfaces that does not route through a helper here.

/** Injectable IO seam — production omits it; tests force the EXDEV / failure
 * branches without a real cross-mount boundary. */
export type MoveDirExdevSafeDeps = {
  rename?: (from: string, to: string) => Promise<void>;
  cp?: (
    from: string,
    to: string,
    opts: { recursive: boolean; preserveTimestamps: boolean },
  ) => Promise<void>;
};

/**
 * Move `sourceDir` onto `targetDir`, EXDEV-safe.
 *
 * Fast path: a plain intra-filesystem `rename`. On a cross-device boundary
 * (`EXDEV`) fall back to copy → fsync → verify → atomic intra-fs swap → unlink
 * source:
 *
 *   1. Recursively COPY `sourceDir` into a SAME-PARENT, dot-prefixed staging
 *      sibling of `targetDir` (`<dir>/.exdev-staging-<base>-<rand>`), intra-fs
 *      with `targetDir`. We NEVER copy straight into `targetDir` — a crash
 *      mid-copy would expose a partial/torn target.
 *   2. fsync the copied files + directories (children before parents) so a
 *      power loss after we acknowledge success can't leave unflushed data.
 *      Best-effort: fsync is a durability enhancement, never a NEW failure mode.
 *   3. VERIFY the copied tree matches the source (recursive file-set, stronger
 *      than a top-level child count) — a truncated copy throws here, before any
 *      swap.
 *   4. Atomically `rename(staging, targetDir)` (same parent → intra-fs, atomic).
 *   5. fsync the target's parent directory (best-effort) and remove the
 *      original cross-fs `sourceDir`.
 *
 * `targetDir` MUST NOT already exist — callers that re-install remove any prior
 * dir first (verdaccio install `rmSync`s it; the relocation worker refuses a
 * pre-existing target). On ANY failure before the swap, the staging dir is
 * removed and `sourceDir` is left intact, so the caller can recover; a non-EXDEV
 * rename error propagates unchanged (no copy fallback).
 */
export async function moveDirExdevSafe(
  sourceDir: string,
  targetDir: string,
  deps: MoveDirExdevSafeDeps = {},
): Promise<void> {
  const doRename = deps.rename ?? rename;
  const doCp = deps.cp ?? cp;

  try {
    await doRename(sourceDir, targetDir);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    // Fall through to the cross-filesystem copy fallback.
  }

  // Same PARENT as targetDir (so the swap `rename` is intra-fs) AND dot-prefixed
  // at the leaf so a crash-orphaned staging dir is INVISIBLE to consumers that
  // scan for installed dirs and skip dotfiles. Matches the transient-dir
  // convention of the other move paths in this package.
  const staging = path.join(
    path.dirname(targetDir),
    `.exdev-staging-${path.basename(targetDir)}-${randomBytes(6).toString("hex")}`,
  );
  // Defensive: clear any stale staging sibling from a previous crashed attempt.
  await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  try {
    await doCp(sourceDir, staging, { recursive: true, preserveTimestamps: true });
    await fsyncTreeBestEffort(staging);
    await assertDirTreesMatch(sourceDir, staging);
    await doRename(staging, targetDir); // same parent → intra-fs, atomic.
  } catch (copyErr) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw copyErr;
  }
  // Target is durably swapped in. Flush its parent dir entry (best-effort) then
  // drop the original cross-fs source.
  await fsyncPathBestEffort(path.dirname(targetDir));
  await rm(sourceDir, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Recursively fsync every regular file and directory under `dir` (children
 * before their parent), then `dir` itself. Best-effort — see the durability
 * note above.
 */
async function fsyncTreeBestEffort(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await fsyncTreeBestEffort(full);
    } else if (entry.isFile()) {
      await fsyncPathBestEffort(full);
    }
    // Symlinks/special files: cp copies them; fsync of the link itself is out
    // of scope — the atomic staging swap still gives a consistent tree.
  }
  await fsyncPathBestEffort(dir);
}

async function fsyncPathBestEffort(p: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(p, "r");
    await handle.sync();
  } catch {
    // Filesystem/platform can't fsync this path (e.g. directory fsync
    // unsupported) — the atomic staging swap is the actual torn-tree guarantee;
    // durability here is a best-effort bonus.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Assert `a` and `b` contain the SAME set of relative file paths (dotfiles
 * included — e.g. a published marker). Recursive; stronger than a top-level
 * child count, which would miss a truncated subtree.
 */
async function assertDirTreesMatch(a: string, b: string): Promise<void> {
  const aFiles = await collectRelativeFiles(a);
  const bFiles = await collectRelativeFiles(b);
  if (aFiles.size !== bFiles.size) {
    throw new Error(
      `EXDEV copy verify failed: source has ${aFiles.size} files, target has ${bFiles.size}`,
    );
  }
  for (const rel of aFiles) {
    if (!bFiles.has(rel)) {
      throw new Error(`EXDEV copy verify failed: target is missing ${rel}`);
    }
  }
}

async function collectRelativeFiles(root: string): Promise<Set<string>> {
  const out = new Set<string>();
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), rel);
      } else {
        out.add(rel);
      }
    }
  }
  await walk(root, "");
  return out;
}
