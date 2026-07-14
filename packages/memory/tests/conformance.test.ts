import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { loadMemoryBundle } from "../src/bundle.ts";
import { checkMemoryTree } from "../src/check.ts";
import type { MemoryDiagnostic } from "../src/types.ts";

const BUNDLE = path.join(
  fileURLToPath(new URL("./fixtures", import.meta.url)),
  "conformance-bundle",
);

function byCode(diagnostics: MemoryDiagnostic[], code: string): MemoryDiagnostic[] {
  return diagnostics.filter((d) => d.code === code);
}

describe("conformance-policy loading of a partially nonconformant bundle", () => {
  const bundle = loadMemoryBundle(BUNDLE);

  it("loads the bundle identity from bundle.yaml", () => {
    expect(bundle.config.bundleId).toBe("6f9c2c5a-1c1e-4b6a-9a3f-0d5e8b7a4c21");
    expect(bundle.config.name).toBe("conformance fixture bundle");
  });

  it("loads every conformant concept and skips the hard-nonconformant files", () => {
    expect(bundle.concepts.map((c) => c.path)).toEqual([
      "links.md",
      "ok.md",
      "sub/other.md",
    ]);
  });

  it("emits structured error diagnostics for each skipped file", () => {
    const missingType = byCode(bundle.diagnostics, "type-missing");
    expect(missingType.map((d) => d.path)).toEqual(["missing-type.md"]);
    const badYaml = byCode(bundle.diagnostics, "frontmatter-unparseable");
    expect(badYaml.map((d) => d.path)).toEqual(["bad-yaml.md"]);
    const noFm = byCode(bundle.diagnostics, "frontmatter-missing");
    expect(noFm.map((d) => d.path)).toEqual(["no-frontmatter.md"]);
    for (const d of [...missingType, ...badYaml, ...noFm]) {
      expect(d.severity).toBe("error");
    }
  });

  it("skips reserved log.md silently and never treats index.md as a concept", () => {
    const paths = bundle.concepts.map((c) => c.path);
    expect(paths).not.toContain("log.md");
    expect(paths).not.toContain("index.md");
    expect(paths).not.toContain("sub/index.md");
    expect(bundle.diagnostics.map((d) => d.path)).not.toContain("log.md");
  });

  it("reads okf_version from the root index frontmatter and flags extra keys", () => {
    expect(bundle.okfVersion).toBe("0.1");
    const invalid = byCode(bundle.diagnostics, "index-frontmatter-invalid");
    expect(invalid.map((d) => d.path).sort()).toEqual(["index.md", "sub/index.md"]);
    for (const d of invalid) expect(d.severity).toBe("warning");
  });

  it("preserves unknown frontmatter keys on loaded concepts", () => {
    const ok = bundle.concepts.find((c) => c.path === "ok.md");
    expect(ok?.frontmatter["custom_key"]).toEqual({ nested: "value" });
    expect(ok?.tags).toEqual(["fixture", "convention"]);
  });
});

describe("root index frontmatter edge cases", () => {
  it("warns when the root index frontmatter is not a mapping", async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const os = await import("node:os");
    const { walkMemoryTree } = await import("../src/bundle.ts");
    const dir = mkdtempSync(path.join(os.tmpdir(), "memory-indexfm-"));
    try {
      writeFileSync(
        path.join(dir, "index.md"),
        "---\n- not\n- a-mapping\n---\n\n# Concepts\n",
      );
      const tree = walkMemoryTree(dir);
      expect(tree.okfVersion).toBeUndefined();
      expect(tree.diagnostics).toEqual([
        expect.objectContaining({
          severity: "warning",
          code: "index-frontmatter-invalid",
          path: "index.md",
        }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("checkMemoryTree link diagnostics", () => {
  const result = checkMemoryTree(BUNDLE);

  it("tolerates broken links as warnings, never errors", () => {
    const broken = byCode(result.diagnostics, "broken-link");
    expect(broken.length).toBeGreaterThan(0);
    for (const d of broken) expect(d.severity).toBe("warning");
  });

  it("flags the dangling absolute link, the dangling relative link, and the escaping link", () => {
    const broken = byCode(result.diagnostics, "broken-link");
    const flagged = broken.map((d) => `${d.path} -> ${d.message}`).join("\n");
    expect(flagged).toContain("/missing/thing.md");
    expect(flagged).toContain("./nope.md");
    expect(flagged).toContain("../outside.md");
    // Valid internal links and external links produce no diagnostics.
    expect(flagged).not.toContain("/sub/other.md");
    expect(flagged).not.toContain("example.com");
  });

  it("reports the bundle nonconformant because error diagnostics exist", () => {
    expect(result.conformant).toBe(false);
  });
});
