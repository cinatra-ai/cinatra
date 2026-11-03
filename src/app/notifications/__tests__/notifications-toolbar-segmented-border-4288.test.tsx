// @vitest-environment jsdom
/**
 * The /notifications toolbar's segmented filter keeps its one outer border
 * (cinatra#4288).
 *
 *   pnpm exec vitest run --config vitest.config.ts --no-coverage src/app/notifications/__tests__/notifications-toolbar-segmented-border-4288.test.tsx
 *
 * The drawing says a control inside a toolbar drops its own border, and it says
 * a segmented button group shares one outer border with hairlines between the
 * segments. The design ruling on #4288 settles which sentence wins: a segmented
 * group inside a toolbar keeps its one outer border. This test mounts the real
 * <NotificationsFeed>, finds the filter group inside its toolbar, and reads the
 * border classes on the rendered group element. Tailwind is not compiled under
 * jsdom, so the rendered class list is the reading: it is what survives
 * `cn()`/tailwind-merge and reaches the DOM.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

// The same isolation as notifications-feed.test.tsx: the pagination server
// action and the per-source decide components are mocked; the feed body and
// its toolbar are the real production code.
const { fetchFeedWindow } = vi.hoisted(() => ({
  fetchFeedWindow: vi.fn(
    async (): Promise<import("../feed-window").FeedWindowResult> => ({
      pageItems: [],
      page: 1,
      pageCount: 1,
      total: 0,
      needsActionCount: 0,
      unreadCount: 0,
      inProgressCount: 0,
      feedIsEmpty: true,
      degraded: false,
      capped: false,
      newestNotification: null,
    }),
  ),
}));
vi.mock("../feed-actions", () => ({ fetchFeedWindow }));
vi.mock("../approval-inline-actions", () => ({
  ApprovalInlineActions: () => null,
}));

import { NotificationsFeed } from "../notifications-feed";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve({ ok: true, json: async () => ({}) })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderGroup(): { group: HTMLElement; toolbar: HTMLElement } {
  const { container } = render(
    <NotificationsFeed
      initialWindow={{
        pageItems: [],
        page: 1,
        pageCount: 1,
        total: 0,
        needsActionCount: 0,
        unreadCount: 0,
        inProgressCount: 0,
        feedIsEmpty: true,
        degraded: false,
        capped: false,
        newestNotification: null,
      }}
    />,
  );
  const group = container.querySelector<HTMLElement>(
    '[data-slot="toggle-group"][aria-label="Filter notifications"]',
  );
  if (!group) throw new Error("the notifications feed rendered no filter group");
  const toolbar = group.closest<HTMLElement>('[role="toolbar"]');
  if (!toolbar) throw new Error("the notifications filter group is not inside a toolbar");
  return { group, toolbar };
}

describe("cinatra#4288 — /notifications: a segmented group inside a toolbar keeps its one outer border", () => {
  it("renders the filter group inside the Notifications toolbar", () => {
    const { toolbar } = renderGroup();
    expect(toolbar.getAttribute("aria-label")).toBe("Notifications toolbar");
  });

  it("the rendered group carries the one outer hairline border (border + border-line, 7px radius)", () => {
    const { group } = renderGroup();
    const classes = group.className.split(/\s+/);
    expect(classes).toContain("border");
    expect(classes).toContain("border-line");
    expect(classes).toContain("rounded-[7px]");
    expect(classes).not.toContain("border-0");
    expect(classes).not.toContain("border-none");
  });
});
