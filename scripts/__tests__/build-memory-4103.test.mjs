// cinatra#4103 - the production build's peak memory.
//
// Two settings keep the build lean. next.config.ts switches the server source maps off whenever the
// error-report upload that reads them is not set up (the maps were about 2 GB beside about 590 MB of
// server code), and sixteen run-time path calls carry the bundler's ignore hint. In the fixture readings only the
// process.cwd()-first hint forms take the trace from 38 to 1; the other retained forms do not stop it. Both settings are
// read straight from the real files, so a later edit that drops either one fails here.

import { afterEach, describe, expect, it, vi } from "vitest";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
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

// The call each of the sixteen places makes, in the order they stand in the file, keyed by file.
const SITES = {
  "packages/agents/src/ensure-agent-package.ts": ["join"],
  "packages/agents/src/materialize-agent-package.ts": ["path.join", "path.join"],
  "packages/agents/src/mcp/agent-source-paths.ts": ["join"],
  "packages/agents/src/mcp/handlers.ts": ["join"],
  "packages/extensions/src/license-detection.ts": ["join"],
  "packages/llm/src/tools/skills.ts": ["path.join"],
  "packages/skills/src/skills-store.ts": ["path.join", "path.join"],
  "src/lib/artifacts/artifact-data-root.ts": ["path.resolve"],
  "src/lib/artifacts/run-data-root.ts": ["path.resolve"],
  "src/lib/dev-fixture-seeder.ts": ["path.join"],
  "src/lib/extension-data-root.ts": ["path.join", "path.join"],
  "src/lib/required-extension-materialize.ts": ["path.join", "path.join"],
};

const HINT = "/* turbopackIgnore: true */";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("@sentry/nextjs");
  vi.resetModules();
});

const UPLOAD_VARS = ["SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT"];

// Runs the real next.config.ts for the production build phase with the given upload variables set and returns what it handed to withSentryConfig.
// Only withSentryConfig is replaced: a spy that returns its first argument tagged, so the wrapped case is visible.
async function loadConfig(set) {
  for (const name of UPLOAD_VARS) vi.stubEnv(name, set.includes(name) ? `value-of-${name}` : "");
  vi.resetModules();
  const withSentryConfig = vi.fn((config) => ({ ...config, wrappedBySentry: true }));
  vi.doMock("@sentry/nextjs", () => ({ withSentryConfig }));
  const mod = await import("../../next.config");
  // The default export is Next's config function of the phase (cinatra#4546); this test reads the production build's.
  return { withSentryConfig, config: mod.default(PHASE_PRODUCTION_BUILD) };
}

// A configured upload reads the maps, so the row with all three variables keeps the config and the options as they were at the base.
function expectConfigured({ withSentryConfig, config }) {
  expect(withSentryConfig).toHaveBeenCalledTimes(1);
  const [passed, options] = withSentryConfig.mock.calls[0];
  expect(passed.experimental.serverSourceMaps).not.toBe(false);
  expect(Object.keys(options).sort()).toEqual(
    ["authToken", "disableLogger", "org", "project", "silent", "sourcemaps", "tunnelRoute", "widenClientFileUpload"],
  );
  expect(options).toEqual({
    org: "value-of-SENTRY_ORG",
    project: "value-of-SENTRY_PROJECT",
    authToken: "value-of-SENTRY_AUTH_TOKEN",
    silent: !process.env.CI,
    widenClientFileUpload: true,
    tunnelRoute: "/monitoring",
    disableLogger: true,
    sourcemaps: { deleteSourcemapsAfterUpload: true },
  });
  expect(config.wrappedBySentry).toBe(true);
}

// The default config used to write about 2 GB of map files beside the server code on every build, which is what raised the build's peak memory.
function expectNotReady({ withSentryConfig, config }) {
  expect(withSentryConfig).toHaveBeenCalledTimes(0);
  expect(config.wrappedBySentry).toBeUndefined();
  expect(config.experimental.serverSourceMaps).toBe(false);
  // The switch adds to the experimental settings; it must not drop the ones the block already had.
  expect(config.experimental.reactDebugChannel).toBe(false);
}

