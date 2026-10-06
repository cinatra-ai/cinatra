// @vitest-environment jsdom
import React from "react";
import { GROUPED_SETUP_FORM_RENDERER_ID } from "../agent-builder-ids";
import type { ChatGateDescriptor } from "../agentic-run-panel";
import { Button } from "@/components/ui/button";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { fieldRendererRegistry, type FieldRendererProps } from "../field-renderer-registry";

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
  approveReviewTask: vi.fn(async () => ({ ok: true })),
  rejectReviewTask: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../a2a-actions", () => ({
  getAgentBuilderTask: vi.fn(async () => null),
}));
vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({
    connectedApps: [],
    gmailAliases: [],
    runId: "run-publish-choice",
  })),
  getAuditAvailabilityAction: vi.fn(async () => ({ visible: false, promptCount: 0, skillCount: 0 })),
  getSkillsForAgentAction: vi.fn(async () => []),
}));
vi.mock("../agent-ui-override-registry", () => ({
  agentUIOverrideRegistry: { resolve: () => null },
}));


vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("../run-window-actions", () => ({
  loadRunWindowConversation: vi.fn(async () => []),
  sendRunWindowTurn: vi.fn(async () => ({ ok: true, entries: [] })),
}));
vi.mock("../run-actions", () => ({
  startDevChildPreviewRun: vi.fn(async () => ({ ok: false })),
  buildSubmissionMapByStepIndex: vi.fn(async () => []),
  resetAgentRun: vi.fn(async () => ({ ok: true })),
  createAndTriggerRun: vi.fn(async () => ({ ok: true, runId: "run-next" })),
  triggerAgentRun: vi.fn(async () => ({ ok: true })),
  readRunOutputEvidence: vi.fn(async () => null),
}));
vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: vi.fn(async () => ({ state: "none" })),
  confirmRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
  skipRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
}));

// Installed extension modules are outside this panel submission test.
vi.mock("@/lib/generated/extensions.server", () => ({
  STATIC_EXTENSION_MANIFEST: {},
  STATIC_EXTENSION_RECORDS: [],
  GENERATED_EXTENSION_SERVER_ENTRIES: {},
  GENERATED_CONNECTOR_ENTRY_MODULES: {},
  GENERATED_CONNECTOR_MCP_MODULES: {},
  GENERATED_CONNECTOR_PRIMITIVE_HANDLERS: {},
  GENERATED_EXTERNAL_MCP_TOOLBOXES: {},
  GENERATED_WIDGET_STREAM_AGENTS: {},
  GENERATED_CHAT_WIDGET_MODULES: {},
  GENERATED_CHAT_WIDGET_MANIFEST_MODULES: {},
  GENERATED_DEV_SETUP_MODULES: {},
}));
// The test registers its own mid-run renderer below; installed renderer
// imports are outside this host-owned submission regression.
vi.mock("@/lib/generated/field-renderer-components", () => ({
  GENERATED_FIELD_RENDERER_COMPONENTS: {},
}));

vi.mock("../orchestrator-actions", () => ({
  cancelOrchestratorAction: vi.fn(async () => ({ ok: true })),
  resumeStoppedOrchestratorAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../run-name-actions", () => ({
  ensureOrCheckRunNameAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../use-runtime-field-renderer-bindings", () => ({
  useRuntimeFieldRendererBindings: () => ({ bindings: {}, loading: false }),
}));

const RENDERER_ID = "@example/publish-agent:confirm";
const TASK_ID = "wayflow-publish-choice";

// A renderer only stages its answer. The real panel's Continue owns submission.
function ChoiceRenderer({ onChange }: FieldRendererProps) {
  return <div>
    <Button type="button" onClick={() => onChange({ approved: false, draftId: "draft-kept" })}>Do not publish</Button>
    <Button type="button" onClick={() => onChange({ approved: true, draftId: "draft-kept" })}>Publish</Button>
    <Button type="button" onClick={() => onChange({ approved: true, userResponse: '{"approved":true}' })}>Publish with response</Button>
    <Button type="button" onClick={() => onChange({ note: "changed note" })}>Change note</Button>
    <Button type="button" onClick={() => onChange({
      approved: false,
      draftId: "draft-kept",
      userResponse: '{"approved":false,"draftId":"draft-kept"}',
    })}>Decline with response</Button>
  </div>;
}

let gateTaskId = TASK_ID;
let gateRendererId = RENDERER_ID;

vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: vi.fn(() => ({
    status: "pending_approval",
    error: null,
    presentationHint: null,
    isLive: true,
    interruptContext: {
      schema: { type: "object", properties: { approved: { type: "boolean" } } },
      xRenderer: gateRendererId,
      values: {},
      reviewTaskId: gateTaskId,
    },
    streamedText: "",
    dataPartFrames: [],
  })),
}));

