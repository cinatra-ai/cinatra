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
      expect(screen.queryByText(/Agentic Run Progress/i)).toBeNull();
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
