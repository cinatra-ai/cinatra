/**
 * cinatra#2039 (epic #2037 S1) — the pure REVIEW-ORCHESTRATION core: the
 * idempotent auto-gate task id, the per-event review plan over the S0 lattice,
 * and the effects-gating verdict. Pure (no DB).
 */
import { describe, it, expect } from "vitest";

import {
  AUTO_REVIEW_TASK_PREFIX,
  AUTO_REVIEW_BATCH_PREFIX,
  autoReviewTaskId,
  autoReviewEventId,
  isAutoReviewTaskId,
  isBatchAutoReviewTaskId,
  batchPartitionReviewTaskId,
  planReviewForEvent,
  evaluateEffectHold,
  type ProducedEventAxes,
  type ReviewOrchestrationContext,
} from "../lifecycle-orchestration";
import type { OrgPolicyRule } from "../lifecycle-policy";
import type { BatchTarget } from "../lifecycle-batch";

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

describe("batch partition gate task id", () => {
  const t = (a: string, r: string): BatchTarget => ({ artifactId: a, representationRevisionId: r });

  it("carries the batch prefix, which is itself an AUTO task id (superset) but NOT wayflow", () => {
    const id = batchPartitionReviewTaskId([t("a", "1"), t("b", "2")]);
    expect(id.startsWith(AUTO_REVIEW_BATCH_PREFIX)).toBe(true);
    expect(isBatchAutoReviewTaskId(id)).toBe(true);
    // a batch gate is still an auto-gate (the expiry drain reasons over it; the
    // resume-delivery worker skips it, being non-wayflow).
    expect(isAutoReviewTaskId(id)).toBe(true);
    expect(id.startsWith("wayflow-")).toBe(false);
  });

  it("is DETERMINISTIC on the target SET — order-independent, replay-stable", () => {
    const forward = batchPartitionReviewTaskId([t("a", "1"), t("b", "2"), t("c", "3")]);
    const reversed = batchPartitionReviewTaskId([t("c", "3"), t("b", "2"), t("a", "1")]);
    expect(forward).toBe(reversed);
  });

  it("distinct partitions never collide, and injective across the id-join boundary", () => {
    expect(batchPartitionReviewTaskId([t("a", "1")])).not.toBe(
      batchPartitionReviewTaskId([t("a", "2")]),
    );
    // length-prefixed key: {a, "b:c"} must not collide with {"a:b", c}.
    expect(batchPartitionReviewTaskId([t("a", "b:c")])).not.toBe(
      batchPartitionReviewTaskId([t("a:b", "c")]),
    );
  });

  it("a batch task id encodes NO single event id (autoReviewEventId returns null)", () => {
    const id = batchPartitionReviewTaskId([t("a", "1")]);
    expect(autoReviewEventId(id)).toBeNull();
    // a plain single-event auto id is NOT a batch id.
    expect(isBatchAutoReviewTaskId(autoReviewTaskId("evt-1"))).toBe(false);
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

  it("org-REQUIRED bound → create-gate required, and the plan says nothing about WHO may decide", () => {
    const plan = planReviewForEvent(axes(), ctx({ bound: "required" }));
    expect(plan.action).toBe("create-gate");
    if (plan.action !== "create-gate") return;
    expect(plan.outcome).toBe("required");
    // cinatra#2047 row-3 re-scope: a bound decides whether a review is required,
    // never who is eligible to decide it.
    for (const key of Object.keys(plan)) {
      expect(key).not.toMatch(/separation|selfApproval|eligib|reviewer/i);
    }
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

  // ── D-7 (cinatra#2047): the TTL-expired park's terminal block lands ON THE
  // EFFECT. S0's continuation contract: "TTL always-resumes with the protected
  // effect in a terminal `policy_unresolved` blocked state." Before this the
  // block existed only as a park-row status and the effect layer never consulted
  // it, so the always-resume path released an effect whose policy was never
  // resolved.
  it("D-7: external + a TTL-expired policy_unresolved PARK → HELD terminally, even with a RESOLVED gate", () => {
    const v = evaluateEffectHold({
      event: { destinationClass: "external_publish", status: "processed", continuationAddress: "gate-1" },
      gateStatus: "resolved",
      gateDisposition: "approve",
      policyUnresolvedPark: true,
    });
    expect(v.held).toBe(true);
    expect(v.policyUnresolved).toBe(true);
    expect(v.reason).toContain("policy_unresolved");
  });

  it("D-7: the park block OUTRANKS a pending gate (same terminal reason, not the ordinary hold)", () => {
    const v = evaluateEffectHold({
      event: { destinationClass: "pipeline_handoff", status: "processed", continuationAddress: "gate-1" },
      gateStatus: "pending",
      policyUnresolvedPark: true,
    });
    expect(v.held).toBe(true);
    expect(v.policyUnresolved).toBe(true);
  });

  it("D-7: a park block on a NON-external (none) destination holds nothing", () => {
    const v = evaluateEffectHold({
      event: { destinationClass: "none", status: "processed", continuationAddress: null },
      gateStatus: null,
      policyUnresolvedPark: true,
    });
    expect(v.held).toBe(false);
    expect(v.policyUnresolved).toBeUndefined();
  });

  it("D-7: no park ⇒ the verdict is unchanged (no policyUnresolved flag)", () => {
    const v = evaluateEffectHold({
      event: { destinationClass: "external_publish", status: "processed", continuationAddress: "gate-1" },
      gateStatus: "resolved",
      gateDisposition: "approve",
      policyUnresolvedPark: false,
    });
    expect(v.held).toBe(false);
    expect(v.policyUnresolved).toBeUndefined();
  });
});
