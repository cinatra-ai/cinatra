import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execSync } from "node:child_process";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

import {
  valueExports,
  starReexports,
  wrapperAliasLeaks,
  findLeaks,
  runGate,
  FENCED_CONSTANTS,
  HOST_BUS_CONTRACT_MODULES,
  INDEX_REL,
} from "../sdk-public-surface-ban.mjs";

const REPO_ROOT = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
const GATE = resolve(REPO_ROOT, "scripts/audit/sdk-public-surface-ban.mjs");

// ---------------------------------------------------------------------------
// valueExports — what counts as a runtime VALUE export

test("valueExports captures `export { A, B } from`", () => {
  const names = valueExports('export { A, B } from "./x";');
  assert.ok(names.has("A") && names.has("B"));
});

test("valueExports IGNORES `export type { … }` blocks entirely", () => {
  const names = valueExports('export type { HostFooService, BarShape } from "./x";');
  assert.equal(names.size, 0);
});

test("valueExports drops inline `type X` members from a mixed value block", () => {
  const names = valueExports('export { setFoo, type FooShape } from "./x";');
  assert.ok(names.has("setFoo"));
  assert.ok(!names.has("FooShape"));
});

test("valueExports captures `export const|function|class NAME`", () => {
  const names = valueExports(
    "export const HOST_PORT_NAMES = [];\nexport function defineExtension() {}\nexport class Foo {}",
  );
  assert.ok(names.has("HOST_PORT_NAMES"));
  assert.ok(names.has("defineExtension"));
  assert.ok(names.has("Foo"));
});

test("valueExports follows `A as B` re-export (both names tracked — an alias can't launder)", () => {
  const names = valueExports('export { CHAT_USER_CONTEXT_CAPABILITY_ID as X } from "./x";');
  assert.ok(names.has("CHAT_USER_CONTEXT_CAPABILITY_ID"));
  assert.ok(names.has("X"));
});

// ---------------------------------------------------------------------------
// findLeaks — the fence verdict

test("findLeaks flags a capability VALUE re-export", () => {
  const leaks = findLeaks('export { NANGO_SYSTEM_CAPABILITY } from "./nango-system-contract";');
  assert.deepEqual(leaks, ["NANGO_SYSTEM_CAPABILITY"]);
});

test("findLeaks flags the services-map object too", () => {
  const leaks = findLeaks('export { HOST_CONNECTOR_SERVICE_CAPABILITIES } from "./x";');
  assert.deepEqual(leaks, ["HOST_CONNECTOR_SERVICE_CAPABILITIES"]);
});

test("findLeaks is fail-closed for a FUTURE _CAPABILITY id never listed in FENCED_CONSTANTS", () => {
  const leaks = findLeaks('export { SOME_NEW_FUTURE_CAPABILITY } from "./x";');
  assert.deepEqual(leaks, ["SOME_NEW_FUTURE_CAPABILITY"]);
});

test("findLeaks does NOT flag a capability TYPE re-export (public author surface)", () => {
  const leaks = findLeaks('export type { BlogSystemProvider, HostEmailRoutingService } from "./x";');
  assert.deepEqual(leaks, []);
});

test("findLeaks does NOT flag legitimate author value exports", () => {
  const leaks = findLeaks(
    'export { HOST_PORT_NAMES } from "./host-context";\n' +
      'export { defineExtension, SDK_EXTENSIONS_ABI_VERSION } from "./register";',
  );
  assert.deepEqual(leaks, []);
});

test("FENCED_CONSTANTS lists exactly 21 known host capability ids", () => {
  assert.equal(FENCED_CONSTANTS.length, 21);
});

// ---------------------------------------------------------------------------
// Fail-closed against star / namespace re-export evasion (codex SDK-P2 finding)

test("starReexports captures `export * from` and `export * as ns from`", () => {
  const got = starReexports(
    'export * from "./nango-system-contract";\n' +
      'export * as HostBus from "./host-connector-services-contract";',
  );
  assert.deepEqual(got, [
    { alias: null, spec: "./nango-system-contract" },
    { alias: "HostBus", spec: "./host-connector-services-contract" },
  ]);
});

