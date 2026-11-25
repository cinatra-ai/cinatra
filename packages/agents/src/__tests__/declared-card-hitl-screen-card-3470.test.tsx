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

const asking = {
  state: "asking" as const,
  runId: RUN_ID,
  screenRef: "hitl-screen-ref-task-3470",
  gate: {
    reviewTaskId: "task-3470",
    xRenderer: CARD_ID,
    inputSchema: { type: "object", properties: { angle: { type: "string", title: "Angle" } } },
    currentValues: { topic: "Audit trails for agent runs" },
    fieldName: undefined,
  },
};
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
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
  it("chat_thread: the Continue is held until the field holds text, then sends the one staged answer", async () => {
    registerFieldRendererBindings([{ id: CARD_ID, kind: "cta", priority: 90, midRunHitl: true, screen: SCREEN }]);
    const { container } = mount("chat_thread");
    await settle();
    await waitFor(() => expect(container.querySelector("[data-declared-hitl-screen]")).not.toBeNull());
    expect(container.textContent).toContain("Check the brief before it is written.");
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

  it("a refused declaration (a decision) draws no declared card and never a blank one", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const refused = { ...SCREEN, sections: [...SCREEN.sections, { type: "decision", key: "d" }] };
    registerFieldRendererBindings([{ id: CARD_ID, kind: "cta", priority: 90, midRunHitl: true, screen: refused }]);
    const { container } = mount("chat_thread");
    await settle();
    await waitFor(() => expect(cardContinue(container)).not.toBeNull());
    expect(container.querySelector("[data-declared-hitl-screen]")).toBeNull();
    expect(errors.mock.calls.some((c) => String(c[0]).includes("declared screen refused"))).toBe(true);
  });
});
