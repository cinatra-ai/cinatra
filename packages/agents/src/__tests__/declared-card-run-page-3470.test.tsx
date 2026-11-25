// @vitest-environment jsdom
// A DECLARED CARD ON THE RUN PAGE (cinatra#3470, app-lifecycle-cards V.1): the real stepper
// draws the declared fields in its gate region, holds its one Continue until every field
// holds text, and sends the one answer the card staged.
import React from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { ensureDefaultFieldRenderersRegistered, registerFieldRendererBindings } from "../register-default-renderers";
import { OrchestratorStepperPanel } from "../orchestrator-stepper-panel";

const stream = vi.hoisted(() => ({ interruptContext: null as unknown }));
const gateSend = vi.hoisted(() => ({ approveReviewTask: vi.fn(async (..._args: unknown[]) => ({ ok: true })) }));
vi.mock("lucide-react", () => {
  const StubIcon: React.FC = () => null;
  return new Proxy({} as Record<string, React.FC>, {
    get: (_target, prop) => (prop === "__esModule" ? true : prop === "then" || typeof prop === "symbol" ? undefined : StubIcon),
    has: () => true,
    ownKeys: () => ["AlertCircle", "ArrowRight", "Check", "Info", "Loader2", "Pause", "X", "default"],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: StubIcon }),
  });
});
vi.mock("@/lib/cinatra-toast", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/agents/cinatra-ai/blog-pipeline-agent/run-3035",
}));
const ok = vi.hoisted(() => async () => ({ ok: true }));
vi.mock("../orchestrator-actions", () => ({ cancelOrchestratorAction: vi.fn(ok), resumeStoppedOrchestratorAction: vi.fn(ok) }));
vi.mock("../run-actions", () => ({
  startDevChildPreviewRun: vi.fn(async () => ({ ok: false })),
  buildSubmissionMapByStepIndex: vi.fn(async () => []),
  createAndTriggerRun: vi.fn(async () => ({ ok: true, runId: "run-next" })),
  readRunOutputEvidence: vi.fn(async () => ({ ok: true, outputs: [], hasTranscript: false, hasStepResults: false })),
}));
vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: vi.fn(async () => ({ state: "none" })),
  confirmRunRecommendationAction: vi.fn(ok),
  skipRunRecommendationAction: vi.fn(ok),
}));
vi.mock("../run-name-actions", () => ({ ensureOrCheckRunNameAction: vi.fn(async () => ({ ok: true, title: "Run 1" })) }));
vi.mock("../hitl-actions", () => ({ approveReviewTask: (...args: unknown[]) => gateSend.approveReviewTask(...args) }));
vi.mock("../use-runtime-field-renderer-bindings", () => ({ useRuntimeFieldRendererBindings: () => ({ bindings: {}, loading: false }) }));
vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: (_runId: string, opts: { initialStatus?: string }) => ({
    status: opts?.initialStatus ?? "pending_approval", interruptContext: stream.interruptContext, messages: [],
    streamedText: "", presentationHint: null, dataPartFrames: [], isLive: true, error: null,
  }),
}));

const CARD_ID = "@acme/card-fixture-agent:brief";
// A card on an id the stepper otherwise reads as the list step (cinatra#3470):
// the card's rule governs it, with no approval note.
const LIST_ID = "@acme/card-fixture-agent:list-picker";
/** A presentation hint beside the card: the card draws the step, not the hint. */
const HINT = { presentation: { type: "card_list", title: "Hint title", items: [{ title: "Hint item", description: "d" }] } };
const CASES: Array<[string, string, Record<string, unknown>]> = [
  ["a plain declared card", CARD_ID, {}],
  ["a declared card beside a presentation hint", CARD_ID, HINT],
  ["a declared card whose binding id ends in :list-picker", LIST_ID, {}],
];
const SCREEN = {
  layout: "card",
  sections: [
    { type: "fact", label: "Topic", key: "topic" },
    { type: "field", key: "angle", label: "Angle", multiline: true },
  ],
  carry: ["topic"],
};
type PanelProps = import("../orchestrator-stepper-panel").OrchestratorStepperPanelProps;

function panelProps(id: string = CARD_ID): PanelProps {
  return {
    runId: "run-3470", initialStatus: "pending_approval", initialError: null, agUiEnabled: false as boolean | null,
    agentPackageName: "@acme/card-fixture-agent", inputParams: {},
    stepperSteps: [{ index: 1, stepNumber: 1, label: "Check the brief", xRenderer: id }],
    agentId: "acme/card-fixture-agent", lgThreadId: null, templateId: "tmpl-3470", templateName: "Card Fixture Agent",
  };
}

function continueButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button")).filter((b) => /^continu/i.test((b.textContent ?? "").trim()));
}

beforeEach(() => {
  ensureDefaultFieldRenderersRegistered();
  registerFieldRendererBindings([
    { id: CARD_ID, kind: "cta", priority: 90, midRunHitl: true, screen: SCREEN },
    { id: LIST_ID, kind: "cta", priority: 90, midRunHitl: true, screen: SCREEN },
  ]);
  const body = JSON.stringify({ reviewGate: { ref: null, awaiting: false } });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200, headers: { "Content-Type": "application/json" } })));
});
afterEach(() => {
  cleanup();
  stream.interruptContext = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
afterAll(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("the run page draws a declared card and holds its Continue until the field is written", () => {
  it.each(CASES)("%s: shows the declared fact and field; Continue waits for text and then sends the one staged answer", async (_name, id, extra) => {
    stream.interruptContext = {
      xRenderer: id,
      schema: { type: "object", "x-renderer": id, properties: { angle: { type: "string", title: "Angle" } } },
      values: { stepNumber: 1, topic: "Audit trails for agent runs", ...extra },
      reviewTaskId: "gate-card-3470",
    };
    render(<OrchestratorStepperPanel {...panelProps(id)} />);
    await waitFor(() => expect(document.querySelector("[data-declared-hitl-screen]")).not.toBeNull());
    const screen = document.querySelector("[data-declared-hitl-screen]")!;
    expect(document.body.textContent).not.toContain("Hint item");
    expect(screen.textContent).toContain("Audit trails for agent runs");
    expect(continueButtons()).toHaveLength(1);
    expect(continueButtons()[0]!.disabled).toBe(true);

    const field = screen.querySelector<HTMLTextAreaElement>("textarea")!;
    fireEvent.change(field, { target: { value: "Why runs need a record" } });
    await waitFor(() => expect(continueButtons()[0]!.disabled).toBe(false));
    fireEvent.change(field, { target: { value: "" } });
    await waitFor(() => expect(continueButtons()[0]!.disabled).toBe(true));
    fireEvent.change(field, { target: { value: "Why runs need a record" } });
    await waitFor(() => expect(continueButtons()[0]!.disabled).toBe(false));
    fireEvent.click(continueButtons()[0]!);
    await waitFor(() => expect(gateSend.approveReviewTask).toHaveBeenCalledTimes(1));
    const [taskId, payload] = gateSend.approveReviewTask.mock.calls[0]! as [string, Record<string, unknown>];
    expect(taskId).toBe("gate-card-3470");
    const answer = { topic: "Audit trails for agent runs", angle: "Why runs need a record" };
    expect(payload).toMatchObject({ ...answer, userResponse: JSON.stringify(answer) });
    const declared = new Set(["topic", "angle", "userResponse", "approved", "approvedAt", "stepNumber"]);
    expect(Object.keys(payload).filter((k) => !declared.has(k))).toEqual([]);
  });
});
