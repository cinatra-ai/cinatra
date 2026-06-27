// Build a PRIVATE, fully-populated copy of the on-disk `extensions/` tree in a
// throwaway temp dir, so a test can write a scratch fixture into it WITHOUT
// mutating the shared committed `extensions/` tree.
//
// Why this exists (cinatra#380): the import-ban gate's "live gate subprocess
// fixtures" prove the gate detects a real `@/` (or cross-extension / sdkOnly)
// edge by writing a scratch source file into a connector's `src/` and running
// `node scripts/audit/extension-import-ban.mjs` (which scans the tree via
// `buildInventory()`). Writing that fixture into the SHARED tree raced the
// `inventory.test.mjs` scan (a different vitest worker scanning the SAME tree in
// the wholesale `pnpm test:root` run): when the scan landed inside the write
// window it observed the transient `@/` edge and false-failed
// `distinctHostInternalImports` against its pinned-empty expectation.
//
// The fix isolates the WRITER instead of serializing readers and writers: the
// fixture goes into a per-test clone, and the gate subprocess is pointed at it
// via `CINATRA_INVENTORY_EXT_ROOT` (honored by scripts/extensions/inventory.mjs).
// The shared tree is never touched, so no concurrent reader can ever see the
// fixture and no cross-file lock is needed.
//
// The clone is cheap and disk-light: every regular file is HARDLINKED to the
// original (instant, near-zero space) and directories are recreated as REAL
// dirs, so the inventory scanner walks it identically to the real tree
// (`readdirSync(..., { withFileTypes: true })` reports hardlinks as regular
// files and the real dirs as directories — a symlinked dir would be skipped by
// the scanner's `entry.isDirectory()` walk, hence hardlinks, not symlinks). The
// clone preserves the exact connector COUNT, so the gate's fail-closed
// `assertExtensionsPresent` floor still holds.

import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  linkSync,
  copyFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const REAL_EXT_ROOT = join(REPO_ROOT, "extensions");

// Recursively recreate `srcDir` under `destDir`: real directories, with each
// regular file HARDLINKED to the original (instant, near-zero disk). `.git` /
// `node_modules` are skipped (the inventory scanner skips them too, so cloning
// them would be wasted work). If the temp dir lands on a different filesystem
// than the checkout, `link()` raises EXDEV — fall back to a plain copy so the
// clone still works in any CI layout (a corrupt linked clone is never produced).
function cloneTree(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const src = join(srcDir, entry.name);
    const dest = join(destDir, entry.name);
    if (entry.isDirectory()) {
      cloneTree(src, dest);
    } else if (entry.isFile()) {
      try {
        linkSync(src, dest);
      } catch (err) {
        if (err && err.code === "EXDEV") copyFileSync(src, dest);
        else throw err;
      }
    }
    // symlinks / sockets / etc. are not part of the scanned source surface — skip.
  }
}

/**
 * Create an isolated, fully-populated clone of `extensions/` in a temp dir.
 * Returns `{ extRoot, writeFixture, cleanup }`:
 *   - `extRoot`      absolute path to the cloned tree (pass as CINATRA_INVENTORY_EXT_ROOT)
 *   - `writeFixture(relPath, contents)` write a test fixture INTO the clone safely:
 *       it `rm`s the destination first so a write can never mutate a hardlinked
 *       original's inode (defense-in-depth — fixtures use unique names anyway).
 *       `relPath` is resolved relative to `extRoot` (e.g. "cinatra-ai/x/src/f.ts").
 *   - `cleanup()`    removes the temp dir (call in a `finally`)
 */
export function makeIsolatedExtensionsTree() {
  const tmpBase = mkdtempSync(join(tmpdir(), "cinatra-ext-fixture-"));
  const extRoot = join(tmpBase, "extensions");
  cloneTree(REAL_EXT_ROOT, extRoot);
  return {
    extRoot,
    writeFixture(relPath, contents) {
      const dest = join(extRoot, relPath);
      mkdirSync(dirname(dest), { recursive: true });
      // Break any existing hardlink before writing so we mutate the CLONE's own
      // file, never the shared original's inode.
      rmSync(dest, { force: true });
      writeFileSync(dest, contents);
      return dest;
    },
    cleanup() {
      rmSync(tmpBase, { recursive: true, force: true });
    },
  };
}

export { REAL_EXT_ROOT };
