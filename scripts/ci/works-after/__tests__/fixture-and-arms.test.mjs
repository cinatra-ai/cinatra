// Unit tests for the works-after harness (cinatra#352) — fast, service-free.
//
// These assert the STATIC invariants the harness depends on, so a refactor that
// silently breaks them is caught without spinning containers:
//   - the no-LLM echo OAS fixture is well-formed (a StartNode→OutputMessageNode→
//     EndNode flow with NO LlmNode/AgentNode/ApiNode, exposing echo_nonce);
//   - its committed published marker's oasSha256 matches the OAS bytes (so the
//     read-only-mounted loader accepts it without backfill);
//   - the orchestrator declares exactly the six designed arms and rejects an
//     unknown WORKS_AFTER_ONLY value;
//   - the works-after:gate entrypoint enforces the fail-closed gate contract
//     (forced gate mode, explicit --arms, documented exit codes, and it refuses
//     a zero-arm selection so it can never false-green) and its ALL_ARMS stays
//     in lockstep with the orchestrator (cinatra#1147).
//
// Run: node --test scripts/ci/works-after/__tests__/

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
const FIXTURE_DIR = resolve(REPO_ROOT, "tests/fixtures/works-after-agent/cinatra-works-after/echo-proof");
const OAS_PATH = resolve(FIXTURE_DIR, "cinatra/oas.json");
const MARKER_PATH = resolve(FIXTURE_DIR, ".cinatra-published.json");

test("echo OAS fixture exists and is a Flow with the cinatra packageName", () => {
  assert.ok(existsSync(OAS_PATH), `missing OAS at ${OAS_PATH}`);
  const oas = JSON.parse(readFileSync(OAS_PATH, "utf8"));
  assert.equal(oas.component_type, "Flow");
  assert.equal(oas.metadata?.cinatra?.packageName, "@cinatra-works-after/echo-proof");
});

test("echo OAS is LLM-FREE (no LlmNode / AgentNode / ApiNode)", () => {
  const oas = JSON.parse(readFileSync(OAS_PATH, "utf8"));
  const refs = oas.$referenced_components ?? {};
  const types = Object.values(refs).map((c) => c.component_type);
  for (const banned of ["LlmNode", "AgentNode", "ApiNode"]) {
    assert.ok(!types.includes(banned), `fixture must not contain a ${banned} (it would need an LLM/secret)`);
  }
  // It must contain exactly the deterministic echo node set.
  assert.ok(types.includes("StartNode"), "missing StartNode");
  assert.ok(types.includes("OutputMessageNode"), "missing OutputMessageNode");
  assert.ok(types.includes("EndNode"), "missing EndNode");
});

test("echo OAS exposes echo_nonce as a flow input AND output", () => {
  const oas = JSON.parse(readFileSync(OAS_PATH, "utf8"));
  const inTitles = (oas.inputs ?? []).map((p) => p.title);
  const outTitles = (oas.outputs ?? []).map((p) => p.title);
  assert.ok(inTitles.includes("echo_nonce"), "echo_nonce must be a declared flow input");
  assert.ok(outTitles.includes("echo_nonce"), "echo_nonce must be a declared flow output");
});

test("committed published marker's oasSha256 matches the OAS bytes", () => {
  assert.ok(existsSync(MARKER_PATH), `missing marker at ${MARKER_PATH}`);
  const marker = JSON.parse(readFileSync(MARKER_PATH, "utf8"));
  for (const k of ["packageName", "packageVersion", "oasSha256", "publishedAt"]) {
    assert.ok(marker[k], `marker missing required key '${k}'`);
  }
  const actual = createHash("sha256").update(readFileSync(OAS_PATH)).digest("hex");
  assert.equal(
    marker.oasSha256,
    actual,
    "marker oasSha256 is stale — re-run the OAS generator OR recompute the marker (sha256 of cinatra/oas.json)",
  );
  assert.equal(marker.packageName, "@cinatra-works-after/echo-proof");
});

test("orchestrator declares exactly the nine designed arms", () => {
  const orch = readFileSync(resolve(REPO_ROOT, "scripts/ci/works-after-proof.sh"), "utf8");
  const m = orch.match(/ALL_ARMS="([^"]+)"/);
  assert.ok(m, "could not find ALL_ARMS in the orchestrator");
  const arms = m[1].split(/\s+/).sort();
  // six fresh-init arms (cinatra#352) + the three upgrade-from arms (cinatra#1421/#1422)
  assert.deepEqual(
    arms,
    ["graphiti", "nango", "postgres", "redis", "verdaccio", "wayflow", "upgrade-redis", "upgrade-mariadb", "upgrade-postgres"].sort(),
  );
});

