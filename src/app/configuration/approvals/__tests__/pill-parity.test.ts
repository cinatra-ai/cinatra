/**
 * Approval total + visibility PARITY (cinatra#1283).
 *
 * The root layout resolves an approval total for a viewer via
 * `summarizeApprovalsNav(availableNavSources, viewer)`. Post-#1558 cutover that
 * `total` feeds the NOTIFICATIONS BELL badge's approvals contribution (spec §IV)
 * — it previously drove the now-retired sidebar Approvals pill. This test pins
 * the REDUCER: given one shared source list, `summarizeApprovalsNav().total`
 * equals the exact Inbox reduce (sum of every available source's Inbox count,
 * per-source soft-failing to 0) that the unified surface derives from the same
 * registry, and `visible` lights exactly when an actionable Inbox source applies
 * (the `visible` flag is retained on the summary but no longer gates a nav item —
 * the bell always renders). `registry-parity.test.ts` proves the nav registry
 * and the full registry enumerate the same sources with the same count
 * FUNCTIONS, so the bell badge and the /notifications feed agree in steady state.
 */
import { describe, it, expect } from "vitest";

import { summarizeApprovalsNav } from "../nav-summary";
import type { ApprovalNavSource, ApprovalViewer, SourceCounts } from "../sources/types";

const ADMIN: ApprovalViewer = { userId: "admin-1", orgId: "org-1", isAdmin: true };
const MEMBER: ApprovalViewer = { userId: "member-1", orgId: "org-1", isAdmin: false };

function navSource(opts: {
  id: string;
  inboxActionable?: boolean;
  appliesInbox: (v: ApprovalViewer) => boolean;
  counts: (v: ApprovalViewer) => SourceCounts;
}): ApprovalNavSource {
  return {
    id: opts.id,
    ...(opts.inboxActionable === undefined ? {} : { inboxActionable: opts.inboxActionable }),
    availability: () => "ready",
    appliesTo: (v, dir) => (dir === "inbox" ? opts.appliesInbox(v) : true),
    counts: async (v) => opts.counts(v),
  };
}

// The exact Inbox reduce the unified surface derives from the registry: sum
// of every available source's Inbox count, per-source soft-failing to 0.
async function inboxReduceTotal(sources: ApprovalNavSource[], viewer: ApprovalViewer): Promise<number> {
  const countsList = await Promise.all(
    sources.map((s) => s.counts(viewer).catch(() => ({ inbox: 0, mine: 0 }) as SourceCounts)),
  );
  return countsList.reduce((sum, c) => sum + c.inbox, 0);
}

const sources = [
  navSource({
    id: "agent-creation-requests",
    appliesInbox: (v) => v.isAdmin,
    counts: (v) => ({ inbox: v.isAdmin ? 3 : 0, mine: 1 }),
  }),
  navSource({
    id: "workflow-legacy",
    inboxActionable: false,
    appliesInbox: () => true,
    counts: () => ({ inbox: 2, mine: 0 }),
  }),
  navSource({
    id: "marketplace-submission-moderation",
    appliesInbox: (v) => v.isAdmin,
    counts: (v) => ({ inbox: v.isAdmin ? 4 : 0, mine: 0 }),
  }),
];

describe("bell-badge approvals total ⇔ inbox reduce parity", () => {
  it("admin: summarizeApprovalsNav total equals the inbox reduce, and visible is true", async () => {
    const badge = await summarizeApprovalsNav(sources, ADMIN);
    const reduced = await inboxReduceTotal(sources, ADMIN);
    expect(badge.total).toBe(reduced); // 3 + 2 + 4
    expect(badge.total).toBe(9);
    expect(badge.visible).toBe(true); // an actionable admin Inbox source applies
  });

  it("non-admin: summarizeApprovalsNav total equals the inbox reduce; visible lights via their own request (option-b)", async () => {
    const badge = await summarizeApprovalsNav(sources, MEMBER);
    const reduced = await inboxReduceTotal(sources, MEMBER);
    // Only the read-only workflow passthrough contributes an Inbox count to a
    // member; both reducers agree on it. No actionable Inbox source applies, but
    // the member has an own request in flight (agent `mine: 1`), so the nav is
    // visible via the option-b mine path (owner review #1302 ask 5) — visibility
    // rides `mine`, independent of the Inbox total.
    expect(badge.total).toBe(reduced); // 0 + 2 + 0 (Inbox total unchanged)
    expect(badge.total).toBe(2);
    expect(badge.visible).toBe(true);
  });

  it("non-admin with NO own request: nav stays hidden", async () => {
    const noOwn = sources.map((s) =>
      s.id === "agent-creation-requests"
        ? navSource({ id: s.id, appliesInbox: (v) => v.isAdmin, counts: () => ({ inbox: 0, mine: 0 }) })
        : s,
    );
    const badge = await summarizeApprovalsNav(noOwn, MEMBER);
    const reduced = await inboxReduceTotal(noOwn, MEMBER);
    expect(badge.total).toBe(reduced); // 0 + 2 + 0
    expect(badge.visible).toBe(false);
  });
});
