// @vitest-environment jsdom
/**
 * A MARKED REVIEW STEP'S SECOND GATE OPENS WITH ITS DECISION FLOOR
 * (cinatra#3035, CELL2 of round 3035-railg1).
 *
 * A template-marked review step that names two artifacts opens one gate per
 * artifact in ONE pause: the post's gate (`<task>`) and the featured image's
 * gate (`<task>#2`). The run announces ONE interrupt for that pause, and it
 * names the first leg that is not yet resolved when it is sent (the post's, on a
 * fresh pause). When the person decides the post, the run does not resume (the
 * image's gate is still open), so no new interrupt arrives: the interrupt still
 * names the post's gate, which is now decided.
 *
 * Both run panels took the card of a marked gate from that interrupt alone. So
 * after one Continue the run detail drew the post's settled card where the
 * image's gate should stand: no decision bar and no prompt window, while the
 * rail already named the image's gate as the pending one. The run's review slot
 * (the server's own election of the current gate) did name the image's gate,
 * through a look of the slot reader or through the server render that follows,
 * but the marked-gate branch never read it.
 *
 * The rule under test: of the interrupt's gate and the slot's gate of the SAME
 * PAUSE (same task id before `#`), the card shows the one not known to be
 * resolved. The inverse order is covered too: the slot still holds the decided
 * post gate while a replayed or retried interrupt already names the image's
 * gate. A slot that names a gate of another pause never replaces the
 * interrupt's own gate.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/marked-review-next-leg-of-one-pause-3035.test.tsx
 */
// red-first-expect: the image gate drew no decision bar with its terminal control
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

import { ARTIFACT_REVIEW_REDIRECT_RENDERER_ID } from "../agent-builder-ids";

vi.mock("lucide-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lucide-react")>();
  const StubIcon: React.FC = () => null;
  return new Proxy({} as Record<string, React.FC>, {
    get: (_target, prop) => {
      if (prop === "Loader2Icon" || prop === "Loader2") return actual.Loader2Icon;
      if (prop === "__esModule") return true;
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return undefined;
      return StubIcon;
    },
    has: () => true,
    ownKeys: () => ["AlertCircle", "ArrowRight", "Check", "Info", "Loader2", "Pause", "X", "default"],
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
      value: StubIcon,
    }),
  });
});

vi.mock("@/lib/cinatra-toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("../orchestrator-actions", () => ({
  cancelOrchestratorAction: vi.fn(async () => ({ ok: true })),
  resumeStoppedOrchestratorAction: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../run-actions", () => ({
  startDevChildPreviewRun: vi.fn(async () => ({ ok: false })),
  buildSubmissionMapByStepIndex: vi.fn(async () => []),
  createAndTriggerRun: vi.fn(async () => ({ ok: true, runId: "run-next" })),
  resetAgentRun: vi.fn(async () => ({ ok: true })),
  triggerAgentRun: vi.fn(async () => ({ ok: true })),
  readRunOutputEvidence: vi.fn(async () => ({
    ok: true as const,
    outputs: [] as { id: string; type: string; title: string }[],
    hasTranscript: false,
    hasStepResults: false,
    outputsUnavailable: false,
    unlinkableOutputs: 0,
  })),
}));

vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: vi.fn(async () => ({ state: "none" })),
  decideRunRecommendationAction: vi.fn(async () => ({ ok: true })),
  confirmRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
  skipRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
}));

vi.mock("../run-name-actions", () => ({
  ensureOrCheckRunNameAction: vi.fn(async () => ({ ok: true, title: "Run 1" })),
}));

vi.mock("../hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => ({ ok: true })),
  rejectReviewTask: vi.fn(async () => undefined),
}));

vi.mock("../a2a-actions", () => ({
  getAgentBuilderTask: vi.fn(async () => null),
}));

vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({
    connectedApps: [],
    gmailAliases: [],
    runId: "run-3035-legs",
  })),
  getAuditAvailabilityAction: vi.fn(async () => ({ visible: false, promptCount: 0, skillCount: 0 })),
  getSkillsForAgentAction: vi.fn(async () => []),
  confirmRunSkillSelectionAction: vi.fn(async () => ({ ok: true })),
  getRunRecommendedSkillsAction: vi.fn(async () => []),
}));

