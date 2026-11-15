// @vitest-environment jsdom
/**
 * cinatra#3035 - THE IDEA STEP ON THE HITL SCREEN CARD.
 *
 * The screen card draws the same Continue as the run page and the conversation
 * card (`specs/app-artifact-review.html` I.1, I.3): a gate whose renderer kind
 * holds its Continue until a pick opens with nothing picked and its Continue
 * unavailable. A later gate with the same renderer and no field name (another
 * review task) must open the same way: no row checked from the earlier gate,
 * and its Continue held again.
 *
 * Harness mirrors agent-hitl-screen-card-boolean-4310.test.tsx. The gate is
 * drawn through a runtime binding of the idea kind, so the host's own chooser
 * mounts (the kind's renderer, declared safe without a session).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import type { LifecycleCardHost } from "@cinatra-ai/agent-ui-protocol/renderable-views";

const screenStateMock = vi.fn();
vi.mock("../agent-hitl-screen-actions", () => ({
  getAgentHitlScreenStateAction: (input: { runId: string }) => screenStateMock(input),
}));

const approveMock = vi.fn(
  async (_taskId: string, _values?: unknown, _fieldName?: string) => ({ ok: true as const }),
);
vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: async () => ({
    connectedApps: [],
    gmailAliases: [],
  }),
}));

vi.mock("../hitl-actions", () => ({
  approveReviewTask: (taskId: string, values?: unknown, fieldName?: string) =>
    approveMock(taskId, values, fieldName),
  rejectReviewTask: vi.fn(async () => undefined),
}));

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { fieldRendererRegistry } from "../field-renderer-registry";
import {
  ensureDefaultFieldRenderersRegistered,
  registerFieldRendererBindings,
} from "../register-default-renderers";
import { AgentHitlScreenCard } from "../agent-hitl-screen-card";

const RUN_ID = "run-3035-screen";
const IDEA_RENDERER_ID = "@cinatra-test/idea-kind-3035:ideas";

const IDEAS_A = [
  { title: "First gate idea one", summary: "A1" },
  { title: "First gate idea two", summary: "A2" },
];
const IDEAS_B = [
  { title: "Second gate idea one", summary: "B1" },
  { title: "Second gate idea two", summary: "B2" },
];

/** A mid-run idea gate with no field name, for one review task. */
function ideaAsking(reviewTaskId: string, ideas: typeof IDEAS_A) {
  return {
    state: "asking" as const,
    runId: RUN_ID,
    screenRef: `hitl-screen-ref-${reviewTaskId}`,
    gate: {
      reviewTaskId,
      xRenderer: IDEA_RENDERER_ID,
      inputSchema: {
        type: "object",
        properties: { selectedIdeaJson: { type: "string" } },
      },
      currentValues: { ideas },
      fieldName: undefined,
    },
  };
}

let asking = ideaAsking("task-3035-a", IDEAS_A);
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  fieldRendererRegistry.clear();
  ensureDefaultFieldRenderersRegistered();
  registerFieldRendererBindings([
    { id: IDEA_RENDERER_ID, kind: "blog-idea-selection", priority: 80, midRunHitl: true },
  ]);
  asking = ideaAsking("task-3035-a", IDEAS_A);
  screenStateMock.mockImplementation(async () => asking);
  approveMock.mockClear();
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(asking), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  fieldRendererRegistry.clear();
  ensureDefaultFieldRenderersRegistered();
  vi.clearAllMocks();
});

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 20));
    await Promise.resolve();
  });
}

function card(host: LifecycleCardHost, wireRef: string) {
  return (
    <LifecycleCardSurfaceProvider host={host}>
      <AgentHitlScreenCard runId={RUN_ID} wireRef={wireRef} />
    </LifecycleCardSurfaceProvider>
  );
}

function radios(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[role="radio"]'));
}

function checkedRadios(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[role="radio"][aria-checked="true"]'));
}

function cardContinue(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('[data-action="submit-hitl-screen"]');
}

describe("AgentHitlScreenCard - the idea step holds its Continue until a pick (cinatra#3035)", () => {
  it("chat_thread: the gate opens with nothing picked and its Continue disabled; one press on a row makes it available", async () => {
    const mounted = render(card("chat_thread", "task-3035-a"));
    await settle();
    await waitFor(() => expect(radios(mounted.container)).toHaveLength(2));
    expect(checkedRadios(mounted.container)).toHaveLength(0);
    await waitFor(() => expect(cardContinue(mounted.container)).not.toBeNull());
    expect(cardContinue(mounted.container)!.disabled).toBe(true);

    fireEvent.click(radios(mounted.container)[0]!);
    await waitFor(() => expect(checkedRadios(mounted.container)).toHaveLength(1));
    await waitFor(() => expect(cardContinue(mounted.container)!.disabled).toBe(false));
  });

  it("chat_thread: a later idea gate (another review task, the same renderer, no field name) shows no row checked from the earlier gate and holds its Continue", async () => {
    const mounted = render(card("chat_thread", "task-3035-a"));
    await settle();
    await waitFor(() => expect(radios(mounted.container)).toHaveLength(2));
    fireEvent.click(radios(mounted.container)[0]!);
    await waitFor(() => expect(checkedRadios(mounted.container)).toHaveLength(1));
    await waitFor(() => expect(cardContinue(mounted.container)!.disabled).toBe(false));

    // The run moves on: the next read brings task B with the same renderer.
    asking = ideaAsking("task-3035-b", IDEAS_B);
    mounted.rerender(card("chat_thread", "task-3035-b"));
    await settle();
    await waitFor(() => expect(mounted.container.textContent).toContain("Second gate idea one"));
    await waitFor(() => expect(cardContinue(mounted.container)!.disabled).toBe(true));
    // The chooser on screen is task B's, freshly mounted: nothing is checked.
    expect(radios(mounted.container)).toHaveLength(2);
    expect(checkedRadios(mounted.container)).toHaveLength(0);
    expect(approveMock).not.toHaveBeenCalled();
  });
});