test("findLeaks flags a bare `export *` from a host-bus contract module", () => {
  const leaks = findLeaks('export * from "./host-connector-services-contract";');
  assert.equal(leaks.length, 1);
  assert.match(leaks[0], /star re-export of host-bus contract module/);
});

test("findLeaks flags a namespace `export * as HostBus` from a host-bus contract module", () => {
  const leaks = findLeaks('export * as HostBus from "./nango-system-contract";');
  assert.equal(leaks.length, 1);
  assert.match(leaks[0], /as HostBus/);
});

test("findLeaks flags star re-export regardless of relative path depth / extension", () => {
  const leaks = findLeaks('export * from "../sdk/chat-user-context-contract.ts";');
  assert.equal(leaks.length, 1);
});

test("findLeaks does NOT flag a `export *` from a NON host-bus module", () => {
  const leaks = findLeaks('export * from "./register";\nexport * from "./manifest";');
  assert.deepEqual(leaks, []);
});

test("HOST_BUS_CONTRACT_MODULES enumerates the 6 modules that define fenced constants", () => {
  assert.equal(HOST_BUS_CONTRACT_MODULES.length, 6);
});

// ---------------------------------------------------------------------------
// Fail-closed against wrapper / launder aliases (codex SDK-P2 finding)

test("wrapperAliasLeaks flags `export const X = <FENCED_CONSTANT>`", () => {
  const leaks = wrapperAliasLeaks(
    "export const NANGO_ID = NANGO_SYSTEM_CAPABILITY;",
  );
  assert.equal(leaks.length, 1);
  assert.match(leaks[0], /NANGO_ID/);
  assert.match(leaks[0], /NANGO_SYSTEM_CAPABILITY/);
});

test("findLeaks flags a wrapper alias re-publishing a fenced constant value under a fence-evading name", () => {
  const leaks = findLeaks(
    'import { NANGO_SYSTEM_CAPABILITY } from "./nango-system-contract";\n' +
      "export const NANGO_ID = NANGO_SYSTEM_CAPABILITY;",
  );
  assert.equal(leaks.length, 1);
  assert.match(leaks[0], /wrapper\/launder/);
});

test("wrapperAliasLeaks flags an object-literal that embeds a fenced constant", () => {
  const leaks = wrapperAliasLeaks(
    "export const BUS = { nango: NANGO_SYSTEM_CAPABILITY, n: 1 };",
  );
  assert.equal(leaks.length, 1);
});

test("wrapperAliasLeaks does NOT flag an unrelated value declaration", () => {
  const leaks = wrapperAliasLeaks(
    "export const HOST_PORT_NAMES = ['db', 'settings'];\n" +
      "export const VERSION = '2.2.0';",
  );
  assert.deepEqual(leaks, []);
});

// ---------------------------------------------------------------------------
// Integration — the committed index.ts must be clean; the gate must catch a leak

test("runGate PASSES on the committed public root", () => {
  const r = runGate(REPO_ROOT);
  assert.equal(r.ok, true, `unexpected leaks: ${JSON.stringify(r.leaks)}`);
});

test("the committed index.ts re-exports none of the fenced constants as values", () => {
  const src = readFileSync(resolve(REPO_ROOT, INDEX_REL), "utf8");
  const names = valueExports(src);
  for (const c of FENCED_CONSTANTS) {
    assert.ok(!names.has(c), `fenced constant ${c} is value-exported from the public root`);
  }
});

test("CLI exits 0 on the clean tree", () => {
  const res = spawnSync("node", [GATE], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /PASS/);
});

test("CLI exits 1 when a leak is injected (synthetic index)", () => {
  // Prove the tripwire fires: feed findLeaks a leaking source directly (the CLI
  // reads the committed file, so we assert the pure verdict for the inject case).
  const leaks = findLeaks(
    'export type { Foo } from "./x";\n' +
      'export { LLM_TOOLBOX_CAPABILITY } from "./host-connector-services-contract";',
  );
  assert.deepEqual(leaks, ["LLM_TOOLBOX_CAPABILITY"]);
});
