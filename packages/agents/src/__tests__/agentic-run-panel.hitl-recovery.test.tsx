// @vitest-environment jsdom
/**
 * THE INVARIANT on the run page: a `pending_approval` run must
 * expose an inline action OR an explicit recovery/error state. It must never
 * present a banner whose only affordance is a link to the notifications feed,
 * whose row links straight back to this page.
 *
 * The panel is mounted the way the degraded run presented itself: status
 * `pending_approval`, no interrupt context on the stream, and a hydration
 * transport that never yields one. Asserted here:
 *   1. the inline "Re-check" action is present even with no gate context;
 *   2. the notifications deep-link is KEPT (it stays the out-of-band escape);
 *   3. a repeatedly failing derivation produces a concrete recovery state that
 *      names the reason, instead of a silent null.
 *
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/agentic-run-panel.hitl-recovery.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@cinatra-ai/sdk-ui", () => ({
  LoadingSpinner: () => null,
  PromptField: ({ placeholder }: { placeholder?: string }) => (
    <div data-testid="field-assist-prompt-stub">{placeholder}</div>
  ),
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
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
    ownKeys: () => ["ArrowRight", "AlertCircle", "CalendarClock", "Clock", "default"],
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
      value: StubIcon,
    }),
  });
});

vi.mock("../hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => undefined),
  rejectReviewTask: vi.fn(async () => undefined),
}));
vi.mock("../a2a-actions", () => ({
  getAgentBuilderTask: vi.fn(async () => ({ error: "not found" })),
}));
vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({
    connectedApps: [],
    gmailAliases: [],
    runId: "run-2725",
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

// A paused run whose stream carries NO interrupt context — the exact shape the
// degraded run presented: a status with nothing to render a gate from.
vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: vi.fn(() => ({
    status: "pending_approval",
    error: null,
    presentationHint: null,
    isLive: true,
    interruptContext: null,
    streamedText: "",
  })),
}));

beforeEach(() => {
  cleanup();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function renderPausedRun() {
  const { AgenticRunPanel } = await import("../agentic-run-panel");
  render(
    <AgenticRunPanel
      runId="run-2725"
      initialStatus="pending_approval"
      initialError={null}
      initialMessages={[]}
      agUiEnabled={true}
    />,
  );
}

describe("AgenticRunPanel — pending_approval recovery invariant", () => {
  it("offers an inline Re-check action even with no gate context", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));
    await renderPausedRun();

    expect(await screen.findByRole("button", { name: "Re-check" })).toBeTruthy();
  });

  it("KEEPS the notifications deep-link as the out-of-band escape", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));
    await renderPausedRun();

    const cta = await screen.findByRole("link", { name: "Review approval" });
    expect(cta.getAttribute("href")).toBe("/notifications?run=run-2725");
  });

  it("does not claim the run is broken before it has tried", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));
    await renderPausedRun();

    await screen.findByRole("button", { name: "Re-check" });
    expect(screen.queryByText(/could not be loaded/i)).toBeNull();
    expect(screen.getByText(/Loading the approval step/i)).toBeTruthy();
  });

  it("surfaces a concrete recovery state when the derivation keeps failing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));
    await renderPausedRun();

    const recheck = await screen.findByRole("button", { name: "Re-check" });
    fireEvent.click(recheck);

    const recovery = await screen.findByText(/could not be loaded/i);
    expect(recovery.textContent).toContain("network down");
    // The escape hatch survives the failure — both affordances stay on the page.
    expect(screen.getByRole("link", { name: "Review approval" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Re-check" })).toBeTruthy();
  });

  it("names a SERVER-SIDE derivation failure — paused run, no approval step", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        status: "pending_approval",
        error: null,
        messages: [],
        hitlContext: null,
      }),
    })));
    await renderPausedRun();

    fireEvent.click(await screen.findByRole("button", { name: "Re-check" }));

    await waitFor(() =>
      expect(screen.getByText(/sent no approval step/i)).toBeTruthy(),
    );
  });

  it("clears the recovery state once a gate context finally arrives", async () => {
    let answerWithContext = false;
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (!answerWithContext) throw new Error("network down");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: "pending_approval",
          error: null,
          messages: [],
          hitlContext: {
            xRenderer: "",
            childRunId: null,
            reviewTaskId: "setup-run-2725",
            inputSchema: {},
            currentValues: {},
          },
        }),
      };
    }));
    await renderPausedRun();

    fireEvent.click(await screen.findByRole("button", { name: "Re-check" }));
    await screen.findByText(/could not be loaded/i);

    answerWithContext = true;
    fireEvent.click(screen.getByRole("button", { name: "Re-check" }));

    // A context arrived: the inline decision row replaces the recovery state.
    await waitFor(() => expect(screen.queryByText(/could not be loaded/i)).toBeNull());
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
  });
});
