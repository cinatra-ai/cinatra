// Workspace phantom-dependency gate — unit tests for the pure helpers.
// Zero-dep (node:test) to match the gate (a .mjs gate can't import .ts deps).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  parseWorkspaceGlobs,
  resolveSpecifierToPackage,
  extractInternalImports,
  extractThirdPartyImports,
  isBuiltinPackage,
  isSyncedExtensionDir,
  diffAgainstBaseline,
  diffThirdPartyAgainstBaseline,
  baselineGrowth,
  thirdPartyBaselineGrowth,
} from "../workspace-phantom-deps.mjs";

const GATE_SCRIPT = fileURLToPath(new URL("../workspace-phantom-deps.mjs", import.meta.url));

test("parseWorkspaceGlobs extracts the packages list and stops at the next key", () => {
  const yaml = [
    "packages:",
    '  - "packages/*"',
    "  - extensions/cinatra-ai/*-connector",
    "  # a comment line is ignored",
    '  - "extensions/*/*-workflow" # trailing comment',
    "overrides:",
    '  - "should-not-appear"',
  ].join("\n");
  assert.deepEqual(parseWorkspaceGlobs(yaml), [
    "packages/*",
    "extensions/cinatra-ai/*-connector",
    "extensions/*/*-workflow",
  ]);
});

test("resolveSpecifierToPackage maps specifiers to their owning package", () => {
  assert.equal(resolveSpecifierToPackage("@cinatra-ai/llm"), "@cinatra-ai/llm");
  assert.equal(resolveSpecifierToPackage("@cinatra-ai/agents/agent-install-path"), "@cinatra-ai/agents");
  assert.equal(resolveSpecifierToPackage("lodash/merge"), "lodash");
  // relative / builtin / subpath-imports are not packages
  assert.equal(resolveSpecifierToPackage("./local"), null);
  assert.equal(resolveSpecifierToPackage("../../x"), null);
  assert.equal(resolveSpecifierToPackage("/abs"), null);
  assert.equal(resolveSpecifierToPackage("node:fs"), null);
  assert.equal(resolveSpecifierToPackage("#internal"), null);
  assert.equal(resolveSpecifierToPackage("@scope-only"), null);
});

test("extractInternalImports covers all import forms and only flags OTHER workspace members", () => {
  const internal = new Set(["@cinatra-ai/objects", "@cinatra-ai/skills", "@cinatra-ai/self"]);
  const src = `
    import { a } from "@cinatra-ai/objects";
    import type { T } from "@cinatra-ai/objects/types";
    export { b } from "@cinatra-ai/skills";
    const x = await import("@cinatra-ai/skills");
    const y = require("@cinatra-ai/self");          // self -> excluded
    import "@cinatra-ai/objects";                    // side-effect
    import external from "openai";                   // not internal -> ignored
    import rel from "./local";                       // relative -> ignored
  `;
  const got = extractInternalImports(src, internal, "@cinatra-ai/self");
  assert.deepEqual([...got].sort(), ["@cinatra-ai/objects", "@cinatra-ai/skills"]);
});

test("extractInternalImports does not flag a package's own name", () => {
  const internal = new Set(["@cinatra-ai/self"]);
  const got = extractInternalImports(`import { x } from "@cinatra-ai/self";`, internal, "@cinatra-ai/self");
  assert.equal(got.size, 0);
});

test("diffAgainstBaseline reports only NEW (pkg, dep) pairs", () => {
  const findings = {
    "@cinatra-ai/a": ["@cinatra-ai/x", "@cinatra-ai/y"], // y is new
    "@cinatra-ai/b": ["@cinatra-ai/z"],                  // entirely new package
  };
  const baseline = { phantomDeps: { "@cinatra-ai/a": ["@cinatra-ai/x"] } };
  const { newViolations } = diffAgainstBaseline(findings, baseline);
  assert.deepEqual(newViolations, {
    "@cinatra-ai/a": ["@cinatra-ai/y"],
    "@cinatra-ai/b": ["@cinatra-ai/z"],
  });
});

test("diffAgainstBaseline is clean when everything is baselined", () => {
  const findings = { "@cinatra-ai/a": ["@cinatra-ai/x"] };
  const baseline = { phantomDeps: { "@cinatra-ai/a": ["@cinatra-ai/x", "@cinatra-ai/extra"] } };
  const { newViolations } = diffAgainstBaseline(findings, baseline);
  assert.deepEqual(newViolations, {});
});

