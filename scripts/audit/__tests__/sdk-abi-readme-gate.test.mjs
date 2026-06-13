import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execSync } from "node:child_process";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

import {
  stripCodeFences,
  extractRegisterAbi,
  extractPackageAbi,
  extractReadmeAbi,
  checkAbiSync,
  REGISTER_REL,
  PACKAGE_JSON_REL,
  README_REL,
} from "../sdk-abi-readme-gate.mjs";

const REPO_ROOT = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
const GATE = resolve(REPO_ROOT, "scripts/audit/sdk-abi-readme-gate.mjs");

const REGISTER_OK = 'export const SDK_EXTENSIONS_ABI_VERSION = "2.2.0" as const;\n';
const PKG_OK = JSON.stringify({ name: "@cinatra-ai/sdk-extensions", cinatra: { sdkAbiVersion: "2.2.0" } });
const README_OK = "## ABI version\n\nThe SDK ABI is **`2.2.0`** today.\n";

// ---------------------------------------------------------------------------
// Extractors

test("extractRegisterAbi reads the anchored const", () => {
  assert.equal(extractRegisterAbi(REGISTER_OK).value, "2.2.0");
});

test("extractRegisterAbi ignores a changelog comment carrying an old version", () => {
  const src = "// 2.0.0: added telemetry\n// 2.1.0: getPublicBaseUrl\n" + REGISTER_OK;
  assert.equal(extractRegisterAbi(src).value, "2.2.0");
});

test("extractRegisterAbi fails-closed when the const is gone (drift)", () => {
  const r = extractRegisterAbi("const SOMETHING_ELSE = 1;\n");
  assert.ok(r.error);
  assert.match(r.error, /did not match/);
});

test("extractPackageAbi parses JSON by key", () => {
  assert.equal(extractPackageAbi(PKG_OK).value, "2.2.0");
});

test("extractPackageAbi fails on a missing field", () => {
  const r = extractPackageAbi(JSON.stringify({ cinatra: {} }));
  assert.ok(r.error);
  assert.match(r.error, /missing or not a string/);
});

test("extractPackageAbi fails on invalid JSON", () => {
  const r = extractPackageAbi("{ not json ");
  assert.ok(r.error);
  assert.match(r.error, /not valid JSON/);
});

test("extractReadmeAbi reads the canonical statement", () => {
  assert.equal(extractReadmeAbi(README_OK).value, "2.2.0");
});

test("extractReadmeAbi ignores a fenced example carrying a different version", () => {
  const md = README_OK + "\n```jsonc\n{ \"sdkAbiVersion\": \"9.9.9\" }\n```\n";
  assert.equal(extractReadmeAbi(md).value, "2.2.0");
});

test("extractReadmeAbi fails-closed when the statement is gone", () => {
  const r = extractReadmeAbi("## ABI version\n\nNothing canonical here.\n");
  assert.ok(r.error);
  assert.match(r.error, /did not match/);
});

test("stripCodeFences keeps inline backtick spans", () => {
  const out = stripCodeFences("a `2.2.0` b\n```\n9.9.9\n```\n");
  assert.match(out, /`2\.2\.0`/);
  assert.doesNotMatch(out, /9\.9\.9/);
});

// ---------------------------------------------------------------------------
// Three-way check

test("checkAbiSync passes when all three agree", () => {
  const r = checkAbiSync({ registerSource: REGISTER_OK, packageJson: PKG_OK, readme: README_OK });
  assert.equal(r.ok, true);
  assert.deepEqual(r.values, { register: "2.2.0", package: "2.2.0", readme: "2.2.0" });
});

test("checkAbiSync catches the historical README drift (README 2.0.0 vs code 2.2.0)", () => {
  const r = checkAbiSync({
    registerSource: REGISTER_OK,
    packageJson: PKG_OK,
    readme: "## ABI version\n\nThe SDK ABI is **`2.0.0`** today.\n",
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /drift/);
});

test("checkAbiSync catches package.json drifting from register.ts", () => {
  const r = checkAbiSync({
    registerSource: REGISTER_OK,
    packageJson: JSON.stringify({ cinatra: { sdkAbiVersion: "2.1.0" } }),
    readme: README_OK,
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /drift/);
});

// ---------------------------------------------------------------------------
// Live smoke — the gate must PASS against the real (fixed) worktree

test("the gate passes against the current worktree (post-fix)", () => {
  const r = spawnSync("node", [GATE], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, `expected PASS\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /PASS/);
});

test("the three real files carry byte-equal ABI versions", () => {
  const reg = extractRegisterAbi(readFileSync(resolve(REPO_ROOT, REGISTER_REL), "utf8"));
  const pkg = extractPackageAbi(readFileSync(resolve(REPO_ROOT, PACKAGE_JSON_REL), "utf8"));
  const doc = extractReadmeAbi(readFileSync(resolve(REPO_ROOT, README_REL), "utf8"));
  assert.equal(reg.error, undefined, reg.error);
  assert.equal(pkg.error, undefined, pkg.error);
  assert.equal(doc.error, undefined, doc.error);
  assert.equal(reg.value, pkg.value);
  assert.equal(pkg.value, doc.value);
});
