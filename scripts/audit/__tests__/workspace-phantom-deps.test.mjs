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
  isClassBootstrap,
  classGrowth,
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
// Class-aware growth guard (cinatra#2521): the PR that INTRODUCES a baseline
// class writes all of its grandfathered entries at once; that one-time write is
// a class BOOTSTRAP, not baseline growth. Everything after it still fails.
// ---------------------------------------------------------------------------

test("isClassBootstrap is true only when the class key is entirely ABSENT from the base baseline", () => {
  const withClass = { phantomDeps: {}, thirdPartyPhantomDeps: { "@cinatra-ai/a-connector": ["zod"] } };
  assert.equal(isClassBootstrap({ phantomDeps: {} }, "thirdPartyPhantomDeps"), true);
  assert.equal(isClassBootstrap(withClass, "thirdPartyPhantomDeps"), false);
  // present-but-EMPTY is NOT absent: the class exists on the base branch.
  assert.equal(isClassBootstrap({ phantomDeps: {}, thirdPartyPhantomDeps: {} }, "thirdPartyPhantomDeps"), false);
  // fail-closed on a missing / non-object base baseline (normal growth path).
  assert.equal(isClassBootstrap(null, "thirdPartyPhantomDeps"), false);
  assert.equal(isClassBootstrap(undefined, "thirdPartyPhantomDeps"), false);
  assert.equal(isClassBootstrap([], "thirdPartyPhantomDeps"), false);
});

test("the bootstrap carve-out is an explicit allowlist — the first-party class is NEVER bootstrap-eligible (codex review, cinatra#2521)", () => {
  // An absent first-party section is not a legitimate bootstrap (phantomDeps
  // has existed since the gate landed) — it must keep reporting every
  // committed pair as growth, byte-identically to the pre-carve-out gate.
  assert.equal(isClassBootstrap({ note: "…" }, "phantomDeps"), false);
  assert.equal(isClassBootstrap({}, "phantomDeps"), false);
  assert.equal(isClassBootstrap({}, "someFutureClass"), false); // not on the allowlist either
  const committed = { phantomDeps: { "@cinatra-ai/a": ["@cinatra-ai/x", "@cinatra-ai/y"] } };
  assert.deepEqual(classGrowth({ note: "…" }, committed, "phantomDeps"), {
    grew: ["@cinatra-ai/a :: @cinatra-ai/x", "@cinatra-ai/a :: @cinatra-ai/y"],
    bootstrap: null,
  });
  assert.deepEqual(baselineGrowth({}, committed), ["@cinatra-ai/a :: @cinatra-ai/x", "@cinatra-ai/a :: @cinatra-ai/y"]);
  // …and a null / array base baseline stays fail-closed for BOTH classes.
  assert.deepEqual(baselineGrowth(null, committed), ["@cinatra-ai/a :: @cinatra-ai/x", "@cinatra-ai/a :: @cinatra-ai/y"]);
  const tp = { thirdPartyPhantomDeps: { "@cinatra-ai/a-connector": ["zod"] } };
  assert.deepEqual(classGrowth(null, tp, "thirdPartyPhantomDeps"), { grew: ["@cinatra-ai/a-connector :: zod"], bootstrap: null });
  assert.deepEqual(classGrowth([], tp, "thirdPartyPhantomDeps"), { grew: ["@cinatra-ai/a-connector :: zod"], bootstrap: null });
});

test("classGrowth reports a bootstrap (entry count, no growth) when the class is absent from the base baseline", () => {
  const base = { note: "…", phantomDeps: { "@cinatra-ai/a": ["@cinatra-ai/x"] } }; // no third-party class at all
  const committed = {
    phantomDeps: { "@cinatra-ai/a": ["@cinatra-ai/x"] },
    thirdPartyPhantomDeps: { "@cinatra-ai/a-connector": ["next", "zod"], "@cinatra-ai/b-connector": ["pg"] },
  };
  assert.deepEqual(classGrowth(base, committed, "thirdPartyPhantomDeps"), { grew: [], bootstrap: 3 });
  // Nothing to report when neither side has the class.
  assert.deepEqual(classGrowth(base, { phantomDeps: {} }, "thirdPartyPhantomDeps"), { grew: [], bootstrap: null });
});

test("classGrowth still fails growth in a class that EXISTS in the base baseline (the ratchet)", () => {
  const base = { phantomDeps: {}, thirdPartyPhantomDeps: { "@cinatra-ai/a-connector": ["zod"] } };
  const committed = { phantomDeps: {}, thirdPartyPhantomDeps: { "@cinatra-ai/a-connector": ["next", "zod"] } };
  assert.deepEqual(classGrowth(base, committed, "thirdPartyPhantomDeps"), {
    grew: ["@cinatra-ai/a-connector :: next"],
    bootstrap: null,
  });
  // …and an EMPTY-but-present class gives no free pass either.
  const emptyBase = { phantomDeps: {}, thirdPartyPhantomDeps: {} };
  assert.deepEqual(classGrowth(emptyBase, committed, "thirdPartyPhantomDeps").grew, [
    "@cinatra-ai/a-connector :: next",
    "@cinatra-ai/a-connector :: zod",
  ]);
});

