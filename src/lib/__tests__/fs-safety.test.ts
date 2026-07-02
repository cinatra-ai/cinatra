// Unit tests for the consolidated file-safety primitives (cinatra#798).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

// Wrap node:fs/promises so a single test can force the EXDEV branch of
// `atomicReplaceDir` while every other fs call (incl. the copy-fallback's own
// staging rename) delegates to the real implementation.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

import { rename as mockedRename } from "node:fs/promises";
import {
  assertDirTreesMatch,
  assertNoUnsafeEntries,
  atomicReplaceDir,
  isAcceptedTarEntryType,
  isContainedRealpath,
  pathExists,
} from "@/lib/fs-safety";

let realRename: typeof import("node:fs/promises").rename;
let tmp: string;

beforeEach(async () => {
  realRename = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).rename;
  (mockedRename as unknown as ReturnType<typeof vi.fn>).mockImplementation(realRename);
  tmp = mkdtempSync(path.join(os.tmpdir(), "fs-safety-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  (mockedRename as unknown as ReturnType<typeof vi.fn>).mockImplementation(realRename);
  rmSync(tmp, { recursive: true, force: true });
});

describe("isAcceptedTarEntryType", () => {
  it("accepts only plain File and Directory headers", () => {
    expect(isAcceptedTarEntryType("File")).toBe(true);
    expect(isAcceptedTarEntryType("Directory")).toBe(true);
  });

  it("rejects every symlink / hardlink / device / FIFO / unknown header type", () => {
    for (const t of ["SymbolicLink", "Link", "CharacterDevice", "BlockDevice", "FIFO", "GNUDumpDir", "", "file"]) {
      expect(isAcceptedTarEntryType(t)).toBe(false);
    }
  });
});

describe("isContainedRealpath", () => {
  it("treats the root itself and any descendant as contained", () => {
    expect(isContainedRealpath("/a/store", "/a/store")).toBe(true);
    expect(isContainedRealpath("/a/store/pkg/register.mjs", "/a/store")).toBe(true);
  });

  it("rejects a prefix-sibling that is NOT under root + '/'", () => {
    // The `+ "/"` boundary is load-bearing: `/a/store-evil` shares the string
    // prefix `/a/store` but must NOT be treated as contained.
    expect(isContainedRealpath("/a/store-evil", "/a/store")).toBe(false);
    expect(isContainedRealpath("/a/store-evil/x", "/a/store")).toBe(false);
    expect(isContainedRealpath("/b/other", "/a/store")).toBe(false);
  });
});

describe("pathExists", () => {
  it("reports presence/absence without throwing", async () => {
    const f = path.join(tmp, "f.txt");
    expect(await pathExists(f)).toBe(false);
    writeFileSync(f, "x");
    expect(await pathExists(f)).toBe(true);
  });
});

describe("assertNoUnsafeEntries", () => {
  it("passes for a tree of only regular files and directories", async () => {
    const root = path.join(tmp, "clean");
    mkdirSync(path.join(root, "sub"), { recursive: true });
    writeFileSync(path.join(root, "a.txt"), "a");
    writeFileSync(path.join(root, "sub", "b.txt"), "b");
    await expect(assertNoUnsafeEntries(root)).resolves.toBeUndefined();
  });

  it("throws on a bundled symlink (escape vector), even nested", async () => {
    const root = path.join(tmp, "withlink");
    mkdirSync(path.join(root, "sub"), { recursive: true });
    writeFileSync(path.join(root, "sub", "real.txt"), "r");
    symlinkSync(path.join(root, "sub", "real.txt"), path.join(root, "sub", "link.txt"));
    await expect(assertNoUnsafeEntries(root)).rejects.toThrow(/refusing extracted symlink/);
  });

  it("throws on a non-regular file (FIFO)", async () => {
    const root = path.join(tmp, "withfifo");
    mkdirSync(root, { recursive: true });
    const fifo = path.join(root, "pipe");
    try {
      execFileSync("mkfifo", [fifo]);
    } catch {
      return; // mkfifo unavailable on this platform — skip (symlink case covers the primary vector)
    }
    await expect(assertNoUnsafeEntries(root)).rejects.toThrow(/refusing non-regular file/);
  });
});

describe("assertDirTreesMatch", () => {
  it("resolves for identical trees and throws on a missing file", async () => {
    const a = path.join(tmp, "a");
    const b = path.join(tmp, "b");
    for (const root of [a, b]) {
      mkdirSync(path.join(root, "d"), { recursive: true });
      writeFileSync(path.join(root, "d", "f.txt"), "same");
    }
    await expect(assertDirTreesMatch(a, b)).resolves.toBeUndefined();
    writeFileSync(path.join(a, "extra.txt"), "x");
    await expect(assertDirTreesMatch(a, b)).rejects.toThrow(/EXDEV copy verify failed/);
  });
});

describe("atomicReplaceDir", () => {
  const seedSource = (dir: string) => {
    mkdirSync(path.join(dir, "cinatra"), { recursive: true });
    writeFileSync(path.join(dir, "cinatra", "oas.json"), '{"ok":true}');
    writeFileSync(path.join(dir, "package.json"), '{"name":"x"}');
  };

  it("renames the source into place (happy path) and consumes the source", async () => {
    const src = path.join(tmp, "src");
    const dst = path.join(tmp, "dst");
    seedSource(src);
    await atomicReplaceDir(src, dst);
    expect(existsSync(path.join(dst, "cinatra", "oas.json"))).toBe(true);
    expect(existsSync(src)).toBe(false);
  });

  it("replaces a pre-existing target and cleans up the prior backup", async () => {
    const src = path.join(tmp, "src2");
    const dst = path.join(tmp, "dst2");
    seedSource(src);
    mkdirSync(dst, { recursive: true });
    writeFileSync(path.join(dst, "stale.txt"), "old");
    await atomicReplaceDir(src, dst);
    expect(existsSync(path.join(dst, "package.json"))).toBe(true);
    expect(existsSync(path.join(dst, "stale.txt"))).toBe(false);
    // No `.old-*` / `.staging-*` siblings left behind.
    const siblings = existsSync(tmp)
      ? (await import("node:fs")).readdirSync(tmp)
      : [];
    expect(siblings.some((n) => n.startsWith("dst2."))).toBe(false);
  });

  it("falls back to copy+verify+swap when rename throws EXDEV, dropping the source", async () => {
    const src = path.join(tmp, "src3");
    const dst = path.join(tmp, "dst3");
    seedSource(src);
    (mockedRename as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (oldPath: string, newPath: string) => {
        // Force EXDEV only on the direct source->target move; let the
        // copy-fallback's staging->target rename (and any backup rename) succeed.
        if (oldPath === src && newPath === dst) {
          const err = new Error("EXDEV: cross-device link not permitted") as NodeJS.ErrnoException;
          err.code = "EXDEV";
          throw err;
        }
        return realRename(oldPath, newPath);
      },
    );
    await atomicReplaceDir(src, dst);
    expect(existsSync(path.join(dst, "cinatra", "oas.json"))).toBe(true);
    expect(existsSync(path.join(dst, "package.json"))).toBe(true);
    // Source dropped after the copy-fallback swap.
    expect(existsSync(src)).toBe(false);
    // No staging sibling survives.
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(tmp).some((n) => n.startsWith("dst3.staging-"))).toBe(false);
  });
});
