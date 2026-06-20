// Config-key correctness for the dev-extension clone set (cinatra#255 Stage-1,
// workstream S1-e).
//
// The RFC prose (and some docs/.github comments) historically named the config
// key `cinatraDevExtensions`, but the code has ALWAYS read the correct
// `cinatra.devExtensions` (consistent with `cinatra.devApps`). No code rename is
// needed; this test pins that the reader keeps using the right key and that the
// real root manifest's `cinatra.devExtensions` (+ `cinatra.devApps`) resolves —
// so a future typo (`cinatraDevExtensions`) or a manifest regression is caught.
//
// Lives under `tests/` (the CLI's vitest.config.ts only globs `tests/**`), not
// `src/__tests__/`, so the package-scoped runner actually executes it.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { readDevExtensionsConfig } from "../src/cinatra-dev-extensions.mjs";
import { readDevAppsConfig } from "../src/dev-apps.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_SRC = path.join(HERE, "..", "src");
// packages/cli/ -> packages/ -> repo root.
const REPO_ROOT = path.join(HERE, "..", "..", "..");

describe("dev-extensions config key — reads cinatra.devExtensions (not cinatraDevExtensions)", () => {
  it("readDevExtensionsConfig returns the map under cinatra.devExtensions", () => {
    const pkg = {
      cinatra: {
        devExtensions: { "@cinatra-ai/foo-agent": { ref: "main" } },
      },
    };
    const cfg = readDevExtensionsConfig("/repo", () => JSON.stringify(pkg));
    expect(cfg).toEqual({ "@cinatra-ai/foo-agent": { ref: "main" } });
  });

  it("ignores a (wrong) top-level cinatraDevExtensions key", () => {
    const pkg = {
      cinatraDevExtensions: { "@cinatra-ai/wrong": {} }, // wrong shape — must be ignored.
      cinatra: { devExtensions: { "@cinatra-ai/right": {} } },
    };
    const cfg = readDevExtensionsConfig("/repo", () => JSON.stringify(pkg));
    expect(cfg).toEqual({ "@cinatra-ai/right": {} });
    expect(cfg).not.toHaveProperty("@cinatra-ai/wrong");
  });

  it("returns null when neither key is present", () => {
    const cfg = readDevExtensionsConfig("/repo", () => JSON.stringify({ cinatra: {} }));
    expect(cfg).toBe(null);
  });
});

describe("dev-extensions config key — resolves against the real root manifest", () => {
  it("cinatra.devExtensions resolves with a substantial declared set", () => {
    const cfg = readDevExtensionsConfig(REPO_ROOT);
    expect(cfg).toBeTruthy();
    expect(typeof cfg).toBe("object");
    // 81 entries at the time of writing; assert a stable floor so the test does
    // not churn every time a connector is added, while still proving the key
    // resolves to the full declared map (never empty).
    expect(Object.keys(cfg).length).toBeGreaterThanOrEqual(50);
  });

  it("cinatra.devApps resolves as the parallel companion-apps key (3 entries)", () => {
    const cfg = readDevAppsConfig(REPO_ROOT);
    expect(cfg).toBeTruthy();
    expect(Object.keys(cfg).length).toBeGreaterThanOrEqual(2);
  });

  it("no CLI source file references the camelCase `cinatraDevExtensions` token", async () => {
    const { readdirSync } = await import("node:fs");
    const mjs = readdirSync(CLI_SRC).filter((f) => f.endsWith(".mjs"));
    for (const file of mjs) {
      const src = readFileSync(path.join(CLI_SRC, file), "utf8");
      expect(src.includes("cinatraDevExtensions"), `${file} references cinatraDevExtensions`).toBe(false);
    }
  });
});
