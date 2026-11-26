// @vitest-environment jsdom
/**
 * cinatra#3471: A RETIRED STEP GETS NO CONTINUE OR REJECT ON THE RUN PANEL.
 *
 * A step parked under a tombstoned id (`isRetiredHitlStep`, the predicate the
 * server roads ask too) draws no approval actions row, also when its values
 * carry a presentation hint (the branch that draws the row directly).
 *
 * Harness mirrors agentic-run-panel.hitl.test.tsx.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { fieldRendererRegistry } from "../field-renderer-registry";
import { ensureDefaultFieldRenderersRegistered, registerFieldRendererBindings } from "../register-default-renderers";
import { __resetFieldRendererComponentMapForTests } from "../field-renderer-components";

vi.mock("@cinatra-ai/sdk-ui", () => ({
  LoadingSpinner: () => null,
  PromptField: ({ placeholder }: { placeholder?: string }) => <div>{placeholder}</div>,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
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
    ownKeys: () => ["ArrowRight", "Check", "CheckCircle2", "ChevronDown", "Circle", "CircleDot", "ClipboardList", "ExternalLink", "Loader2", "XCircle", "default"],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: StubIcon }),
  });
});
vi.mock("../hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => ({ ok: true as const })),
  rejectReviewTask: vi.fn(async () => undefined),
}));
vi.mock("../a2a-actions", () => ({ getAgentBuilderTask: vi.fn(async () => null) }));
vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({ connectedApps: [], gmailAliases: [], runId: "run-1" })),
  getAuditAvailabilityAction: vi.fn(async () => ({ visible: false, promptCount: 0, skillCount: 0 })),
  getSkillsForAgentAction: vi.fn(async () => []),
}));
vi.mock("../agent-ui-override-registry", () => ({ agentUIOverrideRegistry: { resolve: () => null } }));

const gate = vi.hoisted(() => ({ xRenderer: "", values: {} as Record<string, unknown>, reviewTaskId: "wayflow-task-retired" }));
vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: vi.fn(() => ({
    status: "pending_approval",
    error: null,
    presentationHint: null,
    isLive: true,
    interruptContext: {
      schema: { type: "object", properties: { note: { type: "string", title: "Note" } } },
      xRenderer: gate.xRenderer,
      values: gate.values,
      reviewTaskId: gate.reviewTaskId,
    },
    streamedText: "",
  })),
}));

const buttons = (label: RegExp) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("button")).filter((b) => label.test(b.textContent ?? ""));

beforeEach(() => {
  fieldRendererRegistry.clear();
  ensureDefaultFieldRenderersRegistered();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  __resetFieldRendererComponentMapForTests();
  gate.values = {};
  gate.reviewTaskId = "wayflow-task-retired";
});

describe("AgenticRunPanel and a retired step", () => {
  // red-first-expect: to have a length of +0 but got 1
  it("draws no Continue and no Reject for a tombstoned step with a presentation hint", async () => {
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    gate.xRenderer = "@cinatra/email-reviewer-agent:output";
    gate.values = {
      presentation: { type: "card_list", title: "Review drafts", items: [{ title: "Draft A", description: "Body A" }] },
    };
    render(
      <AgenticRunPanel runId="run-retired" initialStatus="pending_approval" initialError={null} initialMessages={[]} agUiEnabled={true} />,
    );
    await waitFor(() => expect(document.body.textContent ?? "").toMatch(/Review drafts/));
    expect(buttons(/Continue|Submitting|Continuing/)).toHaveLength(0);
    expect(buttons(/Reject/)).toHaveLength(0);
  });
});

// cinatra#3471 (convergence finding 1): a runtime binding of a tombstoned id to
// the control-less `cta` kind (the call the runtime-bindings hook makes) draws
// no Continue on a setup gate: the retired id wins over the binding.
describe("AgenticRunPanel, a retired step and a runtime binding", () => {
  // red-first-expect: expected 'Agentic Run ProgressAwaiting inputYou…' to match /no renderer configured/
  it("draws no Continue on a setup gate whose tombstoned id a runtime binding maps", async () => {
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    registerFieldRendererBindings([{ id: "ai-review-panel", kind: "cta", priority: 1000 }]);
    gate.xRenderer = "ai-review-panel";
    gate.reviewTaskId = "setup-run-retired";
    render(
      <AgenticRunPanel runId="run-retired" initialStatus="pending_approval" initialError={null} initialMessages={[]} agUiEnabled={true} />,
    );
    await waitFor(() => expect(document.body.textContent ?? "").toMatch(/no renderer configured/));
    expect(buttons(/Continue|Submitting|Continuing/)).toHaveLength(0);
  });
});
