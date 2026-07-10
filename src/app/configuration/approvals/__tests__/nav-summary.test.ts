/**
 * Unit proof for the registry-driven sidebar Approvals summary
 * (`summarizeApprovalsNav`), the pure core behind cinatra#1047.
 *
 * Acceptance covered, all with MOCK sources and NO sidebar / registry / DB /
 * session dependency (the reducer takes a source list + viewer):
 *  - admin badge = the sum of every source's Inbox count; visibility on when an
 *    actionable Inbox applies (even at zero pending — count-independent);
 *  - a READ-ONLY source (inboxActionable:false, e.g. the workflow passthrough)
 *    that applies to a non-admin's Inbox and even has a POSITIVE count does NOT
 *    light the nav — preserving v1's admin-only nav;
 *  - adding a mock source changes BOTH the badge total and the visibility with
 *    no sidebar edit — including a future source that grants a NON-ADMIN an
 *    actionable Inbox, which lights the nav;
 *  - one failing/slow source soft-fails to 0 without blanking the others or
 *    breaking visibility;
 *  - no available sources → hidden + zero.
 */
import { describe, it, expect } from "vitest";

import { summarizeApprovalsNav } from "../nav-summary";
import type { ApprovalSource, ApprovalViewer, SourceCounts } from "../sources/types";

const ADMIN: ApprovalViewer = { userId: "admin-1", orgId: "org-1", isAdmin: true };
const MEMBER: ApprovalViewer = { userId: "member-1", orgId: "org-1", isAdmin: false };

/** Build a minimal valid ApprovalSource; only the fields the reducer reads
 *  (appliesTo, inboxActionable, counts) are meaningful — the rest satisfy the
 *  contract. `counts` may throw to exercise the per-source soft-fail. */
function makeSource(opts: {
  id: string;
  inboxActionable?: boolean;
  appliesInbox: (v: ApprovalViewer) => boolean;
  counts: (v: ApprovalViewer) => SourceCounts | Promise<SourceCounts>;
}): ApprovalSource {
  return {
    id: opts.id,
    title: opts.id,
    ...(opts.inboxActionable === undefined ? {} : { inboxActionable: opts.inboxActionable }),
    availability: () => "ready",
    appliesTo: (v, dir) => (dir === "inbox" ? opts.appliesInbox(v) : true),
    fetchInbox: async () => ({ availability: "ready", rows: [], actions: [] }),
    fetchMine: async () => ({ availability: "ready", rows: [], actions: [] }),
    counts: async (v) => opts.counts(v),
    rowRenderer: () => null,
    actions: { decide: async () => ({ ok: true }) },
  };
}

// The two v1 sources, modeled from the merged registry behavior.
const agentSource = makeSource({
  id: "agent-creation-requests",
  appliesInbox: (v) => v.isAdmin, // admin-only inbox
  counts: (v) => ({ inbox: v.isAdmin ? 3 : 0, mine: 1 }), // self-gating
});
const workflowPassthrough = makeSource({
  id: "workflow-legacy",
  inboxActionable: false, // read-only mirror
  appliesInbox: () => true, // applies to EVERY org member's inbox
  counts: () => ({ inbox: 2, mine: 0 }), // org-wide, all viewers
});

describe("summarizeApprovalsNav", () => {
  it("admin: visible with the summed Inbox total across sources", async () => {
    const s = await summarizeApprovalsNav([agentSource, workflowPassthrough], ADMIN);
    expect(s.visible).toBe(true);
    expect(s.total).toBe(5); // 3 agent + 2 workflow
  });

  it("non-admin with only the read-only passthrough: NOT visible, even though its count is positive", async () => {
    const s = await summarizeApprovalsNav([agentSource, workflowPassthrough], MEMBER);
    // Passthrough applies to the member's inbox but is inboxActionable:false;
    // the agent inbox does not apply to a non-admin → no actionable source.
    expect(s.visible).toBe(false);
    // The badge would still be non-zero (workflow org-wide count) — moot while
    // the nav is hidden, and it matches today's pendingApprovalsCount semantics.
    expect(s.total).toBe(2);
  });

  it("admin sees the nav even at ZERO pending (visibility is count-independent)", async () => {
    const emptyAgent = makeSource({
      id: "agent-creation-requests",
      appliesInbox: (v) => v.isAdmin,
      counts: () => ({ inbox: 0, mine: 0 }),
    });
    const s = await summarizeApprovalsNav([emptyAgent], ADMIN);
    expect(s.visible).toBe(true);
    expect(s.total).toBe(0);
  });

  it("a future source that grants a NON-ADMIN an actionable Inbox lights the nav (no sidebar edit)", async () => {
    const projectAgentGate = makeSource({
      id: "project-agent-gate",
      appliesInbox: () => true, // applies to members
      counts: () => ({ inbox: 4, mine: 0 }), // actionable (inboxActionable defaults on)
    });
    const before = await summarizeApprovalsNav([agentSource, workflowPassthrough], MEMBER);
    const after = await summarizeApprovalsNav(
      [agentSource, workflowPassthrough, projectAgentGate],
      MEMBER,
    );
    // Adding a source flips visibility AND changes the total — both derived from
    // the source list alone.
    expect(before.visible).toBe(false);
    expect(after.visible).toBe(true);
    expect(after.total).toBe(before.total + 4);
  });

  it("soft-fails a throwing source to 0 without blanking siblings or breaking visibility", async () => {
    const flaky = makeSource({
      id: "remote-flaky",
      appliesInbox: () => true,
      counts: () => {
        throw new Error("remote down");
      },
    });
    const s = await summarizeApprovalsNav([agentSource, flaky], ADMIN);
    expect(s.total).toBe(3); // agent 3 + flaky treated as 0
    expect(s.visible).toBe(true); // agent (admin, actionable) still lights it
  });

  it("no available sources → hidden + zero", async () => {
    const s = await summarizeApprovalsNav([], MEMBER);
    expect(s).toEqual({ total: 0, visible: false });
  });
});
