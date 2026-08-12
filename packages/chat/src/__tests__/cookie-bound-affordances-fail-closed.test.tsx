// @vitest-environment jsdom
//
// ---------------------------------------------------------------------------
// The cookie-bound affordances refuse unless the surface says, positively, that
// it is a first-party cookie session (cinatra#2683, epic #2564 S8f).
// ---------------------------------------------------------------------------
// Two components in the shared conversation column read and DECIDE through
// cookie-bound server actions: the pending tool-confirmation cards (a
// destructive-call list plus freshly minted decision tokens) and the undo chip
// (a change-set id for the caller's own data). Since S8f the site widget mounts
// that same column — and the widget frame is SAME-ORIGIN to the Cinatra app, so
// a server action fired from it rides whatever Cinatra cookie happens to be in
// that browser and answers, and records decisions, as somebody else.
//
// The guard is therefore keyed on the COOKIE question, not on the presence of a
// broker credential, and this file pins the distinction that motivated it
// (codex round 1, finding 1; the direct cases codex round 2 asked for):
//
//   · no declaration at all            → refuse
//   · a REFUSED broker declaration     → refuse   ← the case a credential-based
//     (site_widget with no auth,                     read got WRONG: the runtime
//     which the runtime rejects)                     exposes no auth for it, so
//                                                    "auth === null" looked
//                                                    exactly like `/chat`
//   · a valid broker declaration       → refuse
//   · a first-party cookie host        → ALLOW
//
// "Refuse" is asserted as NO REQUEST, not merely no DOM: a component that
// fetched and then hid the answer would already have leaked it to the frame.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const listPendingToolConfirmations = vi.fn(async () => ({ rows: [] as unknown[] }));
const recentUndoableChangeSetForRunAction = vi.fn(async () => ({ changeSetId: "cs-1" }));

vi.mock("../pending-call-actions", () => ({
  listPendingToolConfirmations: () => listPendingToolConfirmations(),
  decidePendingToolCall: async () => ({ outcome: "refused" }),
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
  headers: () => ({ Authorization: "Bearer cit_site" }),
  credentials: "omit" as const,
};
const BROKER_FRAME = { assistant: "wordpress", instanceId: "inst-1" };

/** Every declaration shape a mounted column can be under. */
const SURFACES: Array<{
  name: string;
  wrap: (children: ReactNode) => ReactNode;
  cookieSession: boolean;
}> = [
  {
    name: "no declaration at all",
    wrap: (children) => children,
    cookieSession: false,
  },
  {
    name: "a REFUSED broker declaration (site_widget, no credential)",
    // The runtime rejects this: a non-cookie host MUST declare
    // `credentials: "omit"`. It then exposes no host and no auth — which is why
    // reading the auth to answer "is this brokered?" got this case backwards.
    wrap: (children) => (
      <LifecycleCardSurfaceProvider host="site_widget">{children}</LifecycleCardSurfaceProvider>
    ),
    cookieSession: false,
  },
  {
    name: "a valid broker declaration",
    wrap: (children) => (
      <LifecycleCardSurfaceProvider host="site_widget" auth={BROKER_AUTH} frame={BROKER_FRAME}>
        {children}
      </LifecycleCardSurfaceProvider>
    ),
    cookieSession: false,
  },
  {
    name: "the first-party cookie host",
    wrap: (children) => (
      <LifecycleCardSurfaceProvider host="chat_thread">{children}</LifecycleCardSurfaceProvider>
    ),
    cookieSession: true,
  },
];

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe.each(SURFACES)("cookie-bound affordances under $name (#2683)", (surface) => {
  it(`pending tool-confirmation cards ${surface.cookieSession ? "read" : "issue NO request"}`, async () => {
    const { container } = render(<>{surface.wrap(<PendingToolConfirmationCards />)}</>);
    if (surface.cookieSession) {
      await waitFor(() => expect(listPendingToolConfirmations).toHaveBeenCalled());
      return;
    }
    // Give the mount every chance to fire before asserting silence.
    await new Promise((r) => setTimeout(r, 30));
    expect(listPendingToolConfirmations).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="pending-tool-confirmations"]')).toBeNull();
  });

  it(`the undo chip ${surface.cookieSession ? "polls" : "issues NO request"}`, async () => {
    const { container } = render(<>{surface.wrap(<UndoActionChip runId="run-1" />)}</>);
    if (surface.cookieSession) {
      await waitFor(() => expect(recentUndoableChangeSetForRunAction).toHaveBeenCalled());
      await waitFor(() =>
        expect(
          container.querySelector('[data-conformance-id="artifacts-undo-entry"]'),
        ).not.toBeNull(),
      );
      return;
    }
    await new Promise((r) => setTimeout(r, 30));
    expect(recentUndoableChangeSetForRunAction).not.toHaveBeenCalled();
    expect(container.querySelector('[data-conformance-id="artifacts-undo-entry"]')).toBeNull();
  });
});
