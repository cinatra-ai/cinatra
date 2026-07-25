/**
 * cinatra#2038 (S0) → cinatra#2040 (S2), epic #2037 — the changes_requested
 * disposition (S2 UNFENCES it), request validation, and the S2 repair-loop pure
 * cores (cycle guard, routing, lineage/base-revision CAS validation). Pure.
 */
import { describe, it, expect } from "vitest";

import {
  LIFECYCLE_REVIEW_DISPOSITIONS,
  isSelectableDisposition,
  isChangesRequestedFenced,
  validateChangesRequested,
  evaluateRepairCycle,
  routeChangesRequested,
  validateRepairLineage,
  MAX_REPAIR_CYCLES,
  type ChangesRequestedRequest,
  type RepairResponse,
} from "../lifecycle-repair";

describe("S2 (cinatra#2040): changes_requested is UNFENCED", () => {
  it("is present in the disposition vocabulary", () => {
    expect(LIFECYCLE_REVIEW_DISPOSITIONS).toContain("changes_requested");
  });
  it("is now SELECTABLE (S2 flipped the S0 fence)", () => {
    expect(isSelectableDisposition("changes_requested")).toBe(true);
    expect(isChangesRequestedFenced()).toBe(false);
  });
  it("every other disposition stays selectable", () => {
    expect(isSelectableDisposition("approve")).toBe(true);
    expect(isSelectableDisposition("reject")).toBe(true);
    expect(isSelectableDisposition("comment")).toBe(true);
  });
});

describe("changes_requested request validation", () => {
  function mk(over: Partial<ChangesRequestedRequest> = {}): ChangesRequestedRequest {
    return {
      gateId: "gate-1",
      decisionId: "dec-1",
      idempotencyKey: "idem-1",
      baseTarget: { artifactId: "art-1", representationRevisionId: "rev-1" },
      expectedBaseRevisionId: "rev-1",
      findings: [{ id: "f1", message: "fix the title" }],
      continuationMode: "async_effects_gated",
      continuationAddress: null,
      ...over,
    };
  }
  it("accepts a well-formed request", () => {
    expect(validateChangesRequested(mk()).ok).toBe(true);
  });
  it("requires at least one finding", () => {
    expect(validateChangesRequested(mk({ findings: [] })).ok).toBe(false);
  });
  it("rejects duplicate finding ids", () => {
    const r = validateChangesRequested(mk({ findings: [{ id: "f1", message: "a" }, { id: "f1", message: "b" }] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/duplicate finding/);
  });
  it("requires the expected-base CAS witness", () => {
    expect(validateChangesRequested(mk({ expectedBaseRevisionId: "" })).ok).toBe(false);
  });
});

describe("S2: repair cycle guard", () => {
  it("first attempt is within bound", () => {
    const v = evaluateRepairCycle(0);
    expect(v).toEqual({ attempt: 1, withinBound: true, escalate: false });
  });
  it("attempts up to the bound stay within bound; the next escalates", () => {
    expect(evaluateRepairCycle(MAX_REPAIR_CYCLES - 1).withinBound).toBe(true);
    const over = evaluateRepairCycle(MAX_REPAIR_CYCLES);
    expect(over.withinBound).toBe(false);
    expect(over.escalate).toBe(true);
    expect(over.attempt).toBe(MAX_REPAIR_CYCLES + 1);
  });
  it("respects a custom bound", () => {
    expect(evaluateRepairCycle(1, 2).escalate).toBe(false);
    expect(evaluateRepairCycle(2, 2).escalate).toBe(true);
  });
});

describe("S2: changes_requested routing", () => {
  it("a repair-capable producer implements the repair per its continuation mode", () => {
    expect(routeChangesRequested({ repairCapable: true, continuationMode: "checkpointed" })).toEqual({
      kind: "producer_repair",
      continuationMode: "checkpointed",
    });
  });
  it("a non-repairing producer with an org route routes there", () => {
    expect(
      routeChangesRequested({ repairCapable: false, continuationMode: "async_effects_gated", orgRepairRoute: "queue:repairs" }),
    ).toEqual({ kind: "org_repair_route", route: "queue:repairs" });
  });
  it("a non-repairing producer with no org route escalates to a human (never drops)", () => {
    const r = routeChangesRequested({ repairCapable: false, continuationMode: "async_effects_gated" });
    expect(r.kind).toBe("human_escalation");
  });
});

describe("S2: repair-response lineage + base-revision CAS validation", () => {
  const request: ChangesRequestedRequest = {
    gateId: "gate-1",
    decisionId: "dec-1",
    idempotencyKey: "idem-1",
    baseTarget: { artifactId: "art-1", representationRevisionId: "rev-1" },
    expectedBaseRevisionId: "rev-1",
    findings: [
      { id: "f1", message: "fix title" },
      { id: "f2", message: "fix intro" },
    ],
    continuationMode: "async_effects_gated",
    continuationAddress: null,
  };
  function mkResponse(over: Partial<RepairResponse> = {}): RepairResponse {
    return {
      gateId: "gate-1",
      baseTarget: { artifactId: "art-1", representationRevisionId: "rev-1" },
      successorTarget: { artifactId: "art-1", representationRevisionId: "rev-2" },
      findingOutcomes: [
        { findingId: "f1", applied: true },
        { findingId: "f2", applied: false, skipReason: "out of scope" },
      ],
      changeSummary: "retitled + trimmed intro",
      producerProvenance: { runId: "run-1", agentId: null },
      ...over,
    };
  }
  it("accepts a well-formed repair against the live base", () => {
    expect(validateRepairLineage({ request, response: mkResponse(), currentBaseRevisionId: "rev-1" }).ok).toBe(true);
  });
  it("rejects a moved base (CAS witness mismatch → stale)", () => {
    const r = validateRepairLineage({ request, response: mkResponse(), currentBaseRevisionId: "rev-9" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("stale-base");
  });
  it("rejects a tombstoned base", () => {
    const r = validateRepairLineage({ request, response: mkResponse(), currentBaseRevisionId: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("tombstoned-base");
  });
  it("rejects a base-target mismatch", () => {
    const r = validateRepairLineage({
      request,
      response: mkResponse({ baseTarget: { artifactId: "other", representationRevisionId: "rev-1" } }),
      currentBaseRevisionId: "rev-1",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("base-mismatch");
  });
  it("rejects a successor equal to the base", () => {
    const r = validateRepairLineage({
      request,
      response: mkResponse({ successorTarget: { artifactId: "art-1", representationRevisionId: "rev-1" } }),
      currentBaseRevisionId: "rev-1",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("successor-equals-base");
  });
  it("rejects an unmapped finding (missing outcome)", () => {
    const r = validateRepairLineage({
      request,
      response: mkResponse({ findingOutcomes: [{ findingId: "f1", applied: true }] }),
      currentBaseRevisionId: "rev-1",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("finding-unmapped");
  });
  it("rejects an outcome for an unknown finding", () => {
    const r = validateRepairLineage({
      request,
      response: mkResponse({
        findingOutcomes: [
          { findingId: "f1", applied: true },
          { findingId: "f2", applied: true },
          { findingId: "fX", applied: true },
        ],
      }),
      currentBaseRevisionId: "rev-1",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("finding-unknown");
  });
});
