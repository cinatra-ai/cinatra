import path from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { afterAll, describe, expect, it } from "vitest";

import {
  coverageDefects,
  readDeclaredRequiredNames,
  scanHostImportedExtensions,
} from "../required-extensions-cover-host-imports.mjs";

const tmpRoots = [];
afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

function scratchRepo(files) {
  const root = mkdtempSync(path.join(os.tmpdir(), "req-cover-"));
  tmpRoots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

describe("readDeclaredRequiredNames", () => {
  it("strips version ranges with the last-@ split (scoped names intact)", () => {
    const names = readDeclaredRequiredNames({
      cinatra: {
        requiredExtensions: ["@scope/a@^0.1.0", "@scope/b", "@scope/c@", "  ", 42],
      },
    });
    expect([...names].sort()).toEqual(["@scope/a", "@scope/b", "@scope/c"]);
  });
  it("is empty for an absent block", () => {
    expect(readDeclaredRequiredNames({}).size).toBe(0);
  });
});

describe("scanHostImportedExtensions", () => {
  it("finds static, dynamic, and require imports incl. generated files; skips tests and comments", () => {
    const root = scratchRepo({
      "src/lib/uses.ts": `import { x } from "@scope/alpha-connector";\nconst y = require("@scope/beta-connector/util");\n`,
      "src/lib/generated/map.ts": `export const m = { a: () => import("@scope/gamma-connector/setup-page") };\n`,
      "src/lib/__tests__/uses.test.ts": `import "@scope/test-only-connector";\n`,
      "src/lib/commented.ts": `// import "@scope/commented-connector";\nexport const z = 1;\n`,
      "packages/llm/src/index.ts": `import "@scope/pkgside-connector";\n`,
    });
    const extensionNames = new Set([
      "@scope/alpha-connector",
      "@scope/beta-connector",
      "@scope/gamma-connector",
      "@scope/test-only-connector",
      "@scope/commented-connector",
      "@scope/pkgside-connector",
    ]);
    const { names, byFile } = scanHostImportedExtensions(["src", "packages"], extensionNames, root);
    expect([...names].sort()).toEqual([
      "@scope/alpha-connector",
      "@scope/beta-connector",
      "@scope/gamma-connector",
      "@scope/pkgside-connector",
    ]);
    expect(byFile["src/lib/generated/map.ts"]).toEqual(["@scope/gamma-connector"]);
    expect(byFile["src/lib/__tests__/uses.test.ts"]).toBeUndefined();
    expect(byFile["src/lib/commented.ts"]).toBeUndefined();
  });

  it("ignores non-extension scoped imports", () => {
    const root = scratchRepo({
      "src/core.ts": `import "@scope/core-package";\n`,
    });
    const { names } = scanHostImportedExtensions(["src"], new Set(["@scope/some-connector"]), root);
    expect(names.size).toBe(0);
  });
});

describe("coverageDefects", () => {
  const base = {
    hostImported: new Set(["@scope/a-connector"]),
    rootDepExtensions: new Set(["@scope/b-connector"]),
    required: new Set(["@scope/a-connector", "@scope/b-connector", "@scope/system-agent"]),
    locked: new Set(["@scope/a-connector", "@scope/b-connector", "@scope/system-agent"]),
  };

  it("passes when required = lock covers imports ∪ root deps (superset allowed)", () => {
    const { defects, bootable } = coverageDefects(base);
    expect(defects).toEqual([]);
    expect([...bootable].sort()).toEqual(["@scope/a-connector", "@scope/b-connector"]);
  });

  it("fails when a host import is missing from requiredExtensions", () => {
    const { defects } = coverageDefects({
      ...base,
      required: new Set(["@scope/b-connector", "@scope/system-agent"]),
      locked: new Set(["@scope/a-connector", "@scope/b-connector", "@scope/system-agent"]),
    });
    expect(defects.some((d) => d.includes("@scope/a-connector") && d.includes("requiredExtensions"))).toBe(true);
  });

  it("fails when a host import is missing from the lock", () => {
    const { defects } = coverageDefects({
      ...base,
      locked: new Set(["@scope/b-connector", "@scope/system-agent"]),
    });
    expect(defects.some((d) => d.includes("@scope/a-connector") && d.includes("acquisition lock"))).toBe(true);
  });

  it("fails on lock ↔ requiredExtensions drift in both directions", () => {
    const { defects } = coverageDefects({
      hostImported: new Set(),
      rootDepExtensions: new Set(),
      required: new Set(["@scope/only-required"]),
      locked: new Set(["@scope/only-locked"]),
    });
    expect(defects.some((d) => d.includes("@scope/only-required") && d.includes("no acquisition-lock entry"))).toBe(true);
    expect(defects.some((d) => d.includes("@scope/only-locked") && d.includes("stale lock"))).toBe(true);
  });
});

describe("repo-live coverage (the gate's own contract against THIS tree)", () => {
  it("the committed declaration + lock cover the live host import surface", async () => {
    // Equivalent to running the gate: a regression here means a host import
    // exists that prod cannot acquire. Uses the real tree (extensions/ must
    // be cloned back — same precondition as every IoC gate in this suite).
    const { discoverExtensionNames } = await import("../core-extension-import-ban.mjs");
    const { readFileSync } = await import("node:fs");
    const repoRoot = path.resolve(__dirname, "..", "..", "..");
    const extensionNames = discoverExtensionNames();
    if (extensionNames.size === 0) return; // extensions not cloned back: the gate itself fails closed in CI
    const pkgJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    const { names: hostImported } = scanHostImportedExtensions(["src", "packages"], extensionNames, repoRoot);
    const rootDepExtensions = new Set(
      Object.keys(pkgJson.dependencies ?? {}).filter((d) => extensionNames.has(d)),
    );
    const required = readDeclaredRequiredNames(pkgJson);
    const locked = new Set(
      JSON.parse(readFileSync(path.join(repoRoot, "cinatra-required-extensions.lock.json"), "utf8")).packages.map(
        (p) => p.packageName,
      ),
    );
    const { defects } = coverageDefects({ hostImported, rootDepExtensions, required, locked });
    expect(defects).toEqual([]);
  });
});
