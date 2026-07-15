/** @vitest-environment jsdom */

// cinatra #1559 / notifications epic E9 — the run "awaiting human" notification
// renders as an ACTIONABLE row through the E7 unified /notifications feed.
//
// It is a standard AppNotification (category run_awaiting_human) carrying an
// href to the run's approval surface, so it flows through the feed's
// notification row-shell with zero page-specific wiring: the row-shell renders
// the title as an inline "open -> navigated" Link to the run (mark-read on
// navigate). This test proves that end-to-end against the REAL feed component +
// the REAL (pure) feed view-model derivation.
//
// Mirrors the existing notifications-feed test harness: the pagination server
// action + per-source decide components are mocked (they drag server-only /
// runtime graphs); the real pure `feed-view-model` is used so the derivation is
// genuine.
import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AppNotification } from "@cinatra-ai/notifications/types";
import {
  RUN_AWAITING_HUMAN_CATEGORY,
  isRunAwaitingHumanNotification,
  getRunAwaitingHumanMetadata,
} from "@cinatra-ai/notifications/flyout-state";

const { loadMore } = vi.hoisted(() => ({
  loadMore: vi.fn(async () => ({ items: [], nextCursor: null, degraded: false })),
}));
vi.mock("../feed-actions", () => ({ loadMoreUnifiedFeed: loadMore }));
vi.mock("../approval-inline-actions", () => ({
  ApprovalInlineActions: () => null,
}));

import type { FeedRowVM } from "../feed-view-model";
import { buildFeedRowVMs, deriveFeed } from "../feed-view-model";
import { NotificationsFeed } from "../notifications-feed";

function runAwaitingHumanNotification(): AppNotification {
  return {
    id: "n-1",
    title: '"Nightly sync" is awaiting your approval',
    body: "Open the run to review and approve the pending step.",
    kind: "warning",
    href: "/agents/acme/sales/R1",
    createdAt: "2026-07-15T05:12:13.000Z",
    dedupeKey: "run-awaiting-human:R1",
    metadata: {
      category: RUN_AWAITING_HUMAN_CATEGORY,
      runAwaitingHuman: { runId: "R1", reason: "pending_approval" },
    },
  };
}

function runAwaitingHumanVM(): FeedRowVM {
  return {
    key: "notification:n-1",
    kind: "notification",
    createdAt: "2026-07-15T05:12:13.000Z",
    notification: runAwaitingHumanNotification(),
  };
}

describe("run_awaiting_human — browser-safe feed classification helpers", () => {
  it("is recognized by the category predicate + payload extractor", () => {
    const n = runAwaitingHumanNotification();
    expect(isRunAwaitingHumanNotification(n)).toBe(true);
    expect(getRunAwaitingHumanMetadata(n)).toEqual({
      runId: "R1",
      reason: "pending_approval",
    });
  });

  it("does not misclassify an unrelated notification", () => {
    expect(
      isRunAwaitingHumanNotification({
        id: "n-2",
        title: "Done",
        body: "",
        kind: "success",
        createdAt: "2026-07-15T05:12:13.000Z",
      }),
    ).toBe(false);
  });
});

describe("run_awaiting_human — renders as an actionable row in the unified feed", () => {
  it("renders a notification row whose title Link deep-links to the run's approval", () => {
    const html = renderToString(
      React.createElement(NotificationsFeed, {
        initialItems: [runAwaitingHumanVM()],
        initialNextCursor: null,
        initialDegraded: false,
      }),
    );

    // Renders through the notification row-shell.
    expect(html).toContain('data-conformance-id="notification-row"');
    expect(html).toContain("is awaiting your approval");
    // The inline action: the title is an "open -> navigated" Link to the run.
    expect(html).toContain('href="/agents/acme/sales/R1"');
    expect(html).toContain('data-action="open -&gt; navigated"');
  });
});

describe("run_awaiting_human — feed derivation (E7 §II integration)", () => {
  it("counts under Unread + All (a notification row); the Needs-action chip stays approval-only", () => {
    const vms = [runAwaitingHumanVM()];
    const d = deriveFeed(vms, "/some-other-path");

    // Unread: a warning notification with no readAt.
    expect(d.unreadCount).toBe(1);
    expect(d.unreadKeys.has("notification:n-1")).toBe(true);
    // All: present.
    expect(d.allKeys.has("notification:n-1")).toBe(true);
    // Needs-action is eligibility-driven over APPROVAL rows only — a
    // notification (even an actionable one) is never in it, by E7 design.
    expect(d.needsActionCount).toBe(0);
    expect(d.needsActionKeys.has("notification:n-1")).toBe(false);
  });

  it("buildFeedRowVMs preserves it as a notification-kind row", () => {
    const vms = buildFeedRowVMs([
      {
        kind: "notification",
        createdAt: "2026-07-15T05:12:13.000Z",
        id: "n-1",
        sourceKey: "notifications",
        notification: runAwaitingHumanNotification(),
      } as never,
    ]);
    expect(vms).toHaveLength(1);
    expect(vms[0].kind).toBe("notification");
  });
});
