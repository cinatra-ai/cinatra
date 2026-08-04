import { describe, expect, it } from "vitest";

import type { AppNotification } from "@cinatra-ai/notifications/types";
import type { UnifiedFeedItem } from "@/app/configuration/approvals/unified-feed";
import type { ApprovalRow } from "@/app/configuration/approvals/sources/types";

import {
  approvalDecideKind,
  buildFeedRowVMs,
  deriveFeed,
  isApprovalActionable,
  keysForChip,
  notificationIsUnread,
  paginateFeed,
  type FeedRowVM,
} from "../feed-view-model";

// --- fixtures --------------------------------------------------------------

function notif(over: Partial<AppNotification> = {}): AppNotification {
  return {
    id: over.id ?? "n-1",
    title: over.title ?? "Prospect list finished",
    body: over.body ?? "240 rows",
    kind: over.kind ?? "success",
    createdAt: over.createdAt ?? "2026-05-15T05:12:13.000Z",
    ...over,
  };
}

function running(id: string, jobId: string, createdAt: string): AppNotification {
  return {
    id,
    title: "Running",
    body: "",
    kind: "info",
    createdAt,
    sourceJobId: jobId,
    metadata: { category: "background_process", progress: { status: "running" } },
  };
}

function row(over: Partial<ApprovalRow> & { sourceId: string; id: string }): ApprovalRow {
  return {
    title: over.title ?? "Approve something",
    status: over.status ?? "pending",
    createdAt: over.createdAt ?? "2026-05-15T06:00:00.000Z",
    ...over,
  };
}

function notifItem(n: AppNotification): UnifiedFeedItem {
  return {
    kind: "notification",
    createdAt: n.createdAt,
    sourceKey: "notifications",
    id: n.id,
    notification: n,
  };
}

function apprItem(r: ApprovalRow, direction: "inbox" | "mine"): UnifiedFeedItem {
  return {
    kind: "approval",
    createdAt: r.createdAt,
    sourceKey: r.sourceId,
    id: r.id,
    approval: { row: r, direction },
  };
}

// --- decideKind / eligibility ---------------------------------------------

describe("approvalDecideKind", () => {
  it("maps each actionable source and defaults to none", () => {
    expect(approvalDecideKind("agent-creation-requests")).toBe("agent");
    expect(approvalDecideKind("extension-host-port-grants")).toBe("host-port");
    expect(approvalDecideKind("marketplace-submission-moderation")).toBe("marketplace-moderate");
    expect(approvalDecideKind("marketplace-vendor-app-moderation")).toBe("marketplace-moderate");
    // the shared promotion source (#1560) — one decide kind for every subject type
    expect(approvalDecideKind("promotion-requests")).toBe("promotion");
    // self / passthrough / unknown → none
    expect(approvalDecideKind("marketplace-my-submissions")).toBe("none");
    expect(approvalDecideKind("workflow-legacy")).toBe("none");
    // the dynamic-type artifact-visibility source was retired (#1790, epic
    // #1785 slice E) — its id no longer maps to a decide kind.
    expect(approvalDecideKind("dynamic-type-artifact-visibility")).toBe("none");
    expect(approvalDecideKind("whatever")).toBe("none");
  });
});

describe("isApprovalActionable — §II eligibility, not raw pendingness", () => {
  it("an inbox row of an actionable source is actionable", () => {
    expect(isApprovalActionable("agent-creation-requests", "inbox")).toBe(true);
    expect(isApprovalActionable("marketplace-submission-moderation", "inbox")).toBe(true);
  });
  it("a 'mine' (own request) row is never actionable here", () => {
    expect(isApprovalActionable("agent-creation-requests", "mine")).toBe(false);
    expect(isApprovalActionable("marketplace-my-submissions", "mine")).toBe(false);
    // a promotion request the viewer made awaits others — not actionable in the feed
    expect(isApprovalActionable("promotion-requests", "mine")).toBe(false);
  });
  it("a promotion inbox row (a request to review) is actionable", () => {
    expect(isApprovalActionable("promotion-requests", "inbox")).toBe(true);
  });
  it("the read-only workflow-legacy passthrough is never actionable", () => {
    expect(isApprovalActionable("workflow-legacy", "inbox")).toBe(false);
  });
  it("an inbox row of a source with no decide affordance is not actionable", () => {
    expect(isApprovalActionable("marketplace-my-submissions", "inbox")).toBe(false);
  });
  it("a marketplace row denied BOTH approve and reject is not actionable (#1045 eligibility)", () => {
    expect(
      isApprovalActionable("marketplace-submission-moderation", "inbox", {
        can_approve: false,
        can_reject: false,
      }),
    ).toBe(false);
    // At least one action still available → still actionable.
    expect(
      isApprovalActionable("marketplace-submission-moderation", "inbox", {
        can_approve: false,
        can_reject: true,
      }),
    ).toBe(true);
    // Unknown hints → actionable (action-time enforcement stays authoritative).
    expect(
      isApprovalActionable("marketplace-submission-moderation", "inbox", {}),
    ).toBe(true);
  });
});

