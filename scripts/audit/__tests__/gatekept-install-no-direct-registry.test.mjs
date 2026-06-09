import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  ALLOWLIST,
  TARGET_PATHS,
  scan,
} from "../gatekept-install-no-direct-registry.mjs";

/**
 * Build a minimal fixture repo that mirrors the real TARGET_PATHS layout so the
 * scanner's path expansion succeeds (it fail-closes on a missing target). Each
 * target directory gets a clean placeholder file; each target FILE is created.
 * Tests then plant additional files to exercise specific behaviors.
 */
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "gatekept-no-direct-reg-"));
  for (const target of TARGET_PATHS) {
    const abs = join(root, target);
    if (target.endsWith(".ts") || target.endsWith(".tsx")) {
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, "export const placeholder = 1;\n");
    } else {
      // Directory target.
      mkdirSync(abs, { recursive: true });
      writeFileSync(join(abs, "clean.ts"), "export const placeholder = 1;\n");
    }
  }
  return root;
}

function write(root, relPath, contents) {
  const abs = join(root, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, contents);
}

// ---------------------------------------------------------------------------

test("ALLOWLIST + TARGET_PATHS are frozen", () => {
  assert.throws(() => {
    // @ts-expect-error runtime mutation guard
    ALLOWLIST.push("foo");
  });
  assert.throws(() => {
    // @ts-expect-error runtime mutation guard
    TARGET_PATHS.push("foo");
  });
});

test("ALLOWLIST names the sanctioned seams", () => {
  assert.ok(ALLOWLIST.includes("src/lib/gatekept-install.ts"));
  assert.ok(ALLOWLIST.includes("src/lib/verdaccio-config.ts"));
  assert.ok(ALLOWLIST.includes("packages/registries/src/verdaccio/config.ts"));
  assert.ok(ALLOWLIST.includes("packages/registries/src/verdaccio/client.ts"));
  assert.ok(ALLOWLIST.includes("src/lib/deployment-registry-config.ts"));
});

test("TARGET_PATHS includes the real install/detail consumers (agent-detail + actions)", () => {
  // The gate must scan the transitive install/detail consumers — the
  // agent-detail reader (RegistryEntryDetailSections) and the registry actions —
  // not just the handler + pipeline.
  assert.ok(TARGET_PATHS.includes("packages/agents/src/screens.tsx"));
  assert.ok(TARGET_PATHS.includes("packages/agents/src/actions.ts"));
});

test("ALLOWLIST does NOT whole-file allow the mixed mcp/handlers.ts", () => {
  // A WHOLE-FILE allowlist of a mixed handler file would let a future
  // install/detail bypass land silently next to the one sanctioned browse line.
  // The browse-path construction is covered by a line-scoped directive instead.
  assert.ok(!ALLOWLIST.includes("packages/extensions/src/mcp/handlers.ts"));
});

// ---------------------------------------------------------------------------
// 1. Passes on the current (real) tree.
// ---------------------------------------------------------------------------

test("gate passes on the current repo tree", () => {
  const result = scan(); // default REPO_ROOT
  assert.equal(
    result.ok,
    true,
    `expected current tree to be clean, got violations: ${JSON.stringify(
      result.violations,
      null,
      2,
    )} unreadable: ${JSON.stringify(result.unreadable)}`,
  );
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.unreadable, []);
  assert.ok(result.scannedFileCount > 0);
});

// ---------------------------------------------------------------------------
// 2. A planted direct-registry read in a non-allowlisted target is flagged.
// ---------------------------------------------------------------------------

