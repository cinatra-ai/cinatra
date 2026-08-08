/**
 * Unit proof for the registry-driven sidebar Approvals summary
 * (`summarizeApprovalsNav`), the pure core behind cinatra#1047.
 *
 * Acceptance covered, all with MOCK sources and NO sidebar / registry / DB /
 * session dependency (the reducer takes a source list + viewer):
 *  - admin badge = the sum of every source's Inbox count; visibility on when an
 *    actionable Inbox applies (even at zero pending — count-independent);
 *  - a READ-ONLY source (inboxActionable:false, e.g. the workflow passthrough)
 *    that applies to a non-admin's Inbox and even has a POSITIVE Inbox count does
 *    NOT, on its own, light the nav;
 *  - a NON-ADMIN with an own request in flight (`mine > 0`) IS visible via the
 *    option-b mine path (owner review #1302 ask 5); a member with nothing of
 *    their own stays hidden;
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

  it("non-admin WITH an own request in flight: visible via the option-b mine path (owner #1302 ask 5)", async () => {
    // agentSource has no actionable Inbox for a member, and the passthrough is a
    // read-only mirror — so pre-#1302 the member saw nothing. Now a member with
    // an own request (agentSource `mine: 1`) reaches the Approvals surface to
    // track it, even though no Inbox source is actionable for them.
    const s = await summarizeApprovalsNav([agentSource, workflowPassthrough], MEMBER);
    expect(s.visible).toBe(true);
    // The Inbox pill total is the member's actionable Inbox count only (0 agent +
    // 2 org-wide passthrough) — unchanged; visibility now rides `mine`, not it.
    expect(s.total).toBe(2);
  });

  it("non-admin with NO own request and only the read-only passthrough: NOT visible", async () => {
    // No actionable Inbox source AND mine === 0 across sources → still hidden, so
    // the option-b path does not light the nav for a member with nothing of theirs.
    const memberNoOwn = makeSource({
      id: "agent-creation-requests",
      appliesInbox: (v) => v.isAdmin,
      counts: () => ({ inbox: 0, mine: 0 }),
    });
    const s = await summarizeApprovalsNav([memberNoOwn, workflowPassthrough], MEMBER);
    expect(s.visible).toBe(false);
    expect(s.total).toBe(2); // org-wide passthrough count, moot while hidden
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
    // Base: a member with NO own requests (agent `mine: 0`) + the read-only
    // passthrough → hidden. Adding an actionable-Inbox source flips visibility
    // via the Inbox path independently of the option-b `mine` path.
    const agentNoOwn = makeSource({
      id: "agent-creation-requests",
      appliesInbox: (v) => v.isAdmin,
      counts: () => ({ inbox: 0, mine: 0 }),
    });
    const projectAgentGate = makeSource({
      id: "project-agent-gate",
      appliesInbox: () => true, // applies to members
      counts: () => ({ inbox: 4, mine: 0 }), // actionable (inboxActionable defaults on)
    });
    const before = await summarizeApprovalsNav([agentNoOwn, workflowPassthrough], MEMBER);
    const after = await summarizeApprovalsNav(
      [agentNoOwn, workflowPassthrough, projectAgentGate],
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
