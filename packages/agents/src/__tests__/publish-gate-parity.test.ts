/**
 * cinatra#4150 PR 4 (A3): the gate ids the host derives equal the gate ids the
 * runtime loader inserts.
 *
 * The host never builds a publish gate. The flow runtime's loader inserts one
 * host-owned gate, `cinatra_publish_gate__<node>`, in front of each node a pack
 * declares `metadata.cinatra.publishes: true`, and the host derives the same id
 * from the compiler's `publishingSteps`. Both sides read ONE fixture,
 * `docker/wayflow/tests/fixtures/publish_gate_parity.json`: the loader's tests
 * (`docker/wayflow/tests/test_publish_gate_insert.py` and
 * `test_repo_agents_load.py`) assert that the gates inserted are
 * `gatePrefix + step` for each listed step, and this file asserts that the
 * compiler lists exactly those steps and reserves exactly that prefix.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/publish-gate-parity.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectPublishingSteps, compileOasAgentJson, __resetRegistryCacheForTests } from "../oas-compiler";

type ParityCase = { name: string; publishingSteps: string[]; flow: Record<string, unknown> };
type ParityFixture = { gatePrefix: string; flows: ParityCase[] };

const FIXTURE = path.resolve(__dirname, "../../../../docker/wayflow/tests/fixtures/publish_gate_parity.json");
const parity = JSON.parse(readFileSync(FIXTURE, "utf8")) as ParityFixture;

let tempDir: string;
beforeEach(() => {
  __resetRegistryCacheForTests();
  tempDir = mkdtempSync(path.join(tmpdir(), "gate4150-"));
});
afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

async function compiledPublishingSteps(flow: Record<string, unknown>): Promise<string[]> {
  const p = path.join(tempDir, "agent.json");
  writeFileSync(p, JSON.stringify(flow, null, 2));
  const res = await compileOasAgentJson({
    packageName: "@cinatra-ai/publish-gate-parity-fixture",
    oasSourcePath: p,
    registryPath: path.join(tempDir, "components.json"),
  });
  expect(res.ok, res.ok ? "" : res.error).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  return res.value.publishingSteps;
}

describe("cinatra#4150 PR 4: host-derived gate ids equal the loader's (A3)", () => {
  it("the fixture holds both publish pack shapes and a flow with two publishing steps", () => {
    expect(parity.flows.map((f) => f.name)).toEqual([
      "wordpress-publish-shape",
      "linkedin-publish-shape",
      "two-publishing-steps",
    ]);
  });

  it.each(parity.flows.map((f) => [f.name, f] as const))(
    "%s: the compiled publishingSteps are the fixture's, so the derived gate ids are the ones the loader inserts",
    async (_name, c) => {
      const steps = await compiledPublishingSteps(c.flow);
      expect(steps).toEqual(c.publishingSteps);
      expect(steps.map((s) => `${parity.gatePrefix}${s}`)).toEqual(
        c.publishingSteps.map((s) => `cinatra_publish_gate__${s}`),
      );
    },
  );

  it("the fixture's gate prefix is the one the compiler reserves: a pack node may not take it", () => {
    expect(parity.gatePrefix).toBe("cinatra_publish_gate__");
    const flow = JSON.parse(JSON.stringify(parity.flows[0]!.flow)) as {
      nodes: Array<{ $component_ref: string }>;
      $referenced_components: Record<string, Record<string, unknown>>;
    };
    const id = `${parity.gatePrefix}publish`;
    flow.$referenced_components[id] = { component_type: "ApiNode", id, name: id };
    flow.nodes.push({ $component_ref: id });
    const res = collectPublishingSteps(flow as unknown as Record<string, unknown>);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toMatch(/^RESERVED_NODE_ID: /);
    // One character short of the prefix is not reserved.
    const near = JSON.parse(JSON.stringify(parity.flows[0]!.flow)) as typeof flow;
    const nearId = `${parity.gatePrefix.slice(0, -1)}publish`;
    near.$referenced_components[nearId] = { component_type: "ApiNode", id: nearId, name: nearId };
    near.nodes.push({ $component_ref: nearId });
    expect(collectPublishingSteps(near as unknown as Record<string, unknown>).ok).toBe(true);
  });
});
