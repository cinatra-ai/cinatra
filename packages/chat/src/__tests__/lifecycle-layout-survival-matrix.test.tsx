// @vitest-environment jsdom
//
// ---------------------------------------------------------------------------
// THE LAYOUT / ERROR SURVIVAL MATRIX (cinatra#2825, epic #2784 S9l).
// Plan: engineering wiki "PLAN: Agents Lifecycle" §2 (§2.3 rows 1-3).
// ---------------------------------------------------------------------------
// A lifecycle card is the only thing in the conversation that a reader OWES an
// answer to. Everything else a turn draws is a reading; a held review, a held
// recommendation, a proposal waiting to be armed are all decisions parked in the
// transcript. So the property this file measures is not "the card renders" —
// three other suites already measure that — it is that NOTHING ABOUT THE
// PRESENTATION can make one disappear:
//
//   · not the LAYOUT MODE. The Slack (two-mention) layout pins its own turn
//     shape and drops the ordered `parts` trace, and its atomic reveal used to
//     test only text / thought groups / errors — so a turn whose ONLY content
//     was a card was never written to the list at all.
//   · not an UNRELATED STREAM ERROR. An error turn drew the error card INSTEAD
//     of the turn's renderable views and instead of its ordered parts, so a
//     transport failure could dismiss a decision the run had already produced.
//   · not the ABSENCE OF PROSE. A turn with no text and no trace — a card and
//     nothing else — fell through the render ladder to `null`.
//
// WHAT A CELL IS. One CARRIAGE CLASS × layout × prose × turn outcome × liveness:
//
//   carriage   review_card          — a real typed `DATA_PART` owner: the review
//                                     card, resolved and drawn by the shipped
//                                     `ReviewGateCard`.
//              recommendation_slot  — the real `agent_run` ANCHOR the
//                                     recommendation card mounts at (#2786).
//   layout     chatgpt | slack
//   prose      with-prose | no-prose   (a card-only turn is the honest case;
//                                       prose can hide a suppressed card)
//   outcome    clean | error           (an error-bearing turn)
//   liveness   live | reloaded         (reloaded = the SAME projected turn taken
//                                       through the JSON round trip the thread
//                                       is persisted and restored by)
//
// HOW A CELL IS MEASURED. Real AG-UI frames, reduced by the REAL reducer, driven
// by the REAL `/chat` turn driver (`driveAssistantChatTurn` — the layout reveal
// and the error path are ITS code, so a cell that stubbed it would measure
// nothing), projected by the REAL projection, and rendered by the REAL
// conversation column the page mounts. The only stand-ins are the four modules
// whose graphs reach the server runtime, replaced exactly as the sibling
// transcript suites replace them.
//
// WHY THE TWO CLASSES DIFFER IN WHAT IS ASSERTED. The review card is mounted in
// the chat transcript today, so its own root and its controls are asserted. The
// recommendation card's chat mount was still OWED
// (`HELD_TURN_MOUNT_OBLIGATIONS` in the S9h contract) when this file was
// written, so what the matrix asserted for that class was that the SLOT it
// mounts at survives every cell, with a separate block putting the REAL held
// card in that surviving slot and driving it.
//
// THE OBLIGATION IS NOW STRUCK. S9b (cinatra#2786) landed the production
// chat_thread mount, so the list is empty and the slot assertion has tightened
// to the owner root, by reading the same list and with no edit to the assertion
// itself. One thing did have to change for that arm to mean anything: a
// recommendation cell now drives a HELD hold, because the card self-gates and
// draws nothing without one. See the fixture note in the matrix body.
// ---------------------------------------------------------------------------

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { AgUiEvent } from "@cinatra-ai/agent-ui-protocol";

// --- the four server-reaching modules, stubbed as the sibling suites stub them

vi.mock("lucide-react", () => {
  const StubIcon: React.FC = () => null;
  return new Proxy({} as Record<string, React.FC>, {
    get: (_t, prop) => {
      if (prop === "__esModule") return true;
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return undefined;
      return StubIcon;
    },
    has: () => true,
    ownKeys: () => ["Check", "ChevronDown", "default"],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: StubIcon }),
  });
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/chat",
  useSearchParams: () => new URLSearchParams(),
}));

