// Unit + integration tests for the manifest-driven build-config generator.
// Proves: (1) the committed tsconfig.json + next.config.ts regions are
// BYTE-EXACT what the manifest renders (so the --check gate is green on main),
// (2) --check FAILS on drift, and (3) the pure helpers behave.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateManifest,
  renderTsconfigPathsBody,
  renderNextArrayBody,
  replaceRegion,
  renderTsconfig,
  renderNextConfig,
  checkExitCode,
} from "../generate-build-config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const GENERATOR = join(REPO_ROOT, "scripts", "config", "generate-build-config.mjs");
const MANIFEST_PATH = join(REPO_ROOT, "config", "build-config.manifest.json");
const TSCONFIG_PATH = join(REPO_ROOT, "tsconfig.json");
const NEXT_CONFIG_PATH = join(REPO_ROOT, "next.config.ts");

function loadManifest() {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
}

describe("manifest", () => {
  it("is valid JSON and passes shape validation", () => {
    const manifest = loadManifest();
    expect(() => validateManifest(manifest)).not.toThrow();
  });

  it("has a non-trivial alias list and package arrays", () => {
    const manifest = loadManifest();
    expect(manifest.tsconfigPaths.length).toBeGreaterThan(300);
    expect(manifest.nextServerExternalPackages.some((i) => i.package)).toBe(true);
    expect(manifest.nextTranspilePackages.some((i) => i.package)).toBe(true);
  });

  it("has no duplicate aliases", () => {
    const manifest = loadManifest();
    const aliases = manifest.tsconfigPaths.map((e) => e.alias);
    expect(new Set(aliases).size).toBe(aliases.length);
  });
});

describe("generate == committed (byte-exact)", () => {
  it("renders the committed tsconfig.json identically from the manifest", () => {
    const manifest = loadManifest();
    const current = readFileSync(TSCONFIG_PATH, "utf8");
    expect(renderTsconfig(current, manifest)).toBe(current);
  });

  it("renders the committed next.config.ts identically from the manifest", () => {
    const manifest = loadManifest();
    const current = readFileSync(NEXT_CONFIG_PATH, "utf8");
    expect(renderNextConfig(current, manifest)).toBe(current);
  });

  it("--check exits 0 against the committed tree", () => {
    // Throws (non-zero exit) on drift; success = no throw.
    expect(() =>
      execFileSync("node", [GENERATOR, "--check"], { cwd: REPO_ROOT, stdio: "pipe" }),
    ).not.toThrow();
  });
});

describe("--check fails on drift", () => {
  it("detects a hand-edited tsconfig paths region and restores it", () => {
    const original = readFileSync(TSCONFIG_PATH, "utf8");
    // Introduce drift: append a stray alias inside the paths block by mangling
    // the first generated entry's whitespace (a classic hand-edit).
    const drifted = original.replace(
      '"@/*": ["./src/*"],',
      '"@/*":   ["./src/*"],',
    );
    expect(drifted).not.toBe(original);
    writeFileSync(TSCONFIG_PATH, drifted);
    try {
      let failed = false;
      try {
        execFileSync("node", [GENERATOR, "--check"], { cwd: REPO_ROOT, stdio: "pipe" });
      } catch (err) {
        failed = true;
        expect(err.status).toBe(1);
        expect(String(err.stderr)).toContain("DRIFT");
        expect(String(err.stderr)).toContain("tsconfig.json");
      }
      expect(failed).toBe(true);
    } finally {
      writeFileSync(TSCONFIG_PATH, original);
    }
  });

  it("detects a drifted next.config.ts package list and restores it", () => {
    const original = readFileSync(NEXT_CONFIG_PATH, "utf8");
    const drifted = original.replace('"openai",', '"openai",\n    "drifted-extra-pkg",');
    expect(drifted).not.toBe(original);
    writeFileSync(NEXT_CONFIG_PATH, drifted);
    try {
      let failed = false;
      try {
        execFileSync("node", [GENERATOR, "--check"], { cwd: REPO_ROOT, stdio: "pipe" });
      } catch (err) {
        failed = true;
        expect(err.status).toBe(1);
        expect(String(err.stderr)).toContain("next.config.ts");
      }
      expect(failed).toBe(true);
    } finally {
      writeFileSync(NEXT_CONFIG_PATH, original);
    }
  });
});

