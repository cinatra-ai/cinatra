// @vitest-environment jsdom
/**
 * cinatra#4150 -- a run parked at a PUBLISH gate is `pending_approval` with no gate context and no generic review task
 * (publish-decision-actions.ts, `holdRunAtPublishGate`). The panel draws the publish card for it and must NOT also
 * draw the generic approval banner (its "Review approval" link, its loading line and its Re-check) beside the card.
 * A pause that is not a publish gate keeps the generic banner exactly as before.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

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
    runId: "run-9413",
  })),
  getAuditAvailabilityAction: vi.fn(async () => ({ visible: false, promptCount: 0, skillCount: 0 })),
  getSkillsForAgentAction: vi.fn(async () => []),
}));
vi.mock("../agent-ui-override-registry", () => ({
  agentUIOverrideRegistry: { resolve: () => null },
}));

const publishStateMock = vi.fn();
vi.mock("../publish-decision-card-actions", () => ({
  getPublishDecisionCardStateAction: (input: { runId: string }) => publishStateMock(input),
}));

const RUN_ID = "run-4150-gate";
const PENDING = {
  state: "pending",
  runId: RUN_ID,
  agentName: "Blog publisher",
  rows: [{ label: "Title", value: "Spring launch" }],
  mayDecide: true,
};

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

async function mountPanel() {
  const { AgenticRunPanel } = await import("../agentic-run-panel");
  const mounted = render(
    <AgenticRunPanel
      runId={RUN_ID}
      initialStatus="pending_approval"
      initialError={null}
      initialMessages={[]}
      agUiEnabled={true}
    />,
  );
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    await Promise.resolve();
  });
  return mounted;
}

beforeEach(() => {
  cleanup();
  publishStateMock.mockReset();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AgenticRunPanel at a publish gate (cinatra#4150)", () => {
  it("draws the publish card and NOT the generic approval banner beside it", async () => {
    publishStateMock.mockImplementation(async () => PENDING);
    const mounted = await mountPanel();
    const cards = mounted.container.querySelectorAll('[data-lifecycle-card="publish_decision"]');
    expect(cards).toHaveLength(1);
    expect(cards[0]!.getAttribute("data-lifecycle-card-host")).toBe("run_card");
    expect(screen.queryByRole("link", { name: "Review approval" })).toBeNull();
    expect(mounted.container.querySelector('[data-testid="hitl-recovery-state"]')).toBeNull();
    expect(mounted.container.textContent).not.toContain("awaiting human approval");
  });

  it("a pause that is NOT a publish gate keeps the generic approval banner", async () => {
    publishStateMock.mockImplementation(async () => ({ state: "none" }));
    const mounted = await mountPanel();
    expect(mounted.container.querySelector('[data-lifecycle-card="publish_decision"]')).toBeNull();
    expect(await screen.findByRole("link", { name: "Review approval" })).not.toBeNull();
    expect(mounted.container.querySelector('[data-testid="hitl-recovery-state"]')).not.toBeNull();
  });
});
