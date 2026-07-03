// Unit tests for the @cinatra-ai/skills package-local moveDirExdevSafe
// (cinatra#873 — a faithful mirror of the cinatra#846 agents helper; see the
// module header for why this package cannot import that one).
//
// The cross-device (EXDEV) branch is forced via the injectable `rename`/`cp`
// seam rather than a real cross-mount boundary: source and target live under
// the same tmp root (a real `rename` would succeed), so the injected `rename`
// throws EXDEV for the source→target promote and delegates to the real `rename`
// for the intra-fs staging→target swap.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cp as realCp, mkdir, mkdtemp, readdir, readFile, rename as realRename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { moveDirExdevSafe } from "../exdev-safe-move";

let root: string;

/** Build a nested source tree with a dotfile marker; returns its path. */
async function makeSourceTree(base: string): Promise<string> {
  const src = path.join(base, "src-stage");
  await mkdir(path.join(src, "skills", "nested"), { recursive: true });
  await writeFile(path.join(src, "skills", "SKILL.md"), "# skill");
  await writeFile(path.join(src, "skills", "nested", "leaf.txt"), "leaf");
  await writeFile(path.join(src, "package.json"), '{"name":"x"}');
  // Dotfile marker — must ride through the move + verify.
  await writeFile(path.join(src, ".cinatra-published.json"), '{"hash":"abc"}');
  return src;
}

async function relFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string, prefix: string): Promise<void> {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(d, e.name), rel);
      else out.push(rel);
    }
  }
  await walk(dir, "");
  return out.sort();
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Injected rename that simulates a cross-device source→target promote. */
function exdevOnSource(sourceDir: string) {
  return async (from: string, to: string): Promise<void> => {
    if (from === sourceDir) {
      const err = new Error("EXDEV: cross-device link not permitted") as NodeJS.ErrnoException;
      err.code = "EXDEV";
      throw err;
    }
    await realRename(from, to); // intra-fs staging→target swap.
  };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "skills-exdev-move-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

describe("moveDirExdevSafe (skills)", () => {
  it("fast path: a plain rename promotes without any copy fallback", async () => {
    const src = await makeSourceTree(root);
    const target = path.join(root, "target");
    let cpCalled = false;
    await moveDirExdevSafe(src, target, {
      cp: async (...args) => {
        cpCalled = true;
        await realCp(...args);
      },
    });
    expect(cpCalled).toBe(false); // no EXDEV → no copy fallback
    expect(await exists(src)).toBe(false); // source consumed by the rename
    expect(await relFiles(target)).toEqual([
      ".cinatra-published.json",
      "package.json",
      "skills/SKILL.md",
      "skills/nested/leaf.txt",
    ]);
  });

  it("EXDEV fallback: copy+fsync+verify+swap materializes the full tree (incl marker) and removes the source", async () => {
    const src = await makeSourceTree(root);
    const target = path.join(root, "target");

    await moveDirExdevSafe(src, target, { rename: exdevOnSource(src) });

    expect(await relFiles(target)).toEqual([
      ".cinatra-published.json",
      "package.json",
      "skills/SKILL.md",
      "skills/nested/leaf.txt",
    ]);
    expect(await readFile(path.join(target, ".cinatra-published.json"), "utf-8")).toBe(
      '{"hash":"abc"}',
    );
    // Source removed; no staging sibling left behind.
    expect(await exists(src)).toBe(false);
    const siblings = await readdir(root);
    expect(siblings.some((n) => n.includes("exdev-staging"))).toBe(false);
    expect(siblings).toContain("target");
  });

  it("mid-copy failure: no partial target, source intact, staging cleaned + dot-hidden", async () => {
    const src = await makeSourceTree(root);
    const target = path.join(root, "target");

    let stagingPath = "";
    await expect(
      moveDirExdevSafe(src, target, {
        rename: exdevOnSource(src),
        cp: async (_from, to) => {
          stagingPath = to;
          throw new Error("copy blew up mid-tree");
        },
      }),
    ).rejects.toThrow(/copy blew up/);

    // Staging is same-parent (intra-fs swap) AND dot-prefixed at the leaf, so a
    // crash-orphaned staging dir is invisible to non-dot slug scans.
    expect(path.dirname(stagingPath)).toBe(root);
    expect(path.basename(stagingPath).startsWith(".")).toBe(true);

    expect(await exists(target)).toBe(false); // never a partial target
    expect(await exists(src)).toBe(true); // source preserved for caller recovery
    expect(await relFiles(src)).toContain(".cinatra-published.json");
    expect((await readdir(root)).some((n) => n.includes("exdev-staging"))).toBe(false);
  });

  it("verify failure (truncated copy): rolls back — no target, source intact, staging cleaned", async () => {
    const src = await makeSourceTree(root);
    const target = path.join(root, "target");

    await expect(
      moveDirExdevSafe(src, target, {
        rename: exdevOnSource(src),
        // Copy real, then drop one file so the recursive tree-verify mismatches.
        cp: async (from, to, opts) => {
          await realCp(from, to, opts);
          await rm(path.join(to, "package.json"));
        },
      }),
    ).rejects.toThrow(/EXDEV copy verify failed/);

    expect(await exists(target)).toBe(false);
    expect(await exists(src)).toBe(true);
    expect((await readdir(root)).some((n) => n.includes("exdev-staging"))).toBe(false);
  });

  it("non-EXDEV rename error propagates unchanged, with no copy fallback", async () => {
    const src = await makeSourceTree(root);
    const target = path.join(root, "target");
    let cpCalled = false;

    await expect(
      moveDirExdevSafe(src, target, {
        rename: async () => {
          const err = new Error("ENOENT") as NodeJS.ErrnoException;
          err.code = "ENOENT";
          throw err;
        },
        cp: async (...args) => {
          cpCalled = true;
          await realCp(...args);
        },
      }),
    ).rejects.toThrow(/ENOENT/);
    expect(cpCalled).toBe(false); // non-EXDEV → no copy fallback
    expect(await exists(src)).toBe(true);
  });
});
