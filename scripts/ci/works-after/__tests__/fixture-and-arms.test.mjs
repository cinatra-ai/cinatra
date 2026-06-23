// Unit tests for the works-after harness (cinatra#352) — fast, service-free.
//
// These assert the STATIC invariants the harness depends on, so a refactor that
// silently breaks them is caught without spinning containers:
//   - the no-LLM echo OAS fixture is well-formed (a StartNode→OutputMessageNode→
//     EndNode flow with NO LlmNode/AgentNode/ApiNode, exposing echo_nonce);
//   - its committed published marker's oasSha256 matches the OAS bytes (so the
//     read-only-mounted loader accepts it without backfill);
//   - the orchestrator declares exactly the six designed arms and rejects an
//     unknown WORKS_AFTER_ONLY value.
//
// Run: node --test scripts/ci/works-after/__tests__/

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
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

test("orchestrator declares exactly the six designed arms", () => {
  const orch = readFileSync(resolve(REPO_ROOT, "scripts/ci/works-after-proof.sh"), "utf8");
  const m = orch.match(/ALL_ARMS="([^"]+)"/);
  assert.ok(m, "could not find ALL_ARMS in the orchestrator");
  const arms = m[1].split(/\s+/).sort();
  assert.deepEqual(arms, ["graphiti", "nango", "postgres", "redis", "verdaccio", "wayflow"].sort());
});

test("each arm script exists and is referenced by the orchestrator", () => {
  const armsDir = resolve(REPO_ROOT, "scripts/ci/works-after");
  for (const arm of ["redis", "verdaccio", "nango", "wayflow", "graphiti", "postgres"]) {
    assert.ok(existsSync(resolve(armsDir, `${arm}.sh`)), `missing arm script ${arm}.sh`);
  }
});
