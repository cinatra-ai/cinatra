// @vitest-environment jsdom
// A DECLARED CARD ON THE CONVERSATION'S HITL SCREEN CARD (cinatra#3470, app-lifecycle-cards
// V.1): the real card draws the declared fields, holds its Continue until every field holds
// text, and sends the one answer the card staged; a refused declaration draws the plain form.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import type { LifecycleCardHost } from "@cinatra-ai/agent-ui-protocol/renderable-views";

const screenStateMock = vi.fn();
vi.mock("../agent-hitl-screen-actions", () => ({
  getAgentHitlScreenStateAction: (input: { runId: string }) => screenStateMock(input),
}));
const approveMock = vi.fn(async (_taskId: string, _values?: unknown, _fieldName?: string) => ({ ok: true as const }));
vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: async () => ({ connectedApps: [], gmailAliases: [] }),
}));
vi.mock("../hitl-actions", () => ({
  approveReviewTask: (taskId: string, values?: unknown, fieldName?: string) => approveMock(taskId, values, fieldName),
  rejectReviewTask: vi.fn(async () => undefined),
}));

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { fieldRendererRegistry } from "../field-renderer-registry";
import { ensureDefaultFieldRenderersRegistered, registerFieldRendererBindings } from "../register-default-renderers";
import { AgentHitlScreenCard } from "../agent-hitl-screen-card";

const RUN_ID = "run-3470-screen";
const CARD_ID = "@acme/card-fixture-agent:brief";
const SCREEN = {
  layout: "card",
  sections: [
    { type: "note", text: "Check the brief before it is written." },
    { type: "field", key: "angle", label: "Angle" },
  ],
  carry: ["topic"],
};

// A card on an id a host otherwise reads by its suffix (cinatra#3470): the
// card's rule governs it.
const LIST_ID = "@acme/card-fixture-agent:list-picker";
/** A presentation hint beside the card: the card draws the step, not the hint. */
const HINT = { presentation: { type: "card_list", title: "Hint title", items: [{ title: "Hint item", description: "d" }] } };
/** The same renderer in a newer build: its field is another one. */
const SCREEN_V2 = { layout: "card", sections: [{ type: "field", key: "hook", label: "Hook" }] };
/** The card the step paused with, as the server stored it in the step's schema. */
const stored = (screen: Record<string, unknown> = SCREEN) => ({ "x-declared-screen": { screen, digest: "sha256:fixture" } });
// [case, renderer id, extra run values, the screen the build declares NOW (null: no binding)]
const CASES: Array<[string, string, Record<string, unknown>, Record<string, unknown> | null]> = [
  ["the card it paused with, its binding since removed", CARD_ID, {}, null],
  ["the card it paused with, its binding since changed", CARD_ID, {}, SCREEN_V2],
  ["the card it paused with, beside a presentation hint", CARD_ID, HINT, SCREEN],
  ["the card it paused with, on a binding id ending in :list-picker", LIST_ID, {}, SCREEN],
];

function askingFor(id: string, extra: Record<string, unknown> = {}, schemaExtra: Record<string, unknown> = stored()) {
  return {
    state: "asking" as const,
    runId: RUN_ID,
    screenRef: "hitl-screen-ref-task-3470",
    gate: {
      reviewTaskId: "task-3470",
      xRenderer: id,
      inputSchema: { type: "object", properties: { angle: { type: "string", title: "Angle" } }, ...schemaExtra },
      currentValues: { topic: "Audit trails for agent runs", ...extra },
      fieldName: undefined,
    },
  };
}
let asking = askingFor(CARD_ID);
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  asking = askingFor(CARD_ID);
  fieldRendererRegistry.clear();
  ensureDefaultFieldRenderersRegistered();
  screenStateMock.mockImplementation(async () => asking);
  approveMock.mockClear();
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(asking), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  fieldRendererRegistry.clear();
  ensureDefaultFieldRenderersRegistered();
  vi.restoreAllMocks();
});

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 20));
    await Promise.resolve();
  });
}

function mount(host: LifecycleCardHost) {
  return render(
    <LifecycleCardSurfaceProvider host={host}>
      <AgentHitlScreenCard runId={RUN_ID} wireRef="task-3470" />
    </LifecycleCardSurfaceProvider>,
  );
}

const cardContinue = (c: HTMLElement) => c.querySelector<HTMLButtonElement>('[data-action="submit-hitl-screen"]');

describe("AgentHitlScreenCard draws a declared card (cinatra#3470)", () => {
  it.each(CASES)("chat_thread, %s: the Continue is held until the field holds text, then sends the one staged answer", async (_name, id, extra, deployed) => {
    asking = askingFor(id, extra);
    if (deployed) registerFieldRendererBindings([{ id, kind: "cta", priority: 90, midRunHitl: true, screen: deployed }]);
    const { container } = mount("chat_thread");
    await settle();
    await waitFor(() => expect(container.querySelector("[data-declared-hitl-screen]")).not.toBeNull());
    expect(container.textContent).toContain("Check the brief before it is written.");
    expect(container.textContent).not.toContain("Hint item");
    expect(container.textContent).not.toContain("Hook");
    await waitFor(() => expect(cardContinue(container)).not.toBeNull());
    expect(cardContinue(container)!.disabled).toBe(true);

    const field = container.querySelector<HTMLInputElement>("[data-declared-hitl-screen] input")!;
    fireEvent.change(field, { target: { value: "Why runs need a record" } });
    await waitFor(() => expect(cardContinue(container)!.disabled).toBe(false));
    fireEvent.click(cardContinue(container)!);
    await waitFor(() => expect(approveMock).toHaveBeenCalledTimes(1));
    const [taskId, payload] = approveMock.mock.calls[0]! as [string, Record<string, unknown>];
    expect(taskId).toBe("task-3470");
    const answer = { topic: "Audit trails for agent runs", angle: "Why runs need a record" };
    expect(payload).toMatchObject({ ...answer, userResponse: JSON.stringify(answer) });
    const declared = new Set(["topic", "angle", "userResponse", "approved", "approvedAt", "stepNumber"]);
    expect(Object.keys(payload).filter((k) => !declared.has(k))).toEqual([]);
  });

  it("a refused stored declaration (a decision) draws no declared card and never a blank one", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const refused = { ...SCREEN, sections: [...SCREEN.sections, { type: "decision", key: "d" }] };
    asking = askingFor(CARD_ID, {}, stored(refused));
    registerFieldRendererBindings([{ id: CARD_ID, kind: "cta", priority: 90, midRunHitl: true }]);
    const { container } = mount("chat_thread");
    await settle();
    await waitFor(() => expect(cardContinue(container)).not.toBeNull());
    expect(container.querySelector("[data-declared-hitl-screen]")).toBeNull();
    expect(errors.mock.calls.some((c) => String(c[0]).includes("declared screen refused"))).toBe(true);
  });

  it("a step that stored no card (paused before the card was recorded) draws no declared card, whatever the build declares now", async () => {
    asking = askingFor(CARD_ID, {}, {});
    registerFieldRendererBindings([{ id: CARD_ID, kind: "cta", priority: 90, midRunHitl: true, screen: SCREEN }]);
    const { container } = mount("chat_thread");
    await settle();
    await waitFor(() => expect(cardContinue(container)).not.toBeNull());
    expect(container.querySelector("[data-declared-hitl-screen]")).toBeNull();
  });
});