beforeEach(() => {
  gateTaskId = TASK_ID;
  gateRendererId = RENDERER_ID;
  fieldRendererRegistry.register({
    id: RENDERER_ID,
    priority: 100,
    midRunHitl: true,
    condition: (_field, schema) => schema["x-renderer"] === RENDERER_ID,
    renderer: ChoiceRenderer,
  });
});
afterEach(() => {
  cleanup();
  fieldRendererRegistry.clear();
  vi.clearAllMocks();
});

async function openGate(surface: "chat" | "agent-detail", onActiveGateChange?: (_runId: string, gate: ChatGateDescriptor | null) => void) {
  const { AgenticRunPanel } = await import("../agentic-run-panel");
  render(<AgenticRunPanel
    runId="run-publish-choice"
    initialStatus="pending_approval"
    initialError={null}
    initialMessages={[]}
    agUiEnabled={true}
    surface={surface}
    onActiveGateChange={onActiveGateChange}
  />);
  await screen.findByRole("button", { name: "Do not publish" });
}

async function continueGate() {
  const { approveReviewTask } = await import("../hitl-actions");
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(approveReviewTask).toHaveBeenCalledTimes(1));
  const [taskId, payload] = vi.mocked(approveReviewTask).mock.calls[0];
  expect(taskId).toBe(TASK_ID);
  return payload as Record<string, unknown>;
}

describe.each(["chat", "agent-detail"] as const)("Continue preserves the renderer's choice on %s", (surface) => {
  it("sends a refusal as false both in the saved values and on the resume wire", async () => {
    await openGate(surface);
    const { approveReviewTask } = await import("../hitl-actions");
    fireEvent.click(screen.getByRole("button", { name: "Do not publish" }));
    expect(approveReviewTask).not.toHaveBeenCalled();
    const payload = await continueGate();
    expect(payload.approved).toBe(false);
    expect(payload.draftId).toBe("draft-kept");
    expect(JSON.parse(payload.userResponse as string)).toMatchObject({
      approved: false,
      draftId: "draft-kept",
    });
  });

  it("keeps an explicitly supplied refusal response unchanged", async () => {
    await openGate(surface);
    fireEvent.click(screen.getByRole("button", { name: "Decline with response" }));
    const payload = await continueGate();
    expect(payload.approved).toBe(false);
    expect(payload.userResponse).toBe('{"approved":false,"draftId":"draft-kept"}');
  });

  it("uses the latest explicit choice when a person changes their mind", async () => {
    await openGate(surface);
    fireEvent.click(screen.getByRole("button", { name: "Do not publish" }));
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    const payload = await continueGate();
    expect(payload.approved).toBe(true);
    expect(payload.draftId).toBe("draft-kept");
  });

  it("keeps the existing Continue default when no renderer decision is stored", async () => {
    await openGate(surface);
    const payload = await continueGate();
    expect(payload.approved).toBe(true);
    expect(typeof payload.approvedAt).toBe("string");
  });
});

async function openStepper() {
  const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
  render(<OrchestratorStepperPanel
    runId="run-publish-choice" initialStatus="pending_approval" initialError={null}
    agUiEnabled={true} agentPackageName="@example/publish-agent" inputParams={{}}
    stepperSteps={[{ index: 1, stepNumber: 0, label: "Decision", xRenderer: gateRendererId }]}
    agentId="example/publish-agent" lgThreadId={null} templateId="template-decision" templateName="Decision"
  />);
  await screen.findByRole("button", { name: "Do not publish" });
}

