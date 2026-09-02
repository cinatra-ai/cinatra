// @vitest-environment jsdom
/**
 * THE SWAP HAPPENS ON ITS OWN, WITH THE STREAM ON (cinatra#3046).
 *
 * The drawing at the contract's pin, cards §II, is a statement about who acts:
 *
 *   "The placeholder is replaced, in place, by the review. When the run's output
 *    is generated, the placeholder becomes the Review requested screen — the same
 *    slot, in the same turn. It happens on its own: the reader neither asks for
 *    the card nor presses anything to bring it."
 *
 * The park's own slot pins live beside these, in
 * `agentic-run-panel.review-slot.test.tsx`, and they were green — with the
 * stream OFF. Every one of them runs the panel on `agUiEnabled: false`, which is
 * the run page's poll-driven shape and is NOT the shape a run dispatched from a
 * conversation takes. Measured on two real runs, one per palette: with the
 * stream on, the conversation still showed the placeholder FOUR MINUTES after
 * the gate row existed, and the card appeared only after a page reload.
 *
 * THE MECHANISM, and it is a rule about silence rather than about freshness. The
 * panel resolved its status stream-first (`resolveStreamFirst`) and the poll tick
 * deliberately does not write the status while the stream is enabled. A run
 * parked on its produced output's review reaches NO terminal status, so it emits
 * no RUN_FINISHED and no RUN_ERROR: the stream's last word stays `running` for
 * the whole park. Stream-first then pinned the surface to `running` for ever —
 * the slot reader looks only under `completed` or the parked status, so it never
 * looked; `parkedOnProducedReview` is read beside the parked status, so it was
 * never true; and the run's already-answered question kept its live control
 * because nothing could tell the surface the pause belonged to the review. A
 * RELOAD fixed it because a reload re-seeds the status from the row.
 *
 * So these pins run the SAME park, on both surfaces, with the stream ON and stuck
 * at `running` — the real conversation shape — and require the swap to happen
 * with no reload, no new turn and nothing pressed.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/agentic-run-panel.live-park-swap.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";
import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

vi.mock("lucide-react", () => {
  const StubIcon = () => null;
  return new Proxy({} as Record<string, () => null>, {
    get: (_t, prop) => {
      if (prop === "__esModule") return true;
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return undefined;
      return StubIcon;
    },
    has: () => true,
    ownKeys: () => ["Loader2", "default"],
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
      value: StubIcon,
    }),
  });
});

vi.mock("../hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => undefined),
  rejectReviewTask: vi.fn(async () => undefined),
}));

/**
 * THE A2A TRANSPORT'S OWN SNAPSHOT, live rather than frozen.
 *
 * The panel's tick has TWO branches, and which one it takes is decided by the
 * `taskId` prop alone. `InlineAgentRunCard` passes `seed.taskId` for every run
 * dispatched through A2A - which is every run a conversation dispatches - so
 * the task-snapshot branch, not the seed-route fallback, is the one the
 * measured surface really runs. A case that wants that branch sets this.
 */
const a2aSnapshot = vi.hoisted(() => ({
  value: null as Record<string, unknown> | null,
}));
vi.mock("../a2a-actions", () => ({
  getAgentBuilderTask: vi.fn(async () => a2aSnapshot.value),
}));

vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({
    connectedApps: [],
    gmailAliases: [],
    runId: "run-3046",
  })),
  getAuditAvailabilityAction: vi.fn(async () => ({
    visible: false,
    promptCount: 0,
    skillCount: 0,
  })),
  getSkillsForAgentAction: vi.fn(async () => []),
  confirmRunSkillSelectionAction: vi.fn(async () => ({ ok: true })),
  getRunRecommendedSkillsAction: vi.fn(async () => []),
}));

vi.mock("../agent-ui-override-registry", () => ({
  agentUIOverrideRegistry: { resolve: () => null },
}));

const {
  readRunOutputEvidence,
  getRunRecommendationHoldStateAction,
  confirmRunRecommendationAction,
  skipRunRecommendationAction,
} = vi.hoisted(() => ({
  readRunOutputEvidence: vi.fn(),
  getRunRecommendationHoldStateAction: vi.fn(),
  confirmRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
  skipRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
}));
vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction,
  confirmRunRecommendationAction,
  skipRunRecommendationAction,
}));
vi.mock("../run-actions", () => ({
  resetAgentRun: vi.fn(async () => ({ ok: true })),
  createAndTriggerRun: vi.fn(async () => ({ ok: true, runId: "run-next" })),
  triggerAgentRun: vi.fn(async () => ({ ok: true })),
  readRunOutputEvidence,
}));

