/**
 * THE BINDER ACTUALLY SUPPLIES THE HISTORICAL READERS (enabler 0.9 of
 * `PLAN: Agents Lifecycle (C)`, cinatra#3027 / epic #3023).
 *
 * WHY THIS FILE EXISTS. The core consults `readArtifactHistorical` and
 * `revisionMemberHistorical` only when the binder supplies them, and falls back
 * to the live readers when it does not — deliberately, so a binder that has not
 * adopted the enabler keeps the pre-0.9 behaviour. That fallback is also the
 * failure mode nothing else would notice: a port bound inside the function but
 * left out of the object it returns makes every core-level case pass while the
 * settled card on the real surface floors at `unknown-or-tombstoned`. This file
 * pins the wiring itself, which no fixture can stand in for.
 */
import { describe, expect, it } from "vitest";

import type { ActorContext } from "@/lib/authz/actor-context";

import { bindArtifactReviewPorts } from "../review-target-prepare";

const actor = { actorType: "human", userId: "u" } as unknown as ActorContext;

describe("the review binder — the settled reading's two ports are bound, not merely written", () => {
  it("supplies BOTH historical readers alongside the live ones", () => {
    const ports = bindArtifactReviewPorts({ orgId: "org_3027", actor });
    expect(typeof ports.readArtifact).toBe("function");
    expect(typeof ports.revisionMember).toBe("function");
    // The two the settled reading needs. Either one missing silently reverts
    // that half of the enabler to the live reading.
    expect(typeof ports.readArtifactHistorical).toBe("function");
    expect(typeof ports.revisionMemberHistorical).toBe("function");
  });

  it("keeps the live and historical readers DISTINCT functions", () => {
    // The same function bound twice would mean the live reading had quietly
    // gained the tombstone replay — the opposite mistake, and the dangerous one.
    const ports = bindArtifactReviewPorts({ orgId: "org_3027", actor });
    expect(ports.readArtifactHistorical).not.toBe(ports.readArtifact);
    expect(ports.revisionMemberHistorical).not.toBe(ports.revisionMember);
  });
});
