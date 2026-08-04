/** @vitest-environment jsdom */

import React from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Isolate the client body from its heavy graph: the pagination server action
// (drags the `server-only` union-feed walk) and the per-source decide
// components (drag the agents/marketplace runtimes) are mocked. The real
// `feed-view-model` (pure) is used so `paginateFeed`/`deriveFeed` under test
// are genuine. `vi.hoisted` gives the mock factory a reference that survives
// the hoist above the imports.
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
  ApprovalInlineActions: ({ onDecided }: { onDecided: () => void }) =>
    React.createElement(
      "button",
      { type: "button", "data-testid": "decide-stub", onClick: onDecided },
      "decide",
    ),
}));

import type { FeedRowVM } from "../feed-view-model";
import { paginateFeed } from "../feed-view-model";
import type { FeedWindowResult } from "../feed-window";
import { NotificationsFeed } from "../notifications-feed";

function notifVM(over: {
  id: string;
  title?: string;
  body?: string;
  kind?: "success" | "error" | "warning" | "info";
  createdAt?: string;
  readAt?: string;
  href?: string;
}): FeedRowVM {
  return {
    key: `notification:${over.id}`,
    kind: "notification",
    createdAt: over.createdAt ?? "2026-05-15T05:12:13.000Z",
    notification: {
      id: over.id,
      title: over.title ?? "Prospect list finished",
      body: over.body ?? "",
      kind: over.kind ?? "success",
      createdAt: over.createdAt ?? "2026-05-15T05:12:13.000Z",
      readAt: over.readAt,
      href: over.href,
    },
  };
}

function approvalVM(over: {
  id: string;
  title?: string;
  actionable: boolean;
  createdAt?: string;
  version?: string;
}): FeedRowVM {
  return {
    key: `approval:agent-creation-requests:${over.id}`,
    kind: "approval",
    createdAt: over.createdAt ?? "2026-05-15T06:00:00.000Z",
    approval: {
      sourceId: "agent-creation-requests",
      rowId: over.id,
      title: over.title ?? "Approve access scope for Outreach agent",
      status: "pending",
      version: over.version,
      direction: over.actionable ? "inbox" : "mine",
      actionable: over.actionable,
      decideKind: over.actionable ? "agent" : "none",
    },
  };
}

/** Build a `FeedWindowResult` the same way the server would (§VII): paginate
 *  the "all"-derivation, then hand-attach the newest-notification boundary. */
function buildWindow(
  vms: FeedRowVM[],
  opts?: { chip?: import("../feed-view-model").FilterChip; page?: number; degraded?: boolean },
): FeedWindowResult {
  const window = paginateFeed(vms, opts?.chip ?? "all", opts?.page ?? 1, 25);
  const newestVm = vms.find((v) => v.kind === "notification");
  return {
    ...window,
    degraded: opts?.degraded ?? false,
    capped: false,
    newestNotification:
      newestVm && newestVm.kind === "notification"
        ? { id: newestVm.notification.id, createdAt: newestVm.createdAt }
        : null,
  };
}

function feed(
  vms: FeedRowVM[],
  opts?: { chip?: import("../feed-view-model").FilterChip; page?: number; degraded?: boolean },
) {
  return React.createElement(NotificationsFeed, { initialWindow: buildWindow(vms, opts) });
}

async function mount(element: React.ReactElement): Promise<HTMLElement> {
  const html = renderToString(element);
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);
  await act(async () => {
    hydrateRoot(container, element);
    await Promise.resolve();
  });
  return container;
}

function click(el: Element | null | undefined): void {
  if (!el) throw new Error("element not found");
  (el as HTMLElement).click();
}

function buttonByText(root: ParentNode, text: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes(text),
  ) as HTMLButtonElement | undefined;
}

/** The toggle-group filter segments render as `role="radio"` (Radix single-
 *  select ToggleGroup, matching the shipped /connectors toolbar toggle —
 *  never a Radix tablist). */
function radioByText(root: ParentNode, text: string): HTMLElement | undefined {
  return [...root.querySelectorAll('[role="radio"]')].find((b) =>
    (b.textContent ?? "").includes(text),
  ) as HTMLElement | undefined;
}

function elementByAriaLabel(root: ParentNode, label: string): HTMLElement | undefined {
  return root.querySelector(`[aria-label="${label}"]`) as HTMLElement | undefined;
}

/** The JSON bodies of every PATCH the stubbed global `fetch` received. */
function patchBodies(): unknown[] {
  const fetchMock = globalThis.fetch as unknown as {
    mock: { calls: [string, RequestInit | undefined][] };
  };
  return fetchMock.mock.calls
    .filter(([, init]) => init?.method === "PATCH")
    .map(([, init]) => JSON.parse(init!.body as string));
}

