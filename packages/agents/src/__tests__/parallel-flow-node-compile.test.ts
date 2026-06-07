/**
 * `ParallelFlowNode` TS compiler support.
 *
 * Validates that an OAS Flow containing a `ParallelFlowNode` with two
 * deterministic sub-Flows passes structural validation, without
 * contributing any approval steps (the parallel container itself is
 * structural; its children inside subflows execute natively in WayFlow
 * without Cinatra approval translation). The compile-from-disk path
 * (`compileOasAgentJson`) is exercised via a tmp-dir fixture so the
 * full happy path is covered.
 *
 * Runtime concurrency is verified separately by a Docker smoke test
 * against the WayFlow container — that's the canonical signal for
 * "actually executes in parallel vs serialized at runtime." This test
 * just proves the TS compiler accepts the construct.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileOasAgentJson, validateOasFlowStructural } from "../oas-compiler";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const FIXTURE_PATH = path.join(
  __dirname,
  "fixtures",
  "parallel-flow-node-spike.oas.json",
);

function loadFixture(): Record<string, unknown> {
  const raw = fs.readFileSync(FIXTURE_PATH, "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("ParallelFlowNode — TS compiler support", () => {
  let tmpAgentJsonPath: string;

  beforeEach(async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "parallel-flow-spike-"));
    tmpAgentJsonPath = path.join(dir, "oas.json");
    const raw = fs.readFileSync(FIXTURE_PATH, "utf-8");
    await fsp.writeFile(tmpAgentJsonPath, raw);
  });

  afterEach(async () => {
    try {
      await fsp.rm(path.dirname(tmpAgentJsonPath), { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it("validateOasFlowStructural accepts a ParallelFlowNode-bearing Flow", () => {
    const oas = loadFixture();
    const errors = validateOasFlowStructural(oas);
    expect(errors).toEqual([]);
  });

  it("compileOasAgentJson returns ok=true for the fixture OAS", async () => {
    const result = await compileOasAgentJson({
      packageName: "@cinatra/parallel-flow-node-spike",
      agentJsonPath: tmpAgentJsonPath,
    });
    expect(result.ok).toBe(true);
  });

  it("the ParallelFlowNode container contributes ZERO approval-policy steps", async () => {
    // Each subflow contains only ApiNodes (non-steppable). The parent's
    // approvalPolicy.steps must therefore be empty — proving the structural
    // transparency contract.
    const result = await compileOasAgentJson({
      packageName: "@cinatra/parallel-flow-node-spike",
      agentJsonPath: tmpAgentJsonPath,
    });
    if (!result.ok) {
      throw new Error(`unexpected compile error: ${result.error}`);
    }
    expect(result.value.approvalPolicy.steps).toEqual([]);
  });

  it("compiled output preserves the top-level Flow's outputs (lane_*_started_at)", async () => {
    const result = await compileOasAgentJson({
      packageName: "@cinatra/parallel-flow-node-spike",
      agentJsonPath: tmpAgentJsonPath,
    });
    if (!result.ok) {
      throw new Error(`unexpected compile error: ${result.error}`);
    }
    const outputSchema = result.value.outputSchema as
      | { properties?: Record<string, unknown> }
      | undefined;
    expect(outputSchema?.properties).toBeDefined();
    expect(outputSchema!.properties).toHaveProperty("lane_a_started_at");
    expect(outputSchema!.properties).toHaveProperty("lane_b_started_at");
  });

  it("ParallelFlowNode is filtered out of the steppable approval-policy walk", async () => {
    // If a future change accidentally adds ParallelFlowNode to the steppable
    // filter, the compiler's assertHandledComponentType would throw with a
    // clear error. This test exercises the negative path: the fixture
    // produces ok=true because ParallelFlowNode is structural and skipped.
    // Should the filter ever include it, the error surface kicks in clearly.
    const result = await compileOasAgentJson({
      packageName: "@cinatra/parallel-flow-node-spike",
      agentJsonPath: tmpAgentJsonPath,
    });
    expect(result.ok).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Schema is LIVE — these tests prove the parallelFlowNodeSchema actually
  // runs against `$referenced_components` (not dead code). The schema
  // definition alone is meaningless without an active validator pass; these
  // tests pin the wiring.
  // ---------------------------------------------------------------------------

  it("rejects a ParallelFlowNode with empty subflows[]", () => {
    const oas = loadFixture();
    // Empty subflows[] violates the spec's min(1) requirement.
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    refs.parallel.subflows = [];
    const errors = validateOasFlowStructural(oas);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("parallel") && e.includes("subflows"))).toBe(true);
  });

  it("rejects a ParallelFlowNode missing the required `name` field", () => {
    const oas = loadFixture();
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    delete (refs.parallel as Record<string, unknown>).name;
    const errors = validateOasFlowStructural(oas);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("parallel") && e.includes("name"))).toBe(true);
  });

  it("accepts a ParallelFlowNode with an INLINE Flow object in subflows (spec-compliant)", () => {
    // Per OAS 26.1.0 spec, `subflows: List[Flow]` where Flow can be either
    // a $component_ref OR an inline BaseFlow object. The schema permits
    // both via `z.union([componentRefSchema, z.record(z.string(), z.unknown())])`.
    const oas = loadFixture();
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    refs.parallel.subflows = [
      // First subflow as a ref (existing pattern)
      { "$component_ref": "lane_a_flow" },
      // Second as an inline object (also spec-compliant)
      { component_type: "Flow", id: "inline_lane", name: "Inline Lane" },
    ];
    const errors = validateOasFlowStructural(oas);
    expect(errors).toEqual([]);
  });
});
