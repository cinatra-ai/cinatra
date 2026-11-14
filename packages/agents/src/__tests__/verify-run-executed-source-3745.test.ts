/**
 * cinatra#3745: verifyRunExecutedSource mints a proof only for a step the bound
 * graph holds, and only for the values it compared with the bound policy (each
 * claimed value is read once, before any comparison).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
const h = vi.hoisted(() => ({ row: undefined as unknown }));
vi.mock("../schema", () => ({ agentRuns: { id: "id", orgId: "org" }, agentRunOutwardActionPolicies: { runId: "run", orgId: "org", policy: "policy" } }));
vi.mock("../db", () => ({ db: {
  transaction: () => { throw Error("not used"); },
  select: () => ({ from() { return this; }, innerJoin() { return this; }, where: async () => (h.row ? [h.row] : []) }),
} }));
vi.mock("../org-write-run-seam", () => ({ guardedRunWrite: async () => { throw Error("not used"); } }));
import { verifyRunExecutedSource } from "../run-step-tool-policy-store";

const source = JSON.stringify({
  component_type: "Flow", id: "flow",
  $referenced_components: {
    bridge: { component_type: "ApiNode", id: "step-1", url: "{{CINATRA_BASE_URL}}/api/llm-bridge" },
    other: { component_type: "ApiNode", id: "step-2", url: "{{CINATRA_BASE_URL}}/api/agents/passthrough" },
    end: { component_type: "EndNode", id: "end-1" },
  },
});
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const policy = { version: 1, contextId: "ctx", sourceSha256: "a".repeat(64), executedSourceSha256: "b".repeat(64), declarationSourceSha256: sha(source), source };
const claim = (stepId = "step-1") => ({ contextId: "ctx", stepId, sourceSha256: policy.sourceSha256,
  executedSourceSha256: policy.executedSourceSha256, declarationSourceSha256: policy.declarationSourceSha256 });
beforeEach(() => {
  h.row = { run: { id: "run", orgId: "org", status: "running", executionAttemptId: "attempt", a2aContextId: "ctx" },
    binding: { runId: "run", orgId: "org", executionAttemptId: "attempt", policy } };
});

describe("verifyRunExecutedSource: the step exists in the bound graph", () => {
  it("proves a step the bound graph holds (a model-bridge or a passthrough step)", async () => {
    for (const stepId of ["step-1", "step-2"]) {
      await expect(verifyRunExecutedSource("run", "org", claim(stepId))).resolves.toEqual({ ...claim(stepId), executionAttemptId: "attempt" });
    }
  });

  it("refuses a step id the bound graph does not hold, or that names no step of a call", async () => {
    for (const stepId of ["no-such-step", "end-1", "flow"]) {
      await expect(verifyRunExecutedSource("run", "org", claim(stepId))).rejects.toThrow("step_tool_step_unknown");
    }
  });
});

describe("verifyRunExecutedSource: the proof holds the values it compared", () => {
  it("reads each claimed value once, so a getter cannot answer the checks one value and the proof another", async () => {
    for (const field of ["contextId", "stepId", "sourceSha256", "executedSourceSha256", "declarationSourceSha256"] as const) {
      const base = claim();
      let reads = 0;
      const attestation = { ...base };
      Object.defineProperty(attestation, field, { enumerable: true, get: () => (reads++ === 0 ? base[field] : field === "stepId" ? "step-2" : "f".repeat(64)) });
      const proof = await verifyRunExecutedSource("run", "org", attestation);
      expect(proof).toEqual({ ...base, executionAttemptId: "attempt" });
      expect(reads).toBe(1);
    }
  });

  it("reads a proxy's claimed values once each", async () => {
    const base = claim();
    const seen = new Map<string | symbol, number>();
    const attestation = new Proxy({ ...base }, { get(target, key, receiver) {
      const n = seen.get(key) ?? 0; seen.set(key, n + 1);
      return n === 0 ? Reflect.get(target, key, receiver) : key === "contextId" ? "other-ctx" : Reflect.get(target, key, receiver);
    } });
    await expect(verifyRunExecutedSource("run", "org", attestation)).resolves.toEqual({ ...base, executionAttemptId: "attempt" });
    expect(seen.get("contextId")).toBe(1);
  });
});