// --- buildFeedRowVMs -------------------------------------------------------

describe("buildFeedRowVMs", () => {
  it("maps a notification to a notification VM with a stable key", () => {
    const [vm] = buildFeedRowVMs([notifItem(notif({ id: "n-9" }))]);
    expect(vm.kind).toBe("notification");
    expect(vm.key).toBe("notification:n-9");
    if (vm.kind === "notification") expect(vm.notification.id).toBe("n-9");
  });

  it("maps an actionable inbox approval and carries its decide kind", () => {
    const [vm] = buildFeedRowVMs([
      apprItem(row({ sourceId: "agent-creation-requests", id: "a-1", version: "cas-1", href: "/x" }), "inbox"),
    ]);
    expect(vm.kind).toBe("approval");
    if (vm.kind === "approval") {
      expect(vm.approval.actionable).toBe(true);
      expect(vm.approval.decideKind).toBe("agent");
      expect(vm.approval.version).toBe("cas-1");
      expect(vm.approval.direction).toBe("inbox");
      expect(vm.key).toBe("approval:agent-creation-requests:a-1");
    }
  });

  it("maps a non-actionable own-request approval with decideKind none", () => {
    const [vm] = buildFeedRowVMs([
      apprItem(row({ sourceId: "marketplace-my-submissions", id: "m-1" }), "mine"),
    ]);
    if (vm.kind === "approval") {
      expect(vm.approval.actionable).toBe(false);
      expect(vm.approval.decideKind).toBe("none");
    }
  });

  it("marks a fully-denied marketplace inbox row non-actionable with decideKind none", () => {
    const [vm] = buildFeedRowVMs([
      apprItem(
        row({
          sourceId: "marketplace-submission-moderation",
          id: "m-denied",
          eligibility: { can_approve: false, can_reject: false },
        }),
        "inbox",
      ),
    ]);
    if (vm.kind === "approval") {
      expect(vm.approval.actionable).toBe(false);
      expect(vm.approval.decideKind).toBe("none");
    }
  });

  it("does NOT carry the adapter-private `raw` across the boundary", () => {
    const [vm] = buildFeedRowVMs([
      apprItem(row({ sourceId: "agent-creation-requests", id: "a-2", raw: { secret: 1 } }), "inbox"),
    ]);
    if (vm.kind === "approval") {
      expect("raw" in vm.approval).toBe(false);
    }
  });
});

// --- deriveFeed / keysForChip ---------------------------------------------

describe("deriveFeed — §III filter derivation", () => {
  const vms: FeedRowVM[] = buildFeedRowVMs([
    apprItem(row({ sourceId: "agent-creation-requests", id: "a-eligible", createdAt: "2026-05-15T09:00:00Z" }), "inbox"),
    apprItem(row({ sourceId: "marketplace-my-submissions", id: "a-mine", createdAt: "2026-05-15T08:00:00Z" }), "mine"),
    notifItem(notif({ id: "n-unread", kind: "info", body: "hi", createdAt: "2026-05-15T07:00:00Z" })),
    notifItem(notif({ id: "n-read", readAt: "2026-05-15T06:30:00Z", createdAt: "2026-05-15T06:00:00Z" })),
    notifItem(running("n-run", "job-1", "2026-05-15T05:00:00Z")),
  ]);
  const d = deriveFeed(vms, "/notifications");

  it("counts only viewer-actionable approvals for Needs action", () => {
    expect(d.needsActionCount).toBe(1);
    expect([...keysForChip(d, "needs-action")]).toEqual(["approval:agent-creation-requests:a-eligible"]);
  });

  it("counts only unread notifications for Unread; approvals never counted", () => {
    // n-unread is unread + not running; n-read is read; n-run is running (auto-read).
    expect(d.unreadCount).toBe(1);
    const unreadKeys = keysForChip(d, "unread");
    expect(unreadKeys.has("notification:n-unread")).toBe(true);
    expect(unreadKeys.has("approval:agent-creation-requests:a-eligible")).toBe(false);
  });

  it("counts in-progress running rows", () => {
    expect(d.inProgressCount).toBe(1);
    expect(keysForChip(d, "in-progress").has("notification:n-run")).toBe(true);
  });

  it("All shows every row (approvals + collapsed notifications)", () => {
    const all = keysForChip(d, "all");
    expect(all.size).toBe(vms.length);
  });
});

