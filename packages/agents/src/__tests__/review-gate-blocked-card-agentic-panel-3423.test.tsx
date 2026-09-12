// @vitest-environment jsdom
/**
 * THE OTHER RUN SURFACE DRAWS THE SAME STATE, MEASURED BY RENDERING IT
 * (cinatra#3423).
 *
 * The stepper surface's half of this is pinned next door
 * (review-gate-blocked-card-on-resume-3423.test.tsx). This file pins the run
 * page's own panel the same way — by MOUNTING it, waking it, and reading the
 * DOM — because the sentence this change is measured against is about what the
 * reader sees:
 *
 *   "the review surface draws the Blocked-state card on that refusal as the
 *    lifecycle-cards drawing section IV draws it (the card as on main; #3238's
 *    inline Refresh is 3404's, recorded not counted), and a reader tab that lost
 *    the race never renders an empty panel."
 *
 * A reader tab that held the gate, slept through the decision taken in another
 * context and then came back must draw the shipped blocked panel — its own
 * conformance anchor, its ratified sentence and its way back to the live gate —
 * in place of a "Loading the approval step for this run…" line that can never
 * resolve, because the gate it waits for is decided and gone.
 *
 * And ONLY such a tab: a first paint of a paused run holds no context either,
 * and "nothing yet" is not "already settled or the run moved on". That tab keeps
 * the recovery road it has always had.
 *
 * Run: cd packages/agents && pnpm exec vitest run \
 *   src/__tests__/review-gate-blocked-card-agentic-panel-3423.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("@cinatra-ai/sdk-ui", () => ({
  LoadingSpinner: () => null,
  PromptField: ({ placeholder }: { placeholder?: string }) => (
    <div data-testid="field-assist-prompt-stub">{placeholder}</div>
  ),
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("lucide-react", () => {
  const StubIcon = () => null;
  return new Proxy({} as Record<string, () => null>, {
    get: (_t, prop) => {
      if (prop === "__esModule") return true;
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return undefined;
      return StubIcon;
    },
    has: () => true,
    ownKeys: () => ["ArrowRight", "AlertCircle", "CircleX", "RotateCcw", "default"],
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
      value: StubIcon,
    }),
  });
});

vi.mock("../hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => ({ ok: true })),
  rejectReviewTask: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../a2a-actions", () => ({
  getAgentBuilderTask: vi.fn(async () => ({ error: "not found" })),
}));
vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({
    connectedApps: [],
    gmailAliases: [],
    runId: "run-3423",
  })),
  getAuditAvailabilityAction: vi.fn(async () => ({
    visible: false,
    promptCount: 0,
    skillCount: 0,
  })),
  getSkillsForAgentAction: vi.fn(async () => []),
}));
vi.mock("../agent-ui-override-registry", () => ({
  agentUIOverrideRegistry: { resolve: () => null },
}));

// The gate this tab is holding, as the stream reports it. `null` is the run
// saying it is parked while this surface has no gate to draw — the reading a tab
// comes back to when the gate was decided in the other context.
let interruptContext: {
  schema: Record<string, unknown>;
  xRenderer: string;
  values: Record<string, unknown>;
  reviewTaskId: string;
  fieldName?: string;
} | null = null;

vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: vi.fn(() => ({
    status: "pending_approval",
    error: null,
    presentationHint: null,
    isLive: true,
    interruptContext,
    streamedText: "",
    messages: [],
  })),
}));

const BLOCKED = '[data-conformance-id="review-gate-blocked"]';

const OPEN_GATE = {
  schema: { type: "object" },
  xRenderer: "",
  values: {},
  reviewTaskId: "task-raced",
};

beforeEach(() => {
  cleanup();
  // The panel's own hydration poll: a paused run with NO gate left to draw.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        status: "pending_approval",
        error: null,
        messages: [],
        hitlContext: null,
      }),
    })),
  );
});

afterEach(() => {
  cleanup();
  interruptContext = null;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function mountPanel() {
  const { AgenticRunPanel } = await import("../agentic-run-panel");
  // A FRESH element every time: React bails out of a re-render handed the
  // referentially identical element, and this test's whole subject is what the
  // surface does on the NEXT render after the gate went away.
  const draw = () => (
    <AgenticRunPanel
      runId="run-3423"
      initialStatus="pending_approval"
      initialError={null}
      initialMessages={[]}
      agUiEnabled={true}
    />
  );
  const handle = render(draw());
  return { ...handle, draw };
}

describe("AgenticRunPanel — the tab that slept through the decision", () => {
  it("draws the blocked card on resume, in place of a line that never resolves", async () => {
    // This tab IS holding the pending gate — the reader can see it and decide it.
    interruptContext = OPEN_GATE;
    const { rerender, draw } = await mountPanel();
    expect(await screen.findByRole("button", { name: "Approve" })).toBeTruthy();

    // The gate is decided in the OTHER context: this surface's read comes back
    // empty while the run still reads as parked.
    interruptContext = null;
    await act(async () => {
      rerender(draw());
    });

    // Before the reader comes back nothing is claimed — a live tab whose gate
    // context merely flickered must not be told its review is closed.
    expect(document.querySelector(BLOCKED)).toBeNull();

    // The reader comes back.
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => expect(document.querySelector(BLOCKED)).not.toBeNull());
    // The ratified sentence, from the SHIPPED component — not restated copy.
    expect(screen.queryByText("This review is no longer open")).not.toBeNull();
    expect(
      document.querySelector(BLOCKED)?.getAttribute("data-blocked-reason"),
    ).toBe("no-longer-pending");
    // And a way back to the live gate, which is what the drawing owes this state.
    expect(screen.queryByRole("button", { name: /refresh/i })).not.toBeNull();
    // NEVER AN EMPTY PANEL, and never the line that waits for a gate nobody is
    // going to answer.
    expect(screen.queryByText(/Loading the approval step/i)).toBeNull();
  });

  it("leaves a tab whose gate is still open alone when the reader comes back", async () => {
    interruptContext = OPEN_GATE;
    await mountPanel();
    expect(await screen.findByRole("button", { name: "Approve" })).toBeTruthy();

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(document.querySelector(BLOCKED)).toBeNull();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
  });

  it("a tab that never drew the gate keeps its own recovery road — not-yet is not gone", async () => {
    // Every healthy first paint of a paused run holds NO context, and the server
    // synthesizes one for every paused run: null means "nothing yet", never
    // "already settled or the run moved on". Drawing the settled state over a
    // gate that has simply not arrived is the stale reading section IV exists to
    // prevent.
    interruptContext = null;
    await mountPanel();

    expect(await screen.findByRole("button", { name: "Re-check" })).toBeTruthy();

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(document.querySelector(BLOCKED)).toBeNull();
    expect(screen.getByRole("button", { name: "Re-check" })).toBeTruthy();
  });

  it("a hidden tab is not told anything — the read happens on RESUME", async () => {
    interruptContext = OPEN_GATE;
    const { rerender, draw } = await mountPanel();
    expect(await screen.findByRole("button", { name: "Approve" })).toBeTruthy();

    interruptContext = null;
    await act(async () => {
      rerender(draw());
    });

    const hidden = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden" as DocumentVisibilityState);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(document.querySelector(BLOCKED)).toBeNull();

    hidden.mockReturnValue("visible" as DocumentVisibilityState);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(document.querySelector(BLOCKED)).not.toBeNull());
    hidden.mockRestore();
  });
});
