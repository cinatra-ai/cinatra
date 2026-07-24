/**
 * cinatra#2039 (epic #2037 S1) — the pure REVIEW-ORCHESTRATION core: the
 * idempotent auto-gate task id, the per-event review plan over the S0 lattice,
 * and the effects-gating verdict. Pure (no DB).
 */
import { describe, it, expect } from "vitest";

import {
  AUTO_REVIEW_TASK_PREFIX,
  autoReviewTaskId,
  autoReviewEventId,
  isAutoReviewTaskId,
  planReviewForEvent,
  evaluateEffectHold,
  type ProducedEventAxes,
  type ReviewOrchestrationContext,
} from "../lifecycle-orchestration";
import type { OrgPolicyRule } from "../lifecycle-policy";

function axes(over: Partial<ProducedEventAxes> = {}): ProducedEventAxes {
  return {
    eventId: over.eventId ?? "evt-1",
    artifactId: over.artifactId ?? "art-1",
    representationRevisionId: over.representationRevisionId ?? "rev-1",
    originKind: over.originKind ?? "agent_produced",
    destinationClass: over.destinationClass ?? "none",
    continuationMode: over.continuationMode ?? "async_effects_gated",
  };
}

function ctx(
  orgRule: OrgPolicyRule = { bound: "silent" },
  over: Partial<ReviewOrchestrationContext> = {},
): ReviewOrchestrationContext {
  return {
    artifactType: over.artifactType ?? "document",
    humanPresent: over.humanPresent ?? false,
    orgRule,
    manifest: over.manifest,
    elevation: over.elevation,
  };
}

describe("auto-gate task id", () => {
  it("prefixes with the auto marker and round-trips isAuto", () => {
    const id = autoReviewTaskId("evt-abc");
    expect(id).toBe(`${AUTO_REVIEW_TASK_PREFIX}evt-abc`);
    expect(isAutoReviewTaskId(id)).toBe(true);
  });
  it("is DISJOINT from the flow-authored wayflow- convention", () => {
    expect(isAutoReviewTaskId("wayflow-task-123")).toBe(false);
    expect(autoReviewTaskId("x").startsWith("wayflow-")).toBe(false);
  });
  it("is injective on the event id (distinct events never share a gate)", () => {
    expect(autoReviewTaskId("a")).not.toBe(autoReviewTaskId("b"));
  });
  it("autoReviewEventId is the exact inverse of autoReviewTaskId", () => {
    expect(autoReviewEventId(autoReviewTaskId("evt-xyz"))).toBe("evt-xyz");
    expect(autoReviewEventId("wayflow-task-1")).toBeNull();
  });
});