describe("other Continue roads preserve the renderer decision", () => {
  it("the real chat gate descriptor submits the buffered refusal", async () => {
    let gate: ChatGateDescriptor | null = null;
    await openGate("chat", (_runId, next) => { gate = next; });
    fireEvent.click(screen.getByRole("button", { name: "Do not publish" }));
    await waitFor(() => expect(gate).not.toBeNull());
    await act(async () => { await gate!.submit({}); });
    const { approveReviewTask } = await import("../hitl-actions");
    const payload = vi.mocked(approveReviewTask).mock.calls[0][1] as Record<string, unknown>;
    expect(payload.approved).toBe(false);
    expect(JSON.parse(payload.userResponse as string)).toMatchObject({ approved: false, draftId: "draft-kept" });
  });

  it.each(["Do not publish", "Decline with response", "Publish"])("stepper outer Continue carries %s", async (choice) => {
    await openStepper();
    fireEvent.click(screen.getByRole("button", { name: choice }));
    const payload = await continueGate();
    expect(payload.approved).toBe(choice === "Publish");
    if (choice === "Do not publish") expect(JSON.parse(payload.userResponse as string)).toMatchObject({ approved: false, draftId: "draft-kept" });
    if (choice === "Decline with response") expect(payload.userResponse).toBe('{"approved":false,"draftId":"draft-kept"}');
  });

  it.each(["agentic", "stepper"])("%s grouped setup preserves an input named approved as data", async (panel) => {
    gateTaskId = "setup-run-publish-choice";
    gateRendererId = `${GROUPED_SETUP_FORM_RENDERER_ID}:output`;
    fieldRendererRegistry.register({
      id: gateRendererId, priority: 200, midRunHitl: true,
      condition: (_field, schema) => schema["x-renderer"] === gateRendererId,
      renderer: ChoiceRenderer,
    });
    if (panel === "agentic") await openGate("agent-detail");
    else await openStepper();
    fireEvent.click(screen.getByRole("button", { name: "Do not publish" }));
    const { approveReviewTask } = await import("../hitl-actions");
    await waitFor(() => expect(approveReviewTask).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(approveReviewTask).mock.calls[0][1];
    expect(payload).toEqual({ approved: false, draftId: "draft-kept" });
  });

  it.each(["agentic", "stepper"])("%s grouped mid-run still carries a decision and refusal wire", async (panel) => {
    gateRendererId = `${GROUPED_SETUP_FORM_RENDERER_ID}:output`;
    fieldRendererRegistry.register({
      id: gateRendererId, priority: 200, midRunHitl: true,
      condition: (_field, schema) => schema["x-renderer"] === gateRendererId,
      renderer: ChoiceRenderer,
    });
    if (panel === "agentic") await openGate("agent-detail");
    else await openStepper();
    fireEvent.click(screen.getByRole("button", { name: "Do not publish" }));
    const { approveReviewTask } = await import("../hitl-actions");
    await waitFor(() => expect(approveReviewTask).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(approveReviewTask).mock.calls[0][1] as Record<string, unknown>;
    expect(payload.approved).toBe(false);
    expect(JSON.parse(payload.userResponse as string)).toMatchObject({ approved: false, draftId: "draft-kept" });
  });
});

describe.each(["chat", "agent-detail", "stepper"] as const)("%s stages the latest explicit choice", (surface) => {
  async function openSurface() {
    if (surface === "stepper") await openStepper();
    else await openGate(surface);
  }
  it("a refusal supersedes an older confirming response", async () => {
    await openSurface();
    fireEvent.click(screen.getByRole("button", { name: "Publish with response" }));
    fireEvent.click(screen.getByRole("button", { name: "Do not publish" }));
    const payload = await continueGate();
    expect(payload.approved).toBe(false);
    expect(JSON.parse(payload.userResponse as string).approved).toBe(false);
  });
  it("a confirming choice supersedes an older refusal response", async () => {
    await openSurface();
    fireEvent.click(screen.getByRole("button", { name: "Decline with response" }));
    fireEvent.click(screen.getByRole("button", { name: /^Publish$/ }));
    const payload = await continueGate();
    expect(payload.approved).toBe(true);
    expect(payload.userResponse).toBeUndefined();
  });
  it("an unrelated partial change retains the authored response", async () => {
    await openSurface();
    fireEvent.click(screen.getByRole("button", { name: "Decline with response" }));
    fireEvent.click(screen.getByRole("button", { name: "Change note" }));
    const payload = await continueGate();
    expect(payload.approved).toBe(false);
    expect(payload.note).toBe("changed note");
    expect(payload.userResponse).toBe('{"approved":false,"draftId":"draft-kept"}');
  });
});


describe.each(["chat", "agent-detail", "stepper"] as const)("%s refusal after a failed send", (surface) => {
  it("retains the staged choice when the first request fails and the person retries", async () => {
    const { approveReviewTask } = await import("../hitl-actions");
    vi.mocked(approveReviewTask).mockRejectedValueOnce(new Error("network unavailable"));
    if (surface === "stepper") await openStepper();
    else await openGate(surface);
    fireEvent.click(screen.getByRole("button", { name: "Do not publish" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(approveReviewTask).toHaveBeenCalledTimes(1));
    await screen.findByRole("button", { name: "Continue" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(approveReviewTask).toHaveBeenCalledTimes(2));
    for (const [, payload] of vi.mocked(approveReviewTask).mock.calls) {
      expect(payload).toMatchObject({ approved: false, draftId: "draft-kept" });
      expect(JSON.parse((payload as Record<string, unknown>).userResponse as string)).toMatchObject({ approved: false, draftId: "draft-kept" });
    }
  });
});

describe("chat composer decision precedence", () => {
  it.each(["", "keep the draft"])("composer text %s keeps the stored refusal on the real submit road", async (value) => {
    let gate: ChatGateDescriptor | null = null;
    await openGate("chat", (_runId, next) => { gate = next; });
    fireEvent.click(screen.getByRole("button", { name: "Do not publish" }));
    await act(async () => { await gate!.submit(value); });
    const { approveReviewTask } = await import("../hitl-actions");
    const payload = vi.mocked(approveReviewTask).mock.calls[0][1] as Record<string, unknown>;
    expect(payload.approved).toBe(false);
    expect(JSON.parse(payload.userResponse as string)).toMatchObject({ approved: false, draftId: "draft-kept", userResponse: value });
  });
});