/**
 * THE STREAM, MUTE AT `running` — which is what a parked run's stream really is.
 * It is the whole point of this file, so it is a live value the cases read rather
 * than a frozen literal: a case that wants the stream to speak sets it.
 */
const streamState = vi.hoisted(() => ({ status: "running" as string | null }));
vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: vi.fn(() => ({
    status: streamState.status,
    error: null,
    presentationHint: null,
    isLive: true,
    interruptContext: null,
    streamedText: "",
    dataPartFrames: [],
  })),
}));

const RUN_ID = "run-3046";
const PLACEHOLDER = '[data-conformance-id="review-gate-placeholder"]';
const REVIEW_CARD = '[data-conformance-id="review-gate-card"]';
const SLOT = "[data-run-review-slot]";

const RESOLVE_PENDING = {
  kind: "artifact_review_gate",
  state: { state: "pending", canDecide: true, canComment: true },
  body: null,
};

function stubFetch(run: () => Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/agents/runs/")) {
      return new Response(JSON.stringify(run()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(RESOLVE_PENDING), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function seedBody(over: Record<string, unknown> = {}) {
  return {
    status: "running",
    error: null,
    startedAt: null,
    completedAt: null,
    messages: [],
    hitlContext: null,
    reviewGate: { ref: null, awaiting: false, producedReviewPark: false },
    ...over,
  };
}

/** The panel as a CONVERSATION really mounts it: the stream on, because the run
 *  was dispatched from a chat and the chat card seeds `agUiEnabled` off the row. */
function panelProps(over: Record<string, unknown> = {}) {
  return {
    runId: RUN_ID,
    initialStatus: "running",
    initialError: null,
    initialMessages: [],
    agUiEnabled: true as boolean | null,
    templateId: "tmpl-3046",
    surface: "chat" as "agent-detail" | "chat",
    ...over,
  };
}

/** The interrupt a parked run really carries: the LAST question it was asked,
 *  answered minutes ago, which the run has moved past. */
const ANSWERED_INPUT_GATE = {
  xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
  childRunId: null,
  reviewTaskId: `setup-${RUN_ID}`,
  inputSchema: {
    type: "object",
    title: "idea",
    properties: { title: { type: "string" } },
    required: ["title"],
    "x-object-text-property": "title",
  },
  currentValues: {},
  fieldName: "idea",
};

const PARK_WITHOUT_GATE = { ref: null, awaiting: true, producedReviewPark: true };
const PARK_WITH_GATE = {
  ref: "lcr-live-park-gate",
  awaiting: false,
  producedReviewPark: true,
};

/** The two surfaces, mounted the way each really mounts this panel. */
const SURFACES = [
  [
    "conversation",
    "chat" as const,
    (node: React.ReactNode) => (
      <LifecycleCardSurfaceProvider host="chat_thread">{node}</LifecycleCardSurfaceProvider>
    ),
    "chat_thread",
  ],
  ["run page", "agent-detail" as const, (node: React.ReactNode) => node, "run_card"],
] as const;

beforeEach(() => {
  ensureDefaultFieldRenderersRegistered();
  streamState.status = "running";
  a2aSnapshot.value = null;
  readRunOutputEvidence.mockReset();
  readRunOutputEvidence.mockResolvedValue({
    ok: true,
    outputs: [],
    hasTranscript: false,
    hasStepResults: false,
    outputsUnavailable: false,
    unlinkableOutputs: 0,
  });
  getRunRecommendationHoldStateAction.mockReset();
  getRunRecommendationHoldStateAction.mockResolvedValue({ state: "none" });
  cleanup();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the swap happens on its own while the stream stays mute", () => {
  it.each(SURFACES)(
    "%s — the run parks and the card arrives in the SAME slot, with no reload",
    async (_name, surface, wrap, expectedHost) => {
      // The run is WORKING and the stream says so. Nothing about this mount ever
      // changes again except the ROW, which is exactly the real sequence: the
      // executor parks the run, and the stream — which announces only terminal
      // states — says nothing at all from here on.
      let body = seedBody();
      stubFetch(() => body);
      const published: Array<unknown> = [];
      const { AgenticRunPanel } = await import("../agentic-run-panel");
      render(
        wrap(
          <AgenticRunPanel
            {...panelProps({
              surface,
              initialReviewGate: { ref: null, awaiting: false, producedReviewPark: false },
              onActiveGateChange: (_runId: string, gate: unknown) => {
                published.push(gate);
              },
            })}
          />,
        ),
      );

      const placeholder = await waitFor(() => {
        const el = document.querySelector(PLACEHOLDER);
        if (!el) throw new Error("no placeholder");
        return el;
      });
      expect(document.querySelector(SLOT)?.getAttribute("data-run-review-slot")).toBe(
        "working",
      );
      expect(document.querySelector(SLOT)?.contains(placeholder)).toBe(true);

      // THE RUN PARKS ON WHAT IT PRODUCED, and its gate row lands. The STREAM
      // NEVER SPEAKS AGAIN — `streamState.status` is left at "running" for the
      // rest of this case, which is the defect's whole condition.
      body = seedBody({
        status: "pending_approval",
        hitlContext: ANSWERED_INPUT_GATE,
        reviewGate: PARK_WITH_GATE,
      });

      const card = await waitFor(
        () => {
          const el = document.querySelector(REVIEW_CARD);
          if (!el) throw new Error("the review screen did not arrive on its own");
          return el;
        },
        { timeout: 25_000 },
      );
      expect(streamState.status).toBe("running");

      // THE SAME SLOT, ONE SLOT, and the placeholder replaced rather than joined.
      expect(document.querySelectorAll(SLOT).length).toBe(1);
      expect(document.querySelector(SLOT)?.getAttribute("data-run-review-slot")).toBe(
        "review",
      );
      expect(document.querySelector(SLOT)?.contains(card)).toBe(true);
      expect(document.querySelector(PLACEHOLDER)).toBeNull();
      expect(card.getAttribute("data-lifecycle-card")).toBe("artifact_review_gate");
      expect(
        document.querySelectorAll('[data-lifecycle-card="artifact_review_gate"]').length,
      ).toBe(1);

      // THE HOST IS THE SURFACE IT IS ON (cinatra#3046). The conversation's card
      // is a `chat_thread` card; the run page's is a `run_card` one. The recorder
      // keys its cells on exactly this attribute and REFUSED the conversation's
      // review for `chat_thread` on the previous head.
      expect(card.getAttribute("data-lifecycle-card-host")).toBe(expectedHost);

      // NOTHING WAS PRESSED AND NO QUESTION WAS REDRAWN — the answered gate the
      // row still carries is not a live control, here or in the prompt window.
      expect(document.querySelector("#field-idea")).toBeNull();
      expect(screen.queryByRole("button", { name: /Continue/i })).toBeNull();
      expect(published.every((g) => g === null)).toBe(true);
      expect(screen.queryByRole("heading", { name: /Agentic Run Progress/i })).toBeNull();
    },
    45_000,
  );

  it.each(SURFACES)(
    "%s — the park with no gate row yet holds the placeholder, not the answered question",
    async (_name, surface, wrap) => {
      const body = seedBody({
        status: "pending_approval",
        hitlContext: ANSWERED_INPUT_GATE,
        reviewGate: PARK_WITHOUT_GATE,
      });
      stubFetch(() => body);
      const { AgenticRunPanel } = await import("../agentic-run-panel");
      render(
        wrap(
          <AgenticRunPanel
            {...panelProps({
              surface,
              initialReviewGate: { ref: null, awaiting: false, producedReviewPark: false },
            })}
          />,
        ),
      );

      await waitFor(
        () => {
          const slot = document.querySelector(SLOT);
          if (slot?.getAttribute("data-run-review-slot") !== "working") {
            throw new Error("the slot is not holding the placeholder");
          }
          if (!document.querySelector(PLACEHOLDER)) throw new Error("no placeholder");
        },
        { timeout: 25_000 },
      );
      expect(document.querySelector("#field-idea")).toBeNull();
      expect(screen.queryByRole("button", { name: /Continue/i })).toBeNull();
      expect(screen.queryByText(/No messages yet/i)).toBeNull();
    },
    45_000,
  );

  it("the conversation on the A2A transport - the task-backed tick carries the row's park", async () => {
    // THE SHAPE PRODUCTION ACTUALLY MOUNTS, and the one the cases above miss.
    // Every case in this file so far leaves `taskId` unset, so the tick takes
    // its seed-route fallback; the conversation card seeds `taskId` off the row
    // for every A2A run and the tick then reads the TASK SNAPSHOT instead. A row
    // reading recorded only on the fallback branch never reaches this surface -
    // which is the surface the defect was measured on.
    let body = seedBody();
    stubFetch(() => body);
    a2aSnapshot.value = {
      taskId: "task-3046",
      state: "working",
      cinatraStatus: "running",
      runId: RUN_ID,
      messages: [],
      hitlContext: null,
      error: null,
    };
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <AgenticRunPanel
          {...panelProps({
            surface: "chat",
            taskId: "task-3046",
            initialReviewGate: { ref: null, awaiting: false, producedReviewPark: false },
          })}
        />
      </LifecycleCardSurfaceProvider>,
    );
    await waitFor(
      () => {
        if (!document.querySelector(PLACEHOLDER)) throw new Error("no placeholder");
      },
      { timeout: 20_000 },
    );

    // THE RUN PARKS. The stream stays mute at `running` for the rest of the
    // case; the only thing that moves is the ROW, which on this transport is
    // the task snapshot's `cinatraStatus`.
    a2aSnapshot.value = {
      ...a2aSnapshot.value,
      cinatraStatus: "pending_approval",
      hitlContext: ANSWERED_INPUT_GATE,
    };
    body = seedBody({
      status: "pending_approval",
      hitlContext: ANSWERED_INPUT_GATE,
      reviewGate: PARK_WITH_GATE,
    });

    const card = await waitFor(
      () => {
        const el = document.querySelector(REVIEW_CARD);
        if (!el) throw new Error("the review screen did not arrive on its own");
        return el;
      },
      { timeout: 25_000 },
    );
    expect(streamState.status).toBe("running");
    expect(document.querySelectorAll(SLOT).length).toBe(1);
    expect(document.querySelector(SLOT)?.getAttribute("data-run-review-slot")).toBe(
      "review",
    );
    expect(document.querySelector(SLOT)?.contains(card)).toBe(true);
    expect(document.querySelector(PLACEHOLDER)).toBeNull();
    expect(card.getAttribute("data-lifecycle-card-host")).toBe("chat_thread");
    // The answered question the row still carries is not redrawn with a live
    // control on this transport either.
    expect(document.querySelector("#field-idea")).toBeNull();
    expect(screen.queryByRole("button", { name: /Continue/i })).toBeNull();
  }, 45_000);

  // -------------------------------------------------------------------------
  // THE WINDOW BEFORE THE SURFACE HAS HEARD WHICH PAUSE IT IS (cinatra#3007).
  //
  // Both readings that tell a `pending_approval` run's two pauses apart are
  // answers this surface has to GO AND GET — the park off the run's row, the
  // marked gate off a derived context — so between the tick the run enters the
  // status and the tick the first of them lands, BOTH are false. Every reader
  // then fell through to the remaining case, a question, and the third capture
  // photographed what that draws on each surface at once:
  //
  //   · in the conversation, the run's own progress badge reading
  //     "pending approval" with "No messages yet." under it;
  //   · on the run page, "This run is paused, but its approval step could not be
  //     loaded … Re-check" — an error state with two pressable controls.
  //
  // The drawing at the contract's pin gives that window one thing: "the card
  // frame, and a spinning icon … It names no status, reports no result and draws
  // nothing to press."
  //
  // THE TRANSPORT THESE RUN ON is the one that really holds the window open: a
  // tick whose answer carries NO gate reading at all, which is exactly the A2A
  // task snapshot's shape and what the seed route looks like whenever the park
  // has not been written yet. The status moves; the park does not arrive with it.
  // -------------------------------------------------------------------------

  /**
   * WAIT FOR THE WINDOW TO HAVE BEEN ENTERED, not merely for a drawing.
   *
   * Every reading in this window is a NEGATIVE — the placeholder is there and
   * the status word is not — and the frame BEFORE the flip satisfies every one
   * of them, because a working run draws the same placeholder. So a case that
   * asserted straight away would pass on the pristine head by reading the
   * wrong frame. This waits on the transport instead: the panel's own tick goes
   * through `fetch`, so answers taken after the row changed are proof the
   * surface has been told the run is waiting, whatever it decided to draw.
   */
  async function afterTheParkedStatusWasRead(
    fetchMock: { mock: { calls: unknown[] } },
    ticks = 3,
  ): Promise<void> {
    const from = fetchMock.mock.calls.length;
    await waitFor(
      () => {
        if (fetchMock.mock.calls.length < from + ticks) {
          throw new Error("the parked status has not been read yet");
        }
      },
      { timeout: 25_000 },
    );
  }

  /**
   * A SLOT READER WHOSE FIRST LOOK IS STILL IN FLIGHT — which is what the window
   * IS, rather than a payload shape that stands in for it.
   *
   * The run's status and the run's park reach this panel on two different
   * transports whenever the run has an A2A task: the status rides the task
   * snapshot, which carries no gate reading at all, and the park arrives only
   * on the shared slot reader's own look at the run's row. So the window is the
   * span in which that look has been sent and has not come back, and a reader
   * held open is that span exactly — with no budget, no failure and no invented
   * response shape in it. Releasing it ends the window with whichever answer is
   * handed over, which is how the closing guard is written.
   */
  function slotReaderHeldOpen() {
    let release: ((slot: unknown) => void) | null = null;
    const looks: number[] = [];
    return {
      read: async () => {
        looks.push(1);
        return await new Promise((resolve) => {
          release = resolve;
        });
      },
      looks,
      answer(slot: unknown) {
        if (!release) throw new Error("no look is in flight to answer");
        release(slot);
      },
    };
  }

  /**
   * A SLOT READER THAT ANSWERS ONCE AND IS THEN SILENT.
   *
   * The window is spent by LOOKS THAT ANSWER, so a reader that keeps answering
   * would end it by exhausting a budget however wide that budget is, and a case
   * written against such a reader measures only how long the wrong drawing
   * lasts. This one answers the first look — with nothing, which is what the
   * shared reader returns for a row it could not read — and never answers
   * again, so the window can only be ended by the rule under test.
   */
  function slotReaderAnsweringOnce() {
    let answered = false;
    return async () => {
      if (answered) return await new Promise<null>(() => {});
      answered = true;
      return null;
    };
  }

  /** The run's answer WITHOUT the row's gate reading — the task snapshot's own
   *  shape, which is what a run dispatched from a conversation is read through.
   *  `reviewGate` is absent, not false: an absent reading is "this transport
   *  does not carry it", which is the real condition. */
  function bodyWithNoGateReading(over: Record<string, unknown> = {}) {
    const body = seedBody(over) as Record<string, unknown>;
    delete body.reviewGate;
    return body;
  }

  it.each(SURFACES)(
    "%s — the unheard window draws the quiet placeholder, never a status word or an empty transcript",
    async (_name, surface, wrap) => {
      let body: Record<string, unknown> = seedBody();
      const fetchMock = stubFetch(() => body);
      const slotReader = slotReaderHeldOpen();
      const { AgenticRunPanel } = await import("../agentic-run-panel");
      render(
        wrap(
          <AgenticRunPanel
            {...panelProps({
              surface,
              initialReviewGate: { ref: null, awaiting: false, producedReviewPark: false },
              readReviewSlot: slotReader.read,
            })}
          />,
        ),
      );
      await waitFor(() => {
        if (!document.querySelector(PLACEHOLDER)) throw new Error("no placeholder");
      }, { timeout: 20_000 });

      // The run parks. The status moves and the ANSWERED question comes with it;
      // the row's own park reading does not, because the transport carrying the
      // status does not carry it — it is out on the look now in flight.
      body = bodyWithNoGateReading({
        status: "pending_approval",
        hitlContext: ANSWERED_INPUT_GATE,
      });
      await afterTheParkedStatusWasRead(fetchMock);
      await waitFor(() => {
        if (slotReader.looks.length < 1) throw new Error("no look under the parked status");
      }, { timeout: 20_000 });

      const slot = document.querySelector(SLOT);
      expect(slot, "the slot is gone — the pause was read as a question").not.toBeNull();
      expect(slot?.getAttribute("data-run-review-slot")).toBe("working");
      expect(document.querySelector(PLACEHOLDER)).not.toBeNull();

      // NOTHING THE PLACEHOLDER MAY NOT SAY, on either surface.
      expect(screen.queryByRole("heading", { name: /Agentic Run Progress/i })).toBeNull();
      expect(screen.queryByText(/No messages yet/i)).toBeNull();
      expect(screen.queryByText(/pending approval/i)).toBeNull();
      expect(screen.queryByText(/could not be loaded/i)).toBeNull();
      expect(screen.queryByRole("button", { name: /Re-check/i })).toBeNull();
      // …and nothing to press, including the answered question's own control.
      expect(document.querySelector("#field-idea")).toBeNull();
      expect(screen.queryByRole("button", { name: /Continue/i })).toBeNull();
    },
    45_000,
  );

  it.each(SURFACES)(
    "%s — the unheard window with NO context is not a run whose approval step failed to load",
    async (_name, surface, wrap) => {
      // The other half of the same window, and the one the run page's error copy
      // was measured on: the tick answers "still paused" and carries no gate
      // context at all. The derivation contract calls that a server-side failure
      // — conclusive on its FIRST occurrence — and a park is the one paused run
      // for which it is the ordinary reading.
      let body: Record<string, unknown> = seedBody();
      const fetchMock = stubFetch(() => body);
      const slotReader = slotReaderHeldOpen();
      const { AgenticRunPanel } = await import("../agentic-run-panel");
      render(
        wrap(
          <AgenticRunPanel
            {...panelProps({
              surface,
              initialReviewGate: { ref: null, awaiting: false, producedReviewPark: false },
              readReviewSlot: slotReader.read,
            })}
          />,
        ),
      );
      await waitFor(() => {
        if (!document.querySelector(PLACEHOLDER)) throw new Error("no placeholder");
      }, { timeout: 20_000 });

      body = bodyWithNoGateReading({ status: "pending_approval", hitlContext: null });
      await afterTheParkedStatusWasRead(fetchMock);
      await waitFor(() => {
        if (slotReader.looks.length < 1) throw new Error("no look under the parked status");
      }, { timeout: 20_000 });

      expect(document.querySelector(SLOT)?.getAttribute("data-run-review-slot")).toBe(
        "working",
      );
      expect(document.querySelector(PLACEHOLDER)).not.toBeNull();
      expect(screen.queryByText(/could not be loaded/i)).toBeNull();
      expect(screen.queryByText(/Loading the approval step/i)).toBeNull();
      expect(screen.queryByRole("button", { name: /Re-check/i })).toBeNull();
      expect(screen.queryByText(/No messages yet/i)).toBeNull();
    },
    45_000,
  );

  it.each(SURFACES)(
    "%s — a look that FAILS gives the question back rather than burying it",
    async (_name, surface, wrap) => {
      // THE BOUND ON THE WINDOW, and the reason it is one look and not five.
      // Under this status the window withholds a LIVE question and every control
      // on it, and it is spent only while a look is unanswered — so a look that
      // comes back with nothing must END it. Holding a person's question behind
      // a transport that is failing is a worse reading than the one the window
      // exists to prevent, and this is the case that says so.
      let body: Record<string, unknown> = seedBody();
      stubFetch(() => body);
      const { AgenticRunPanel } = await import("../agentic-run-panel");
      render(
        wrap(
          <AgenticRunPanel
            {...panelProps({
              surface,
              initialReviewGate: { ref: null, awaiting: false, producedReviewPark: false },
              readReviewSlot: slotReaderAnsweringOnce(),
            })}
          />,
        ),
      );
      await waitFor(() => {
        if (!document.querySelector(PLACEHOLDER)) throw new Error("no placeholder");
      }, { timeout: 20_000 });

      body = bodyWithNoGateReading({
        status: "pending_approval",
        hitlContext: ANSWERED_INPUT_GATE,
      });

      // THE WINDOW CLOSES on the look that answered with nothing: the run's own
      // pause is drawn again, whatever each host draws for it. The placeholder
      // is the reading under test and it is the same on both.
      await waitFor(() => {
        if (document.querySelector(PLACEHOLDER)) {
          throw new Error("the pause is still buried behind a failing look");
        }
      }, { timeout: 25_000 });
      // …and where the question's own fields are drawn inside this panel — the
      // run page; the conversation's host draws them from the gate the panel
      // publishes — they are back, with their control.
      if (surface === "agent-detail") {
        await waitFor(() => {
          if (!document.querySelector("#field-idea")) {
            throw new Error("the question is still buried behind a failing look");
          }
        }, { timeout: 25_000 });
      }
    },
    45_000,
  );

  it("one run's park does not travel to the next run in the same panel", async () => {
    // THE PARK IS A RUN'S FACT, NOT THE PANEL'S. Both of the panel's readings of
    // it are keyed to the mount, and this panel is exported to hosts that may
    // keep it mounted across a change of run. The next run is genuinely stopped
    // on a QUESTION, in the same status, and on the transport that does not
    // carry the park reading at all — so nothing would ever correct the
    // inherited answer, and the person would face a question with no controls
    // on it for as long as they looked at it.
    let body: Record<string, unknown> = seedBody({
      status: "pending_approval",
      hitlContext: ANSWERED_INPUT_GATE,
      reviewGate: PARK_WITHOUT_GATE,
    });
    stubFetch(() => body);
    const nextRunSlotReader = slotReaderAnsweringOnce();
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    const { rerender } = render(
      <AgenticRunPanel
        {...panelProps({
          surface: "agent-detail",
          initialStatus: "pending_approval",
          initialReviewGate: PARK_WITHOUT_GATE,
          readReviewSlot: nextRunSlotReader,
        })}
      />,
    );
    // The first run really is parked: its answered question draws nothing.
    await waitFor(() => {
      if (!document.querySelector(PLACEHOLDER)) throw new Error("no placeholder");
    }, { timeout: 20_000 });
    expect(document.querySelector("#field-idea")).toBeNull();

    // The SAME panel is handed the next run — stopped on a live question, read
    // through a transport that carries no gate reading of its own.
    body = bodyWithNoGateReading({
      status: "pending_approval",
      hitlContext: ANSWERED_INPUT_GATE,
    });
    rerender(
      <AgenticRunPanel
        {...panelProps({
          runId: "run-3046-next",
          surface: "agent-detail",
          initialStatus: "pending_approval",
          initialReviewGate: { ref: null, awaiting: false, producedReviewPark: false },
          readReviewSlot: nextRunSlotReader,
        })}
      />,
    );
    await waitFor(() => {
      if (!document.querySelector("#field-idea")) {
        throw new Error("the next run inherited the previous run's park");
      }
    }, { timeout: 25_000 });
  }, 45_000);

  it("the answered question is not redrawn once the park IS read — the window closes on the row", async () => {
    // The guard on the rule: this must not become "a paused run is always a
    // placeholder". The moment the row answers that this pause is NOT a park,
    // the question it carries is a live question again and draws as one.
    let body: Record<string, unknown> = seedBody();
    stubFetch(() => body);
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(
      <AgenticRunPanel
        {...panelProps({
          surface: "agent-detail",
          initialReviewGate: { ref: null, awaiting: false, producedReviewPark: false },
        })}
      />,
    );
    await waitFor(() => {
      if (!document.querySelector(PLACEHOLDER)) throw new Error("no placeholder");
    }, { timeout: 20_000 });

    body = seedBody({
      status: "pending_approval",
      hitlContext: ANSWERED_INPUT_GATE,
      reviewGate: { ref: null, awaiting: false, producedReviewPark: false },
    });

    await waitFor(() => {
      if (!document.querySelector("#field-idea")) {
        throw new Error("the question the row confirms is live was not drawn");
      }
    }, { timeout: 25_000 });
    expect(document.querySelector(PLACEHOLDER)).toBeNull();
  }, 45_000);

  it("a stream that HAS spoken keeps its say — the row does not overrule it", async () => {
    // The guard on the rule: this must not become "the row always wins". A
    // stream that reached a terminal state has spoken, and a row lagging behind
    // it changes nothing.
    streamState.status = "completed";
    const body = seedBody({ status: "running" });
    stubFetch(() => body);
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(
      <AgenticRunPanel
        {...panelProps({
          surface: "agent-detail",
          initialReviewGate: { ref: null, awaiting: false, producedReviewPark: false },
        })}
      />,
    );
    // `completed` with no reviewable output is the run's own terminal rendering,
    // never the placeholder's working reading.
    await waitFor(() => {
      const slot = document.querySelector(SLOT);
      if (slot && slot.getAttribute("data-run-review-slot") === "working") {
        throw new Error("the row overruled a stream that had already spoken");
      }
      if (!document.querySelector("[data-run-completion]")) {
        throw new Error("no terminal rendering yet");
      }
    }, { timeout: 20_000 });
  }, 30_000);
});
