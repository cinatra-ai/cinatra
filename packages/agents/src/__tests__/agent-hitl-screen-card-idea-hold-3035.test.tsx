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
import { Profiler } from "react";

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

  /**
   * The step's one Continue (`FloorOwnsContinueReportContext`): exactly one is
   * drawn in the card. While the plain form is on the screen it is the plain
   * form's own, and the card draws none.
   */
  function onlyContinue(container: HTMLElement): HTMLButtonElement {
    const all = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).filter((b) =>
      /Continu/.test(b.textContent ?? ""),
    );
    expect(all).toHaveLength(1);
    return all[0]!;
  }

  /** The plain form is on the screen and the card draws no Continue: the plain form's is the one. */
  async function plainFormDrawsTheOneContinue(container: HTMLElement): Promise<HTMLButtonElement> {
    await waitFor(() => expect(container.querySelector("input, textarea")).not.toBeNull());
    await waitFor(() => expect(cardContinue(container)).toBeNull());
    return onlyContinue(container);
  }

  /** While the component loads, that one Continue is held (the load may still replace the plain form). */
  async function plainFormHoldsTheOneContinue(container: HTMLElement) {
    expect((await plainFormDrawsTheOneContinue(container)).disabled).toBe(true);
  }

  /** Settled on the floor, that one Continue is available: the floor commits no pick to wait for. */
  async function floorOffersTheOneContinue(container: HTMLElement) {
    await plainFormDrawsTheOneContinue(container);
    await waitFor(() => expect(onlyContinue(container).disabled).toBe(false));
  }

  it("a load that fails ends the hold of the loading floor's one Continue, which then sends the typed pick", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const load = deferred();
    loadFloorComponent = () => load.promise;
    registerFloorBinding();
    asking = floorGate("task-3035-floor-1");
    const mounted = render(card("chat_thread", "task-3035-floor-1"));
    await settle();
    // The load window: the plain form is drawn, and its Continue is the step's one, held.
    await plainFormHoldsTheOneContinue(mounted.container);

    await act(async () => {
      load.reject(new Error("chunk unavailable"));
    });
    await floorOffersTheOneContinue(mounted.container);
    await enterThroughFloor(mounted.container, PICK);
    await waitFor(() => expect(approveMock).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(approveMock.mock.calls[0]![1])).toContain("idea-a1");
  });

  it("a component that throws while rendering settles on the floor, whose Continue is the step's one and is available", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const load = deferred();
    loadFloorComponent = () => load.promise;
    registerFloorBinding();
    asking = floorGate("task-3035-floor-2");
    const mounted = render(card("chat_thread", "task-3035-floor-2"));
    await settle();
    await plainFormHoldsTheOneContinue(mounted.container);

    await act(async () => {
      load.resolve({ default: ThrowingChooser });
    });
    await floorOffersTheOneContinue(mounted.container);
    expect(approveMock).not.toHaveBeenCalled();
  });

  it("the same binding mounted again for a later gate after a crash draws the plain form's one Continue, unavailable, while its component loads", async () => {
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
    await plainFormHoldsTheOneContinue(mounted.container);
  });

  it("two mounted instances of one binding keep their own Continue: one floored, one loading and then loaded", async () => {
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
    // Still loading: the plain form's Continue is its one, whatever the other instance settled on.
    await plainFormHoldsTheOneContinue(loading.container);

    await act(async () => {
      second.resolve({ default: QuietChooser });
    });
    await waitFor(() => expect(loading.container.textContent).toContain("pack chooser"));
    // The loaded chooser draws no Continue of its own: the card's is the one, held until a pick.
    await waitFor(() => expect(cardContinue(loading.container)).not.toBeNull());
    expect(onlyContinue(loading.container).disabled).toBe(true);
    // The second instance's good load leaves the first one on its floor: its floor's Continue sends.
    await floorOffersTheOneContinue(floored.container);
    await enterThroughFloor(floored.container, PICK);
    await waitFor(() => expect(approveMock).toHaveBeenCalledTimes(1));
    expect(cardContinue(loading.container)!.disabled).toBe(true);
  });

  // Review 3 of #4429: the card keeps the report above the renderer it remounts per
  // gate, so the record of gate A's floor must not reach gate B's first frame. Every
  // commit of gate B is read in the commit itself (the Profiler's onRender runs before
  // any passive effect of that commit), not after the effects have settled.
  it("a later gate of the same binding, after the earlier gate settled on the floor, offers no available card Continue in any frame while it loads", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    loadFloorComponent = () => Promise.reject(new Error("chunk unavailable"));
    registerFloorBinding();
    asking = floorGate("task-3035-floor-5a");
    const heldInFrame: boolean[] = [];
    let recording = false;
    const onRender = () => {
      if (!recording) return;
      if (!(document.body.textContent ?? "").includes("Idea for task-3035-floor-5b")) return;
      const button = cardContinue(document.body);
      if (button) heldInFrame.push(button.disabled);
    };
    const profiled = (wireRef: string) => (
      <Profiler id="hitl-screen-card" onRender={onRender}>
        {card("chat_thread", wireRef)}
      </Profiler>
    );
    const mounted = render(profiled("task-3035-floor-5a"));
    await settle();
    // Gate A settled on its floor: the floor's Continue is the step's one, available.
    await floorOffersTheOneContinue(mounted.container);

    // The run moves on: gate B mounts the same binding again, and its component is still loading.
    loadFloorComponent = () => new Promise(() => {});
    asking = floorGate("task-3035-floor-5b");
    recording = true;
    mounted.rerender(profiled("task-3035-floor-5b"));
    await settle();
    await waitFor(() => expect(mounted.container.textContent).toContain("Idea for task-3035-floor-5b"));
    // No committed frame of gate B, the first one included, offers an available card Continue.
    expect(heldInFrame).not.toContain(false);
    await plainFormHoldsTheOneContinue(mounted.container);
  });
});