type HoldState =
  | { state: "none" }
  | {
      state: "held";
      agentPackageName: string;
      promptText: string;
      recommendations: {
        skillId: string;
        skillRevisionId: string;
        recommended: boolean;
        name?: string;
      }[];
      holdRef: string;
    }
  | { state: "confirmed"; skillNames: string[] }
  | { state: "skipped" };

const holdStateMock = vi.fn(async (): Promise<HoldState> => ({ state: "none" }));
const confirmMock = vi.fn(async () => ({ ok: true, dispatched: true }));
const skipMock = vi.fn(async () => ({ ok: true, dispatched: true }));

vi.mock("../../../agents/src/run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: (...args: unknown[]) =>
    holdStateMock(...(args as [])),
  confirmRunRecommendationAction: (...args: unknown[]) => confirmMock(...(args as [])),
  skipRunRecommendationAction: (...args: unknown[]) => skipMock(...(args as [])),
}));
const hitlScreenStateMock = vi.fn(async () => ({ state: "none" }) as Record<string, unknown>);
// The HITL screen card's own server-only entry, stubbed for the same reason
// (cinatra#2930, lifecycle-b W3): the column mounts that card beside the §V one
// now, and an unstubbed `"use server"` module fails the whole lazy chat chunk.
// The default answer is "no screen", so a suite that is not about this kind sees
// exactly what it saw before the card existed.
vi.mock("../../../agents/src/agent-hitl-screen-actions", () => ({
  getAgentHitlScreenStateAction: () => hitlScreenStateMock(),
}));
vi.mock("../../../agents/src/hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => undefined),
  rejectReviewTask: vi.fn(async () => undefined),
}));

// `server-actions` is a server-only graph, so it is stubbed rather than loaded.
// It must carry EVERY symbol the lazy chat chunk reaches — the inline run panel
// imports two more — or that chunk fails to evaluate and the transcript never
// mounts at all, which would look like a passing negative arm.
vi.mock("../../../agents/src/server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
  getSkillsForAgentAction: vi.fn(async () => []),
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({})),
  confirmRunSkillSelectionAction: vi.fn(async () => ({ ok: true })),
}));