describe("renderTsconfigPathsBody", () => {
  it("emits one entry per line, trailing comma on all but the last", () => {
    const body = renderTsconfigPathsBody(
      [
        { alias: "@x/a", target: "./a.ts" },
        { alias: "@x/b", target: "./b.ts" },
      ],
      "  ",
    );
    expect(body).toBe('  "@x/a": ["./a.ts"],\n  "@x/b": ["./b.ts"]');
  });

  it("never puts a trailing comma after the final entry (route-graph JSON.parse safety)", () => {
    const body = renderTsconfigPathsBody([{ alias: "@x/a", target: "./a.ts" }], "  ");
    expect(body.endsWith(",")).toBe(false);
  });
});

describe("renderNextArrayBody", () => {
  it("renders comments as // lines and packages as quoted, comma-terminated lines", () => {
    const body = renderNextArrayBody(
      [{ comment: "native" }, { package: "openai" }, { package: "bullmq" }],
      "  ",
    );
    expect(body).toBe('  // native\n  "openai",\n  "bullmq",');
  });

  it("trims trailing whitespace from empty comments", () => {
    const body = renderNextArrayBody([{ comment: "" }], "  ");
    expect(body).toBe("  //");
  });
});

describe("replaceRegion", () => {
  it("replaces only the body between markers", () => {
    const content = ["before", "open {", "OLD", "}", "after"].join("\n");
    const out = replaceRegion(content, "open {", "}", "NEW");
    expect(out).toBe(["before", "open {", "NEW", "}", "after"].join("\n"));
  });

  it("throws when the open marker is missing", () => {
    expect(() => replaceRegion("a\nb", "open {", "}", "x")).toThrow(/open marker not found/);
  });

  it("throws when the close marker is missing after open", () => {
    expect(() => replaceRegion("open {\nbody", "open {", "}", "x")).toThrow(
      /close marker not found/,
    );
  });

  it("throws when the open marker is ambiguous", () => {
    expect(() => replaceRegion("open {\nx\nopen {\ny\n}", "open {", "}", "z")).toThrow(
      /ambiguous/,
    );
  });
});

describe("validateManifest", () => {
  it("rejects a non-object manifest", () => {
    expect(() => validateManifest([])).toThrow(/must be a JSON object/);
  });

  it("rejects a tsconfigPaths entry missing a target", () => {
    expect(() =>
      validateManifest({
        tsconfigPaths: [{ alias: "@x/a" }],
        nextServerExternalPackages: [],
        nextTranspilePackages: [],
      }),
    ).toThrow(/target must be a non-empty string/);
  });

  it("rejects a duplicate alias", () => {
    expect(() =>
      validateManifest({
        tsconfigPaths: [
          { alias: "@x/a", target: "./a.ts" },
          { alias: "@x/a", target: "./b.ts" },
        ],
        nextServerExternalPackages: [],
        nextTranspilePackages: [],
      }),
    ).toThrow(/duplicate alias/);
  });

  it("rejects a next array item with both comment and package", () => {
    expect(() =>
      validateManifest({
        tsconfigPaths: [],
        nextServerExternalPackages: [{ comment: "x", package: "y" }],
        nextTranspilePackages: [],
      }),
    ).toThrow(/exactly one of/);
  });

  it("rejects a duplicate package within a next array", () => {
    expect(() =>
      validateManifest({
        tsconfigPaths: [],
        nextServerExternalPackages: [{ package: "openai" }, { package: "openai" }],
        nextTranspilePackages: [],
      }),
    ).toThrow(/duplicate package/);
  });
});

describe("checkExitCode", () => {
  it("returns 1 when there is drift, 0 otherwise", () => {
    expect(checkExitCode(["tsconfig.json"])).toBe(1);
    expect(checkExitCode([])).toBe(0);
  });
});
