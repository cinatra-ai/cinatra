// @vitest-environment jsdom
// THE IDEA STEP WAITS FOR A PICK IN THE CONVERSATION TOO (cinatra#3035): the conversation hosts the
// run page's card (`specs/app-artifact-review.html` I.3), so its Continue holds as on the run page.
import React from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";

vi.mock("@cinatra-ai/sdk-ui", () => ({
  LoadingSpinner: () => null,
  // The real PromptField pulls in browser-only deps jsdom can't load.
  PromptField: ({ placeholder }: { placeholder?: string }) => (
    <div data-testid="field-assist-prompt-stub">{placeholder}</div>
  ),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
// Every named icon import resolves to a null-render stub (the sibling panel tests' Proxy).
vi.mock("lucide-react", () => {
  const StubIcon = () => null;
  return new Proxy({} as Record<string, () => null>, {
    get: (_t, prop) => (prop === "__esModule" ? true : prop === "then" || typeof prop === "symbol" ? undefined : StubIcon),
    has: () => true,
    ownKeys: () => ["ArrowRight", "Check", "CheckCircle2", "ChevronDown", "Circle", "CircleDot", "ClipboardList", "ExternalLink", "Loader2", "XCircle", "default"],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: StubIcon }),
  });
});

const gateSend = vi.hoisted(() => ({ approveReviewTask: vi.fn(async (..._args: unknown[]) => ({ ok: true })) }));
vi.mock("../hitl-actions", () => ({
  approveReviewTask: (...args: unknown[]) => gateSend.approveReviewTask(...args),
  rejectReviewTask: vi.fn(async () => undefined),
}));
vi.mock("../a2a-actions", () => ({ getAgentBuilderTask: vi.fn(async () => null) }));
vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({ connectedApps: [], gmailAliases: [], runId: "run-1" })),
  getAuditAvailabilityAction: vi.fn(async () => ({ visible: false, promptCount: 0, skillCount: 0 })),
  getSkillsForAgentAction: vi.fn(async () => []),
  getRuntimeFieldRendererBindingsAction: vi.fn(async () => []),
}));
vi.mock("../agent-ui-override-registry", () => ({ agentUIOverrideRegistry: { resolve: () => null } }));

const IDEA_RENDERER_ID = "@cinatra-ai/blog-pipeline-agent:idea-selection";
const IDEAS = [
  { artifactId: "idea-a", representationRevisionId: "rev-a", title: "Build an Audit Trail for Every AI Agent Run", text: "Build an Audit Trail for Every AI Agent Run\n\nWhat a run should keep." },
  { artifactId: "idea-b", representationRevisionId: "rev-b", title: "Why Reviews Belong Inside the Run", text: "Why Reviews Belong Inside the Run\n\nOne page per gate." },
];

/** The idea step, a mid-run gate drawn by the kind the default registration binds. */
const IDEA_GATE = {
  xRenderer: IDEA_RENDERER_ID,
  schema: {
    type: "object",
    "x-renderer": IDEA_RENDERER_ID,
    properties: { selectedIdeaJson: { type: "string", title: "Selected idea (JSON)" } },
  },
  values: { stepNumber: 1, ideas: IDEAS },
  reviewTaskId: "gate-idea-3035",
};

const stream = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: () => stream.current,
}));

function ideaStream(reviewTaskId = IDEA_GATE.reviewTaskId) {
  return { status: "pending_approval", error: null, presentationHint: null, isLive: true, interruptContext: { ...IDEA_GATE, reviewTaskId }, streamedText: "" };
}

function continueButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button")).filter((b) =>
    /^continu/i.test((b.textContent ?? "").trim()),
  );
}

function checkedRadios(): Element[] {
  return Array.from(document.querySelectorAll('[role="radio"][aria-checked="true"]'));
}

async function mountPanel() {
  const { AgenticRunPanel } = await import("../agentic-run-panel");
  const panel = () => (
    <AgenticRunPanel runId="run-3035" initialStatus="pending_approval" initialError={null} initialMessages={[]} agUiEnabled={true} />
  );
  const { rerender } = render(panel());
  return () => rerender(panel());
}

/** C1 on the way: the idea gate opens with zero checked radios and its one Continue disabled; then one row is pressed. */
async function mountAndPickTheFirstRow() {
  stream.current = ideaStream();
  const rerender = await mountPanel();
  await waitFor(() => expect(document.querySelectorAll('[role="radio"]').length).toBe(2));
  expect(checkedRadios()).toHaveLength(0);
  expect(continueButtons()).toHaveLength(1);
  expect(continueButtons()[0]!.disabled).toBe(true);
  fireEvent.click(document.querySelectorAll<HTMLElement>('[role="radio"]')[0]!);
  await waitFor(() => expect(checkedRadios()).toHaveLength(1));
  return rerender;
}

beforeEach(() => {
  ensureDefaultFieldRenderersRegistered();
  stream.current = null;
});

afterEach(() => {
  cleanup();
  stream.current = null;
  vi.clearAllMocks();
});
// New test files restore what they mock.
afterAll(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("the conversation card's idea step opens with nothing picked and its Continue unavailable", () => {
  it("C1, C2: the gate opens with nothing picked and its Continue disabled; one press on a row checks it, makes the Continue available, and sends that row's reference", async () => {
    await mountAndPickTheFirstRow();
    const continues = continueButtons();
    expect(continues).toHaveLength(1);
    await waitFor(() => expect(continues[0]!.disabled).toBe(false));

    fireEvent.click(continues[0]!);
    await waitFor(() => expect(gateSend.approveReviewTask).toHaveBeenCalledTimes(1));
    const payload = gateSend.approveReviewTask.mock.calls[0]![1] as Record<string, unknown>;
    expect(payload.userResponse).toBe(JSON.stringify({ artifactId: "idea-a", representationRevisionId: "rev-a" }));
  });

  it("C3: a later idea gate (another review task, the same renderer) does not inherit the earlier gate's pick", async () => {
    const rerender = await mountAndPickTheFirstRow();
    await waitFor(() => expect(continueButtons()[0]!.disabled).toBe(false));

    stream.current = ideaStream("gate-idea-3035-next");
    rerender();
    await waitFor(() => expect(continueButtons()[0]!.disabled).toBe(true));
    expect(checkedRadios()).toHaveLength(0);
  });
});