test("diffAgainstBaseline treats a missing baseline as all-new", () => {
  const findings = { "@cinatra-ai/a": ["@cinatra-ai/x"] };
  const { newViolations } = diffAgainstBaseline(findings, { phantomDeps: {} });
  assert.deepEqual(newViolations, { "@cinatra-ai/a": ["@cinatra-ai/x"] });
});

test("baselineGrowth flags pairs added to the committed baseline vs the base branch", () => {
  const base = { phantomDeps: { "@cinatra-ai/a": ["@cinatra-ai/x"] } };
  const committed = {
    phantomDeps: {
      "@cinatra-ai/a": ["@cinatra-ai/x", "@cinatra-ai/y"], // y added
      "@cinatra-ai/b": ["@cinatra-ai/z"],                  // new pkg+pair added
    },
  };
  assert.deepEqual(baselineGrowth(base, committed), ["@cinatra-ai/a :: @cinatra-ai/y", "@cinatra-ai/b :: @cinatra-ai/z"]);
});

test("baselineGrowth is empty when the committed baseline only shrinks", () => {
  const base = { phantomDeps: { "@cinatra-ai/a": ["@cinatra-ai/x", "@cinatra-ai/y"] } };
  const committed = { phantomDeps: { "@cinatra-ai/a": ["@cinatra-ai/x"] } }; // y removed (declared)
  assert.deepEqual(baselineGrowth(base, committed), []);
});

// ---------------------------------------------------------------------------
// THIRD-PARTY leg (cinatra#2480) — extractThirdPartyImports + friends
// ---------------------------------------------------------------------------

test("extractThirdPartyImports covers all import forms, resolves subpaths to the owning package", () => {
  const src = `
    import { z } from "zod";
    import Link from "next/link";
    export { helper } from "some-lib/subpath";
    const x = await import("dynamic-pkg");
    const y = require("required-pkg");
    import "server-only";                    // side-effect
  `;
  const got = extractThirdPartyImports(src, new Set(), "@cinatra-ai/self");
  assert.deepEqual([...got].sort(), [
    "dynamic-pkg", "next", "required-pkg", "server-only", "some-lib", "zod",
  ]);
});

test("extractThirdPartyImports excludes workspace-internal packages and the importer's own name", () => {
  const src = `
    import { a } from "@cinatra-ai/sdk-extensions";
    import { b } from "third-party-pkg";
    import { c } from "@cinatra-ai/self";
  `;
  const internal = new Set(["@cinatra-ai/sdk-extensions", "@cinatra-ai/self"]);
  const got = extractThirdPartyImports(src, internal, "@cinatra-ai/self");
  assert.deepEqual([...got], ["third-party-pkg"]);
});

test("extractThirdPartyImports excludes Node built-ins, bare and node:-prefixed", () => {
  const src = `
    import { readFileSync } from "node:fs";
    import path from "path";
    import assert from "node:assert/strict";
    import real from "real-pkg";
  `;
  const got = extractThirdPartyImports(src, new Set(), null);
  assert.deepEqual([...got], ["real-pkg"]);
});

test("extractThirdPartyImports excludes a WHOLE type-only import/export declaration but keeps a mixed one", () => {
  const src = `
    import type { Metadata } from "type-only-pkg";
    export type { Foo } from "type-only-reexport-pkg";
    import { type Bar, baz } from "mixed-pkg";
  `;
  const got = extractThirdPartyImports(src, new Set(), null);
  assert.deepEqual([...got], ["mixed-pkg"]);
});

test("extractThirdPartyImports does not let a plain type-ALIAS declaration swallow a later real import (regression)", () => {
  // `export type X = {...}` has no `from` clause of its own. An earlier,
  // broken version of the type-only stripper scanned unbounded for the NEXT
  // `from "..."` anywhere later in the file and deleted everything up to and
  // including it — silently hiding a real import far below an unrelated type
  // alias. Reproduces that exact shape (padded so the bug, if reintroduced,
  // would have to skip a real statement to "succeed").
  const src = `
    export type SendAsAlias = {
      email: string;
      displayName?: string;
    };

    function unrelated() {
      return 1;
    }

    import { real } from "real-after-alias-pkg";
  `;
  const got = extractThirdPartyImports(src, new Set(), null);
  assert.deepEqual([...got], ["real-after-alias-pkg"]);
});

test("extractThirdPartyImports strips comments before extracting (a commented-out import is not counted)", () => {
  const src = `
    // import { ghost } from "commented-out-pkg";
    /* import { also } from "block-commented-pkg"; */
    import { real } from "real-pkg";
  `;
  const got = extractThirdPartyImports(src, new Set(), null);
  assert.deepEqual([...got], ["real-pkg"]);
});