vi.mock("../agent-ui-override-registry", () => ({
  agentUIOverrideRegistry: { resolve: () => null },
}));

// The gate's prompt window keeps its exchange with the run; nothing was said.
vi.mock("../run-window-actions", () => ({
  loadRunWindowConversation: vi.fn(async () => []),
  sendRunWindowTurn: vi.fn(async () => ({ ok: true, entries: [], fills: [], acted: false })),
}));

const streamState = vi.hoisted(() => ({
  status: "pending_approval" as string | null,
  interruptContext: null as Record<string, unknown> | null,
}));
vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: () => ({
    status: streamState.status,
    interruptContext: streamState.interruptContext,
    messages: [],
    streamedText: "",
    presentationHint: null,
    dataPartFrames: [],
    error: null,
    isLive: false,
  }),
}));

vi.mock("../use-runtime-field-renderer-bindings", () => ({
  useRuntimeFieldRendererBindings: () => ({ bindings: {}, loading: false }),
}));

// THE PAGE OWNS THE WINDOW (cinatra#3487): the run detail registers the gate's
// prompt window with the run page's chrome, which draws it. The panel is
// mounted under the chrome, as the run page mounts it.
import { RunPageChrome } from "../run-page-chrome";

const RUN_ID = "run-3035-legs";
// One pause, two artifacts: the leg ids the gate planner mints.
const POST_TASK = "wf-task-3035";
const IMAGE_TASK = "wf-task-3035#2";
// A gate of ANOTHER pause of the same run.
const OTHER_TASK = "wf-task-earlier";
const POST_REF = "lcr-3035-post-gate";
const IMAGE_REF = "lcr-3035-image-gate";
const OTHER_REF = "lcr-3035-earlier-gate";

const POST_SLOT = { ref: POST_REF, awaiting: false, producedReviewPark: false, reviewTaskId: POST_TASK };
const IMAGE_SLOT = { ref: IMAGE_REF, awaiting: false, producedReviewPark: false, reviewTaskId: IMAGE_TASK };
const OTHER_SLOT = { ref: OTHER_REF, awaiting: false, producedReviewPark: false, reviewTaskId: OTHER_TASK };

/** The one interrupt the pause announced: it names the post's gate. */
const POST_INTERRUPT = {
  schema: { type: "object" },
  xRenderer: ARTIFACT_REVIEW_REDIRECT_RENDERER_ID,
  values: {
    reviewTaskId: POST_TASK,
    lifecycleCardRef: POST_REF,
    reviewSurfaceUrl: `/agents/cinatra-ai/blog-pipeline-agent/${RUN_ID}`,
    targetCount: 2,
  },
  reviewTaskId: POST_TASK,
};
/** The same interrupt as the conversation's panel reads it from the run route. */
const POST_HITL_CONTEXT = {
  reviewTaskId: POST_TASK,
  xRenderer: ARTIFACT_REVIEW_REDIRECT_RENDERER_ID,
  fieldName: null,
  fields: [],
  currentValues: { reviewTaskId: POST_TASK, lifecycleCardRef: POST_REF },
};
/**
 * A replayed or retried interrupt of the same pause, sent after the post was
 * decided: the first unresolved leg is now the image's, so it names that gate.
 */
const IMAGE_INTERRUPT = {
  ...POST_INTERRUPT,
  values: { ...POST_INTERRUPT.values, reviewTaskId: IMAGE_TASK, lifecycleCardRef: IMAGE_REF },
  reviewTaskId: IMAGE_TASK,
};
const IMAGE_HITL_CONTEXT = {
  ...POST_HITL_CONTEXT,
  reviewTaskId: IMAGE_TASK,
  currentValues: { reviewTaskId: IMAGE_TASK, lifecycleCardRef: IMAGE_REF },
};

const RESOLVE_SETTLED = {
  kind: "artifact_review_gate",
  state: { state: "settled", outcome: "approved" },
  body: null,
};
const RESOLVE_PENDING = {
  kind: "artifact_review_gate",
  state: { state: "pending", canDecide: true, canComment: true },
  body: null,
};

