// @vitest-environment jsdom
//
// ---------------------------------------------------------------------------
// The asking affordances ask with the credential the host DECLARED — and ask
// nothing at all when the host declared nothing usable (cinatra#2683, epic
// #2564 S8f).
// ---------------------------------------------------------------------------
// Two components in the shared conversation column do not merely render a
// transcript: they READ and DECIDE. The pending tool-confirmation cards list a
// caller's parked destructive calls with freshly minted decision tokens; the
// undo chip reads a change-set id for the caller's own data.
//
// In the first half of S8f both could only ask one way — with a cookie — so both
// were switched OFF on the widget, because the embed frame is SAME-ORIGIN to the
// Cinatra app and a cookie request from it answers as whoever else is signed in
// on that browser. This half gives them the broker path, and the matrix below is
// the whole rule:
//
//   · no declaration at all            → ASK NOTHING
//   · a REFUSED broker declaration     → ASK NOTHING  ← the case a credential-
//     (site_widget with no auth,                         based read got WRONG:
//     which the runtime rejects)                         the runtime exposes no
//                                                        auth for it, so
//                                                        "auth === null" looked
//                                                        exactly like `/chat`
//   · a valid broker declaration       → ask the ROUTE, with the host's headers
//                                        and `credentials: "omit"`; NEVER the
//                                        cookie-bound server action
//   · a first-party cookie host        → ask the SERVER ACTION, and issue no
//                                        cross-credential fetch
//
// The two negative halves are what keep this honest. "Ask nothing" is asserted
// as NO REQUEST OF EITHER KIND, not merely no DOM — a component that fetched and
// then hid the answer would already have leaked it to the frame. And each
// working surface is asserted to use its OWN path and NOT the other's, so a
// regression that made the widget fall back to the cookie action — the exact
// ambient-session fallback the contract forbids — fails here.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const listPendingToolConfirmations = vi.fn(async () => ({ rows: [] as unknown[] }));
const recentUndoableChangeSetForRunAction = vi.fn(async () => ({ changeSetId: "cs-1" }));

const decidePendingToolCall = vi.fn(async () => ({ outcome: "refused" }) as unknown);
vi.mock("../pending-call-actions", () => ({
  listPendingToolConfirmations: () => listPendingToolConfirmations(),
  decidePendingToolCall: () => decidePendingToolCall(),
}));
vi.mock("../undo-actions", () => ({
  recentUndoableChangeSetForRunAction: () => recentUndoableChangeSetForRunAction(),
}));
vi.mock("@/components/data-safety/undo-toast", () => ({
  undoDeepLink: (id: string) => `/objects?undo=${id}`,
}));

import { LifecycleCardSurfaceProvider } from "@cinatra-ai/agents/lifecycle-card-runtime";
import { PendingToolConfirmationCards } from "../pending-tool-confirmation-card";
import { UndoActionChip } from "../chat-undo-action-chip";

const BROKER_AUTH = {
  headers: () => ({
    Authorization: "Bearer cit_site",
    "X-Cinatra-Widget-User-Token": "cwu_user",
  }),
  credentials: "omit" as const,
};
const BROKER_FRAME = { assistant: "wordpress", instanceId: "inst-1" };

/** Every declaration shape a mounted column can be under. */
const SURFACES: Array<{
  name: string;
  wrap: (children: ReactNode) => ReactNode;
  asks: "cookie" | "broker" | "nothing";
}> = [
  {
    name: "no declaration at all",
    wrap: (children) => children,
    asks: "nothing",
  },
  {
    name: "a REFUSED broker declaration (site_widget, no credential)",
    // The runtime rejects this: a non-cookie host MUST declare
    // `credentials: "omit"`. It then exposes no host and no auth — which is why
    // reading the auth to answer "is this brokered?" got this case backwards.
    wrap: (children) => (
      <LifecycleCardSurfaceProvider host="site_widget">{children}</LifecycleCardSurfaceProvider>
    ),
    asks: "nothing",
  },
  {
    name: "a valid broker declaration",
    wrap: (children) => (
      <LifecycleCardSurfaceProvider host="site_widget" auth={BROKER_AUTH} frame={BROKER_FRAME}>
        {children}
      </LifecycleCardSurfaceProvider>
    ),
    asks: "broker",
  },
  {
    name: "the first-party cookie host",
    wrap: (children) => (
      <LifecycleCardSurfaceProvider host="chat_thread">{children}</LifecycleCardSurfaceProvider>
    ),
    asks: "cookie",
  },
];

/** Every `fetch` the mount made, so a call can be inspected AND counted. */
let fetchCalls: Array<{ url: string; init: RequestInit }>;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  fetchCalls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ rows: [], changeSetId: "cs-1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
});

/** The broker call's shape, asserted the same way for both components. */
function expectBrokerCall(call: { url: string; init: RequestInit }, path: string) {
  expect(call.url.startsWith(path)).toBe(true);
  // The credential rail: no cookie, ever, on this surface.
  expect(call.init.credentials).toBe("omit");
  const headers = call.init.headers as Record<string, string>;
  expect(headers["X-Cinatra-Widget-User-Token"]).toBe("cwu_user");
}

