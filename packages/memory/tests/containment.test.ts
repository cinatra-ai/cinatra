import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { initMemoryBundle, walkMemoryTree } from "../src/bundle.ts";
import {
  MemoryCapError,
  MemoryContainmentError,
  MemoryError,
} from "../src/types.ts";
import { addMemoryConcept } from "../src/write.ts";

const tmp = mkdtempSync(path.join(os.tmpdir(), "memory-containment-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function freshBundle(name: string, capsYaml = ""): string {
  const root = path.join(tmp, name, ".memory");
  mkdirSync(root, { recursive: true });
  writeFileSync(
    path.join(root, "bundle.yaml"),
    `bundleId: 11111111-2222-4333-8444-${name.padEnd(12, "0").slice(0, 12)}\n${capsYaml}`,
  );
  return root;
}

describe("write containment (fail-closed)", () => {
  const root = freshBundle("contain");

  it("rejects relative escapes from the bundle root", () => {
    expect(() =>
      addMemoryConcept(root, { type: "X", path: "../escape.md", body: "" }),
    ).toThrow(MemoryContainmentError);
    expect(() =>
      addMemoryConcept(root, { type: "X", path: "sub/../../escape.md", body: "" }),
    ).toThrow(MemoryContainmentError);
  });

  it("rejects absolute target paths", () => {
    expect(() =>
      addMemoryConcept(root, { type: "X", path: "/abs.md", body: "" }),
    ).toThrow(MemoryContainmentError);
  });

  it("rejects hidden path segments", () => {
    expect(() =>
      addMemoryConcept(root, { type: "X", path: ".hidden/x.md", body: "" }),
    ).toThrow(MemoryContainmentError);
  });

  it("refuses to write through a symlinked directory inside the bundle", () => {
    const outside = path.join(tmp, "contain", "outside-target");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, path.join(root, "linked"));
    expect(() =>
      addMemoryConcept(root, { type: "X", path: "linked/x.md", body: "" }),
    ).toThrow(MemoryContainmentError);
  });

  it("rejects reserved filenames and non-.md targets", () => {
    expect(() =>
      addMemoryConcept(root, { type: "X", path: "sub/index.md", body: "" }),
    ).toThrow(MemoryError);
    expect(() =>
      addMemoryConcept(root, { type: "X", path: "notes/plain.txt", body: "" }),
    ).toThrow(MemoryError);
  });

  it("refuses to overwrite an existing concept", () => {
    addMemoryConcept(root, { type: "X", path: "once.md", body: "first" });
    expect(() =>
      addMemoryConcept(root, { type: "X", path: "once.md", body: "second" }),
    ).toThrow(/already exists/);
  });
});

describe("read-side symlink handling", () => {
  it("never follows symlinks during the walk and diagnoses them", () => {
    const root = freshBundle("readsym");
    const outside = path.join(tmp, "readsym", "outside.md");
    writeFileSync(outside, "---\ntype: Sneaky\n---\nOutside content.\n");
    symlinkSync(outside, path.join(root, "sneaky.md"));

    const tree = walkMemoryTree(root);
    expect(tree.concepts).toEqual([]);
    expect(tree.diagnostics).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "symlink-skipped",
        path: "sneaky.md",
      }),
    ]);
  });
});

describe("caps (defaults configurable via bundle.yaml)", () => {
  it("rejects an oversize concept on the write path", () => {
    const root = freshBundle("capbytes", "caps:\n  maxConceptFileBytes: 128\n");
    expect(() =>
      addMemoryConcept(root, {
        type: "X",
        path: "big.md",
        body: "y".repeat(4096),
      }),
    ).toThrow(MemoryCapError);
  });

  it("skips an oversize on-disk file with an error diagnostic on the read path", () => {
    const root = freshBundle("capread", "caps:\n  maxConceptFileBytes: 128\n");
    writeFileSync(
      path.join(root, "huge.md"),
      `---\ntype: X\n---\n${"z".repeat(4096)}\n`,
    );
    const tree = walkMemoryTree(root, {
      caps: { maxConceptFileBytes: 128, maxConceptsPerBundle: 2000 },
    });
    expect(tree.concepts).toEqual([]);
    expect(tree.diagnostics).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "concept-file-oversize",
        path: "huge.md",
      }),
    ]);
  });

  it("enforces the per-bundle concept-count cap on write and read", () => {
    const root = freshBundle("capcount", "caps:\n  maxConceptsPerBundle: 2\n");
    addMemoryConcept(root, { type: "X", path: "a.md", body: "" });
    addMemoryConcept(root, { type: "X", path: "b.md", body: "" });
    expect(() =>
      addMemoryConcept(root, { type: "X", path: "c.md", body: "" }),
    ).toThrow(MemoryCapError);

    // Read path: a third file dropped on disk out-of-band is skipped.
    writeFileSync(path.join(root, "c.md"), "---\ntype: X\n---\n");
    const tree = walkMemoryTree(root, {
      caps: { maxConceptFileBytes: 65536, maxConceptsPerBundle: 2 },
    });
    expect(tree.concepts.length).toBe(2);
    expect(
      tree.diagnostics.filter((d) => d.code === "concept-cap-exceeded"),
    ).toEqual([
      expect.objectContaining({ severity: "error", path: "c.md" }),
    ]);
  });
});
