// Workspace-dependency resolution gate — unit tests for the pure helpers.
// Zero-dep (node:test) to match the gate (a .mjs gate can't import .ts deps).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseWorkspaceGlobs,
  resolveWorkspaceTarget,
  findDanglingWorkspaceDeps,
} from "../workspace-deps-resolve.mjs";

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

test("resolveWorkspaceTarget: simple range forms target the dependency key", () => {
  for (const spec of ["workspace:*", "workspace:^", "workspace:~", "workspace:1.2.3", "workspace:^1.0.0", "workspace:>=2"]) {
    assert.equal(resolveWorkspaceTarget("@cinatra-ai/foo", spec), "@cinatra-ai/foo", spec);
  }
});

test("resolveWorkspaceTarget: aliased forms target the package named in the spec", () => {
  assert.equal(resolveWorkspaceTarget("alias", "workspace:@cinatra-ai/bar@*"), "@cinatra-ai/bar");
  assert.equal(resolveWorkspaceTarget("alias", "workspace:@cinatra-ai/bar@^1.2.0"), "@cinatra-ai/bar");
  assert.equal(resolveWorkspaceTarget("alias", "workspace:baz@^1"), "baz");
});

test("resolveWorkspaceTarget: x-range and bare workspace: forms target the key", () => {
  assert.equal(resolveWorkspaceTarget("@cinatra-ai/foo", "workspace:"), "@cinatra-ai/foo");
  assert.equal(resolveWorkspaceTarget("@cinatra-ai/foo", "workspace:x"), "@cinatra-ai/foo");
  assert.equal(resolveWorkspaceTarget("@cinatra-ai/foo", "workspace:1.x"), "@cinatra-ai/foo");
});

test("resolveWorkspaceTarget: relative-path workspace refs are skipped (pnpm resolves by path)", () => {
  assert.equal(resolveWorkspaceTarget("foo", "workspace:../foo"), null);
  assert.equal(resolveWorkspaceTarget("foo", "workspace:./pkgs/foo"), null);
});

test("resolveWorkspaceTarget: non-workspace specs are ignored", () => {
  assert.equal(resolveWorkspaceTarget("x", "^1.0.0"), null);
  assert.equal(resolveWorkspaceTarget("x", "npm:y@1"), null);
  assert.equal(resolveWorkspaceTarget("x", "catalog:"), null);
  assert.equal(resolveWorkspaceTarget("x", undefined), null);
  assert.equal(resolveWorkspaceTarget("x", 123), null);
});

test("findDanglingWorkspaceDeps flags a workspace: dep whose target is not a member", () => {
  const members = [
    { name: "@cinatra-ai/agents", dir: "packages/agents", deps: { dependencies: { "@cinatra-ai/skills": "workspace:*", "@cinatra-ai/workflows": "workspace:*" } } },
    { name: "@cinatra-ai/skills", dir: "packages/skills", deps: {} },
  ];
  const dangling = findDanglingWorkspaceDeps(members);
  assert.equal(dangling.length, 1);
  assert.deepEqual(
    { member: dangling[0].member, bucket: dangling[0].bucket, dep: dangling[0].dep, target: dangling[0].target },
    { member: "@cinatra-ai/agents", bucket: "dependencies", dep: "@cinatra-ai/workflows", target: "@cinatra-ai/workflows" },
  );
});

test("findDanglingWorkspaceDeps is clean when every workspace: dep resolves", () => {
  const members = [
    { name: "@cinatra-ai/agents", dir: "packages/agents", deps: { dependencies: { "@cinatra-ai/skills": "workspace:*" }, devDependencies: { "aliased": "workspace:@cinatra-ai/skills@*" } } },
    { name: "@cinatra-ai/skills", dir: "packages/skills", deps: { peerDependencies: { "@cinatra-ai/agents": "workspace:^" } } },
  ];
  assert.deepEqual(findDanglingWorkspaceDeps(members), []);
});

test("findDanglingWorkspaceDeps ignores non-workspace specifiers", () => {
  const members = [
    { name: "@cinatra-ai/agents", dir: "packages/agents", deps: { dependencies: { "react": "^19.0.0", "@cinatra-ai/missing": "^0.1.0" } } },
  ];
  assert.deepEqual(findDanglingWorkspaceDeps(members), []);
});

test("findDanglingWorkspaceDeps resolves relative-path workspace refs by directory", () => {
  const members = [
    { name: "@cinatra-ai/agents", dir: "packages/agents", deps: { dependencies: { "@cinatra-ai/skills": "workspace:../skills", "@cinatra-ai/gone": "workspace:../gone" } } },
    { name: "@cinatra-ai/skills", dir: "packages/skills", deps: {} },
  ];
  const dangling = findDanglingWorkspaceDeps(members);
  assert.equal(dangling.length, 1);
  assert.equal(dangling[0].dep, "@cinatra-ai/gone");
  assert.equal(dangling[0].spec, "workspace:../gone");
});

test("findDanglingWorkspaceDeps scans a nameless member and reports it by dir", () => {
  const members = [
    { name: null, dir: "extensions/cinatra-ai/x-connector", deps: { dependencies: { "@cinatra-ai/gone": "workspace:*" } } },
  ];
  const dangling = findDanglingWorkspaceDeps(members);
  assert.equal(dangling.length, 1);
  assert.equal(dangling[0].member, "extensions/cinatra-ai/x-connector");
  assert.equal(dangling[0].target, "@cinatra-ai/gone");
});
