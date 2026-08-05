// @vitest-environment jsdom
/**
 * cinatra#2444 — a run paused on a BARE tool-call approval gate (no
 * x-renderer) must be decidable INLINE in the run panel: the fallback branch
 * renders the shared approval actions row (Approve + Reject) and a click
 * resumes the run in place via the same approveReviewTask envelope the
 * x-renderer paths submit ({approved, approvedAt}); no full-tab redirect is
 * required. The deep-linked "Review approval" CTA (cinatra#2413) is retained
 * as a secondary affordance and as the sole degraded path when no gate
 * context (reviewTaskId) is available to submit against.
 *
 * Mirrors the sibling agentic-run-panel.hitl.test.tsx harness: the real
 * panel is mounted with `useAgUiRunStream` stubbed. The bare gate is
 * simulated with an interruptContext whose xRenderer is "" — the exact
 * shape the poll path's deriveRunHitlContext produces for a WayFlow gate
 * with no readable interrupt (hitl-context.ts: xRenderer "", reviewTaskId
 * `wayflow-<taskId>`), which is what routes rendering into the fallback
 * branch while approvalActionsRow's only requirement (a reviewTaskId) holds.
 *
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/agentic-run-panel.bare-gate-inline-approval.test.tsx
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
  return new Proxy(
    {} as Record<string, () => null>,
    {
      get: (_t, prop) => {
        if (prop === "__esModule") return true;
        if (prop === "then") return undefined;
        if (typeof prop === "symbol") return undefined;
        return StubIcon;
      },
      has: () => true,
      ownKeys: () => ["ArrowRight", "Check", "CheckCircle2", "ChevronDown", "Circle", "CircleDot", "ClipboardList", "ExternalLink", "Loader2", "XCircle", "default"],
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: StubIcon }),
    },
  );
});

vi.mock("../hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => undefined),
  rejectReviewTask: vi.fn(async () => undefined),
}));
vi.mock("../a2a-actions", () => ({
  getAgentBuilderTask: vi.fn(async () => null),
}));
vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({
    connectedApps: [],
    gmailAliases: [],
    runId: "run-2444",
  })),
  getAuditAvailabilityAction: vi.fn(async () => ({ visible: false, promptCount: 0, skillCount: 0 })),
  getSkillsForAgentAction: vi.fn(async () => []),
}));
vi.mock("../agent-ui-override-registry", () => ({
  agentUIOverrideRegistry: { resolve: () => null },
}));

// Bare tool-call gate: xRenderer "" (no renderer registered / no x-renderer on
// the gate) but a real reviewTaskId — the shape deriveRunHitlContext emits for
// a WayFlow gate with no readable interrupt. mapInterruptToHitlContext passes
// the empty xRenderer through verbatim, so the panel's fallback branch renders
// with a POPULATED effectiveHitlContext.
const BARE_GATE_REVIEW_TASK_ID = "wayflow-task-2444";
const hookResultBareGate = {
  status: "pending_approval",
  error: null,
  presentationHint: null,
  isLive: true,
  interruptContext: {
    schema: {},
    xRenderer: "",
    values: {},
    reviewTaskId: BARE_GATE_REVIEW_TASK_ID,
  },
  streamedText: "",
};

// Degraded shape: pending_approval with NO gate context at all — nothing to
// submit against, so only the /notifications deep-link can be offered.
const hookResultNoContext = {
  status: "pending_approval",
  error: null,
  presentationHint: null,
  isLive: true,
  interruptContext: null,
  streamedText: "",
};

vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: vi.fn(() => hookResultBareGate),
}));

async function renderBareGatePanel(hookResult: unknown = hookResultBareGate) {
  const { AgenticRunPanel } = await import("../agentic-run-panel");
  const { useAgUiRunStream } = await import("../use-ag-ui-run-stream");
  (useAgUiRunStream as unknown as ReturnType<typeof vi.fn>).mockReturnValue(hookResult);
  return render(
    <AgenticRunPanel
      runId="run-2444"
      initialStatus="pending_approval"
      initialError={null}
      initialMessages={[]}
      agUiEnabled={true}
    />,
  );
}

beforeEach(() => {
  cleanup();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AgenticRunPanel — bare tool-call gate decides inline (cinatra#2444)", () => {
  it("renders inline Approve and Reject buttons (not just the redirect banner)", async () => {
    await renderBareGatePanel();

    const approve = await screen.findByRole("button", { name: "Approve" });
    const reject = await screen.findByRole("button", { name: "Reject" });
    expect(approve).not.toBeNull();
    expect(reject).not.toBeNull();
    // The paused message still frames the decision.
    expect(screen.queryByText(/Run paused — awaiting human approval/)).not.toBeNull();
  });

  it("retains the /notifications CTA as a secondary affordance deep-linking to the specific approval", async () => {
    await renderBareGatePanel();

    // Inline actions AND the deep-link coexist; the link stays ?run=-scoped
    // (cinatra#2413), never the bare feed.
    await screen.findByRole("button", { name: "Approve" });
    const cta = screen.getByRole("link", { name: "Review approval" });
    expect(cta.getAttribute("href")).toBe("/notifications?run=run-2444");
  });

  it("Approve resumes the run in place with the standard approval envelope ({approved:true, approvedAt})", async () => {
    await renderBareGatePanel();
    const { approveReviewTask } = await import("../hitl-actions");

    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

    await waitFor(() => {
      expect(approveReviewTask).toHaveBeenCalledTimes(1);
    });
    const [taskId, payload] = (approveReviewTask as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(taskId).toBe(BARE_GATE_REVIEW_TASK_ID);
    expect((payload as Record<string, unknown>).approved).toBe(true);
    expect(typeof (payload as Record<string, unknown>).approvedAt).toBe("string");
    // ISO timestamp — same stamp shape the x-renderer Continue submits.
    expect(() => new Date((payload as Record<string, unknown>).approvedAt as string).toISOString()).not.toThrow();
  });

  it("Reject resumes the run in place with approved:false and the operator-decline marker", async () => {
    await renderBareGatePanel();
    const { approveReviewTask } = await import("../hitl-actions");

    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));

    await waitFor(() => {
      expect(approveReviewTask).toHaveBeenCalledTimes(1);
    });
    const [taskId, payload] = (approveReviewTask as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(taskId).toBe(BARE_GATE_REVIEW_TASK_ID);
    const p = payload as Record<string, unknown>;
    expect(p.approved).toBe(false);
    expect(typeof p.approvedAt).toBe("string");
    // The reject analog of the server-side "[Approved by operator]" fallback —
    // delivered on the SAME resume wire so the paused gate receives an
    // explicit decline and the run resumes in place.
    expect(p.userResponse).toBe("[Rejected by operator]");
  });

  it("degrades to the redirect-only banner when no gate context is available to submit against", async () => {
    await renderBareGatePanel(hookResultNoContext);

    const cta = await screen.findByRole("link", { name: "Review approval" });
    expect(cta.getAttribute("href")).toBe("/notifications?run=run-2444");
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
  });
});