beforeEach(() => {
  fetchFeedWindow.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve({ ok: true, json: async () => ({}) })),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("NotificationsFeed — server render", () => {
  it("renders notification title AND body (workflow-approval parity)", () => {
    const html = renderToString(
      feed([notifVM({ id: "n1", title: "Approval needed", body: "Q3 Launch is waiting for your approval." })]),
    );
    expect(html).toContain("Approval needed");
    expect(html).toContain("Q3 Launch is waiting for your approval.");
  });

  it("renders timestamps with a locale-independent server label", () => {
    const html = renderToString(feed([notifVM({ id: "n1" })]));
    expect(html).toContain("2026-05-15 05:12:13 UTC");
    expect(html).not.toContain("5/15/2026");
  });

  it("shows the one universal 'No notifications' empty state for an empty feed", () => {
    const html = renderToString(feed([]));
    expect(html).toContain("No notifications");
    expect(html).toContain('data-conformance-id="notifications-empty"');
  });

  it("shows the single degraded line when the approval half is incomplete", () => {
    const html = renderToString(feed([notifVM({ id: "n1" })], { degraded: true }));
    expect(html).toContain("some approvals are currently unavailable");
    expect(html).toContain('data-conformance-id="notifications-degraded"');
  });

  it("renders the toolbar toggle group with All selected by default — never a tablist", () => {
    const html = renderToString(
      feed([approvalVM({ id: "a1", actionable: true }), notifVM({ id: "n1", kind: "info", readAt: undefined })]),
    );
    for (const label of ["All", "Needs action", "Unread", "In progress"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('role="radiogroup"');
    expect(html).not.toContain('role="tablist"');
    // "All" segment is aria-checked (Radix single-select semantics).
    expect(html).toMatch(/aria-checked="true"[^>]*>\s*All/);
  });

  it("renders spaced cards with a stretched-overlay activation, not a hairline-divided row list", () => {
    const html = renderToString(feed([notifVM({ id: "n1", href: "/x" })]));
    expect(html).toContain('data-action="activate -&gt; navigated"');
    // Never role="button" on the card itself (§II).
    expect(html).not.toMatch(/data-conformance-id="notification-row"[^>]*role="button"/);
  });
});

describe("NotificationsFeed — hydration", () => {
  it("hydrates without a recoverable error when the browser locale label differs", async () => {
    vi.spyOn(Date.prototype, "toLocaleString").mockReturnValue("15/05/2026, 07:12:13");
    const element = feed([notifVM({ id: "n1" })]);
    const html = renderToString(element);
    const container = document.createElement("div");
    container.innerHTML = html;
    const recoverableErrors: unknown[] = [];
    await act(async () => {
      hydrateRoot(container, element, {
        onRecoverableError(error) {
          recoverableErrors.push(error);
        },
      });
      await Promise.resolve();
    });
    expect(recoverableErrors).toHaveLength(0);
  });
});

describe("NotificationsFeed — §III toolbar toggle narrows the one list, server-side", () => {
  it("selecting Needs action fetches page 1 of the 'needs-action' window", async () => {
    const vms = [
      approvalVM({ id: "a-eligible", actionable: true }),
      approvalVM({ id: "a-mine", actionable: false }),
      notifVM({ id: "n-unread", kind: "info" }),
    ];
    const container = await mount(feed(vms));
    expect(container.querySelectorAll('[data-conformance-id="approval-row"]').length).toBe(2);

    fetchFeedWindow.mockResolvedValueOnce(buildWindow(vms, { chip: "needs-action" }));
    await act(async () => {
      click(radioByText(container, "Needs action"));
      await Promise.resolve();
    });

    expect(fetchFeedWindow).toHaveBeenCalledWith("needs-action", 1);
    const approvals = container.querySelectorAll('[data-conformance-id="approval-row"]');
    const notifs = container.querySelectorAll('[data-conformance-id="notification-row"]');
    expect(approvals.length).toBe(1);
    expect(notifs.length).toBe(0);
    expect(container.textContent).toContain("Approve access scope for Outreach agent");
  });

  it("switching tabs resets to page 1", async () => {
    const vms = [notifVM({ id: "n1" })];
    const container = await mount(feed(vms, { page: 1 }));
    fetchFeedWindow.mockResolvedValueOnce(buildWindow(vms, { chip: "unread" }));
    await act(async () => {
      click(radioByText(container, "Unread"));
      await Promise.resolve();
    });
    expect(fetchFeedWindow).toHaveBeenCalledWith("unread", 1);
  });
});

describe("NotificationsFeed — decided row disappears (§II)", () => {
  it("removes an actionable approval row when its decision succeeds", async () => {
    const container = await mount(
      feed([approvalVM({ id: "a1", actionable: true }), notifVM({ id: "n1" })]),
    );
    expect(container.querySelectorAll('[data-conformance-id="approval-row"]').length).toBe(1);

    await act(async () => {
      click(container.querySelector('[data-testid="decide-stub"]'));
      await Promise.resolve();
    });

    expect(container.querySelectorAll('[data-conformance-id="approval-row"]').length).toBe(0);
    // The notification row is untouched.
    expect(container.querySelectorAll('[data-conformance-id="notification-row"]').length).toBe(1);
  });
});

describe("NotificationsFeed — §VI degraded retry re-requests the same window", () => {
  it("retry calls fetchFeedWindow with the current chip/page", async () => {
    const container = await mount(feed([notifVM({ id: "n1" })], { degraded: true }));
    fetchFeedWindow.mockResolvedValueOnce(buildWindow([notifVM({ id: "n1" })]));
    await act(async () => {
      click(buttonByText(container, "Retry"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchFeedWindow).toHaveBeenCalledWith("all", 1);
  });

  it("never renders the pager alongside the degraded line", async () => {
    const container = await mount(feed([notifVM({ id: "n1" })], { degraded: true }));
    expect(container.querySelector('[data-conformance-id="notifications-list-pager"]')).toBeNull();
  });
});

describe("NotificationsFeed — §VII known-total pagination", () => {
  function manyNotifs(n: number): FeedRowVM[] {
    const base = Date.parse("2026-05-15T12:00:00.000Z");
    return Array.from({ length: n }, (_, i) =>
      notifVM({ id: `p-${i}`, createdAt: new Date(base - i * 60_000).toISOString() }),
    );
  }

  it("renders no pager for a single page", async () => {
    const container = await mount(feed(manyNotifs(5)));
    expect(container.querySelector('[data-conformance-id="notifications-list-pager"]')).toBeNull();
  });

  it("renders 'Page 1 of 2 · 26 total' and pages forward on Next", async () => {
    const vms = manyNotifs(26);
    const container = await mount(feed(vms));
    expect(container.textContent).toContain("Page 1 of 2");
    expect(container.textContent).toContain("26 total");

    fetchFeedWindow.mockResolvedValueOnce(buildWindow(vms, { page: 2 }));
    await act(async () => {
      click(elementByAriaLabel(container, "Next page"));
      await Promise.resolve();
    });
    expect(fetchFeedWindow).toHaveBeenCalledWith("all", 2);
  });
});

describe("NotificationsFeed — read/unread toggle (§II, tri-state overlay)", () => {
  it("clicking the trailing toggle on an unread notification PATCHes {id} (mark read)", async () => {
    const container = await mount(feed([notifVM({ id: "n1", readAt: undefined })]));
    await act(async () => {
      click(elementByAriaLabel(container, "Mark as read"));
      await Promise.resolve();
    });
    expect(patchBodies()).toContainEqual({ id: "n1" });
  });

  it("clicking the trailing toggle on a read notification PATCHes {id, unread:true} (mark unread)", async () => {
    const container = await mount(
      feed([notifVM({ id: "n1", readAt: "2026-05-15T06:00:00.000Z" })]),
    );
    await act(async () => {
      click(elementByAriaLabel(container, "Mark as unread"));
      await Promise.resolve();
    });
    expect(patchBodies()).toContainEqual({ id: "n1", unread: true });
  });

  it("an href notification's whole-card click auto-marks read (keepalive)", async () => {
    const container = await mount(feed([notifVM({ id: "n1", href: "/x", readAt: undefined })]));
    await act(async () => {
      click(container.querySelector('[data-action="activate -> navigated"]'));
      await Promise.resolve();
    });
    expect(patchBodies()).toContainEqual({ id: "n1" });
    const fetchMock = globalThis.fetch as unknown as {
      mock: { calls: [string, RequestInit | undefined][] };
    };
    const [, init] = fetchMock.mock.calls.find(([, i]) => i?.method === "PATCH")!;
    expect(init?.keepalive).toBe(true);
  });
});

describe("NotificationsFeed — mark-all-read watermark (§ read-state, feed-wide boundary)", () => {
  it("PATCHes {beforeId} using the feed-wide newest notification, not merely the current page", async () => {
    const vms = [
      notifVM({ id: "n-new", kind: "info", createdAt: "2026-05-15T05:00:00.000Z" }),
      notifVM({ id: "n-mid", kind: "info", createdAt: "2026-05-15T04:30:00.000Z" }),
      notifVM({ id: "n-old", kind: "info", createdAt: "2026-05-15T04:00:00.000Z" }),
    ];
    const container = await mount(feed(vms));

    await act(async () => {
      click(buttonByText(container, "Mark all read"));
      await Promise.resolve();
    });

    expect(patchBodies()).toEqual([{ beforeId: "n-new" }]);
    expect(patchBodies()).not.toContainEqual({ all: true });
  });

  it("an explicit per-row 'mark unread' after mark-all-read is never resurrected as read", async () => {
    const vms = [notifVM({ id: "n1", kind: "info", createdAt: "2026-05-15T05:00:00.000Z" })];
    const container = await mount(feed(vms));

    await act(async () => {
      click(buttonByText(container, "Mark all read"));
      await Promise.resolve();
    });
    // n1 is now overlaid read by the watermark.
    expect(elementByAriaLabel(container, "Mark as unread")).toBeTruthy();

    await act(async () => {
      click(elementByAriaLabel(container, "Mark as unread"));
      await Promise.resolve();
    });
    // The explicit unread override wins over the watermark.
    expect(elementByAriaLabel(container, "Mark as read")).toBeTruthy();
  });
});
