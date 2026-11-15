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
 * drawn through the pipeline's own idea binding, so the pack's chooser mounts
 * (the host's chooser is retired, cinatra#3380) and the kind's hold applies.
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
import {
  FIELD_RENDERER_PROPS_API_VERSION,
  __resetFieldRendererComponentMapForTests,
  __setFieldRendererComponentMapForTests,
} from "../field-renderer-components";
import { AgentHitlScreenCard } from "../agent-hitl-screen-card";

const RUN_ID = "run-3035-screen";
const IDEA_RENDERER_ID = "@cinatra-ai/blog-pipeline-agent:idea-selection";

const IDEAS_A = [
  { artifactId: "idea-a1", representationRevisionId: "rev-idea-a1", title: "First gate idea one", summary: "A1", text: "First gate idea one\nA1" },
  { artifactId: "idea-a2", representationRevisionId: "rev-idea-a2", title: "First gate idea two", summary: "A2", text: "First gate idea two\nA2" },
];
const IDEAS_B = [
  { artifactId: "idea-b1", representationRevisionId: "rev-idea-b1", title: "Second gate idea one", summary: "B1", text: "Second gate idea one\nB1" },
  { artifactId: "idea-b2", representationRevisionId: "rev-idea-b2", title: "Second gate idea two", summary: "B2", text: "Second gate idea two\nB2" },
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

/*
 * THE HOLD IS THE MOUNTED RENDERER'S (cinatra#3035, review 2 of #4429). A binding of
 * the kind whose component this build maps: while that instance loads, the pack may
 * still mount, so the Continue is held; once that instance settles on the floor (a
 * load that fails, a render-time throw), the floor commits no pick, so the Continue
 * is not held. The card is told by the instance it mounted, never by a state shared
 * by binding id, and the telling re-renders the card's Continue.
 */
describe("AgentHitlScreenCard - the idea step's hold follows the renderer instance it mounted (cinatra#3035)", () => {
  const FLOOR_ID = "@example/ideas:instance-hold";
  const PICK = JSON.stringify({ artifactId: "idea-a1", representationRevisionId: "rev-idea-a1" });
  let loadFloorComponent: () => Promise<unknown> = () => new Promise(() => {});

  function deferred() {
    let resolve!: (value: unknown) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  function ThrowingChooser(): never {
    throw new Error("chooser crashed");
  }

  function QuietChooser() {
    return <p>pack chooser</p>;
  }

  function registerFloorBinding() {
    __setFieldRendererComponentMapForTests({
      [FLOOR_ID]: {
        resolution: "guardedOptional",
        packageName: "@example/ideas",
        propsApiVersion: FIELD_RENDERER_PROPS_API_VERSION,
        load: () => loadFloorComponent(),
      },
    });
    registerFieldRendererBindings([{ id: FLOOR_ID, kind: "blog-idea-selection", priority: 80, midRunHitl: true }]);
  }

  /** The idea gate drawn through FLOOR_ID; its field is titled for the review task. */
  function floorGate(reviewTaskId: string) {
    const base = ideaAsking(reviewTaskId, IDEAS_A);
    return {
      ...base,
      gate: {
        ...base.gate,
        xRenderer: FLOOR_ID,
        inputSchema: {
          type: "object",
          properties: { selectedIdeaJson: { type: "string", title: `Idea for ${reviewTaskId}` } },
        },
      },
    };
  }

  /** Type a pick into the floor's field and press the floor's own Continue: the card buffers it. */
  async function enterThroughFloor(container: HTMLElement, text: string) {
    const region = container.querySelector<HTMLElement>('[data-conformance-id="hitl-screen-fields"]')!;
    const input = region.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea")!;
    fireEvent.change(input, { target: { value: text } });
    const floorContinue = Array.from(region.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      (b.textContent ?? "").includes("Continue"),
    )!;
    fireEvent.click(floorContinue);
    await settle();
  }

  function logged(errorSpy: { mock: { calls: unknown[][] } }, text: string): boolean {
    return errorSpy.mock.calls.some((call) => call.some((arg) => String(arg).includes(text)));
  }

  afterEach(() => {
    __resetFieldRendererComponentMapForTests();
    loadFloorComponent = () => new Promise(() => {});
    vi.restoreAllMocks();
  });

  it("a load that fails after a pick was entered through the loading floor makes the Continue available with no further input", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const load = deferred();
    loadFloorComponent = () => load.promise;
    registerFloorBinding();
    asking = floorGate("task-3035-floor-1");
    const mounted = render(card("chat_thread", "task-3035-floor-1"));
    await settle();
    await waitFor(() => expect(cardContinue(mounted.container)).not.toBeNull());
    // The load window: the pack's chooser may still mount, so the hold applies.
    expect(cardContinue(mounted.container)!.disabled).toBe(true);
    await enterThroughFloor(mounted.container, PICK);
    expect(cardContinue(mounted.container)!.disabled).toBe(true);

    await act(async () => {
      load.reject(new Error("chunk unavailable"));
    });
    await waitFor(() => expect(cardContinue(mounted.container)!.disabled).toBe(false));
  });

  it("a component that throws while rendering settles on the floor and makes the Continue available", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const load = deferred();
    loadFloorComponent = () => load.promise;
    registerFloorBinding();
    asking = floorGate("task-3035-floor-2");
    const mounted = render(card("chat_thread", "task-3035-floor-2"));
    await settle();
    await waitFor(() => expect(cardContinue(mounted.container)).not.toBeNull());
    expect(cardContinue(mounted.container)!.disabled).toBe(true);

    await act(async () => {
      load.resolve({ default: ThrowingChooser });
    });
    await waitFor(() => expect(cardContinue(mounted.container)!.disabled).toBe(false));
  });

  it("the same binding mounted again for a later gate after a crash starts held while its component loads", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = deferred();
    loadFloorComponent = () => first.promise;
    registerFloorBinding();
    asking = floorGate("task-3035-floor-3a");
    const mounted = render(card("chat_thread", "task-3035-floor-3a"));
    await settle();
    await act(async () => {
      first.resolve({ default: ThrowingChooser });
    });
    await waitFor(() => expect(logged(errorSpy, "threw during render")).toBe(true));

    // The run moves on: task B mounts the same binding again, and its component is still loading.
    loadFloorComponent = () => new Promise(() => {});
    asking = floorGate("task-3035-floor-3b");
    mounted.rerender(card("chat_thread", "task-3035-floor-3b"));
    await settle();
    await waitFor(() => expect(mounted.container.textContent).toContain("Idea for task-3035-floor-3b"));
    expect(cardContinue(mounted.container)!.disabled).toBe(true);
  });

  it("two mounted instances of one binding keep their own hold: one floored, one loading and then loaded", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    loadFloorComponent = () => Promise.reject(new Error("chunk unavailable"));
    registerFloorBinding();
    asking = floorGate("task-3035-floor-4");
    const floored = render(card("chat_thread", "task-3035-floor-4"));
    await settle();
    await waitFor(() => expect(logged(errorSpy, `binding "${FLOOR_ID}", reason "load-failed"`)).toBe(true));

    // A second card mounts the same binding while the first stays on its floor.
    const second = deferred();
    loadFloorComponent = () => second.promise;
    const loading = render(card("chat_thread", "task-3035-floor-4"));
    await settle();
    await waitFor(() => expect(cardContinue(loading.container)).not.toBeNull());
    // Still loading: held, whatever the other instance settled on.
    expect(cardContinue(loading.container)!.disabled).toBe(true);

    await act(async () => {
      second.resolve({ default: QuietChooser });
    });
    await waitFor(() => expect(loading.container.textContent).toContain("pack chooser"));
    // The second instance's good load does not put the hold back on the first one's floor.
    await enterThroughFloor(floored.container, PICK);
    expect(cardContinue(floored.container)!.disabled).toBe(false);
    // The loaded chooser still holds its own Continue until a pick.
    expect(cardContinue(loading.container)!.disabled).toBe(true);
  });
});
