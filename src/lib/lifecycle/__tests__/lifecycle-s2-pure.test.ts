/**
 * cinatra#2040 (epic #2037 S2) — pure S2 additions beyond the repair contract:
 *   - the DURABLE batch-epoch membership hash (order-independent, growth-sensitive);
 *   - the repair-successor gate task ids (disjoint, injective);
 *   - the disposition-aware effect-hold (a changes_requested gate keeps HOLDING).
 * Pure.
 */
import { describe, it, expect } from "vitest";

import { batchMembershipHash, type BatchTarget } from "../lifecycle-batch";
import {
  repairSuccessorReviewTaskId,
  isRepairSuccessorTaskId,
  isAutoReviewTaskId,
  isBatchAutoReviewTaskId,
  autoReviewEventId,
  evaluateEffectHold,
} from "../lifecycle-orchestration";

const t = (a: string, r: string): BatchTarget => ({ artifactId: a, representationRevisionId: r });

describe("S2: durable batch-epoch membership hash", () => {
  it("is order-INDEPENDENT (the same set hashes identically)", () => {
    const a = batchMembershipHash([t("x", "1"), t("y", "2"), t("z", "3")]);
    const b = batchMembershipHash([t("z", "3"), t("x", "1"), t("y", "2")]);
    expect(a).toBe(b);
  });
  it("is GROWTH-sensitive (a new revision hashes DIFFERENTLY → a successor epoch)", () => {
    const frozen = batchMembershipHash([t("x", "1"), t("y", "2")]);
    const grown = batchMembershipHash([t("x", "1"), t("y", "2"), t("z", "3")]);
    expect(frozen).not.toBe(grown);
  });
  it("is injective across the artifact/revision boundary", () => {
    expect(batchMembershipHash([t("a", "bc")])).not.toBe(batchMembershipHash([t("ab", "c")]));
  });
});

describe("S2: repair-successor gate task ids", () => {
  it("is recognized as an auto-gate task but NOT a batch task", () => {
    const id = repairSuccessorReviewTaskId("repair-1", 1);
    expect(isRepairSuccessorTaskId(id)).toBe(true);
    expect(isAutoReviewTaskId(id)).toBe(true); // the expiry drain reasons over it
    expect(isBatchAutoReviewTaskId(id)).toBe(false);
  });
  it("encodes no single event id (re-derived from pinned targets, like a batch)", () => {
    expect(autoReviewEventId(repairSuccessorReviewTaskId("repair-1", 2))).toBeNull();
  });
  it("is injective on (repairId, attempt)", () => {
    expect(repairSuccessorReviewTaskId("r", 1)).not.toBe(repairSuccessorReviewTaskId("r", 2));
    expect(repairSuccessorReviewTaskId("r1", 1)).not.toBe(repairSuccessorReviewTaskId("r2", 1));
  });
});

describe("S2: disposition-aware effect-hold", () => {
  const externalEvent = { destinationClass: "external_publish" as const, status: "processed", continuationAddress: "gate-1" };

  it("a changes_requested gate KEEPS HOLDING the effect (repair in flight)", () => {
    const v = evaluateEffectHold({ event: externalEvent, gateStatus: "resolved", gateDisposition: "changes_requested" });
    expect(v.held).toBe(true);
  });
  it("an approve-resolved gate RELEASES the effect", () => {
    const v = evaluateEffectHold({ event: externalEvent, gateStatus: "resolved", gateDisposition: "approve" });
    expect(v.held).toBe(false);
  });
  it("a reject-resolved gate does not hold (a tombstoned artifact publishes nothing)", () => {
    const v = evaluateEffectHold({ event: externalEvent, gateStatus: "resolved", gateDisposition: "reject" });
    expect(v.held).toBe(false);
  });
  it("a pending gate still holds regardless of disposition", () => {
    const v = evaluateEffectHold({ event: externalEvent, gateStatus: "pending", gateDisposition: null });
    expect(v.held).toBe(true);
  });
});