describe("planReviewForEvent", () => {
  it("agent-produced durable local artifact → create-gate (fire), async, holds NO effect", () => {
    const plan = planReviewForEvent(axes(), ctx());
    expect(plan.action).toBe("create-gate");
    if (plan.action !== "create-gate") return;
    expect(plan.outcome).toBe("fire");
    expect(plan.reviewTaskId).toBe(autoReviewTaskId("evt-1"));
    expect(plan.continuationMode).toBe("async_effects_gated");
    expect(plan.park).toBeNull();
    expect(plan.heldEffect).toBeNull(); // destination 'none' → nothing to hold
    expect(plan.separationOfDutiesRequired).toBe(false);
  });

  it("user-provided durable local artifact → no-gate (skip)", () => {
    const plan = planReviewForEvent(axes({ originKind: "user_provided" }), ctx());
    expect(plan.action).toBe("no-gate");
  });

  it("intermediate artifact → no-gate (skip)", () => {
    const plan = planReviewForEvent(axes({ originKind: "intermediate" }), ctx());
    expect(plan.action).toBe("no-gate");
  });

  it("external-effect artifact → create-gate that HOLDS the effect class (async)", () => {
    const plan = planReviewForEvent(
      axes({ destinationClass: "external_publish", originKind: "user_provided" }),
      ctx(),
    );
    expect(plan.action).toBe("create-gate");
    if (plan.action !== "create-gate") return;
    expect(plan.heldEffect).toBe("external_publish");
  });

  it("org-REQUIRED bound → create-gate required + SoD (no self-approval opt-in)", () => {
    const plan = planReviewForEvent(axes(), ctx({ bound: "required" }));
    expect(plan.action).toBe("create-gate");
    if (plan.action !== "create-gate") return;
    expect(plan.outcome).toBe("required");
    expect(plan.separationOfDutiesRequired).toBe(true);
  });

  it("org-REQUIRED with self-approval opt-in → required WITHOUT SoD", () => {
    const plan = planReviewForEvent(axes(), ctx({ bound: "required", selfApprovalOptIn: true }));
    expect(plan.action).toBe("create-gate");
    if (plan.action !== "create-gate") return;
    expect(plan.separationOfDutiesRequired).toBe(false);
  });

  it("org-FORBIDDEN bound → no-gate (a hard non-fire, even for agent_produced)", () => {
    const plan = planReviewForEvent(axes(), ctx({ bound: "forbidden" }));
    expect(plan.action).toBe("no-gate");
  });

  it("CHECKPOINTED mode on a fired review → the plan PARKS the run", () => {
    const plan = planReviewForEvent(axes({ continuationMode: "checkpointed" }), ctx());
    expect(plan.action).toBe("create-gate");
    if (plan.action !== "create-gate") return;
    expect(plan.continuationMode).toBe("checkpointed");
    expect(plan.park?.kind).toBe("park");
  });

  it("a manifest skip is honored where the org is silent + class non-external", () => {
    const plan = planReviewForEvent(
      axes(),
      ctx({ bound: "silent" }, { manifest: { requestedSkips: ["review"] } }),
    );
    expect(plan.action).toBe("no-gate");
  });

  it("a manifest skip is IGNORED on an external-effect class (fail-closed)", () => {
    const plan = planReviewForEvent(
      axes({ destinationClass: "visibility_promotion", originKind: "user_provided" }),
      ctx({ bound: "silent" }, { manifest: { requestedSkips: ["review"] } }),
    );
    expect(plan.action).toBe("create-gate");
  });
});

describe("evaluateEffectHold", () => {
  it("no produced event → NOT held (ungated artifact's effects flow)", () => {
    expect(evaluateEffectHold({ event: null, gateStatus: null }).held).toBe(false);
  });

  it("non-external (none) destination → NOT held", () => {
    const v = evaluateEffectHold({
      event: { destinationClass: "none", status: "processed", continuationAddress: null },
      gateStatus: null,
    });
    expect(v.held).toBe(false);
  });

  it("external + still PENDING (not yet orchestrated) → HELD (fail-closed)", () => {
    const v = evaluateEffectHold({
      event: { destinationClass: "external_publish", status: "pending", continuationAddress: null },
      gateStatus: null,
    });
    expect(v.held).toBe(true);
  });

  it("external + orchestrated + NO gate (org-forbidden) → NOT held (permitted)", () => {
    const v = evaluateEffectHold({
      event: { destinationClass: "external_publish", status: "processed", continuationAddress: null },
      gateStatus: null,
    });
    expect(v.held).toBe(false);
  });

  it("external + orchestrated + PENDING gate → HELD", () => {
    const v = evaluateEffectHold({
      event: { destinationClass: "pipeline_handoff", status: "processed", continuationAddress: "gate-1" },
      gateStatus: "pending",
    });
    expect(v.held).toBe(true);
  });

  it("external + orchestrated + RESOLVED gate → NOT held (released)", () => {
    const v = evaluateEffectHold({
      event: { destinationClass: "visibility_promotion", status: "processed", continuationAddress: "gate-1" },
      gateStatus: "resolved",
    });
    expect(v.held).toBe(false);
  });
});