// Some Node builds expose a global `localStorage` that SHADOWS jsdom's and
// throws on use, which the composer's prompt field reads on mount. Repair it
// only when it is actually broken: on a runtime whose jsdom storage works (the
// one CI runs) this is inert, and the suite behaves identically on both.
if (typeof window !== "undefined" && typeof window.localStorage?.getItem !== "function") {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

vi.mock("../pending-call-actions", () => ({
  listPendingToolConfirmations: async () => ({ rows: [] }),
  decidePendingToolCall: async () => ({ ok: true }),
}));
vi.mock("../undo-actions", () => ({
  recentUndoableChangeSetForRunAction: async () => ({ changeSetId: null }),
}));
vi.mock("@/components/data-safety/undo-toast", () => ({
  undoDeepLink: (id: string) => `/objects?undo=${id}`,
}));

// The inline run card is the AG-UI run panel, whose graph reaches the server
// runtime. Replaced by the SAME stand-in the S9h transcript suite uses: it
// declares the host the shipped panel declares, so the slot is measured against
// the production vocabulary rather than a marker invented here.
vi.mock("../inline-agent-run-card", () => ({
  InlineAgentRunCard: ({ runId }: { runId: string }) => (
    <div data-lifecycle-card-host="run_card" data-inline-run-card={runId} />
  ),
}));

import {
  HELD_TURN_MOUNT_OBLIGATIONS,
  heldTurnMountIsOwed,
} from "@/lib/lifecycle/held-turn-card-contract";
import { LifecycleCardSurfaceProvider } from "../../../agents/src/lifecycle-card-runtime";
import { RecommendationHoldCard } from "../../../agents/src/run-recommendation-chip-row";
import {
  __resetAssistantChatNegotiation,
  driveAssistantChatTurn,
  type AssistantChatTurnUiPort,
} from "../ag-ui-chat-client";
import { LIFECYCLE_VIEW_RESOLVE_PATH } from "../renderable-views/lifecycle-card";
import { mountSurface } from "./conversation-column-harness";
import type { UiMessage } from "../types";

// ---------------------------------------------------------------------------
// The cell vocabulary
// ---------------------------------------------------------------------------

const CARRIAGES = ["review_card", "recommendation_slot"] as const;
const LAYOUTS = ["chatgpt", "slack"] as const;
const PROSE = ["with-prose", "no-prose"] as const;
const OUTCOMES = ["clean", "error"] as const;
const LIVENESS = ["live", "reloaded"] as const;

type Carriage = (typeof CARRIAGES)[number];
type Layout = (typeof LAYOUTS)[number];
type Prose = (typeof PROSE)[number];
type Outcome = (typeof OUTCOMES)[number];
type Liveness = (typeof LIVENESS)[number];

type Cell = {
  carriage: Carriage;
  layout: Layout;
  prose: Prose;
  outcome: Outcome;
  liveness: Liveness;
};

/** The canonical cell name — the one a PR names a red cell by. */
function cellName(c: Cell): string {
  return [c.carriage, c.layout, c.prose, c.outcome, c.liveness].join(" · ");
}

const MATRIX: Cell[] = CARRIAGES.flatMap((carriage) =>
  LAYOUTS.flatMap((layout) =>
    PROSE.flatMap((prose) =>
      OUTCOMES.flatMap((outcome) =>
        LIVENESS.map((liveness) => ({ carriage, layout, prose, outcome, liveness })),
      ),
    ),
  ),
);

const THREAD_ID = "th-survival-2825";
const ASSISTANT_ID = "a-survival-2825";
const RUN_ID = "run-survival-2825";
const REVIEW_REF = "ref-survival-2825";
const PROSE_TEXT = "Dispatched the proof agent.";
// What a mid-run drop surfaces on the bubble: the stream's own message,
// carried through verbatim by the driver.
const TRANSPORT_ERROR = "transport drop";

/** The review card's DATA_PART: a bounded opaque ref and nothing else. */
const REVIEW_VIEW = {
  viewType: "artifact_review_gate",
  schemaVersion: 1,
  ref: REVIEW_REF,
} as const;

// ---------------------------------------------------------------------------
// The wire — real frames for the cell's carriage
// ---------------------------------------------------------------------------

function frames(cell: Cell): Array<{ id: string; event: AgUiEvent }> {
  const out: Array<{ id: string; event: AgUiEvent }> = [
    { id: "1-0", event: { type: "RUN_STARTED", threadId: THREAD_ID, runId: "r1" } as AgUiEvent },
  ];
  if (cell.prose === "with-prose") {
    out.push(
      { id: "2-0", event: { type: "TEXT_MESSAGE_START", messageId: "m1" } as AgUiEvent },
      {
        id: "2-1",
        event: {
          type: "TEXT_MESSAGE_CONTENT",
          messageId: "m1",
          delta: PROSE_TEXT,
        } as AgUiEvent,
      },
      { id: "2-2", event: { type: "TEXT_MESSAGE_END", messageId: "m1" } as AgUiEvent },
    );
  }
  if (cell.carriage === "review_card") {
    out.push({ id: "3-0", event: { type: "DATA_PART", data: REVIEW_VIEW } as AgUiEvent });
  } else {
    // The held dispatch: the tool call the card anchors at, and the DATA_PART
    // that pins its runId (the runId NEVER comes from TOOL_CALL_END).
    out.push(
      {
        id: "3-0",
        event: { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "agent_run" } as AgUiEvent,
      },
      { id: "3-1", event: { type: "TOOL_CALL_END", toolCallId: "t1" } as AgUiEvent },
      {
        id: "3-2",
        event: {
          type: "DATA_PART",
          data: { kind: "agent_run", toolCallId: "t1", runId: RUN_ID },
        } as AgUiEvent,
      },
    );
  }
  // A clean turn finishes; an error-bearing turn drops mid-run (the stream errors
  // below) and its durable-log resume fails too, which is what surfaces the error.
  if (cell.outcome === "clean") {
    out.push({
      id: "9-0",
      event: { type: "RUN_FINISHED", threadId: THREAD_ID, runId: "r1" } as AgUiEvent,
    });
  }
  return out;
}

/**
 * The turn's frames as an SSE body, optionally followed by a mid-run TRANSPORT
 * DROP.
 *
 * One frame per `pull`, deliberately: `controller.error()` DISCARDS whatever is
 * still queued, so a body that enqueued everything up front and then errored
 * would deliver no frames at all — and the error cells would be measuring an
 * empty turn rather than a turn that produced a card and then lost its stream.
 * Pulling one at a time means every frame has been read before the drop.
 */
function sseBody(
  turnFrames: Array<{ id: string; event: AgUiEvent }>,
  thenError: boolean,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let next = 0;
  return new ReadableStream({
    pull(controller) {
      const frame = turnFrames[next++];
      if (frame) {
        controller.enqueue(
          encoder.encode(`id: ${frame.id}\ndata: ${JSON.stringify(frame.event)}\n\n`),
        );
        return;
      }
      if (thenError) controller.error(new Error("transport drop"));
      else controller.close();
    },
  });
}

function fakePort() {
  let messages: UiMessage[] = [];
  const typing: boolean[] = [];
  const port: AssistantChatTurnUiPort = {
    updateMessages: (updater) => {
      messages = updater(messages);
    },
    setTypingIndicator: (on) => typing.push(on),
    isWidgetRefreshTool: () => false,
    onWidgetRefresh: () => {},
  };
  return {
    port,
    get messages() {
      return messages;
    },
    typing,
  };
}

/**
 * Drive the cell's turn through the REAL driver and return what the list holds
 * afterwards — including, for the Slack layout, whether the turn was revealed at
 * all. The POST streams the cell's frames; the durable-log resume a mid-run drop
 * attempts is refused, so the error path is the one production takes.
 */
async function driveCell(cell: Cell): Promise<UiMessage[]> {
  const wants = frames(cell);
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const isTurnPost = (init?.method ?? "GET").toUpperCase() === "POST";
    if (isTurnPost && url.includes("/chat")) {
      return new Response(sseBody(wants, cell.outcome === "error"), { status: 200 });
    }
    // The resume GET (and anything else this turn reaches for).
    return new Response("no", { status: 500 });
  }) as unknown as typeof fetch;

  const f = fakePort();
  await driveAssistantChatTurn({
    threadId: THREAD_ID,
    assistantId: ASSISTANT_ID,
    messages: [{ role: "user", content: "Run the proof agent" }],
    slack: cell.layout === "slack",
    signal: new AbortController().signal,
    ui: f.port,
  });
  return f.messages;
}