test("extractThirdPartyImports rejects import-shaped text inside a template-literal string (not real code)", () => {
  // Observed directly in this tree: an audit gate's own error-message
  // template literally contains `import "${h}"` as MESSAGE TEXT, not code.
  const src = 'errors.push(`bad import "${h}" found`);';
  const got = extractThirdPartyImports(src, new Set(), null);
  assert.deepEqual([...got], []);
});

test("extractThirdPartyImports rejects a URL-shaped specifier", () => {
  const src = `throw new Error("failed to fetch from \\"https://example.com/pkg\\"");`;
  const got = extractThirdPartyImports(src, new Set(), null);
  assert.deepEqual([...got], []);
});

test("isBuiltinPackage recognizes Node built-ins and rejects real packages", () => {
  assert.equal(isBuiltinPackage("fs"), true);
  assert.equal(isBuiltinPackage("path"), true);
  assert.equal(isBuiltinPackage("zod"), false);
  assert.equal(isBuiltinPackage("next"), false);
});

test("isSyncedExtensionDir is true only for a dir under the injected extensions root", () => {
  const extRoot = "/repo/extensions";
  assert.equal(isSyncedExtensionDir("/repo/extensions/cinatra-ai/drupal-mcp-connector", extRoot), true);
  assert.equal(isSyncedExtensionDir("/repo/packages/agents", extRoot), false);
  assert.equal(isSyncedExtensionDir("/repo/extensions", extRoot), false); // the root itself, not a member under it
  assert.equal(isSyncedExtensionDir("/repo/extensions-other/x", extRoot), false); // prefix collision, not a real subdir
});

test("diffThirdPartyAgainstBaseline reports only NEW (member, package) pairs, independent of the first-party section", () => {
  const findings = {
    "@cinatra-ai/drupal-mcp-connector": ["next", "zod"], // zod is new
  };
  const baseline = {
    phantomDeps: { "@cinatra-ai/drupal-mcp-connector": ["next", "zod"] }, // first-party section must not leak in
    thirdPartyPhantomDeps: { "@cinatra-ai/drupal-mcp-connector": ["next"] },
  };
  const { newViolations } = diffThirdPartyAgainstBaseline(findings, baseline);
  assert.deepEqual(newViolations, { "@cinatra-ai/drupal-mcp-connector": ["zod"] });
});

test("diffThirdPartyAgainstBaseline treats a missing baseline section as all-new", () => {
  const findings = { "@cinatra-ai/x-connector": ["left-pad"] };
  const { newViolations } = diffThirdPartyAgainstBaseline(findings, {});
  assert.deepEqual(newViolations, { "@cinatra-ai/x-connector": ["left-pad"] });
});

test("thirdPartyBaselineGrowth flags pairs added to the committed baseline vs the base branch, independent of phantomDeps", () => {
  const base = { thirdPartyPhantomDeps: { "@cinatra-ai/a-connector": ["zod"] } };
  const committed = {
    phantomDeps: { "@cinatra-ai/a-connector": ["@cinatra-ai/unrelated"] }, // first-party growth must not leak in
    thirdPartyPhantomDeps: { "@cinatra-ai/a-connector": ["zod", "next"] }, // next added
  };
  assert.deepEqual(thirdPartyBaselineGrowth(base, committed), ["@cinatra-ai/a-connector :: next"]);
});

// ---------------------------------------------------------------------------
// Integration: red-before / green-after on a real fixture tree, reproducing
// the drupal-mcp-connector#82/#83 shape — a synced-extension member with a
// production import of an undeclared third-party package. Drives the actual
// CLI (spawned with cwd = the fixture root) rather than the in-process
// helpers, so REPO_ROOT/EXTENSIONS_ROOT resolve against the fixture.
// ---------------------------------------------------------------------------

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "phantom-deps-fixture-"));
  writeFileSync(
    join(root, "pnpm-workspace.yaml"),
    ['packages:', '  - "packages/*"', '  - "extensions/*/*-connector"', ""].join("\n"),
  );
  const connectorDir = join(root, "extensions", "vendor", "fixture-connector");
  mkdirSync(join(connectorDir, "src"), { recursive: true });
  return { root, connectorDir };
}

function writeConnectorManifest(connectorDir, deps = {}) {
  writeFileSync(
    join(connectorDir, "package.json"),
    JSON.stringify({ name: "@cinatra-ai/fixture-connector", version: "0.0.0", dependencies: deps }, null, 2),
  );
}