test("a third-party class bootstrap does NOT exempt first-party growth in the same PR (first-party behaviour unchanged)", () => {
  const base = { note: "…", phantomDeps: { "@cinatra-ai/a": ["@cinatra-ai/x"] } };
  const committed = {
    phantomDeps: { "@cinatra-ai/a": ["@cinatra-ai/x", "@cinatra-ai/y"] }, // regenerate-to-pass, first-party
    thirdPartyPhantomDeps: { "@cinatra-ai/a-connector": ["zod"] },        // legitimate bootstrap
  };
  assert.deepEqual(baselineGrowth(base, committed), ["@cinatra-ai/a :: @cinatra-ai/y"]);
  assert.deepEqual(thirdPartyBaselineGrowth(base, committed), []);
  assert.equal(classGrowth(base, committed, "thirdPartyPhantomDeps").bootstrap, 1);
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

function runGate(cwd, args = [], env = {}) {
  try {
    const stdout = execFileSync("node", [GATE_SCRIPT, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return { status: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

function writeBaseline(root, baseline) {
  mkdirSync(join(root, "scripts", "audit"), { recursive: true });
  writeFileSync(
    join(root, "scripts", "audit", "workspace-phantom-deps.baseline.json"),
    JSON.stringify(baseline, null, 2) + "\n",
  );
}

/** Turn the fixture into a one-commit git repo so the base-ref growth guard
 * (`WORKSPACE_PHANTOM_DEPS_BASE`) can `git show <ref>:…baseline.json` a REAL
 * base-branch baseline. Hooks are pointed at an empty dir (and --no-verify) so
 * a contributor's global commit hooks can't touch these fixture commits. */
function commitFixtureBase(root) {
  const hooks = join(root, ".empty-githooks");
  mkdirSync(hooks, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: ["ignore", "ignore", "pipe"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "phantom-deps-gate-test@example.invalid");
  git("config", "user.name", "phantom-deps gate test");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", hooks);
  git("add", "-A");
  git("commit", "-q", "--no-verify", "-m", "fixture base");
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

// ---------------------------------------------------------------------------
// Integration: the CLASS-AWARE base-ref growth guard, driven through the real
// CLI against a real one-commit git fixture (so `git show <base>:…baseline.json`
// resolves an actual base-branch baseline). Reproduces the exact cinatra#2521
// shape — a gate whose own introducing PR was failed by its growth guard — and
// pins that the ratchet survives the carve-out.
// ---------------------------------------------------------------------------

test("integration: the PR that INTRODUCES a baseline class passes the growth guard as a one-time class bootstrap (cinatra#2521)", () => {
  const { root, connectorDir } = makeFixture();
  try {
    writeConnectorManifest(connectorDir);
    writeFileSync(join(connectorDir, "src", "index.ts"), `export const noop = true;\n`);
    // BASE commit: the gate exists, but the third-party class does not.
    writeBaseline(root, { phantomDeps: {} });
    commitFixtureBase(root);

    // THE PR: the new class's first scan lands and grandfathers its debt.
    writeFileSync(join(connectorDir, "src", "index.ts"), `import { z } from "zod";\n`);
    writeBaseline(root, { phantomDeps: {}, thirdPartyPhantomDeps: { "@cinatra-ai/fixture-connector": ["zod"] } });

    const res = runGate(root, [], { WORKSPACE_PHANTOM_DEPS_BASE: "HEAD" });
    assert.equal(res.status, 0, `the introducing PR must not be failed by its own growth guard; stderr: ${res.stderr}`);
    assert.match(res.stdout, /third-party class bootstrap: 1 grandfathered entries/);
    assert.doesNotMatch(res.stderr, /GREW/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: growth in a class that ALREADY exists on the base branch still FAILS the growth guard", () => {
  const { root, connectorDir } = makeFixture();
  try {
    writeConnectorManifest(connectorDir);
    writeFileSync(join(connectorDir, "src", "index.ts"), `import { z } from "zod";\n`);
    // BASE commit: the third-party class exists, with one grandfathered entry.
    writeBaseline(root, { phantomDeps: {}, thirdPartyPhantomDeps: { "@cinatra-ai/fixture-connector": ["zod"] } });
    commitFixtureBase(root);

    // THE PR: a new undeclared import + a regenerated baseline to absorb it.
    writeFileSync(join(connectorDir, "src", "index.ts"), `import { z } from "zod";\nimport lucide from "lucide-react";\n`);
    writeBaseline(root, { phantomDeps: {}, thirdPartyPhantomDeps: { "@cinatra-ai/fixture-connector": ["lucide-react", "zod"] } });

    const res = runGate(root, [], { WORKSPACE_PHANTOM_DEPS_BASE: "HEAD" });
    assert.equal(res.status, 1, "regenerate-to-pass inside an EXISTING class must still fail");
    assert.match(res.stderr, /committed baseline GREW/);
    assert.match(res.stderr, /\+ \[third-party\] @cinatra-ai\/fixture-connector :: lucide-react/);
    assert.doesNotMatch(res.stdout, /class bootstrap/, "an existing class is never a bootstrap");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: once the introducing PR has merged, a SECOND entry on top of the bootstrapped class FAILS (the self-ratchet)", () => {
  const { root, connectorDir } = makeFixture();
  try {
    // BASE commit = the post-merge state of the bootstrap test above: the class
    // now EXISTS on main, carrying exactly its grandfathered entry.
    writeConnectorManifest(connectorDir);
    writeFileSync(join(connectorDir, "src", "index.ts"), `import { z } from "zod";\n`);
    writeBaseline(root, { phantomDeps: {}, thirdPartyPhantomDeps: { "@cinatra-ai/fixture-connector": ["zod"] } });
    commitFixtureBase(root);

    // THE NEXT PR: a second synced extension brings its own undeclared import
    // and tries to grandfather it into the same (now-existing) class.
    const secondDir = join(root, "extensions", "vendor", "second-connector");
    mkdirSync(join(secondDir, "src"), { recursive: true });
    writeFileSync(join(secondDir, "package.json"), JSON.stringify({ name: "@cinatra-ai/second-connector", version: "0.0.0" }, null, 2));
    writeFileSync(join(secondDir, "src", "index.ts"), `import { Pool } from "pg";\nexport const p = new Pool();\n`);
    writeBaseline(root, {
      phantomDeps: {},
      thirdPartyPhantomDeps: {
        "@cinatra-ai/fixture-connector": ["zod"],
        "@cinatra-ai/second-connector": ["pg"],
      },
    });

    const res = runGate(root, [], { WORKSPACE_PHANTOM_DEPS_BASE: "HEAD" });
    assert.equal(res.status, 1, "the bootstrap is one-time only — the next addition must fail");
    assert.match(res.stderr, /committed baseline GREW/);
    assert.match(res.stderr, /\+ \[third-party\] @cinatra-ai\/second-connector :: pg/);
    assert.doesNotMatch(res.stderr, /fixture-connector :: zod/, "the already-baselined entry is not re-reported as growth");
    assert.doesNotMatch(res.stdout, /class bootstrap/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: an ABSENT first-party section is NOT a bootstrap — it still FAILS the growth guard (codex review, cinatra#2521)", () => {
  const root = mkdtempSync(join(tmpdir(), "phantom-deps-fixture-"));
  try {
    writeFileSync(join(root, "pnpm-workspace.yaml"), ["packages:", '  - "packages/*"', ""].join("\n"));
    for (const name of ["lib-a", "lib-b"]) {
      mkdirSync(join(root, "packages", name, "src"), { recursive: true });
      writeFileSync(join(root, "packages", name, "package.json"), JSON.stringify({ name: `@cinatra-ai/${name}`, version: "0.0.0" }, null, 2));
      writeFileSync(join(root, "packages", name, "src", "index.ts"), `export const ${name.replace("-", "_")} = true;\n`);
    }
    // BASE commit: a baseline FILE that exists but carries no first-party
    // section at all (corrupted, or a deliberate delete-and-re-add).
    writeBaseline(root, { note: "…" });
    commitFixtureBase(root);

    // THE PR: a new undeclared first-party import, grandfathered in one write.
    writeFileSync(join(root, "packages", "lib-b", "src", "index.ts"), `import { lib_a } from "@cinatra-ai/lib-a";\nexport const x = lib_a;\n`);
    writeBaseline(root, { phantomDeps: { "@cinatra-ai/lib-b": ["@cinatra-ai/lib-a"] } });

    const res = runGate(root, [], { WORKSPACE_PHANTOM_DEPS_BASE: "HEAD" });
    assert.equal(res.status, 1, "the first-party class is not bootstrap-eligible — this must still fail");
    assert.match(res.stderr, /committed baseline GREW/);
    assert.match(res.stderr, /\+ @cinatra-ai\/lib-b :: @cinatra-ai\/lib-a/);
    assert.doesNotMatch(res.stdout, /class bootstrap/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
