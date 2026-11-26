// @vitest-environment jsdom
// A DECLARED CARD ON THE RUN PAGE (cinatra#3470, app-lifecycle-cards V.1): the real stepper
// draws the declared fields in its gate region, holds its one Continue until every field
// holds text, and sends the one answer the card staged.
import React from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { ensureDefaultFieldRenderersRegistered, registerFieldRendererBindings } from "../register-default-renderers";
import { OrchestratorStepperPanel } from "../orchestrator-stepper-panel";
import { declaredCardEntryOf } from "../declared-hitl-screen-renderer";
import type { FieldRendererProps } from "../field-renderer-registry";

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
  usePathname: () => "/agents/acme/card-fixture-agent/run-3470",
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
// The run window's registration, captured: its submit is how files reach a screen.
const windowScreen = vi.hoisted(() => ({
  current: null as null | { onSubmit: (p: string, a?: unknown[]) => Promise<void>; enableAttachments?: boolean },
}));
vi.mock("../run-window-screen-context", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useRunWindowScreen: (screen: typeof windowScreen.current) => {
    windowScreen.current = screen;
  },
}));
vi.mock("../use-run-window-conversation", () => ({
  useRunWindowConversation: () => ({ entries: [], pending: false, send: async () => ({ fill: null, acted: false }) }),
}));
/** A file the person attached in the run window. */
const FILE = {
  artifactId: "art-3470",
  representationRevisionId: "rev-3470",
  digest: "sha256:3470",
  mime: "application/pdf",
  originKind: "upload",
  filename: "brief.pdf",
  size: 10,
};
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
const SCREEN = {
  layout: "card",
  sections: [
    { type: "fact", label: "Topic", key: "topic" },
    { type: "field", key: "angle", label: "Angle", multiline: true },
  ],
  carry: ["topic"],
};
/** The same renderer in a newer build: its field is another one. */
const SCREEN_V2 = { layout: "card", sections: [{ type: "field", key: "hook", label: "Hook" }] };
/** The card the step paused with, as the server stored it in the step's schema. */
const STORED = { "x-declared-screen": { screen: SCREEN, digest: "sha256:fixture" } };
// [case, renderer id, extra run values, the screen the build declares NOW (null: no binding)]
const CASES: Array<[string, string, Record<string, unknown>, Record<string, unknown> | null]> = [
  ["the card it paused with, its binding since removed", CARD_ID, {}, null],
  ["the card it paused with, its binding since changed", CARD_ID, {}, SCREEN_V2],
  ["the card it paused with, beside a presentation hint", CARD_ID, HINT, SCREEN],
  ["the card it paused with, on a binding id ending in :list-picker", LIST_ID, {}, SCREEN],
];
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
  it.each(CASES)("%s: shows the declared fact and field; Continue waits for text and then sends the one staged answer", async (_name, id, extra, deployed) => {
    if (deployed) registerFieldRendererBindings([{ id, kind: "cta", priority: 90, midRunHitl: true, screen: deployed }]);
    stream.interruptContext = {
      xRenderer: id,
      schema: { type: "object", "x-renderer": id, properties: { angle: { type: "string", title: "Angle" } }, ...STORED },
      values: { stepNumber: 1, topic: "Audit trails for agent runs", ...extra },
      reviewTaskId: "gate-card-3470",
    };
    render(<OrchestratorStepperPanel {...panelProps(id)} />);
    await waitFor(() => expect(document.querySelector("[data-declared-hitl-screen]")).not.toBeNull());
    const screen = document.querySelector("[data-declared-hitl-screen]")!;
    expect(document.body.textContent).not.toContain("Hint item");
    expect(document.body.textContent).not.toContain("Hook");
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

describe("the run page draws the declared field as the chat card does (V.1)", () => {
  it("the label and the control carry the chat card's classes under its one field rule, and no bordered box surrounds the fields inside the card", async () => {
    const schema = { type: "object", "x-renderer": CARD_ID, properties: { angle: { type: "string", title: "Angle" } }, ...STORED };
    // The chat card's form: the shared renderer it mounts, inside its region's field rule.
    const Chat = declaredCardEntryOf(CARD_ID, schema)!.renderer;
    const chat = render(<Chat {...({ value: {}, onChange: () => {}, mode: "edit" } as unknown as FieldRendererProps)} />);
    const chatLabel = chat.container.querySelector("[data-declared-hitl-screen] label")!.className;
    const chatField = chat.container.querySelector("[data-declared-hitl-screen] textarea")!.className;
    chat.unmount();

    stream.interruptContext = {
      xRenderer: CARD_ID,
      schema,
      values: { stepNumber: 1, topic: "Audit trails for agent runs" },
      reviewTaskId: "gate-card-3470",
    };
    render(<OrchestratorStepperPanel {...panelProps(CARD_ID)} />);
    await waitFor(() => expect(document.querySelector("[data-declared-hitl-screen]")).not.toBeNull());
    const screen = document.querySelector("[data-declared-hitl-screen]")!;
    const label = screen.querySelector("label")!;
    const field = screen.querySelector("textarea")!;
    expect(label.className).toBe(chatLabel);
    expect(field.className).toBe(chatField);
    expect(label.closest(".lifecycle-fields-subordinate")).not.toBeNull();
    expect(field.closest(".lifecycle-fields-subordinate")).not.toBeNull();

    // The card is the one frame: nothing between it and the fields draws a box.
    const card = screen.closest<HTMLElement>('[data-slot="card"]')!;
    expect(card).not.toBeNull();
    for (let el: HTMLElement | null = screen as HTMLElement; el && el !== card; el = el.parentElement) {
      expect(el.className).not.toMatch(/(^|\s)(soft-panel|border|rounded-panel|bg-surface-muted)(\s|$)/);
    }
  });
});

describe("a step that stored no card (paused before the card was recorded) is drawn as before", () => {
  it("the run page draws no declared card, whatever the build's binding declares now", async () => {
    registerFieldRendererBindings([{ id: CARD_ID, kind: "cta", priority: 90, midRunHitl: true, screen: SCREEN }]);
    stream.interruptContext = {
      xRenderer: CARD_ID,
      schema: { type: "object", "x-renderer": CARD_ID, properties: { angle: { type: "string", title: "Angle" } } },
      values: { stepNumber: 1, topic: "Audit trails for agent runs" },
      reviewTaskId: "gate-card-3470",
    };
    render(<OrchestratorStepperPanel {...panelProps(CARD_ID)} />);
    await waitFor(() => expect(continueButtons().length).toBeGreaterThan(0));
    expect(document.querySelector("[data-declared-hitl-screen]")).toBeNull();
  });
});

describe("a declared card takes no files", () => {
  it("the run page: the window offers no attach control, a file sent while the card is open is not kept, and the card's answer is sent without it", async () => {
    stream.interruptContext = {
      xRenderer: CARD_ID,
      schema: { type: "object", "x-renderer": CARD_ID, properties: { angle: { type: "string", title: "Angle" } }, ...STORED },
      values: { stepNumber: 1, topic: "Audit trails for agent runs" },
      reviewTaskId: "gate-card-3470",
    };
    render(<OrchestratorStepperPanel {...panelProps(CARD_ID)} />);
    await waitFor(() => expect(document.querySelector("[data-declared-hitl-screen]")).not.toBeNull());
    expect(windowScreen.current?.enableAttachments).not.toBe(true);
    await act(async () => {
      await windowScreen.current!.onSubmit("Use the attached brief", [FILE]).catch(() => undefined);
    });
    const field = document.querySelector<HTMLElement>("[data-declared-hitl-screen] input, [data-declared-hitl-screen] textarea")!;
    fireEvent.change(field, { target: { value: "Why runs need a record" } });
    await waitFor(() => expect(continueButtons()[0]!.disabled).toBe(false));
    fireEvent.click(continueButtons()[0]!);
    await waitFor(() => expect(gateSend.approveReviewTask).toHaveBeenCalledTimes(1));
    const payload = gateSend.approveReviewTask.mock.calls[0]![1] as Record<string, unknown>;
    const answer = { topic: "Audit trails for agent runs", angle: "Why runs need a record" };
    expect(payload.userResponse).toBe(JSON.stringify(answer));
    expect(JSON.stringify(payload)).not.toContain("art-3470");
  });
});