// ---------------------------------------------------------------------------
// The surface — the real column, with the authoritative resolve answered
// ---------------------------------------------------------------------------

/** The `pending` answer, in the per-kind envelope the card parses (S9c). */
function installResolveStub(state: Record<string, unknown> = {
  state: "pending",
  canDecide: true,
  canComment: true,
}) {
  const calls: string[] = [];
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith(LIFECYCLE_VIEW_RESOLVE_PATH)) {
      let kind = "artifact_review_gate";
      try {
        kind = JSON.parse(String(init?.body ?? "{}")).viewType ?? kind;
      } catch {
        // A caller that issued no body keeps the review kind.
      }
      return new Response(JSON.stringify({ kind, state, body: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ rows: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  return calls;
}

/** The persisted round trip a reload replays the transcript through. */
function reloaded(messages: UiMessage[]): UiMessage[] {
  return JSON.parse(JSON.stringify(messages)) as UiMessage[];
}

async function mountTranscript(messages: UiMessage[], layout: Layout) {
  const mounted = await mountSurface("chat", {
    messages: [{ id: "u1", role: "user", content: "Run the proof agent" }, ...messages],
    slackMode: layout === "slack",
  });
  const root = mounted.container.querySelector<HTMLElement>('[data-parity-surface="chat"]');
  if (!root) throw new Error("the chat surface did not mount");
  return root;
}

beforeEach(() => {
  holdStateMock.mockImplementation(async () => ({ state: "none" }));
  confirmMock.mockClear();
  skipMock.mockClear();
});

afterEach(() => {
  cleanup();
  __resetAssistantChatNegotiation();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// THE MATRIX
// ---------------------------------------------------------------------------

describe("a lifecycle item survives every layout, every turn outcome, live and reloaded", () => {
  for (const cell of MATRIX) {
    it(cellName(cell), async () => {
      // A RECOMMENDATION CELL NEEDS A HOLD TO DRAW, and this is the fixture that
      // gives it one (cinatra#2786, S9b).
      //
      // The struck-obligation arm below requires the owner root itself once
      // `recommendation_hold` leaves `HELD_TURN_MOUNT_OBLIGATIONS`. S9b struck
      // it, and the arm then failed all sixteen recommendation cells. The
      // mount is not missing. The suite's `beforeEach`
      // leaves the hold at `state: "none"`, and `RecommendationHoldCard`
      // SELF-GATES: no live hold means it renders nothing. That gate is
      // deliberate and load-bearing. It is what lets the card survive a
      // transcript reload and settle IN PLACE into its decided summary instead
      // of disappearing, and it is why a fresh thread reports zero
      // `recommendation_hold` roots on entry. So with `"none"` there is no root
      // to find in ANY layout, and the arm could not have passed however good
      // the mount was.
      //
      // The fixture is the same held row the operability describe below already
      // uses, so the two halves read the same card. This STRENGTHENS the arm:
      // it now asserts the mount actually draws through
      // `MessageLifecycleSlots` in both pinned layouts and on an error turn,
      // live and reloaded, where before it asserted an absence it had itself
      // arranged. No assertion was changed or removed.
      if (cell.carriage === "recommendation_slot") {
        holdStateMock.mockImplementation(async () => ({
          state: "held",
          agentPackageName: "@cinatra-ai/proof-agent",
          promptText: "{}",
          recommendations: [
            {
              skillId: HELD_SKILL_ID,
              skillRevisionId: "rev-a",
              recommended: true,
              name: "Skill A",
            },
          ],
          holdRef: "hold-ref-2825",
        }));
      }
      const driven = await driveCell(cell);

      // (1) THE TURN IS ON THE LIST. The Slack layout writes the whole turn in
      // one atomic reveal, so a reveal condition that does not count a card is
      // the first place a card-only turn disappears — before any renderer runs.
      const turn = driven.find((m) => m.id === ASSISTANT_ID);
      expect(turn, `${cellName(cell)}: the turn was never revealed`).toBeDefined();

      // (2) THE CARRIAGE SURVIVED THE PROJECTION.
      if (cell.carriage === "review_card") {
        expect(turn?.dataParts, `${cellName(cell)}: the card payload was dropped`).toEqual([
          REVIEW_VIEW,
        ]);
      } else {
        const slots = [...(turn?.parts ?? []), ...(turn?.lifecycleParts ?? [])].filter(
          (p) => p.kind === "tool_call" && p.name === "agent_run",
        );
        expect(slots, `${cellName(cell)}: the lifecycle slot was dropped`).toHaveLength(1);
      }

      // (3) THE REAL VIEW DRAWS IT — live, or from the persisted round trip.
      const messages = cell.liveness === "reloaded" ? reloaded(driven) : driven;
      installResolveStub();
      const root = await mountTranscript(messages, cell.layout);

      if (cell.carriage === "review_card") {
        // The owner root, in its held state, with its controls live.
        await waitFor(() =>
          expect(
            root.querySelectorAll('[data-conformance-id="review-gate-card"]'),
            `${cellName(cell)}: the review card is not in the transcript`,
          ).toHaveLength(1),
        );
        const card = root.querySelector<HTMLElement>('[data-conformance-id="review-gate-card"]')!;
        expect(card.getAttribute("data-lifecycle-card-state")).toBe("pending");
        expect(card.getAttribute("data-lifecycle-card-host")).toBe("chat_thread");
        for (const action of [
          "approve-review -> resolved",
          "reject-review -> resolved",
          "comment-review -> annotated",
        ]) {
          const control = card.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
          expect(control, `${cellName(cell)}: no ${action} control`).not.toBeNull();
          expect(
            control!.disabled,
            `${cellName(cell)}: ${action} is present but not operable`,
          ).toBe(false);
        }
        // The note field the composer binding mirrors is part of the offer.
        expect(card.querySelector('[data-testid="review-rationale"]')).not.toBeNull();
      } else {
        // The slot the recommendation card mounts at — the `agent_run` part's
        // own container, named by its run.
        //
        // RE-ANCHORED (cinatra#2790, epic #2784 S9f). This used to look for the
        // inline run panel, which was the only thing that container held. Since
        // the run progress card waits for the skills decision, a held turn draws
        // no panel — so the anchor moved to the container itself, which is the
        // thing this class is actually about and cannot be emptied by a state.
        const slots = root.querySelectorAll(`[data-agent-run-slot="${RUN_ID}"]`);
        expect(
          slots,
          `${cellName(cell)}: the agent_run slot is not in the transcript`,
        ).toHaveLength(1);
        if (!heldTurnMountIsOwed("recommendation_hold")) {
          // The obligation was struck: the owner root itself is now required in
          // the same cell, with no edit to this file.
          //
          // AWAITED, like the review_card branch above (cinatra#3208 fix leg 1).
          // The hold card resolves its state in an effect and commits the owner
          // root only once the answer lands, so the root is never present on the
          // first render — reading it synchronously races that commit and reds
          // under load. The assertion is unchanged; only the wait around it is
          // new.
          await waitFor(() =>
            expect(
              root.querySelectorAll('[data-lifecycle-card="recommendation_hold"]'),
            ).toHaveLength(1),
          );
        }
      }

      // (4) AN ERROR TURN STILL SAYS SO. The card is drawn ALONGSIDE the error,
      // never instead of it — the reader is owed both facts.
      if (cell.outcome === "error") {
        expect(
          root.querySelector("[data-chat-error-card]"),
          `${cellName(cell)}: the error card stopped being drawn`,
        ).not.toBeNull();
        expect(root.textContent).toContain(TRANSPORT_ERROR);
      }

      // (5) PROSE IS NOT COLLATERAL. A turn that had text keeps it.
      if (cell.prose === "with-prose" && cell.outcome === "clean") {
        expect(root.textContent, `${cellName(cell)}: the turn's prose disappeared`).toContain(
          PROSE_TEXT,
        );
      }
    });
  }
});

// ---------------------------------------------------------------------------
// The negative controls — the matrix can still FAIL
// ---------------------------------------------------------------------------

describe("the matrix is not satisfied by drawing a card unconditionally", () => {
  for (const layout of LAYOUTS) {
    it(`${layout}: a turn carrying no lifecycle item draws none`, async () => {
      installResolveStub();
      const root = await mountTranscript(
        [{ id: ASSISTANT_ID, role: "assistant", content: "Just an answer." }],
        layout,
      );
      expect(root.textContent).toContain("Just an answer.");
      expect(root.querySelector('[data-conformance-id="review-gate-card"]')).toBeNull();
      expect(root.querySelector("[data-inline-run-card]")).toBeNull();
    });

    it(`${layout}: a card-carrying turn draws the card ONCE, not once per branch`, async () => {
      installResolveStub();
      const root = await mountTranscript(
        [
          {
            id: ASSISTANT_ID,
            role: "assistant",
            content: "Answer with a card.",
            parts: [
              { kind: "text", content: "Answer with a card." },
              {
                kind: "tool_call",
                id: "t1",
                name: "agent_run",
                status: "completed",
                runId: RUN_ID,
              },
            ],
            lifecycleParts: [
              {
                kind: "tool_call",
                id: "t1",
                name: "agent_run",
                status: "completed",
                runId: RUN_ID,
              },
            ],
            dataParts: [{ ...REVIEW_VIEW }],
          } as UiMessage,
        ],
        layout,
      );
      await waitFor(() =>
        expect(root.querySelectorAll('[data-conformance-id="review-gate-card"]')).toHaveLength(1),
      );
      expect(root.querySelectorAll(`[data-inline-run-card="${RUN_ID}"]`)).toHaveLength(1);
    });
  }
});

// ---------------------------------------------------------------------------
// The surviving slot is a REAL mount point
// ---------------------------------------------------------------------------
// The class above asserts the anchored container survives. That is only worth
// something if the container is somewhere a card can actually live, so this puts
// the REAL held card in the REAL surviving slot and drives its decision. It is
// NOT production carriage and claims none — production carriage is the owed
// mount the S9h contract measures.
//
// THE CONTROLS THIS DRIVES ARE THE SHIPPED ONES, not names the card once used.
// §V's redraw moved the decision OFF the row and ONTO EACH CHIP:
// `packages/agents/src/run-recommendation-chip-row.tsx` draws Confirm, Adjust
// and Skip per skill, and the two contracts that identify this card name the
// same three `[data-skill-action]` values —
// `scripts/ci/lib/capture-record-contract.mjs` and
// `src/lib/lifecycle/held-turn-card-contract.ts`. The row-level
// `confirm-run-recommendation` / `skip-run-recommendation` pair this block was
// first written against is drawn by NOTHING now, so asserting it would measure
// a card that no longer exists. All three are asserted, each scoped to the
// offered skill's OWN chip, and each checked for operability exactly as the
// review arm above checks its own three.

/** The one skill the held fixture offers — the chip these controls belong to. */
const HELD_SKILL_ID = "skill-a";

/** The card's own decision controls, as the SHIPPED §V chip-row draws them. */
const CHIP_ACTIONS = ["confirm", "adjust", "skip"] as const;

/** That skill's chip control for one of the three affordances. */
function chipControl(row: HTMLElement, action: string): HTMLButtonElement | null {
  return row.querySelector<HTMLButtonElement>(
    `[data-skill-action="${action}"][data-skill-id="${HELD_SKILL_ID}"]`,
  );
}

describe("the slot that survives is one the real held card can be operated in", () => {
  for (const layout of LAYOUTS) {
    for (const outcome of OUTCOMES) {
      it(`recommendation_hold · ${layout} · ${outcome}: the chip's Confirm, Adjust and Skip are live in the surviving slot`, async () => {
        holdStateMock.mockImplementation(async () => ({
          state: "held",
          agentPackageName: "@cinatra-ai/proof-agent",
          promptText: "{}",
          recommendations: [
            {
              skillId: HELD_SKILL_ID,
              skillRevisionId: "rev-a",
              recommended: true,
              name: "Skill A",
            },
          ],
          holdRef: "hold-ref-2825",
        }));
        const driven = await driveCell({
          carriage: "recommendation_slot",
          layout,
          prose: "no-prose",
          outcome,
          liveness: "live",
        });
        installResolveStub();
        const root = await mountTranscript(driven, layout);
        const slot = root.querySelector<HTMLElement>(`[data-agent-run-slot="${RUN_ID}"]`);
        expect(slot, "the agent_run producing container is not in the transcript").not.toBeNull();
        if (!slot) throw new Error("unreachable — the expectation above throws first");

        render(
          <LifecycleCardSurfaceProvider host="chat_thread">
            <RecommendationHoldCard
              runId={RUN_ID}
              agentPackageName="@cinatra-ai/proof-agent"
              wireRef="hold-ref-2825"
            />
          </LifecycleCardSurfaceProvider>,
          { container: slot },
        );

        const row = await waitFor(() => {
          const el = slot.querySelector<HTMLElement>("[data-run-recommendation-chip-row]");
          expect(el).not.toBeNull();
          return el!;
        });
        const cell = `recommendation_hold · ${layout} · ${outcome}`;
        for (const action of CHIP_ACTIONS) {
          const control = chipControl(row, action);
          expect(
            control,
            `${cell}: no ${action} control on the offered skill's chip`,
          ).not.toBeNull();
          expect(control!.disabled, `${cell}: ${action} is present but not operable`).toBe(false);
        }
        // Driving the row's OWN release. The shipped row releases once EVERY
        // chip is decided (the whole-row release deviation named in the chip
        // row) — the fixture offers one skill, so confirming its chip is the
        // whole row, and the hold is released exactly once.
        fireEvent.click(chipControl(row, "confirm")!);
        await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
      });
    }
  }
});

// ---------------------------------------------------------------------------
// The obligation this matrix reads
// ---------------------------------------------------------------------------

describe("the matrix reads its own obligation rather than restating it", () => {
  it("asserts the SLOT for the recommendation kind exactly while its mount is owed", () => {
    expect(HELD_TURN_MOUNT_OBLIGATIONS.includes("recommendation_hold")).toBe(
      heldTurnMountIsOwed("recommendation_hold"),
    );
  });
});
