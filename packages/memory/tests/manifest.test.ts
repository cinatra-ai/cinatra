import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { initMemoryBundle } from "../src/bundle.ts";
import {
  buildMemoryManifest,
  serializeMemoryManifest,
} from "../src/manifest.ts";
import { addMemoryConcept } from "../src/write.ts";

const tmp = mkdtempSync(path.join(os.tmpdir(), "memory-manifest-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("content-hash manifest", () => {
  const root = path.join(tmp, ".memory");

  it("is deterministic for identical bundle content", () => {
    const config = initMemoryBundle(root);
    addMemoryConcept(root, {
      type: "Convention",
      title: "One",
      body: "First insight.",
      timestamp: null,
    });
    addMemoryConcept(root, {
      type: "Command",
      title: "Two",
      body: "Second insight.",
      timestamp: null,
    });

    const a = buildMemoryManifest(root);
    const b = buildMemoryManifest(root);
    expect(a).toEqual(b);
    expect(serializeMemoryManifest(a)).toBe(serializeMemoryManifest(b));
    expect(a.bundleId).toBe(config.bundleId);
    expect(Object.keys(a.concepts)).toEqual([
      "command/two.md",
      "convention/one.md",
    ]);
    for (const entry of Object.values(a.concepts)) {
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.bytes).toBeGreaterThan(0);
    }
  });

  it("changes exactly the touched concept's hash when a file changes", () => {
    const before = buildMemoryManifest(root);
    writeFileSync(
      path.join(root, "command/two.md"),
      "---\ntype: Command\ntitle: Two\n---\nEdited second insight.\n",
    );
    const after = buildMemoryManifest(root);
    expect(after.concepts["convention/one.md"]).toEqual(
      before.concepts["convention/one.md"],
    );
    expect(after.concepts["command/two.md"]?.sha256).not.toBe(
      before.concepts["command/two.md"]?.sha256,
    );
  });

  it("excludes index files and hard-nonconformant files from the manifest", () => {
    writeFileSync(path.join(root, "broken.md"), "no frontmatter here\n");
    const manifest = buildMemoryManifest(root);
    expect(Object.keys(manifest.concepts)).toEqual([
      "command/two.md",
      "convention/one.md",
    ]);
  });
});