test("each arm script exists and is referenced by the orchestrator", () => {
  const armsDir = resolve(REPO_ROOT, "scripts/ci/works-after");
  for (const arm of ["redis", "verdaccio", "nango", "wayflow", "graphiti", "postgres", "upgrade-redis", "upgrade-mariadb", "upgrade-postgres"]) {
    assert.ok(existsSync(resolve(armsDir, `${arm}.sh`)), `missing arm script ${arm}.sh`);
  }
});

// ── gate entrypoint (cinatra#1147) ───────────────────────────────────────────

test("the works-after gate entrypoint enforces the fail-closed contract", () => {
  const gatePath = resolve(REPO_ROOT, "scripts/ci/works-after-gate.sh");
  assert.ok(existsSync(gatePath), "missing scripts/ci/works-after-gate.sh");
  const gate = readFileSync(gatePath, "utf8");
  // Wraps the orchestrator in forced gate mode (a SKIP is a FAIL).
  assert.match(gate, /works-after-proof\.sh/, "gate must delegate to the proof orchestrator");
  assert.match(gate, /WORKS_AFTER_GATE_MODE=1/, "gate must force gate mode");
  // Requires an explicit arm selection (no silent default) + documents exit codes.
  assert.match(gate, /--arms/, "gate must accept an explicit --arms selection");
  assert.match(gate, /MISCONFIGURED/, "gate must report a misconfiguration path");
  for (const code of ["0", "1", "2"]) {
    assert.match(gate, new RegExp(`exit ${code}\\b`), `gate must define exit ${code}`);
  }
});

test("the gate's ALL_ARMS is in lockstep with the orchestrator", () => {
  const armsOf = (src) => {
    const m = src.match(/ALL_ARMS="([^"]+)"/);
    assert.ok(m, "could not find ALL_ARMS");
    return m[1].split(/\s+/).sort();
  };
  const orch = armsOf(readFileSync(resolve(REPO_ROOT, "scripts/ci/works-after-proof.sh"), "utf8"));
  const gate = armsOf(readFileSync(resolve(REPO_ROOT, "scripts/ci/works-after-gate.sh"), "utf8"));
  assert.deepEqual(gate, orch, "works-after-gate.sh ALL_ARMS drifted from the orchestrator");
});

test("package.json exposes the works-after:gate script", () => {
  const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts?.["works-after:gate"], "bash scripts/ci/works-after-gate.sh");
});

// Fail-closed edge cases: the gate must NEVER run zero arms and report success,
// and a malformed invocation must be a MISCONFIGURED (exit 2) — not a silent
// pass and not an exit-1 masquerading as a real proof failure. These spawn bash
// but touch NO container (they all bail during argument validation, before the
// orchestrator is invoked).
const GATE_PATH = resolve(REPO_ROOT, "scripts/ci/works-after-gate.sh");
function gateExit(args, extraEnv = {}) {
  // Force WORKS_AFTER_GATE_ARMS empty by default so an inherited value can't
  // change the outcome; a case overrides it explicitly when testing the env.
  const env = { ...process.env, WORKS_AFTER_GATE_ARMS: "", ...extraEnv };
  return spawnSync("bash", [GATE_PATH, ...args], { encoding: "utf8", env }).status;
}

test("gate is fail-closed: malformed/empty arm selections exit 2 (never a false green)", () => {
  assert.equal(gateExit([]), 2, "no arm selection");
  assert.equal(gateExit(["--arms"]), 2, "trailing --arms with no value");
  assert.equal(gateExit(["--arms", ","]), 2, "comma-only resolves to zero arms");
  assert.equal(gateExit(["--arms", "  "]), 2, "whitespace-only resolves to zero arms");
  assert.equal(gateExit(["--arms", "bogus"]), 2, "unknown arm");
  assert.equal(gateExit(["--nope"]), 2, "unknown flag");
  assert.equal(gateExit([], { WORKS_AFTER_GATE_ARMS: "," }), 2, "comma-only via env");
});