describe("notificationIsUnread", () => {
  it("true only for unread, non-running rows", () => {
    expect(notificationIsUnread(notif({ readAt: undefined }))).toBe(true);
    expect(notificationIsUnread(notif({ readAt: "2026-05-15T06:30:00Z" }))).toBe(false);
    expect(notificationIsUnread(running("r", "j", "2026-05-15T05:00:00Z"))).toBe(false);
  });
});

// --- paginateFeed — §VII known-total pagination -----------------------------

/** `n` notifications, newest first, 1 minute apart, ids `p-0`(newest)…`p-{n-1}`. */
function manyNotifs(n: number): FeedRowVM[] {
  const base = Date.parse("2026-05-15T12:00:00.000Z");
  const items: UnifiedFeedItem[] = [];
  for (let i = 0; i < n; i++) {
    items.push(
      notifItem(notif({ id: `p-${i}`, createdAt: new Date(base - i * 60_000).toISOString() })),
    );
  }
  return buildFeedRowVMs(items);
}

describe("paginateFeed — §VII known-total, 25/page over the filtered rows", () => {
  it("slices page 1 of a small feed into one page, total = row count", () => {
    const vms = manyNotifs(5);
    const w = paginateFeed(vms, "all", 1, 25);
    expect(w.total).toBe(5);
    expect(w.pageCount).toBe(1);
    expect(w.page).toBe(1);
    expect(w.pageItems).toHaveLength(5);
    // Newest first — the page starts with the most recent row.
    expect(w.pageItems[0]!.key).toBe("notification:p-0");
  });

  it("splits a 26-row feed into exactly two pages at 25/page (the pager threshold)", () => {
    const vms = manyNotifs(26);
    const p1 = paginateFeed(vms, "all", 1, 25);
    expect(p1.total).toBe(26);
    expect(p1.pageCount).toBe(2);
    expect(p1.pageItems).toHaveLength(25);

    const p2 = paginateFeed(vms, "all", 2, 25);
    expect(p2.pageItems).toHaveLength(1);
    expect(p2.pageItems[0]!.key).toBe("notification:p-25");
  });

  it("a 25-row feed shows exactly one page (never a trailing empty page)", () => {
    const w = paginateFeed(manyNotifs(25), "all", 1, 25);
    expect(w.pageCount).toBe(1);
    expect(w.pageItems).toHaveLength(25);
  });

  it("clamps an out-of-range page to the last page", () => {
    const w = paginateFeed(manyNotifs(26), "all", 99, 25);
    expect(w.page).toBe(2);
    expect(w.pageItems).toHaveLength(1);
  });

  it("clamps page 0 / negative pages up to page 1", () => {
    const w = paginateFeed(manyNotifs(5), "all", 0, 25);
    expect(w.page).toBe(1);
  });

  it("an empty feed is one page of zero rows, never zero pages", () => {
    const w = paginateFeed([], "all", 1, 25);
    expect(w.total).toBe(0);
    expect(w.pageCount).toBe(1);
    expect(w.pageItems).toHaveLength(0);
    expect(w.feedIsEmpty).toBe(true);
  });

  it("paginates the FILTERED, POST-COLLAPSE rows — a chip narrows total/pageCount independently of 'all'", () => {
    const vms: FeedRowVM[] = buildFeedRowVMs([
      apprItem(row({ sourceId: "agent-creation-requests", id: "a-eligible" }), "inbox"),
      notifItem(notif({ id: "n-unread", createdAt: "2026-05-15T07:00:00Z" })),
      notifItem(notif({ id: "n-read", readAt: "2026-05-15T06:30:00Z", createdAt: "2026-05-15T06:00:00Z" })),
    ]);
    const all = paginateFeed(vms, "all", 1, 25);
    expect(all.total).toBe(3);
    const unread = paginateFeed(vms, "unread", 1, 25);
    expect(unread.total).toBe(1);
    expect(unread.pageItems).toHaveLength(1);
    // feedIsEmpty reflects the WHOLE feed, not the narrower chip's total.
    expect(unread.feedIsEmpty).toBe(false);
    // Global chip counts are unaffected by which chip is active.
    expect(unread.needsActionCount).toBe(1);
  });
});
