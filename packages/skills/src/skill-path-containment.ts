// Pure realpath/symlink containment primitives for the skills store (#300).
//
// Extracted verbatim (behavior-identical) from skills-store.ts to keep that file
// under the file-size ratchet. These depend only on node `path`/`fs` (no
// skills-store imports), so there is no import cycle. The root-aware assert
// wrappers (`assertSkillFilePathInsideRoot` / `assertSkillDirectoryInsideRoot`,
// which need the configured store/legacy roots) stay in skills-store.ts and
// call into these.

import { existsSync, lstatSync, realpathSync } from "fs";
import path from "path";

function realpathNearestExisting(target: string): string {
  let current = path.resolve(target);
  for (;;) {
    if (existsSync(current)) {
      return realpathSync.native(current);
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
}

/**
 * Realpath-containment re-assertion (#300). After the lexical resolve+prefix
 * check confirms `resolved` is lexically inside one of the allowed roots, this
 * canonicalizes the root and the target (via the nearest existing ancestor for
 * not-yet-created leaves) and re-checks containment on the REAL paths. A
 * symlinked ancestor under a root passes the lexical check but resolves OUT of
 * it — this layer rejects that. Behavior is identical for legitimate
 * non-symlink and not-yet-created paths (realpath is a no-op on those).
 */
export function isRealpathContained(resolved: string, root: string): boolean {
  const realRoot = realpathNearestExisting(root);
  const realTarget = realpathNearestExisting(resolved);
  return realTarget === realRoot || realTarget.startsWith(realRoot + path.sep);
}

/**
 * File-LEAF realpath confinement (the next layer beyond #300's directory
 * containment). `assertSkillDirectoryInsideRoot` confines a scan/repository
 * BASE directory, but a confined directory can still hold a FILE that is a
 * symlink to outside — e.g. `<repositoryPath>/README.md -> /outside/secret`, or
 * a discovered `<skillDir>/SKILL.md` symlinked out — and a `readFileSync` would
 * follow it. Before reading any content file rooted on an already-confined base
 * dir, assert the file's REAL path stays inside the REAL base dir. A
 * non-existent file is already skipped by its own `existsSync` gate, so this
 * only confines existing leaves (and realpath is a no-op on non-symlink files,
 * keeping behavior identical for legitimate layouts). Returns `false` on a
 * symlink escape so the caller skips the read instead of exfiltrating an
 * arbitrary local file.
 */
export function isFileLeafContainedInDir(baseDir: string, filePath: string): boolean {
  return isRealpathContained(path.resolve(filePath), path.resolve(baseDir));
}

/**
 * Dangling-write-leaf confinement (#300). The directory + leaf realpath checks
 * above use `existsSync`, which FOLLOWS symlinks: a leaf that is a DANGLING
 * symlink (the symlink file pre-exists but its target does NOT) makes
 * `existsSync` return false, so the realpath checks treat it as an absent /
 * not-yet-created leaf and pass — then `writeFile` follows the dangling symlink
 * and CREATES the file at the OUTSIDE target. `lstatSync` does NOT follow the
 * symlink, so it catches the dangling case. Call this immediately before any
 * write whose leaf was only confined via `existsSync`/nearest-ancestor realpath.
 * ENOENT (no leaf at all) → genuinely new file, proceed. A regular file →
 * proceed (the dir is already realpath-confined and overwriting a regular file
 * stays inside). A symlink (dangling or live) → throw, refusing to write
 * through it. Behavior is identical for legitimate new-file and regular-file
 * writes (lstat is a no-op decision on those).
 */
export function assertLeafNotSymlink(leafPath: string): void {
  let stats;
  try {
    stats = lstatSync(leafPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return; // genuinely new file — safe to create
    }
    throw err;
  }
  if (stats.isSymbolicLink()) {
    throw new Error(
      `Skill write path leaf is a symlink; refusing to write through it: ${leafPath}`,
    );
  }
}