test("flags a planted hardcoded registry host in a non-allowlisted module", () => {
  const root = makeRepo();
  try {
    write(
      root,
      "packages/extensions/src/sneaky-install.ts",
      [
        'export function sneaky() {',
        '  const url = "https://registry.cinatra.ai";',
        "  return url;",
        "}",
        "",
      ].join("\n"),
    );
    const result = scan(root);
    assert.equal(result.ok, false);
    const hit = result.violations.find(
      (v) => v.path === "packages/extensions/src/sneaky-install.ts",
    );
    assert.ok(hit, "expected the planted module to be flagged");
    assert.ok(hit.hits.some((h) => h.kind === "hardcoded-registry-host"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("flags a planted raw pacote { registry, token } options object", () => {
  const root = makeRepo();
  try {
    write(
      root,
      "packages/extensions/src/raw-pacote.ts",
      [
        "import * as pacote from 'pacote';",
        "export async function go(name) {",
        "  return pacote.packument(name, {",
        "    registry: 'http://example/',",
        "    token: process.env.SECRET,",
        "  });",
        "}",
        "",
      ].join("\n"),
    );
    const result = scan(root);
    assert.equal(result.ok, false);
    const hit = result.violations.find(
      (v) => v.path === "packages/extensions/src/raw-pacote.ts",
    );
    assert.ok(hit);
    assert.ok(hit.hits.some((h) => h.kind === "raw-pacote-options"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("flags a planted raw :_authToken= install flag", () => {
  const root = makeRepo();
  try {
    write(
      root,
      "src/lib/extension-install-pipeline-extra.ts",
      "export const flag = `--//${host}/:_authToken=${token}`;\n",
    );
    // Put it inside a scanned target dir so it is picked up.
    write(
      root,
      "packages/extensions/src/authtoken-bypass.ts",
      "export const flag = `--//${host}/:_authToken=${token}`;\n",
    );
    const result = scan(root);
    assert.equal(result.ok, false);
    const hit = result.violations.find(
      (v) => v.path === "packages/extensions/src/authtoken-bypass.ts",
    );
    assert.ok(hit);
    assert.ok(hit.hits.some((h) => h.kind === "raw-authtoken-flag"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("flags a planted publicReadToken direct read", () => {
  const root = makeRepo();
  try {
    write(
      root,
      "packages/extensions/src/public-token-bypass.ts",
      [
        "import { loadDeploymentRegistryConfig } from './deployment-registry-config';",
        "export function go() {",
        "  const cfg = loadDeploymentRegistryConfig();",
        "  return cfg.publicReadToken;",
        "}",
        "",
      ].join("\n"),
    );
    const result = scan(root);
    assert.equal(result.ok, false);
    const hit = result.violations.find(
      (v) => v.path === "packages/extensions/src/public-token-bypass.ts",
    );
    assert.ok(hit);
    assert.ok(hit.hits.some((h) => h.kind === "public-read-token-use"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("flags a RegistryEntryDetailScreen-style direct registry read on the agent-detail path", () => {
  // Regression: the agent-detail reader is now in the scanned
  // surface (packages/agents/src/screens.tsx). A screen that reads the manifest
  // by constructing a registry config DIRECTLY (hardcoded host + raw pacote
  // options) instead of routing through resolveDetailReadConfig /
  // resolveGatekeptInstallConfig must be FLAGGED — that is exactly the bypass
  // that defeated the gate while the agent-detail Verdaccio read existed.
  const root = makeRepo();
  try {
    write(
      root,
      "packages/agents/src/screens.tsx",
      [
        "import * as pacote from 'pacote';",
        "export async function RegistryEntryDetailScreen({ packageName }) {",
        "  // Bypass: builds a direct registry read instead of the gatekept resolver.",
        '  const registryUrl = "https://registry.cinatra.ai";',
        "  const entry = await pacote.packument(packageName, {",
        "    registry: registryUrl,",
        "    token: process.env.READ_TOKEN,",
        "  });",
        "  return entry;",
        "}",
        "",
      ].join("\n"),
    );
    const result = scan(root);
    assert.equal(result.ok, false);
    const hit = result.violations.find(
      (v) => v.path === "packages/agents/src/screens.tsx",
    );
    assert.ok(hit, "expected the agent-detail bypass to be flagged");
    assert.ok(hit.hits.some((h) => h.kind === "hardcoded-registry-host"));
    assert.ok(hit.hits.some((h) => h.kind === "raw-pacote-options"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("flags a direct registry construction planted in the registry actions module", () => {
  const root = makeRepo();
  try {
    write(
      root,
      "packages/agents/src/actions.ts",
      [
        '"use server";',
        "export async function installRegistryPackage() {",
        '  return `--//${"host"}/:_authToken=${process.env.T}`;',
        "}",
        "",
      ].join("\n"),
    );
    const result = scan(root);
    assert.equal(result.ok, false);
    const hit = result.violations.find(
      (v) => v.path === "packages/agents/src/actions.ts",
    );
    assert.ok(hit, "expected the actions bypass to be flagged");
    assert.ok(hit.hits.some((h) => h.kind === "raw-authtoken-flag"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Line-scoped exception directive.
// ---------------------------------------------------------------------------

test("a line-scoped allow directive on the SAME line suppresses the hit", () => {
  const root = makeRepo();
  try {
    write(
      root,
      "packages/extensions/src/mixed-handler.ts",
      [
        "export function go(cfg) {",
        "  return cfg.publicReadToken; // gatekept-install-allow-direct-registry: browse path, not install",
        "}",
        "",
      ].join("\n"),
    );
    const result = scan(root);
    assert.equal(
      result.ok,
      true,
      `same-line directive must suppress; got: ${JSON.stringify(result.violations, null, 2)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a line-scoped allow directive on the line ABOVE suppresses the hit", () => {
  const root = makeRepo();
  try {
    write(
      root,
      "packages/extensions/src/mixed-handler-above.ts",
      [
        "export function go(cfg) {",
        "  // gatekept-install-allow-direct-registry: browse/search path, not install/detail",
        "  return cfg.publicReadToken;",
        "}",
        "",
      ].join("\n"),
    );
    const result = scan(root);
    assert.equal(
      result.ok,
      true,
      `directive on the line above must suppress; got: ${JSON.stringify(result.violations, null, 2)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the allow directive suppresses ONLY its line — other bypasses in the same file still flag", () => {
  const root = makeRepo();
  try {
    write(
      root,
      "packages/extensions/src/mixed-handler-partial.ts",
      [
        "export function browse(cfg) {",
        "  // gatekept-install-allow-direct-registry: browse path, not install",
        "  return cfg.publicReadToken;",
        "}",
        "export function sneakyInstall() {",
        '  return "https://registry.cinatra.ai";',
        "}",
        "",
      ].join("\n"),
    );
    const result = scan(root);
    assert.equal(result.ok, false);
    const hit = result.violations.find(
      (v) => v.path === "packages/extensions/src/mixed-handler-partial.ts",
    );
    assert.ok(hit, "the un-directived bypass must still be flagged");
    assert.ok(hit.hits.some((h) => h.kind === "hardcoded-registry-host"));
    // The directived browse line must NOT appear as a violation.
    assert.ok(!hit.hits.some((h) => h.kind === "public-read-token-use"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a bare allow directive with NO reason does NOT suppress", () => {
  const root = makeRepo();
  try {
    write(
      root,
      "packages/extensions/src/bare-directive.ts",
      [
        "export function go(cfg) {",
        "  // gatekept-install-allow-direct-registry:",
        "  return cfg.publicReadToken;",
        "}",
        "",
      ].join("\n"),
    );
    const result = scan(root);
    assert.equal(result.ok, false);
    const hit = result.violations.find(
      (v) => v.path === "packages/extensions/src/bare-directive.ts",
    );
    assert.ok(hit, "a reasonless directive must not suppress");
    assert.ok(hit.hits.some((h) => h.kind === "public-read-token-use"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. An allowlisted file is NOT flagged even with direct constructions.
// ---------------------------------------------------------------------------

test("does NOT flag an allowlisted seam file with direct constructions", () => {
  const root = makeRepo();
  try {
    // gatekept-install.ts is allowlisted — it is the sanctioned resolver and
    // may legitimately reference registry constructs.
    write(
      root,
      "src/lib/gatekept-install.ts",
      [
        'const PROD = "https://registry.cinatra.ai";',
        "const opts = { registry: PROD, token: grant };",
        "export const flag = `--//${host}/:_authToken=${grant}`;",
        "export const t = cfg.publicReadToken;",
        "",
      ].join("\n"),
    );
    // The registries pacote wrapper is allowlisted too.
    write(
      root,
      "packages/registries/src/verdaccio/client.ts",
      "function pacoteOptions(config) { return { registry: config.registryUrl, token: config.token }; }\n",
    );
    const result = scan(root);
    assert.equal(
      result.ok,
      true,
      `allowlisted files must not be flagged; got: ${JSON.stringify(result.violations, null, 2)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does NOT flag a doc comment that merely names publicPublishToken", () => {
  const root = makeRepo();
  try {
    write(
      root,
      "packages/extensions/src/with-doc-comment.ts",
      [
        "/**",
        " * resolvePublishDestination('public') calls deployConfig.publicPublishToken;",
        " * this is null in the baseline fixture.",
        " */",
        "export function safe() { return 1; }",
        "// also mentions registry.cinatra.ai in a line comment",
        "",
      ].join("\n"),
    );
    const result = scan(root);
    assert.equal(
      result.ok,
      true,
      `comment-only mentions must not be flagged; got: ${JSON.stringify(result.violations, null, 2)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Fail-closed + scoping behaviors.
// ---------------------------------------------------------------------------

test("test files inside a target dir are skipped (non-shipping)", () => {
  const root = makeRepo();
  try {
    write(
      root,
      "packages/extensions/src/bypass.test.ts",
      'const url = "https://registry.cinatra.ai";\n',
    );
    write(
      root,
      "packages/extensions/src/__tests__/another.ts",
      'const url = "https://registry.cinatra.ai";\n',
    );
    const result = scan(root);
    assert.equal(result.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a construction OUTSIDE the install/detail target surface is not scanned", () => {
  const root = makeRepo();
  try {
    // src/lib is NOT a scanned directory target (only specific files in it are).
    write(
      root,
      "src/lib/unrelated-helper.ts",
      'export const url = "https://registry.cinatra.ai";\n',
    );
    const result = scan(root);
    assert.equal(result.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fail-closed: a missing configured target throws", () => {
  const root = mkdtempSync(join(tmpdir(), "gatekept-missing-target-"));
  try {
    // Do NOT create the TARGET_PATHS — collectTargetFiles must throw.
    assert.throws(() => scan(root), /target path not found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
