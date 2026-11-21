// Unit tests for replaceFileInSameDir (cinatra#4264 A1b): the one rename that
// replaces a file with a temp sibling in the same directory. A directory lies
// on one filesystem, so this rename cannot throw EXDEV; the helper refuses any
// pair that is not two files in one directory, so it cannot be used to promote
// a file across directories.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { replaceFileInSameDir } from "../exdev-safe-move";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "replace-file-same-dir-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

// Before the fix the helper does not exist, so every case fails at its call:
// red-first-expect: replaceFileInSameDir) is not a function
describe("replaceFileInSameDir", () => {
  it("replaces the target with the temp sibling whole, and the temp name is gone", async () => {
    const target = path.join(root, "oas.json");
    const temp = path.join(root, ".oas.json.1234.tmp");
    await writeFile(target, "old");
    await writeFile(temp, "new");
    await replaceFileInSameDir(temp, target);
    expect(await readFile(target, "utf8")).toBe("new");
    expect((await readdir(root)).sort()).toEqual(["oas.json"]);
  });

  it("refuses a temp file in another directory and renames nothing", async () => {
    const target = path.join(root, "oas.json");
    await mkdir(path.join(root, "other"));
    const temp = path.join(root, "other", ".oas.json.tmp");
    await writeFile(target, "old");
    await writeFile(temp, "new");
    const calls: Array<[string, string]> = [];
    await expect(
      replaceFileInSameDir(temp, target, {
        rename: async (from, to) => {
          calls.push([from, to]);
        },
      }),
    ).rejects.toThrow(/not two files in one directory/);
    expect(calls).toEqual([]);
    expect(await readFile(target, "utf8")).toBe("old");
    expect(await readFile(temp, "utf8")).toBe("new");
  });

  it("refuses a pair that names the same file", async () => {
    const target = path.join(root, "oas.json");
    await writeFile(target, "old");
    await expect(replaceFileInSameDir(path.join(root, ".", "oas.json"), target)).rejects.toThrow(
      /not two files in one directory/,
    );
    expect(await readFile(target, "utf8")).toBe("old");
  });

  it("passes a failed rename through unchanged (the caller removes its temp file)", async () => {
    const target = path.join(root, "oas.json");
    const temp = path.join(root, ".oas.json.tmp");
    const eio = Object.assign(new Error("EIO: i/o error, rename"), { code: "EIO" });
    await expect(
      replaceFileInSameDir(temp, target, {
        rename: async () => {
          throw eio;
        },
      }),
    ).rejects.toBe(eio);
  });
});
