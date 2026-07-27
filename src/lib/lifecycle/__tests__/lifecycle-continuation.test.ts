/**
 * cinatra#2038 (epic #2037 S0) — the typed continuation contract: evaluate-then-
 * park, the park-resolution transitions, and the forced-strand guard. Pure.
 */
import { describe, it, expect } from "vitest";

import {
  evaluateThenPark,
  resolvePark,
  isStrandable,
} from "../lifecycle-continuation";
import type { PolicyDecision } from "../lifecycle-policy";

function decision(over: Partial<PolicyDecision>): PolicyDecision {
  return {
    outcome: "fire",
    fired: true,
    reason: "test",
    decidedBy: "core-default",
    ...over,
  };
}

describe("evaluate-then-park", () => {
  it("a checkpointed run whose policy SKIPS never parks", () => {
    const out = evaluateThenPark(decision({ outcome: "skip", fired: false }), {
      checkpoint: "review",
      destinationClass: "none",
    });
    expect(out.kind).toBe("proceed");
  });
  it("a FORBIDDEN checkpoint never parks", () => {
    const out = evaluateThenPark(decision({ outcome: "forbidden", fired: false }), {
      checkpoint: "review",
      destinationClass: "none",
    });
    expect(out.kind).toBe("proceed");
  });
  it("a FIRED checkpoint parks (no reevaluation intent)", () => {
    const out = evaluateThenPark(decision({ outcome: "fire", fired: true }), {
      checkpoint: "review",
      destinationClass: "external_publish",
    });
    expect(out.kind).toBe("park");
    if (out.kind === "park") {
      expect(out.reevaluationIntent).toBe(false);
      expect(out.protectedEffect).toBe("external_publish");
    }
  });
  it("a REQUIRED checkpoint parks", () => {
    const out = evaluateThenPark(decision({ outcome: "required", fired: true }), {
      checkpoint: "review",
      destinationClass: "none",
    });
    expect(out.kind).toBe("park");
  });
  it("policy_unresolved parks WITH a reevaluation intent", () => {
    const out = evaluateThenPark(decision({ outcome: "policy_unresolved", fired: false }), {
      checkpoint: "verification",
      destinationClass: "visibility_promotion",
    });
    expect(out.kind).toBe("park");
    if (out.kind === "park") expect(out.reevaluationIntent).toBe(true);
  });
});

describe("park resolution transitions", () => {
  it("released / resolved_skip → released, effect NOT blocked", () => {
    expect(resolvePark({ kind: "released" })).toMatchObject({ status: "released", effectBlocked: false });
    expect(resolvePark({ kind: "resolved_skip" })).toMatchObject({ status: "released", effectBlocked: false });
  });
  it("ttl_expired → policy_unresolved, effect BLOCKED (fail closed)", () => {
    expect(resolvePark({ kind: "ttl_expired" })).toMatchObject({ status: "policy_unresolved", effectBlocked: true });
  });
});

describe("forced-strand guard", () => {
  it("a still-parked park is NOT strandable", () => {
    expect(isStrandable({ status: "parked" })).toBe(false);
  });
  it("a terminal park is strandable", () => {
    expect(isStrandable({ status: "released" })).toBe(true);
    expect(isStrandable({ status: "policy_unresolved" })).toBe(true);
  });
});
