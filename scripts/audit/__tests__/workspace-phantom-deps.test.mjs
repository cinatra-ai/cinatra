// Workspace phantom-dependency gate — unit tests for the pure helpers.
// Zero-dep (node:test) to match the gate (a .mjs gate can't import .ts deps).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseWorkspaceGlobs,
  resolveSpecifierToPackage,
  extractInternalImports,
  diffAgainstBaseline,
  baselineGrowth,
} from "../workspace-phantom-deps.mjs";

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
