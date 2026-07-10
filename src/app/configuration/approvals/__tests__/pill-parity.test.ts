/**
 * Pill total + visibility PARITY (cinatra#1283).
 *
 * After the data-contract/view split, two INDEPENDENT passes derive an approval
 * total for a viewer:
 *   • the root layout → `summarizeApprovalsNav(availableNavSources, viewer)` →
 *     the sidebar badge pill total (+ visibility);
 *   • the `/configuration/approvals` page → `sum(availableSources.counts().inbox)`
 *     → the Inbox-tab total.
 *
 * `registry-parity.test.ts` proves both passes enumerate the same sources with
 * the same count FUNCTIONS. This test pins the REDUCERS themselves: given one
 * shared source list, the layout badge total equals the page's Inbox reduce
 * expression, and visibility lights exactly when an actionable Inbox source
 * applies. Together they mean the badge and the page agree in the steady state
 * (they can still momentarily differ under a per-source soft-fail — an
 * independent-pass property, not a reducer disagreement).
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

// The page's exact Inbox-tab reduce (page.tsx): sum of every available source's
// Inbox count, per-source soft-failing to 0.
async function pageInboxTotal(sources: ApprovalNavSource[], viewer: ApprovalViewer): Promise<number> {
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

describe("sidebar pill ⇔ page Inbox parity", () => {
  it("admin: badge total equals the page Inbox reduce, and the nav is visible", async () => {
    const badge = await summarizeApprovalsNav(sources, ADMIN);
    const page = await pageInboxTotal(sources, ADMIN);
    expect(badge.total).toBe(page); // 3 + 2 + 4
    expect(badge.total).toBe(9);
    expect(badge.visible).toBe(true); // an actionable admin Inbox source applies
  });

  it("non-admin: badge total equals the page Inbox reduce, and the nav is hidden", async () => {
    const badge = await summarizeApprovalsNav(sources, MEMBER);
    const page = await pageInboxTotal(sources, MEMBER);
    // Only the read-only workflow passthrough contributes an Inbox count to a
    // member; both reducers agree on it, and neither actionable source applies.
    expect(badge.total).toBe(page); // 0 + 2 + 0
    expect(badge.total).toBe(2);
    expect(badge.visible).toBe(false);
  });
});
