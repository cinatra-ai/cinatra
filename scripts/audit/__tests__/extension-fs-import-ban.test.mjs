import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  isBannedFsSpecifier,
  scanFsImportsInText,
  scanExtensionsForFsImports,
  violationsOf,
  staleAllowlistEntries,
  FS_IMPORT_ALLOWLIST,
} from "../extension-fs-import-ban.mjs";

describe("isBannedFsSpecifier", () => {
  it("matches node:fs and node:fs/promises", () => {
    expect(isBannedFsSpecifier("node:fs")).toBe(true);
    expect(isBannedFsSpecifier("node:fs/promises")).toBe(true);
  });
  it("matches the bare (non-prefixed) fs specifiers too", () => {
    expect(isBannedFsSpecifier("fs")).toBe(true);
    expect(isBannedFsSpecifier("fs/promises")).toBe(true);
  });
  it("does NOT match an unrelated or fs-like third-party specifier", () => {
    expect(isBannedFsSpecifier("fs-extra")).toBe(false);
    expect(isBannedFsSpecifier("node:path")).toBe(false);
    expect(isBannedFsSpecifier("@cinatra-ai/sdk-extensions")).toBe(false);
  });
});

describe("scanFsImportsInText", () => {
  it("catches from/bare-import/require/dynamic-import forms", () => {
    const text = [
      'import { readFile } from "node:fs/promises";',
      'import "fs";',
      'const x = require("node:fs");',
      'const y = await import("fs/promises");',
    ].join("\n");
    expect(scanFsImportsInText(text)).toEqual(new Set(["node:fs/promises", "fs", "node:fs", "fs/promises"]));
  });

  it("strips comments before scanning (a prose mention is not a real import)", () => {
    const text = '// this package must NOT import "node:fs" directly\nimport path from "node:path";';
    expect(scanFsImportsInText(text).size).toBe(0);
  });
});

describe("scanExtensionsForFsImports (fixture tree)", () => {
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "fs-import-ban-fixture-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("a seeded direct-fs logger in extension source is detected (the acceptance-criterion case)", async () => {
    const extDir = path.join(dir, "acme", "seeded-connector");
    await mkdir(path.join(extDir, "src"), { recursive: true });
    await writeFile(
      path.join(extDir, "package.json"),
      JSON.stringify({ name: "@acme/seeded-connector" }),
      "utf8",
    );
    await writeFile(
      path.join(extDir, "src", "index.ts"),
      'import { writeFile } from "node:fs/promises";\nexport async function log() { await writeFile("x", "y"); }\n',
      "utf8",
    );
    const hits = scanExtensionsForFsImports([{ name: "@acme/seeded-connector", dir: extDir }]);
    expect(hits).toEqual({ "@acme/seeded-connector": ["src/index.ts"] });
    expect(violationsOf(hits, new Set())).toEqual(["@acme/seeded-connector::src/index.ts"]);
  });

  it("excludes extension-kind-gate.mjs, top-level scripts/, and test files", async () => {
    const extDir = path.join(dir, "acme", "clean-connector");
    await mkdir(path.join(extDir, "src", "__tests__"), { recursive: true });
    await mkdir(path.join(extDir, "scripts"), { recursive: true });
    await writeFile(path.join(extDir, "package.json"), JSON.stringify({ name: "@acme/clean-connector" }), "utf8");
    await writeFile(
      path.join(extDir, "extension-kind-gate.mjs"),
      'import { readFileSync } from "node:fs";\n',
      "utf8",
    );
    await writeFile(path.join(extDir, "scripts", "seed.mjs"), 'import { readFileSync } from "node:fs";\n', "utf8");
    await writeFile(
      path.join(extDir, "src", "__tests__", "fixture.test.ts"),
      'import { mkdtemp } from "node:fs/promises";\n',
      "utf8",
    );
    await writeFile(path.join(extDir, "src", "index.ts"), 'import path from "node:path";\n', "utf8");
    const hits = scanExtensionsForFsImports([{ name: "@acme/clean-connector", dir: extDir }]);
    expect(hits).toEqual({});
  });

  it("keys by the on-disk dir when package.json has no name", async () => {
    const extDir = path.join(dir, "acme", "unnamed");
    await mkdir(path.join(extDir, "src"), { recursive: true });
    await writeFile(path.join(extDir, "package.json"), "{}", "utf8");
    await writeFile(path.join(extDir, "src", "index.ts"), 'import "node:fs";\n', "utf8");
    const hits = scanExtensionsForFsImports([{ name: null, dir: extDir }]);
    const keys = Object.keys(hits);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain("unnamed");
    expect(hits[keys[0]]).toEqual(["src/index.ts"]);
  });
});

describe("violationsOf / staleAllowlistEntries (self-policing carve-out)", () => {
  it("an allowlisted (extension, file) hit never violates", () => {
    const hits = { "@cinatra-ai/openai-connector": ["src/openai-skills.ts"] };
    expect(violationsOf(hits)).toEqual([]);
  });

  it("the SAME extension's OTHER file still violates (edge-scoped, not whole-extension)", () => {
    const hits = {
      "@cinatra-ai/openai-connector": ["src/openai-skills.ts", "src/index.ts"],
    };
    expect(violationsOf(hits)).toEqual(["@cinatra-ai/openai-connector::src/index.ts"]);
  });

  it("a stale allowlist entry (the hit is gone) is flagged, forcing shrink-only carve-outs", () => {
    const hits = {};
    expect(staleAllowlistEntries(hits)).toEqual([...FS_IMPORT_ALLOWLIST].sort());
  });

  it("the real FS_IMPORT_ALLOWLIST is not empty (documents the one known residual, cinatra#979)", () => {
    expect(FS_IMPORT_ALLOWLIST.size).toBeGreaterThan(0);
  });
});