function runGate(cwd, args = []) {
  try {
    const stdout = execFileSync("node", [GATE_SCRIPT, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, stdout };
  } catch (err) {
    return { status: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

test("integration: a synced-extension production import of an undeclared third-party package is RED, declaring it turns GREEN (the #82/#83 shape)", () => {
  const { root, connectorDir } = makeFixture();
  try {
    writeConnectorManifest(connectorDir); // no deps declared
    writeFileSync(
      join(connectorDir, "src", "index.ts"),
      `import { Client } from "@modelcontextprotocol/sdk";\nexport const client = new Client();\n`,
    );

    const red = runGate(root);
    assert.equal(red.status, 1, "expected FAIL with an undeclared third-party import and no baseline");
    assert.match(red.stderr, /@modelcontextprotocol\/sdk/);
    assert.match(red.stderr, /third-party/);

    // The fix: declare the dependency (mirrors drupal-mcp-connector#82).
    writeConnectorManifest(connectorDir, { "@modelcontextprotocol/sdk": "^1.0.0" });
    const green = runGate(root);
    assert.equal(green.status, 0, "declaring the dependency must turn the gate green");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: a grandfathered third-party finding stays green; a NEW one on top still fails (ratchet)", () => {
  const { root, connectorDir } = makeFixture();
  try {
    writeConnectorManifest(connectorDir);
    writeFileSync(join(connectorDir, "src", "index.ts"), `import { z } from "zod";\n`);

    mkdirSync(join(root, "scripts", "audit"), { recursive: true });
    writeFileSync(
      join(root, "scripts", "audit", "workspace-phantom-deps.baseline.json"),
      JSON.stringify({ phantomDeps: {}, thirdPartyPhantomDeps: { "@cinatra-ai/fixture-connector": ["zod"] } }, null, 2),
    );
    const stillTolerated = runGate(root);
    assert.equal(stillTolerated.status, 0, "a baselined third-party finding must not fail the gate");

    // Add a SECOND, un-baselined undeclared import on top.
    writeFileSync(
      join(connectorDir, "src", "index.ts"),
      `import { z } from "zod";\nimport lucide from "lucide-react";\n`,
    );
    const newOnTop = runGate(root);
    assert.equal(newOnTop.status, 1, "a new third-party phantom beyond the baseline must fail even with tolerated debt present");
    assert.match(newOnTop.stderr, /lucide-react/);
    assert.doesNotMatch(newOnTop.stderr, /- zod/); // the baselined one must not be re-reported as new
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: the third-party leg is scoped to synced extensions only — the same undeclared import under packages/* is not flagged", () => {
  const root = mkdtempSync(join(tmpdir(), "phantom-deps-fixture-"));
  try {
    writeFileSync(join(root, "pnpm-workspace.yaml"), ['packages:', '  - "packages/*"', ""].join("\n"));
    const pkgDir = join(root, "packages", "host-lib");
    mkdirSync(join(pkgDir, "src"), { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@cinatra-ai/host-lib", version: "0.0.0" }, null, 2));
    writeFileSync(join(pkgDir, "src", "index.ts"), `import { z } from "zod";\n`);

    const result = runGate(root, ["--report"]);
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /zod/, "packages/* is out of scope for the third-party leg");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: an ALLOWLISTED tool config (vitest.config.ts) is exempt, but a same-shaped file NOT on the allowlist is still scanned (codex review, cinatra#2480)", () => {
  // CONFIG_FILE_RE is an explicit allowlist of known dev-tooling basenames,
  // not a blanket `*.config.*` — a blanket match would also hide a
  // hypothetical shipped production config MODULE with a real runtime
  // import. This drives both sides of that line through the real CLI.
  const { root, connectorDir } = makeFixture();
  try {
    writeConnectorManifest(connectorDir); // no deps declared
    writeFileSync(join(connectorDir, "vitest.config.ts"), `import { defineConfig } from "vitest/config";\nexport default defineConfig({});\n`);
    writeFileSync(join(connectorDir, "stripe.config.ts"), `import Stripe from "stripe";\nexport const client = new Stripe("x");\n`);
    writeFileSync(join(connectorDir, "src", "index.ts"), `export const noop = true;\n`);

    const result = runGate(root);
    assert.equal(result.status, 1, "the non-allowlisted config file's real import must still fail the gate");
    assert.doesNotMatch(result.stderr, /vitest\/config/, "the allowlisted tool config must stay exempt");
    assert.match(result.stderr, /\bstripe\b/, "a same-shaped file NOT on the allowlist must still be scanned");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
