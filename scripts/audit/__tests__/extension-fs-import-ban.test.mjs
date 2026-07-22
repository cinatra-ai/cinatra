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
  staleBaselineEntries,
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
    const hits = { "@acme/example-connector": ["src/needs-fs.ts"] };
    const allowlist = new Set(["@acme/example-connector::src/needs-fs.ts"]);
    expect(violationsOf(hits, allowlist)).toEqual([]);
  });

  it("the SAME extension's OTHER file still violates (edge-scoped, not whole-extension)", () => {
    const hits = {
      "@acme/example-connector": ["src/needs-fs.ts", "src/index.ts"],
    };
    const allowlist = new Set(["@acme/example-connector::src/needs-fs.ts"]);
    expect(violationsOf(hits, allowlist)).toEqual(["@acme/example-connector::src/index.ts"]);
  });

  it("a stale allowlist entry (the hit is gone) is flagged, forcing shrink-only carve-outs", () => {
    const hits = {};
    const allowlist = new Set(["@acme/example-connector::src/needs-fs.ts"]);
    expect(staleAllowlistEntries(hits, allowlist)).toEqual([
      "@acme/example-connector::src/needs-fs.ts",
    ]);
  });

  it("the real FS_IMPORT_ALLOWLIST is empty — its one documented residual (openai-skills.ts, cinatra#979) was retired when openai-connector 0.1.9 dropped it (cinatra#1715)", () => {
    expect(FS_IMPORT_ALLOWLIST.size).toBe(0);
  });
});

// NO-NEW-ROT RATCHET (temporary, shrink-only): a hit tolerated by the
// committed BASELINE (migration debt already fixed upstream, pending a
// lock-pin bump) never violates; a hit OUTSIDE both the baseline and the
// permanent allowlist still fails immediately — the acceptance-criterion
// "a seeded fs-logger fails CI" case.
describe("violationsOf with a baseline (temporary migration-debt ratchet)", () => {
  it("a baselined hit never violates", () => {
    const hits = { "@cinatra-ai/gemini-connector": ["src/index.ts"] };
    const baseline = new Set(["@cinatra-ai/gemini-connector::src/index.ts"]);
    expect(violationsOf(hits, new Set(), baseline)).toEqual([]);
  });

  it("a NEW hit outside both the baseline and the allowlist still fails (seeded-logger acceptance case)", () => {
    const hits = {
      "@cinatra-ai/gemini-connector": ["src/index.ts"],
      "@acme/seeded-connector": ["src/index.ts"],
    };
    const baseline = new Set(["@cinatra-ai/gemini-connector::src/index.ts"]);
    expect(violationsOf(hits, new Set(), baseline)).toEqual(["@acme/seeded-connector::src/index.ts"]);
  });

  it("staleBaselineEntries reports (does not fail on) migrated-away debt", () => {
    const hits = {};
    const baseline = new Set(["@cinatra-ai/gemini-connector::src/index.ts"]);
    expect(staleBaselineEntries(hits, baseline)).toEqual(["@cinatra-ai/gemini-connector::src/index.ts"]);
  });

  it("the real committed baseline covers exactly the cinatra#981-migrated connectors' pre-migration logging files (incl. the anthropic provider log-writing relocated into the connector by cinatra#1715), and stays disjoint from the (now-empty) permanent allowlist", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const baselinePath = join(__dirname, "..", "extension-fs-import-ban.baseline.json");
    const doc = JSON.parse(readFileSync(baselinePath, "utf8"));
    const keys = new Set();
    for (const [ext, files] of Object.entries(doc.hits ?? {})) {
      for (const f of files) keys.add(`${ext}::${f}`);
    }
    for (const allowlisted of FS_IMPORT_ALLOWLIST) {
      expect(keys.has(allowlisted)).toBe(false);
    }
    expect(keys).toEqual(
      new Set([
        "@cinatra-ai/anthropic-connector::src/telemetry.ts",
        "@cinatra-ai/gemini-connector::src/index.ts",
        "@cinatra-ai/gemini-connector::src/log-retention.ts",
        "@cinatra-ai/openai-connector::src/index.ts",
        "@cinatra-ai/openai-connector::src/log-retention.ts",
        "@cinatra-ai/apollo-connector::src/index.ts",
        "@cinatra-ai/apollo-connector::src/log-retention.ts",
      ]),
    );
  });
});
