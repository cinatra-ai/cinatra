/** @vitest-environment jsdom */

import React from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Isolate the client body from its heavy graph: the pagination server action
// (drags the `server-only` E5 layer) and the per-source decide components (drag
// the agents/marketplace runtimes) are mocked. The real `feed-view-model` (pure)
// is used so the filter derivation under test is genuine. `vi.hoisted` gives the
// mock factory a reference that survives the hoist above the imports.
const { loadMore } = vi.hoisted(() => ({
  loadMore: vi.fn(
    async (): Promise<{
      items: import("../feed-view-model").FeedRowVM[];
      nextCursor: string | null;
      degraded: boolean;
    }> => ({ items: [], nextCursor: null, degraded: false }),
  ),
}));
vi.mock("../feed-actions", () => ({ loadMoreUnifiedFeed: loadMore }));
vi.mock("../approval-inline-actions", () => ({
  ApprovalInlineActions: ({ onDecided }: { onDecided: () => void }) =>
    React.createElement(
      "button",
      { type: "button", "data-testid": "decide-stub", onClick: onDecided },
      "decide",
    ),
}));

import type { FeedRowVM } from "../feed-view-model";
import { NotificationsFeed } from "../notifications-feed";

function notifVM(over: {
  id: string;
  title?: string;
  body?: string;
  kind?: "success" | "error" | "warning" | "info";
  createdAt?: string;
  readAt?: string;
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

function feed(items: FeedRowVM[], opts?: { nextCursor?: string | null; degraded?: boolean }) {
  return React.createElement(NotificationsFeed, {
    initialItems: items,
    initialNextCursor: opts?.nextCursor ?? null,
    initialDegraded: opts?.degraded ?? false,
  });
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
  loadMore.mockClear();
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

  it("renders the four filter chips with All pressed by default", () => {
    const html = renderToString(
      feed([approvalVM({ id: "a1", actionable: true }), notifVM({ id: "n1", kind: "info", readAt: undefined })]),
    );
    for (const label of ["All", "Needs action", "Unread", "In progress"]) {
      expect(html).toContain(label);
    }
    // "All" chip carries aria-pressed="true".
    expect(html).toMatch(/aria-pressed="true"[^>]*>\s*All/);
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

describe("NotificationsFeed — §III filters narrow the one list in place", () => {
  it("Needs action shows only viewer-actionable approvals", async () => {
    const container = await mount(
      feed([
        approvalVM({ id: "a-eligible", actionable: true }),
        approvalVM({ id: "a-mine", actionable: false }),
        notifVM({ id: "n-unread", kind: "info" }),
      ]),
    );
    expect(container.querySelectorAll('[data-conformance-id="approval-row"]').length).toBe(2);

    await act(async () => {
      click(buttonByText(container, "Needs action"));
      await Promise.resolve();
    });

    const approvals = container.querySelectorAll('[data-conformance-id="approval-row"]');
    const notifs = container.querySelectorAll('[data-conformance-id="notification-row"]');
    expect(approvals.length).toBe(1);
    expect(notifs.length).toBe(0);
    expect(container.textContent).toContain("Approve access scope for Outreach agent");
  });

  it("Unread shows only unread notifications; approvals are never in it", async () => {
    const container = await mount(
      feed([
        approvalVM({ id: "a-eligible", actionable: true }),
        notifVM({ id: "n-unread", kind: "info", readAt: undefined }),
        notifVM({ id: "n-read", readAt: "2026-05-15T06:30:00Z" }),
      ]),
    );
    await act(async () => {
      click(buttonByText(container, "Unread"));
      await Promise.resolve();
    });
    expect(container.querySelectorAll('[data-conformance-id="approval-row"]').length).toBe(0);
    expect(container.querySelectorAll('[data-conformance-id="notification-row"]').length).toBe(1);
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

describe("NotificationsFeed — degraded retry re-requests the SAME cursor", () => {
  it("retry calls loadMore with the failing segment's cursor (null on the first page)", async () => {
    const container = await mount(feed([notifVM({ id: "n1" })], { degraded: true }));
    await act(async () => {
      click(buttonByText(container, "Retry"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(loadMore).toHaveBeenCalledWith(null);
  });

  it("a degraded retry does NOT resurrect a row decided during the retry", async () => {
    const approval = approvalVM({ id: "a1", actionable: true });
    // The retry re-fetches the SAME (still-pending server-side) approval.
    loadMore.mockResolvedValueOnce({
      items: [approval, notifVM({ id: "n1" })],
      nextCursor: null,
      degraded: false,
    });
    const container = await mount(feed([approval, notifVM({ id: "n1" })], { degraded: true }));
    expect(container.querySelectorAll('[data-conformance-id="approval-row"]').length).toBe(1);

    // Decide it (optimistic remove), THEN retry the degraded tail.
    await act(async () => {
      click(container.querySelector('[data-testid="decide-stub"]'));
      await Promise.resolve();
    });
    expect(container.querySelectorAll('[data-conformance-id="approval-row"]').length).toBe(0);

    await act(async () => {
      click(buttonByText(container, "Retry"));
      await Promise.resolve();
      await Promise.resolve();
    });

    // The overlay keeps the decided row hidden even though the retry returned it.
    expect(container.querySelectorAll('[data-conformance-id="approval-row"]').length).toBe(0);
    expect(container.querySelectorAll('[data-conformance-id="notification-row"]').length).toBe(1);
  });

  it("a RESUBMITTED approval (same id, new version) reappears after a decision on the old version", async () => {
    const v1 = approvalVM({ id: "a1", actionable: true, version: "v1" });
    const v2 = approvalVM({ id: "a1", actionable: true, version: "v2" });
    // The retry returns the SAME id but a NEW version (rejected → resubmitted).
    loadMore.mockResolvedValueOnce({ items: [v2], nextCursor: null, degraded: false });
    const container = await mount(feed([v1], { degraded: true }));

    await act(async () => {
      click(container.querySelector('[data-testid="decide-stub"]'));
      await Promise.resolve();
    });
    expect(container.querySelectorAll('[data-conformance-id="approval-row"]').length).toBe(0);

    await act(async () => {
      click(buttonByText(container, "Retry"));
      await Promise.resolve();
      await Promise.resolve();
    });

    // The new incarnation (version v2) is a distinct decision and must show.
    expect(container.querySelectorAll('[data-conformance-id="approval-row"]').length).toBe(1);
  });
});

describe("NotificationsFeed — mark-all-read watermark (§ read-state)", () => {
  it("keeps later-loaded older unread notifications read after mark-all", async () => {
    // A later load-more page returns an OLDER, still-unread notification.
    loadMore.mockResolvedValueOnce({
      items: [notifVM({ id: "n-older", kind: "info", createdAt: "2026-05-15T04:00:00.000Z" })],
      nextCursor: null,
      degraded: false,
    });
    const container = await mount(
      feed([notifVM({ id: "n1", kind: "info", createdAt: "2026-05-15T05:00:00.000Z" })], {
        nextCursor: "cursor-2",
      }),
    );
    // One unread notification → Unread chip shows count 1.
    expect(buttonByText(container, "Unread")?.textContent).toContain("1");

    await act(async () => {
      click(buttonByText(container, "Mark all read"));
      await Promise.resolve();
    });

    // The PATCH carries the newest-LOADED notification's `id` as the boundary —
    // NOT a blanket `{ all: true }` — so the server resolves that row's full-
    // precision (created_at, id) and marks read only rows through it, leaving a
    // row created after the boundary (a concurrent insert) untouched (cinatra#1557).
    // This is the client half of the server-scoped fix.
    expect(patchBodies()).toContainEqual({ beforeId: "n1" });
    expect(patchBodies()).not.toContainEqual({ all: true });

    // Load the older page AFTER mark-all.
    await act(async () => {
      click(buttonByText(container, "Load more"));
      await Promise.resolve();
      await Promise.resolve();
    });

    // The older unread row is covered by the watermark → Unread stays empty.
    await act(async () => {
      click(buttonByText(container, "Unread"));
      await Promise.resolve();
    });
    expect(container.querySelectorAll('[data-conformance-id="notification-row"]').length).toBe(0);
  });

  it("sends the newest-LOADED notification id as the boundary, never a blanket all:true, even with many rows", async () => {
    const container = await mount(
      feed([
        notifVM({ id: "n-new", kind: "info", createdAt: "2026-05-15T05:00:00.000Z" }),
        notifVM({ id: "n-mid", kind: "info", createdAt: "2026-05-15T04:30:00.000Z" }),
        notifVM({ id: "n-old", kind: "info", createdAt: "2026-05-15T04:00:00.000Z" }),
      ]),
    );

    await act(async () => {
      click(buttonByText(container, "Mark all read"));
      await Promise.resolve();
    });

    // Exactly one PATCH, carrying the NEWEST row's id as the boundary.
    expect(patchBodies()).toEqual([{ beforeId: "n-new" }]);
  });
});