/** The refs the card asked the resolve route about. */
const resolvedRefs: string[] = [];

/**
 * The run route answers `slot` for the run's review slot (null: the look never
 * answers); the resolve route answers pending for the image's gate only, the
 * post's gate (and any other) is decided.
 */
function stubFetch(slot: Record<string, unknown> | null, hitlContext: Record<string, unknown> | null = null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { body?: unknown }) => {
      const url = String(input);
      if (url.includes("/api/agents/runs/")) {
        if (slot === null) return new Promise<Response>(() => {});
        return new Response(
          JSON.stringify({
            status: "pending_approval",
            error: null,
            startedAt: null,
            completedAt: null,
            messages: [],
            hitlContext,
            reviewGate: slot,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      const ref = (JSON.parse(String(init?.body ?? "{}")) as { ref?: string }).ref ?? "";
      resolvedRefs.push(ref);
      return new Response(JSON.stringify(ref === IMAGE_REF ? RESOLVE_PENDING : RESOLVE_SETTLED), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

beforeEach(() => {
  streamState.status = "pending_approval";
  streamState.interruptContext = POST_INTERRUPT;
  resolvedRefs.length = 0;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

type StepperProps = import("../orchestrator-stepper-panel").OrchestratorStepperPanelProps;

function stepperProps(overrides: Partial<StepperProps> = {}): StepperProps {
  return {
    runId: RUN_ID,
    initialStatus: "pending_approval",
    initialError: null,
    agUiEnabled: false as boolean | null,
    agentPackageName: "@cinatra-ai/blog-pipeline-agent",
    inputParams: {},
    stepperSteps: [
      { index: 1, stepNumber: 0, label: "Setup", xRenderer: "grouped-setup-form" },
      { index: 2, stepNumber: 1, label: "Review", xRenderer: ARTIFACT_REVIEW_REDIRECT_RENDERER_ID },
    ],
    agentId: "cinatra-ai/blog-pipeline-agent",
    lgThreadId: null,
    templateId: "tmpl-3035",
    templateName: "Blog pipeline",
    ...overrides,
  };
}

const SETTLED = '[data-conformance-id="review-gate-settled"]';
const DECISION_BAR = '[data-conformance-id="review-decision-bar"]';
const PROMPT_WINDOW = '[data-conformance-id="review-prompt-window"]';
const CHROME_PROMPT_WINDOW = `[data-run-window-host="page-chrome"] ${PROMPT_WINDOW}`;

/** The bar's terminal affirmative control, however the floor names it. */
function terminalControl(root: ParentNode): HTMLButtonElement | null {
  const bar = root.querySelector(DECISION_BAR);
  if (!bar) return null;
  const buttons = Array.from(bar.querySelectorAll("button"));
  return (
    buttons.find((button) => /^(approve|continue)$/i.test((button.textContent ?? "").trim())) ??
    null
  );
}

async function expectTheImageFloor(container: HTMLElement) {
  await waitFor(
    () => {
      if (!terminalControl(container)) {
        throw new Error("the image gate drew no decision bar with its terminal control");
      }
    },
    { timeout: 15_000 },
  );
  expect(terminalControl(container)!.disabled).toBe(false);
  expect(container.querySelector(CHROME_PROMPT_WINDOW), "the image gate drew no prompt window").not.toBeNull();
  expect(container.querySelector(SETTLED), "the decided post gate is still drawn").toBeNull();
  expect(resolvedRefs).toContain(IMAGE_REF);
}

describe("the run detail (OrchestratorStepperPanel): the next gate of one marked pause", () => {
  it("draws the image gate's floor once the slot reader finds it, though the interrupt still names the post", async () => {
    stubFetch(IMAGE_SLOT);
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    const { container } = render(<RunPageChrome><OrchestratorStepperPanel {...stepperProps({ initialReviewGate: POST_SLOT })} /></RunPageChrome>);
    await expectTheImageFloor(container);
  }, 60_000);

  it("draws the image gate's floor when the server render hands it over, with the reader silent", async () => {
    stubFetch(null);
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    const { container, rerender } = render(
      <RunPageChrome><OrchestratorStepperPanel {...stepperProps({ initialReviewGate: POST_SLOT })} /></RunPageChrome>,
    );
    // The post's gate, decided: a settled card, and nothing to press.
    await waitFor(
      () => {
        if (!container.querySelector(SETTLED)) throw new Error("the settled card never drew");
      },
      { timeout: 20_000 },
    );
    expect(container.querySelector(DECISION_BAR)).toBeNull();

    rerender(<RunPageChrome><OrchestratorStepperPanel {...stepperProps({ initialReviewGate: IMAGE_SLOT })} /></RunPageChrome>);
    await expectTheImageFloor(container);
  }, 60_000);

  it("keeps the interrupt's own gate when the slot names a gate of another pause", async () => {
    // Here the post's gate is the open one; the slot's answer is an earlier
    // pause's decided gate and must not replace it.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: { body?: unknown }) => {
        const url = String(input);
        if (url.includes("/api/agents/runs/")) {
          return new Response(
            JSON.stringify({ status: "pending_approval", error: null, messages: [], hitlContext: null, reviewGate: OTHER_SLOT }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        const ref = (JSON.parse(String(init?.body ?? "{}")) as { ref?: string }).ref ?? "";
        resolvedRefs.push(ref);
        return new Response(JSON.stringify(ref === POST_REF ? RESOLVE_PENDING : RESOLVE_SETTLED), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    const { container } = render(<RunPageChrome><OrchestratorStepperPanel {...stepperProps({ initialReviewGate: OTHER_SLOT })} /></RunPageChrome>);
    await waitFor(
      () => {
        if (!terminalControl(container)) throw new Error("the post gate drew no decision bar");
      },
      { timeout: 15_000 },
    );
    // Give the reader time for a look; the card must stay on the post's gate.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(terminalControl(container)).not.toBeNull();
    expect(resolvedRefs).not.toContain(OTHER_REF);
  }, 60_000);

  it("draws the image gate's floor when the interrupt already names it and the slot still holds the decided post", async () => {
    // The inverse order: a replayed or retried interrupt names the image's
    // gate, while the slot (the server render's answer, the reader silent)
    // still holds the post's gate, decided since.
    streamState.interruptContext = IMAGE_INTERRUPT;
    stubFetch(null);
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    const { container } = render(<RunPageChrome><OrchestratorStepperPanel {...stepperProps({ initialReviewGate: POST_SLOT })} /></RunPageChrome>);
    await expectTheImageFloor(container);
    expect(resolvedRefs).not.toContain(POST_REF);
  }, 60_000);

  it("reads the run rail's resolved gates where the leg position cannot be read", async () => {
    // A leg id whose position this surface cannot read: only the rail's own
    // resolution says the interrupt's post gate is decided.
    const imageTaskOddShape = "wf-task-3035#image";
    const imageSlotOddShape = { ...IMAGE_SLOT, reviewTaskId: imageTaskOddShape };
    stubFetch(imageSlotOddShape);
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    const railExtras = [
      {
        key: "gate:g-post",
        ordinal: 10,
        kind: "gate" as const,
        label: "Review",
        status: "resolved" as const,
        sources: ["gate" as const],
        gate: { gateId: "g-post", reviewTaskId: POST_TASK, disposition: "approved", resolved: true },
      },
    ];
    const { container } = render(
      <RunPageChrome><OrchestratorStepperPanel {...stepperProps({ initialReviewGate: imageSlotOddShape, railExtras })} /></RunPageChrome>,
    );
    await expectTheImageFloor(container);
  }, 60_000);
});

describe("the conversation's run panel (AgenticRunPanel): the next gate of one marked pause", () => {
  it("draws the image gate's floor once the slot names it, though the run's gate context still names the post", async () => {
    streamState.status = null;
    streamState.interruptContext = null;
    stubFetch(IMAGE_SLOT, POST_HITL_CONTEXT);
    const { ensureDefaultFieldRenderersRegistered } = await import("../register-default-renderers");
    ensureDefaultFieldRenderersRegistered();
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    const { LifecycleCardSurfaceProvider } = await import("../lifecycle-card-runtime");
    const { container } = render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <AgenticRunPanel
          {...({
            runId: RUN_ID,
            initialStatus: "pending_approval",
            initialError: null,
            initialMessages: [],
            agUiEnabled: false,
            templateId: "tmpl-3035",
            surface: "chat",
            initialHitlContext: POST_HITL_CONTEXT,
            initialReviewGate: POST_SLOT,
            readReviewSlot: async () => IMAGE_SLOT,
          } as any)}
        />
      </LifecycleCardSurfaceProvider>,
    );
    await waitFor(
      () => {
        if (!terminalControl(container)) {
          throw new Error("the image gate drew no decision bar with its terminal control");
        }
      },
      { timeout: 15_000 },
    );
    expect(container.querySelector(SETTLED), "the decided post gate is still drawn").toBeNull();
    expect(resolvedRefs).toContain(IMAGE_REF);
  }, 60_000);

  it("draws the image gate's floor when the gate context already names it and the slot still holds the decided post", async () => {
    streamState.status = null;
    streamState.interruptContext = null;
    stubFetch(null, IMAGE_HITL_CONTEXT);
    const { ensureDefaultFieldRenderersRegistered } = await import("../register-default-renderers");
    ensureDefaultFieldRenderersRegistered();
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    const { LifecycleCardSurfaceProvider } = await import("../lifecycle-card-runtime");
    const { container } = render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <AgenticRunPanel
          {...({
            runId: RUN_ID,
            initialStatus: "pending_approval",
            initialError: null,
            initialMessages: [],
            agUiEnabled: false,
            templateId: "tmpl-3035",
            surface: "chat",
            initialHitlContext: IMAGE_HITL_CONTEXT,
            initialReviewGate: POST_SLOT,
            // The reader is silent: the slot keeps the stale post answer.
            readReviewSlot: () => new Promise(() => {}),
          } as any)}
        />
      </LifecycleCardSurfaceProvider>,
    );
    await waitFor(
      () => {
        if (!terminalControl(container)) {
          throw new Error("the image gate drew no decision bar with its terminal control");
        }
      },
      { timeout: 15_000 },
    );
    expect(container.querySelector(SETTLED), "the decided post gate is still drawn").toBeNull();
    expect(resolvedRefs).toContain(IMAGE_REF);
    expect(resolvedRefs).not.toContain(POST_REF);
  }, 60_000);
});

describe("markedReviewGateCard: of the gates of one pause, the card shows one not known to be resolved", () => {
  const slotOf = (reviewTaskId: unknown, ref: string | null = `ref:${String(reviewTaskId)}`) =>
    ({ ref, reviewTaskId }) as { ref: string | null; reviewTaskId?: string | null };
  const pick = async (
    interruptReviewTaskId: unknown,
    slot: { ref: string | null; reviewTaskId?: string | null },
    resolved?: string[],
    interruptRef: string | null = `ref:${String(interruptReviewTaskId)}`,
  ) => {
    const { markedReviewGateCard } = await import("../lifecycle-card-runtime");
    return markedReviewGateCard({
      interruptRef,
      interruptReviewTaskId,
      slot,
      resolvedReviewTaskIds: resolved ? new Set(resolved) : undefined,
    });
  };
  const T = "wf-task-9";

  it("the interrupt names a decided earlier leg, the slot a later one: the slot's gate", async () => {
    expect(await pick(T, slotOf(`${T}#2`))).toEqual({ ref: `ref:${T}#2`, reviewTaskId: `${T}#2` });
    expect(await pick(`${T}#2`, slotOf(`${T}#3`))).toEqual({ ref: `ref:${T}#3`, reviewTaskId: `${T}#3` });
    expect(await pick(T, slotOf(`${T}#3`))).toEqual({ ref: `ref:${T}#3`, reviewTaskId: `${T}#3` });
  });

  it("the inverse order (a later interrupt, a stale earlier slot): the interrupt's gate", async () => {
    expect(await pick(`${T}#2`, slotOf(T))).toEqual({ ref: `ref:${T}#2`, reviewTaskId: `${T}#2` });
    expect(await pick(`${T}#3`, slotOf(`${T}#2`))).toEqual({ ref: `ref:${T}#3`, reviewTaskId: `${T}#3` });
    expect(await pick(`${T}#3`, slotOf(T))).toEqual({ ref: `ref:${T}#3`, reviewTaskId: `${T}#3` });
    // Ten legs: the leg number, never the string order, decides.
    expect(await pick(`${T}#10`, slotOf(`${T}#9`))).toEqual({ ref: `ref:${T}#10`, reviewTaskId: `${T}#10` });
  });

  it("one gate, or the same gate on both sides: the interrupt's gate", async () => {
    expect(await pick(T, slotOf(T, "ref:other-ticket"))).toEqual({ ref: `ref:${T}`, reviewTaskId: T });
    expect(await pick(T, { ref: null, reviewTaskId: null })).toEqual({ ref: `ref:${T}`, reviewTaskId: T });
  });

  it("a slot of another pause never replaces the interrupt's gate", async () => {
    expect(await pick(T, slotOf("wf-task-8#2"))).toEqual({ ref: `ref:${T}`, reviewTaskId: T });
  });

  it("every leg resolved: the slot's gate, the reading from before this rule", async () => {
    // The interrupt falls back to the first leg when every leg is resolved.
    expect(await pick(T, slotOf(`${T}#2`), [T, `${T}#2`])).toEqual({ ref: `ref:${T}#2`, reviewTaskId: `${T}#2` });
    expect(await pick(`${T}#2`, slotOf(T), [`${T}#2`])).toEqual({ ref: `ref:${T}`, reviewTaskId: T });
  });

  it("a leg position it cannot read: the rail's resolved gates decide, and with none the interrupt's gate", async () => {
    const odd = `${T}#image`;
    expect(await pick(T, slotOf(odd))).toEqual({ ref: `ref:${T}`, reviewTaskId: T });
    expect(await pick(T, slotOf(odd), [T])).toEqual({ ref: `ref:${odd}`, reviewTaskId: odd });
    expect(await pick(T, slotOf(odd), [odd])).toEqual({ ref: `ref:${T}`, reviewTaskId: T });
  });

  it("the rail's resolution and the legs' own reading agree on a stale slot", async () => {
    expect(await pick(`${T}#2`, slotOf(T), [T])).toEqual({ ref: `ref:${T}#2`, reviewTaskId: `${T}#2` });
  });

  it("empty or missing ids and refs: the interrupt's gate", async () => {
    const own = (id: unknown) => ({ ref: `ref:${String(id)}`, reviewTaskId: typeof id === "string" ? id : null });
    expect(await pick(undefined, slotOf(`${T}#2`))).toEqual(own(undefined));
    expect(await pick("", slotOf(`${T}#2`))).toEqual(own(""));
    expect(await pick(42, slotOf(`${T}#2`))).toEqual(own(42));
    expect(await pick(T, slotOf(""))).toEqual(own(T));
    expect(await pick(T, slotOf(undefined))).toEqual(own(T));
    expect(await pick(T, slotOf(`${T}#2`, null))).toEqual(own(T));
    expect(await pick(T, slotOf(`${T}#2`, ""))).toEqual(own(T));
  });

  it("an interrupt with no ref of its own still gives way to the open later leg", async () => {
    expect(await pick(T, slotOf(`${T}#2`), undefined, null)).toEqual({ ref: `ref:${T}#2`, reviewTaskId: `${T}#2` });
  });

  it("reads a leg's position only from the planner's own shape", async () => {
    const { reviewGateLegNumber } = await import("../lifecycle-card-runtime");
    expect(reviewGateLegNumber(T)).toBe(1);
    expect(reviewGateLegNumber(`${T}#2`)).toBe(2);
    expect(reviewGateLegNumber(`${T}#10`)).toBe(10);
    for (const odd of [`${T}#1`, `${T}#02`, `${T}#x`, `${T}#`, `${T}#2#3`, ""]) {
      expect(reviewGateLegNumber(odd)).toBeNull();
    }
  });
});