describe.each(SURFACES)("the asking affordances under $name (#2683)", (surface) => {
  it(`pending tool-confirmation cards ask via ${surface.asks}`, async () => {
    const { container } = render(<>{surface.wrap(<PendingToolConfirmationCards />)}</>);
    if (surface.asks === "cookie") {
      await waitFor(() => expect(listPendingToolConfirmations).toHaveBeenCalled());
      expect(fetchCalls).toHaveLength(0);
      return;
    }
    if (surface.asks === "broker") {
      await waitFor(() => expect(fetchCalls.length).toBeGreaterThan(0));
      expectBrokerCall(fetchCalls[0], "/api/chat/pending-tool-calls");
      // NEVER the cookie action — that is the forbidden fallback itself.
      expect(listPendingToolConfirmations).not.toHaveBeenCalled();
      return;
    }
    // Give the mount every chance to fire before asserting silence.
    await new Promise((r) => setTimeout(r, 30));
    expect(listPendingToolConfirmations).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
    expect(container.querySelector('[data-testid="pending-tool-confirmations"]')).toBeNull();
  });

  it(`the undo chip asks via ${surface.asks}`, async () => {
    const { container } = render(<>{surface.wrap(<UndoActionChip runId="run-1" />)}</>);
    if (surface.asks === "cookie") {
      await waitFor(() => expect(recentUndoableChangeSetForRunAction).toHaveBeenCalled());
      await waitFor(() =>
        expect(
          container.querySelector('[data-conformance-id="artifacts-undo-entry"]'),
        ).not.toBeNull(),
      );
      expect(fetchCalls).toHaveLength(0);
      return;
    }
    if (surface.asks === "broker") {
      await waitFor(() => expect(fetchCalls.length).toBeGreaterThan(0));
      expectBrokerCall(fetchCalls[0], "/api/chat/undo-candidate");
      expect(fetchCalls[0].url).toContain("runId=run-1");
      expect(recentUndoableChangeSetForRunAction).not.toHaveBeenCalled();
      // The chip renders, and its deep link opens OUT of the frame — the
      // column's shared link policy, not a second undo path.
      await waitFor(() =>
        expect(
          container.querySelector('[data-conformance-id="artifacts-undo-entry"]'),
        ).not.toBeNull(),
      );
      const link = container.querySelector("a[href='/objects?undo=cs-1']");
      expect(link).not.toBeNull();
      expect(link?.getAttribute("target")).toBe("_blank");
      return;
    }
    await new Promise((r) => setTimeout(r, 30));
    expect(recentUndoableChangeSetForRunAction).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
    expect(container.querySelector('[data-conformance-id="artifacts-undo-entry"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A CREDENTIAL CHANGE WHILE A DECISION IS IN FLIGHT (codex confirming round).
// ---------------------------------------------------------------------------
// The dangerous shape is not a subtree that changes credential — it is one that
// changes credential WHILE the previous one still has work outstanding. A
// decision taken under the cookie session can finish, refresh, and try to file
// another person's parked rows and their live decision tokens under whatever the
// subtree has become. So a decision is stamped with the credential it was taken
// under, and nothing it produces is readable under a different one.

describe("a credential change strands the previous credential's work (#2683)", () => {
  it("an in-flight cookie decision cannot repopulate rows after the host becomes refused", async () => {
    const row = {
      id: "cipc_1",
      connectorKey: "files",
      toolName: "delete_everything",
      serverId: "files-mcp",
      instanceId: "inst-1",
      instanceLabel: "Files",
      argsPreview: "{}",
      status: "pending",
      failureCode: null,
      resultSummary: null,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      confirmToken: "tok-confirm",
      rejectToken: "tok-reject",
    };
    listPendingToolConfirmations.mockResolvedValue({ rows: [row] });
    let release: (v: unknown) => void = () => {};
    decidePendingToolCall.mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );

    const { rerender, container } = render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <PendingToolConfirmationCards />
      </LifecycleCardSurfaceProvider>,
    );
    const confirm = await screen.findByRole("button", { name: "Confirm" });
    fireEvent.click(confirm);
    await waitFor(() => expect(decidePendingToolCall).toHaveBeenCalled());

    // The host declaration goes away mid-decision — a re-parented mount, a
    // teardown, a mis-wire. The rows must vanish IMMEDIATELY, in this render.
    rerender(<PendingToolConfirmationCards />);
    expect(container.querySelector('[data-testid="pending-tool-confirmations"]')).toBeNull();

    // …and the decision's own completion, and the refresh it triggers, must not
    // bring them back under the new (refused) credential.
    listPendingToolConfirmations.mockClear();
    release({ outcome: "decided", id: "cipc_1", status: "executed", failureCode: null, resultSummary: null });
    await new Promise((r) => setTimeout(r, 40));
    expect(container.querySelector('[data-testid="pending-tool-confirmations"]')).toBeNull();
  });
});
