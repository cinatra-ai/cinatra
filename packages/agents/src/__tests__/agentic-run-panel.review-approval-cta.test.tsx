// @vitest-environment jsdom
/**
 * cinatra#2413 — the "Review approval" CTA on the Standard HITL approval
 * banner (a tool-call gate with no registered x-renderer / interrupt
 * context) used to be a BARE link to `/notifications`, dropping the viewer
 * on the generic feed to hunt for the row. It now deep-links with
 * `?run=<runId>` so `/notifications` can highlight the specific row (or its
 * run-failure supersession) instead.
 *
 * Mirrors the sibling agentic-run-panel.hitl.test.tsx harness: the real
 * panel is mounted with `useAgUiRunStream` stubbed to a `pending_approval`
 * status with NO interrupt context at all (not merely an unregistered
 * xRenderer) so the fallback "Standard HITL approval banner" branch renders.
 *
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/agentic-run-panel.review-approval-cta.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

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

// No interrupt context at all (not merely an unregistered xRenderer) — the
// renderer-less fallback ("Standard HITL approval banner") is the ONLY branch
// that can render for a pending_approval status with nothing to key a
// per-xRenderer renderer or a PresentationHint off of.
const hookResultRendererless = {
  status: "pending_approval",
  error: null,
  presentationHint: null,
  isLive: true,
  interruptContext: null,
  streamedText: "",
};

vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: vi.fn(() => hookResultRendererless),
}));

beforeEach(() => {
  cleanup();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AgenticRunPanel — Review approval CTA deep-link (cinatra#2413)", () => {
  it('links to "/notifications?run=<runId>" instead of the bare feed', async () => {
    const { AgenticRunPanel } = await import("../agentic-run-panel");

    render(
      <AgenticRunPanel
        runId="run-9413"
        initialStatus="pending_approval"
        initialError={null}
        initialMessages={[]}
        agUiEnabled={true}
      />,
    );

    const cta = await screen.findByRole("link", { name: "Review approval" });
    expect(cta.getAttribute("href")).toBe("/notifications?run=run-9413");
  });

  it("URL-encodes the runId in the deep-link", async () => {
    const { AgenticRunPanel } = await import("../agentic-run-panel");

    render(
      <AgenticRunPanel
        runId="run/with space"
        initialStatus="pending_approval"
        initialError={null}
        initialMessages={[]}
        agUiEnabled={true}
      />,
    );

    const cta = await screen.findByRole("link", { name: "Review approval" });
    expect(cta.getAttribute("href")).toBe(
      `/notifications?run=${encodeURIComponent("run/with space")}`,
    );
  });
});
