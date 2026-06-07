import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOCKFILE_VERSION,
  lockfileFromTree,
  readLockfile,
  stableStringifyLockfile,
  writeLockfile,
  type LockfileShape,
} from "../src/lockfile/lockfile";
import type { DependencyTree, ResolvedNode } from "../src/types";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `cinatra-lockfile-test-${randomUUID()}`);
  await fs.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function sampleLockfile(): LockfileShape {
  return {
    lockfileVersion: LOCKFILE_VERSION,
    root: { packageName: "@cinatra/root", packageVersion: "1.2.3" },
    packages: {
      "@cinatra/root": {
        version: "1.2.3",
        resolved: "https://reg.test/root.tgz",
        integrity: "sha512-root",
        dependencies: { "@cinatra/dep": "^1.0.0" },
      },
      "@cinatra/dep": {
        version: "1.0.5",
        resolved: "https://reg.test/dep.tgz",
        integrity: "sha512-dep",
      },
    },
  };
}

describe("readLockfile", () => {
  it("returns null when the file does not exist", async () => {
    const result = await readLockfile(path.join(tmpDir, "nope.json"));
    expect(result).toBeNull();
  });

  it("returns null and warns when the file is malformed JSON", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const file = path.join(tmpDir, "broken.json");
    await fs.writeFile(file, "{ not valid json", "utf8");
    const result = await readLockfile(file);
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("returns null and warns when the JSON fails schema validation", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const file = path.join(tmpDir, "wrong-shape.json");
    await fs.writeFile(file, JSON.stringify({ lockfileVersion: 99 }), "utf8");
    const result = await readLockfile(file);
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});

describe("writeLockfile / round-trip", () => {
  it("emits 2-space indent + trailing newline + sorted keys", async () => {
    const file = path.join(tmpDir, "lock.json");
    await writeLockfile(file, sampleLockfile());
    const raw = await fs.readFile(file, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain('  "lockfileVersion"');
    // keys at root level should be alphabetical: lockfileVersion, packages, root
    const rootKeysOrder = raw.match(/^  "(\w+)":/gm)?.map((m) => m.slice(3, -2)) ?? [];
    expect(rootKeysOrder).toEqual(["lockfileVersion", "packages", "root"]);
  });

  it("write -> read -> write produces byte-identical output", async () => {
    const file1 = path.join(tmpDir, "a.json");
    const file2 = path.join(tmpDir, "b.json");
    await writeLockfile(file1, sampleLockfile());
    const reread = await readLockfile(file1);
    expect(reread).not.toBeNull();
    await writeLockfile(file2, reread!);
    const buf1 = await fs.readFile(file1);
    const buf2 = await fs.readFile(file2);
    expect(buf1.equals(buf2)).toBe(true);
  });

  it("differs only by key order — emission is byte-identical", () => {
    const a: LockfileShape = sampleLockfile();
    const reordered: LockfileShape = {
      packages: a.packages,
      root: a.root,
      lockfileVersion: a.lockfileVersion,
    } as LockfileShape;
    expect(stableStringifyLockfile(a)).toBe(stableStringifyLockfile(reordered));
  });
});

describe("lockfileFromTree", () => {
  it("preserves integrity, tarball, version, and dependencies map", () => {
    const tree: DependencyTree = {
      root: {
        packageName: "@cinatra/root",
        resolvedVersion: "1.0.0",
        tarballUrl: "https://reg.test/root.tgz",
        integrity: "sha512-root",
        requestedRange: "^1.0.0",
        dependencies: { "@cinatra/dep": "^1.0.0" },
      },
      all: new Map<string, ResolvedNode>([
        [
          "@cinatra/root",
          {
            packageName: "@cinatra/root",
            resolvedVersion: "1.0.0",
            tarballUrl: "https://reg.test/root.tgz",
            integrity: "sha512-root",
            requestedRange: "^1.0.0",
            dependencies: { "@cinatra/dep": "^1.0.0" },
          },
        ],
        [
          "@cinatra/dep",
          {
            packageName: "@cinatra/dep",
            resolvedVersion: "1.5.0",
            tarballUrl: "https://reg.test/dep.tgz",
            integrity: "sha512-dep",
            requestedRange: "^1.0.0",
            dependencies: {},
          },
        ],
      ]),
    };
    const lock = lockfileFromTree(tree);
    expect(lock.root).toEqual({ packageName: "@cinatra/root", packageVersion: "1.0.0" });
    expect(lock.packages["@cinatra/root"].dependencies).toEqual({ "@cinatra/dep": "^1.0.0" });
    expect(lock.packages["@cinatra/dep"].integrity).toBe("sha512-dep");
    // Empty deps map is omitted, not emitted as {}
    expect(lock.packages["@cinatra/dep"].dependencies).toBeUndefined();
  });
});
