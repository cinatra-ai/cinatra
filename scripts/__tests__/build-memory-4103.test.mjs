// cinatra#4103 - the production build's peak memory.
//
// Two settings keep the build lean. next.config.ts switches the server source maps off whenever the
// error-report upload that reads them is not set up (the maps were about 2 GB beside about 590 MB of
// server code), and twenty run-time path calls carry the bundler's ignore hint so the bundler does not
// trace the whole project from them. Both are read straight from the real files, so a later edit that
// drops either one fails here.

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function read(rel) {
  return readFileSync(path.join(repoRoot, rel), "utf8");
}

// The lines that are code: a comment line may quote the setting without setting it.
function codeLines(text) {
  return text
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

// The call each of the twenty places makes, in the order they stand in the file, keyed by file.
const SITES = {
  "packages/agents/src/ensure-agent-package.ts": ["join"],
  "packages/agents/src/install-from-package.ts": ["resolve"],
  "packages/agents/src/materialize-agent-package.ts": ["path.join", "path.join"],
  "packages/agents/src/mcp/agent-source-paths.ts": ["join"],
  "packages/agents/src/mcp/handlers.ts": ["join"],
  "packages/extensions/src/license-detection.ts": ["join"],
  "packages/llm/src/tools/skills.ts": ["path.join"],
  "packages/skills/src/skills-store.ts": ["path.join", "path.join"],
  "src/lib/artifacts/artifact-data-root.ts": ["path.resolve"],
  "src/lib/artifacts/run-data-root.ts": ["path.resolve"],
  "src/lib/dashboards/read-pack-dashboard-template.ts": ["path.resolve"],
  "src/lib/dev-fixture-seeder.ts": ["path.join"],
  "src/lib/extension-data-root.ts": ["path.join", "path.join"],
  "src/lib/extension-package-store.ts": ["path.join"],
  "src/lib/extension-tool-module-loader.ts": ["path.resolve"],
  "src/lib/required-extension-materialize.ts": ["path.join", "path.join"],
};

const HINT = "/* turbopackIgnore: true */";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("server source maps (cinatra#4103)", () => {
  // The default config used to write about 2 GB of map files beside the server code on every build, which is what raised the build's peak memory.
  it("builds without server source maps while the error-report upload variables are empty", async () => {
    vi.stubEnv("SENTRY_AUTH_TOKEN", "");
    vi.stubEnv("SENTRY_ORG", "");
    vi.stubEnv("SENTRY_PROJECT", "");
    vi.resetModules();
    const mod = await import("../../next.config");
    const config = mod.default;
    expect(config.experimental.serverSourceMaps).toBe(false);
    // The switch adds to the experimental settings; it must not drop the ones the block already had.
    expect(config.experimental.reactDebugChannel).toBe(false);
  });

  // A configured upload reads the maps, so the setting may be written only on the branch where the upload is off.
  it("sets the switch only inside the not-ready branch, so a configured upload keeps the config as it was", () => {
    const code = codeLines(read("next.config.ts"));
    expect(code).toMatch(
      /if \(!SENTRY_BUILD_READY\) \{\s*nextConfig\.experimental = \{\s*\.\.\.nextConfig\.experimental,\s*serverSourceMaps: false,\s*\};\s*\}/,
    );
    expect(code.match(/serverSourceMaps/g)).toHaveLength(1);
  });

  // The flag is defined below the config literal, so the switch has to stand after it and still ahead of the default export that hands the config on.
  it("sets the switch after SENTRY_BUILD_READY is defined and before the default export", () => {
    const code = codeLines(read("next.config.ts"));
    const defined = code.indexOf("const SENTRY_BUILD_READY");
    const switched = code.indexOf("serverSourceMaps");
    const exported = code.indexOf("export default");
    expect(defined).toBeGreaterThan(-1);
    expect(switched).toBeGreaterThan(defined);
    expect(exported).toBeGreaterThan(switched);
  });

  // The upload path itself is not part of this change; it still deletes the maps once they are uploaded.
  it("keeps the upload path as it was: the maps are deleted after upload", () => {
    const code = codeLines(read("next.config.ts"));
    expect(code).toContain("sourcemaps: { deleteSourcemapsAfterUpload: true }");
    expect(code).toMatch(/\? withSentryConfig\(nextConfig,/);
  });
});

describe("bundler ignore hint on run-time path calls (cinatra#4103)", () => {
  // The second memory trace named these twenty calls; each builds a folder path at run time, and the hint stops the bundler from scanning the whole project from it.
  it("marks exactly the 20 path calls the build trace named, and no other call in those files", () => {
    const callBefore = /([A-Za-z_$][\w$.]*)\(\/\* turbopackIgnore: true \*\/ (?=[^)\s])/g;
    let total = 0;
    for (const [file, callees] of Object.entries(SITES)) {
      const code = codeLines(read(file));
      const found = [...code.matchAll(callBefore)].map((m) => m[1]);
      expect(found, file).toEqual(callees);
      expect(code.split(HINT).length - 1, file).toBe(callees.length);
      total += found.length;
    }
    expect(total).toBe(20);
  });
});
