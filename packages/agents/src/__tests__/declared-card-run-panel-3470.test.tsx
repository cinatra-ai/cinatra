// @vitest-environment jsdom
// A DECLARED CARD IN THE CONVERSATION'S RUN CARD (cinatra#3470, app-lifecycle-cards V.1):
// the real run panel draws the declared fields, holds its one Continue until every field
// holds text, and sends the one answer the card staged.
import React from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { ensureDefaultFieldRenderersRegistered, registerFieldRendererBindings } from "../register-default-renderers";

vi.mock("@cinatra-ai/sdk-ui", () => ({
  LoadingSpinner: () => null,
  PromptField: ({ placeholder }: { placeholder?: string }) => <div>{placeholder}</div>,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
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
const stream = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../use-ag-ui-run-stream", () => ({ useAgUiRunStream: () => stream.current }));

const CARD_ID = "@acme/card-fixture-agent:brief";
// A card on an id a host otherwise reads as the list step (cinatra#3470): the
// card's rule governs it, with no list pick and no approval note.
const LIST_ID = "@acme/card-fixture-agent:list-picker";
/** A presentation hint beside the card: the card draws the step, not the hint. */
const HINT = { presentation: { type: "card_list", title: "Hint title", items: [{ title: "Hint item", description: "d" }] } };
const SCREEN = {
  layout: "card",
  sections: [
    { type: "note", text: "Check the brief before it is written." },
    { type: "fact", label: "Topic", key: "topic" },
    { type: "field", key: "angle", label: "Angle" },
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

function cardStream(id: string = CARD_ID, extra: Record<string, unknown> = {}, stored = true) {
  return {
    status: "pending_approval", error: null, presentationHint: null, isLive: true, streamedText: "",
    interruptContext: {
      xRenderer: id,
      schema: { type: "object", "x-renderer": id, properties: { angle: { type: "string", title: "Angle" } }, ...(stored ? STORED : {}) },
      values: { stepNumber: 1, topic: "Audit trails for agent runs", ...extra },
      reviewTaskId: "gate-card-3470",
    },
  };
}

function continueButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button")).filter((b) => /^continu/i.test((b.textContent ?? "").trim()));
}

beforeEach(() => {
  ensureDefaultFieldRenderersRegistered();
  stream.current = cardStream();
});
afterEach(() => {
  cleanup();
  stream.current = null;
  vi.clearAllMocks();
});
afterAll(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("the run panel draws a declared card and holds its Continue until the field is written", () => {
  it.each(CASES)("%s: shows the declared note, fact and field; Continue waits for text and then sends the one staged answer", async (_name, id, extra, deployed) => {
    if (deployed) registerFieldRendererBindings([{ id, kind: "cta", priority: 90, midRunHitl: true, screen: deployed }]);
    stream.current = cardStream(id, extra);
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(<AgenticRunPanel runId="run-3470" initialStatus="pending_approval" initialError={null} initialMessages={[]} agUiEnabled={true} />);
    await waitFor(() => expect(document.querySelector("[data-declared-hitl-screen]")).not.toBeNull());
    const screen = document.querySelector("[data-declared-hitl-screen]")!;
    expect(document.body.textContent).not.toContain("Hint item");
    expect(document.body.textContent).not.toContain("Hook");
    expect(screen.textContent).toContain("Check the brief before it is written.");
    expect(screen.querySelector('[data-conformance-id="hitl-declared-facts"]')?.textContent).toContain("Audit trails for agent runs");
    expect(continueButtons()).toHaveLength(1);
    expect(continueButtons()[0]!.disabled).toBe(true);

    const field = screen.querySelector<HTMLInputElement>("input")!;
    fireEvent.change(field, { target: { value: "   " } });
    await waitFor(() => expect(continueButtons()[0]!.disabled).toBe(true));
    fireEvent.click(continueButtons()[0]!);
    expect(gateSend.approveReviewTask).not.toHaveBeenCalled();

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

describe("a step that stored no card (paused before the card was recorded) is drawn as before", () => {
  it("the run panel draws no declared card, whatever the build's binding declares now", async () => {
    registerFieldRendererBindings([{ id: CARD_ID, kind: "cta", priority: 90, midRunHitl: true, screen: SCREEN }]);
    stream.current = cardStream(CARD_ID, {}, false);
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(<AgenticRunPanel runId="run-3470" initialStatus="pending_approval" initialError={null} initialMessages={[]} agUiEnabled={true} />);
    await waitFor(() => expect(continueButtons().length).toBeGreaterThan(0));
    expect(document.querySelector("[data-declared-hitl-screen]")).toBeNull();
  });
});
