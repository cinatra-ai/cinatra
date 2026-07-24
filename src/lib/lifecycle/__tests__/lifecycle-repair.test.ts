/**
 * cinatra#2038 (epic #2037 S0) — the changes_requested + repair contract FENCE
 * (AC-4) and request validation. Pure.
 *
 * AC-4: `changes_requested` is present in the schema and UNSELECTABLE until S2.
 */
import { describe, it, expect } from "vitest";

import {
  LIFECYCLE_REVIEW_DISPOSITIONS,
  isSelectableDisposition,
  isChangesRequestedFenced,
  validateChangesRequested,
  type ChangesRequestedRequest,
} from "../lifecycle-repair";

describe("AC-4: changes_requested is present but fenced", () => {
  it("is present in the disposition vocabulary", () => {
    expect(LIFECYCLE_REVIEW_DISPOSITIONS).toContain("changes_requested");
  });
  it("is NOT selectable (fenced until S2)", () => {
    expect(isSelectableDisposition("changes_requested")).toBe(false);
    expect(isChangesRequestedFenced()).toBe(true);
  });
  it("every OTHER disposition is selectable today", () => {
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