describe("server source maps by upload variables (cinatra#4103)", () => {
  it("all three upload variables set: withSentryConfig runs once with the base options and the maps are not forced off", async () => {
    expectConfigured(await loadConfig(["SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT"]));
  });
  it("SENTRY_AUTH_TOKEN missing alone: no upload wrapper, maps off", async () => {
    expectNotReady(await loadConfig(["SENTRY_ORG", "SENTRY_PROJECT"]));
  });
  it("SENTRY_ORG missing alone: no upload wrapper, maps off", async () => {
    expectNotReady(await loadConfig(["SENTRY_AUTH_TOKEN", "SENTRY_PROJECT"]));
  });
  it("SENTRY_PROJECT missing alone: no upload wrapper, maps off", async () => {
    expectNotReady(await loadConfig(["SENTRY_AUTH_TOKEN", "SENTRY_ORG"]));
  });
  it("only SENTRY_AUTH_TOKEN set: no upload wrapper, maps off", async () => {
    expectNotReady(await loadConfig(["SENTRY_AUTH_TOKEN"]));
  });
  it("only SENTRY_ORG set: no upload wrapper, maps off", async () => {
    expectNotReady(await loadConfig(["SENTRY_ORG"]));
  });
  it("only SENTRY_PROJECT set: no upload wrapper, maps off", async () => {
    expectNotReady(await loadConfig(["SENTRY_PROJECT"]));
  });
  it("none of the upload variables set: no upload wrapper, maps off", async () => {
    expectNotReady(await loadConfig([]));
  });
});

describe("bundler ignore hint on run-time path calls (cinatra#4103)", () => {
  // The second memory trace named twenty calls, and sixteen keep the hint; each builds a folder path at run time. In the fixture readings only the process.cwd()-first hint forms take the trace from 38 to 1; the other retained forms do not stop it. This test counts the hint only.
  it("counts the hint on exactly the 16 path calls the build trace named (a count only: it does not prove the bundler stops tracing)", () => {
    const callBefore = /([A-Za-z_$][\w$.]*)\(\/\* turbopackIgnore: true \*\/ (?=[^)\s])/g;
    let total = 0;
    for (const [file, callees] of Object.entries(SITES)) {
      const code = codeLines(read(file));
      const found = [...code.matchAll(callBefore)].map((m) => m[1]);
      expect(found, file).toEqual(callees);
      expect(code.split(HINT).length - 1, file).toBe(callees.length);
      total += found.length;
    }
    expect(total).toBe(16);
  });

  // Measured on a fixture build of the pinned Next 16.2.10: the hint stops the trace where the first operand is
  // the working directory, but it does not where the operand list holds a literal "." - that path stays relative to the working directory whatever the hint.
  // A hint there would claim a benefit no build shows, so the call carries none.
  it("leaves the one path call whose operand list holds a literal \".\" without a hint (the fixture build shows the hint does not stop that trace)", () => {
    const code = codeLines(read("src/lib/extension-package-store.ts"));
    expect(code).not.toContain(HINT);
    expect(code).toContain('path.join(baseRel || ".", rel)');
  });

  // Three calls take a pack's manifest sourceDir against the working directory and then open that pack's files at
  // run time: the dashboard template reader (package.json and its declared cinatra/dashboard.json), the extension tool
  // module loader (package.json) and the install road's in-tree read (package.json). The runtime image copies the
  // standalone output but not extensions/ (Dockerfile, the runtime stage). A hint on these calls could leave those files
  // out of the standalone trace, so each keeps the form main has, with no hint. Limits: this reads the source only. It
  // runs no build, and it does not prove which files the standalone trace carries.
  const PACK_READS = {
    "src/lib/dashboards/read-pack-dashboard-template.ts": "path.resolve(process.cwd(), sourceDir)",
    "src/lib/extension-tool-module-loader.ts": "path.resolve(process.cwd(), sourceDir)",
    "packages/agents/src/install-from-package.ts": "resolve(process.cwd(), image.sourceDir)",
  };
  for (const [file, call] of Object.entries(PACK_READS)) {
    it(`keeps the pack path call of ${file} without a hint (it opens pack files at run time)`, () => {
      const code = codeLines(read(file));
      expect(code).not.toContain(HINT);
      expect(code).toContain(call);
    });
  }
});
