// @vitest-environment jsdom
/**
 * A SPENT SCHEDULE CARD IS A RECORD, NOT A REASON TO HIDE THE DECISION THE RUN
 * IS ASKING FOR (cinatra#3484).
 *
 * THE DRAWING'S TWO SENTENCES, read together, are the whole of what this file
 * measures. `specs/app-lifecycle-cards.html` SVI, the fired reading: "Once it
 * has fired, the card is a reading. A one-off that has fired cannot be changed,
 * so the rows go read-only - the values still legible, the pickers gone - and
 * the card carries no floor at all: no hairline, no button, nothing to press. A
 * spent schedule is still worth reading, so nothing is hidden; it simply asks
 * nothing." And SIX, the reader matrix: "A reader who may act gets the card
 * whole, with the actions its kind carries live - the review card's decision
 * floor (SII) ... No host puts a step in front of those actions, and no host
 * trades one of these readings for another."
 *
 * WHAT SHIPPED DID INSTEAD. The turn stands the run panel down from the
 * SCHEDULE card's state (`turnCarriesSettledSchedule`), and a one-off schedule
 * stays settled for the whole of the run that follows - so for that whole run
 * the panel sat inside a class-less `hidden aria-hidden` wrapper. The panel is
 * also this conversation's ONLY mount of the review screen, so a reader parked
 * on a pending artifact review gate met the record of a schedule that had
 * already run and nothing else: the review card's root stood in the DOM at a
 * zero-height box, which is none of the three readings the reader matrix allows
 * - not whole, not restricted, not absent.
 *
 * WHAT IS REAL HERE AND WHAT IS NOT, stated plainly because it decides what the
 * two readings below are worth:
 *
 *   - REAL - the conversation column `/chat` mounts (through the shared surface
 *     harness), its `chat_thread` declaration, the turn's own containers, the
 *     stand-down decision this file is about, the REAL schedule card resolved
 *     through the real refetch seam against a settled fired-one-off body, and
 *     the shipped `ReviewGateCard`.
 *   - NOT REAL - the run panel's own module. The chat tier CANNOT load it (the
 *     panel's graph reaches the app's server modules through specifiers this
 *     package's vitest config does not alias), which is why every chat suite
 *     that touches the inline run card mocks it. The stand-in below is
 *     therefore built to draw the panel's review reading as the shipped panel
 *     draws it - the wrapper's own marked `my-2` div, the review slot's section
 *     with its measured class string, and the shipped card inside it under NO
 *     declaration of its own - and to REPORT that reading the way the shipped
 *     panel reports it. That the shipped panel actually reports it, for every
 *     reading it has, is measured in the agents tier
 *     (`packages/agents/src/__tests__/run-panel-reports-the-reading-it-draws-3484.test.tsx`).
 *
 * THE ASSERTION IS THE VISIBILITY PREDICATE THE ROUND ITSELF USED, and it is
 * deliberately not a box: jsdom has no layout, so `getBoundingClientRect` is
 * always zero here and a measured box would prove nothing. What the round read
 * off the offending ancestor is read here instead - the `hidden` attribute, the
 * stand-down's own name, `aria-hidden` reading true, and an inline display of
 * none.
 *
 *   pnpm --filter @cinatra-ai/chat exec vitest run \
 *     src/__tests__/spent-schedule-turn-draws-the-owed-review-3484.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, configure, waitFor } from "@testing-library/react";

configure({ asyncUtilTimeout: 15_000 });

import type { UiMessage } from "../types";

// Some Node builds expose a global `localStorage` that SHADOWS jsdom's and
// throws on use, which the composer's prompt field reads on mount. Repaired
// only when actually broken, so the suite behaves identically on CI's runtime.
if (
  typeof globalThis.window !== "undefined" &&
  typeof window.localStorage?.getItem !== "function"
) {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

const RUN_ID = "7e2b1a44-0f65-4a2c-9a44-2f1e6a0b91cc";
const SCHEDULE_REF = "schedule-ref-3484";
const REVIEW_REF = "lcr-opaque-3484";
const REVIEW_CARD = '[data-conformance-id="review-gate-card"]';
const SCHEDULE_CARD = '[data-conformance-id="schedule-proposal-card"]';

// --- the column's own graph, stubbed exactly as its sibling suites stub it ---

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
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/chat",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("../../../agents/src/run-recommendation-actions", () => ({
  // No hold on this run: the schedule is what parked it, not the skills row.
  getRunRecommendationHoldStateAction: async () => ({ state: "none" }),
  confirmRunRecommendationAction: async () => ({ ok: true, dispatched: true }),
  skipRunRecommendationAction: async () => ({ ok: true, dispatched: true }),
}));
vi.mock("../../../agents/src/agent-hitl-screen-actions", () => ({
  getAgentHitlScreenStateAction: vi.fn(async () => ({ state: "none" })),
}));
vi.mock("../../../agents/src/hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => undefined),
  rejectReviewTask: vi.fn(async () => undefined),
}));
vi.mock("../../../agents/src/server-actions", () => ({
  getRunRecommendedSkillsAction: async () => [],
  getSkillsForAgentAction: async () => [],
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({})),
  confirmRunSkillSelectionAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../pending-call-actions", () => ({
  listPendingToolConfirmations: async () => ({ rows: [] }),
  decidePendingToolCall: async () => ({ ok: true }),
}));
vi.mock("../undo-actions", () => ({
  recentUndoableChangeSetForRunAction: async () => null,
}));
vi.mock("@/components/data-safety/undo-toast", () => ({
  undoDeepLink: (id: string) => `/objects?undo=${id}`,
}));

/**
 * THE PANEL'S REVIEW READING, STOOD IN FOR RATHER THAN LOADED - built to the
 * shipped shape node for node, because the chain between the turn and the card
 * root is exactly what this file measures:
 *
 *   - the wrapper's own `<div className="my-2" data-inline-run-card>`
 *     (`inline-agent-run-card.tsx`),
 *   - the review slot's `<section>` with the class string the round measured
 *     and `data-run-review-slot="review"` (`agentic-run-panel.tsx`),
 *   - the shipped `ReviewGateCard` inside it under NO declaration of its own,
 *     so the nearest one is the transcript's.
 *
 * AND IT REPORTS THE READING IT IS DRAWING, which is the seam this change adds.
 * A stand-in that drew the card without reporting would be a panel that draws a
 * review and says it does not - the state the agents-tier arm makes impossible
 * for the shipped panel.
 */
/**
 * THE STAND-IN'S OWN LIFECYCLE, held outside the mock factory so a case can
 * choose it (cinatra#3484, convergence round). The shipped inline card cannot
 * report a reading the moment it mounts: it fetches its seed first and draws
 * "Loading agent run..." until that answer lands. A stand-in that reports
 * synchronously therefore measures a timing the product does not have - and it
 * is exactly that timing which decides whether revealing the panel is stable or
 * tears its own publisher down. `seedLandsLater` turns the real timing on, and
 * `mounts` counts how many times the stand-in was mounted, which is what a
 * reveal that remounts its publisher shows.
 */
const standIn = vi.hoisted(() => ({ seedLandsLater: false, mounts: 0 }));

vi.mock("../inline-agent-run-card", async () => {
  const { ReviewGateCard, LIFECYCLE_VIEW_SCHEMA_VERSION } = await import(
    "@cinatra-ai/agents/review-gate-card"
  );
  return {
    InlineAgentRunCard: ({
      runId,
      onReviewReadingChange,
    }: {
      runId: string;
      onReviewReadingChange?: (runId: string, drawsReview: boolean) => void;
    }) => {
      // THE SEED, AND WHEN THE READING CAN BE REPORTED AT ALL. The shipped card
      // holds `seed === null` until its own fetch answers and draws a loading
      // line until then, so it cannot report a review before that. A case that
      // asks for the real timing gets it here; the default stays immediate.
      const [seeded, setSeeded] = React.useState(!standIn.seedLandsLater);
      React.useEffect(() => {
        standIn.mounts += 1;
        if (seeded) return;
        let live = true;
        const timer = setTimeout(() => {
          if (live) setSeeded(true);
        }, 0);
        return () => {
          live = false;
          clearTimeout(timer);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      React.useEffect(() => {
        if (!seeded) return;
        onReviewReadingChange?.(runId, true);
        return () => {
          onReviewReadingChange?.(runId, false);
        };
      }, [runId, onReviewReadingChange, seeded]);
      if (!seeded) {
        return (
          <div className="my-2" data-inline-run-card={runId}>
            Loading agent run...
          </div>
        );
      }
      return (
        <div className="my-2" data-inline-run-card={runId}>
          <section
            className="soft-panel rounded-card px-6 py-5 flex flex-col gap-4"
            data-run-review-slot="review"
          >
            <ReviewGateCard
              view={{
                viewType: "artifact_review_gate" as const,
                schemaVersion: LIFECYCLE_VIEW_SCHEMA_VERSION,
                ref: REVIEW_REF,
              }}
              runId={runId}
            />
          </section>
        </div>
      );
    },
  };
});

import { LIFECYCLE_VIEW_SCHEMA_VERSION } from "@cinatra-ai/agent-ui-protocol/renderable-views";
import { LIFECYCLE_VIEW_RESOLVE_PATH } from "../renderable-views/lifecycle-card";
import { RUN_SEED_ROUTE } from "../run-seed-request";
import { mountSurface } from "./conversation-column-harness";

/** A fired one-off schedule, settled - the section's fifth reading. */
const SETTLED_FIRED_ONE_OFF = {
  phase: "settled",
  version: 1,
  agentName: "Q3 cohort sweep",
  runId: RUN_ID,
  schedule: { kind: "scheduled", runAt: "2026-07-14T09:00", timezone: "Europe/Berlin" },
  triggerType: "scheduled",
  scheduleCopy: "Once, at 2026-07-14 09:00",
  timezone: "Europe/Berlin",
  gatedSteps: [],
  released: true,
  arming: false,
  canSave: false,
  canCancel: false,
};

/** The gate a reader may still decide - the review this run OWES. */
const RESOLVE_PENDING_REVIEW = {
  kind: "artifact_review_gate",
  state: { state: "pending", canDecide: true, canComment: true },
  body: null,
};

let restoreFetch: typeof globalThis.fetch;

beforeEach(() => {
  standIn.seedLandsLater = false;
  standIn.mounts = 0;
  restoreFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    // THE RUN'S OWN ROW (cinatra#3044). The conversation's run container reads
    // it to learn which moment the run stands at; this run has already moved
    // past its schedule, so the spent card is a reading of its own and the
    // moment's own stand-down (`runCardStandsDown`) is not what withholds the
    // panel here.
    if (url.startsWith(`${RUN_SEED_ROUTE}/`)) {
      return json({ id: RUN_ID, status: "completed", lifecycleMoment: null, lifecycleCard: null });
    }
    if (url === LIFECYCLE_VIEW_RESOLVE_PATH) {
      // ONE ROUTE, TWO CARDS. The resolve carries the kind it was asked for, so
      // the answer is selected on the request's own `viewType` rather than on
      // call order - the two cards in this turn resolve independently and in no
      // fixed sequence.
      const asked = ((): string => {
        try {
          return String(
            (JSON.parse(String(init?.body ?? "{}")) as { viewType?: unknown }).viewType ?? "",
          );
        } catch {
          return "";
        }
      })();
      if (asked === "artifact_review_gate") return json(RESOLVE_PENDING_REVIEW);
      if (asked === "trigger_schedule_proposal") {
        return json({
          kind: "trigger_schedule_proposal",
          state: { state: "settled" },
          body: SETTLED_FIRED_ONE_OFF,
          // THE FIRED READING RIDES THE ANSWER, BESIDE THE BODY (cinatra#3193).
          firedOnce: true,
        });
      }
      return json({}, 404);
    }
    return json({});
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = restoreFetch;
  vi.clearAllMocks();
  vi.useRealTimers();
});

/** The turn a schedule-parked chat dispatch produces, whose run has since gone
 *  on to park on the review of the artifact it produced: the `agent_run` part
 *  with the server-pinned run id, the schedule view it PRODUCED at that same
 *  step, and the assistant's own line about the spent schedule. */
function spentScheduleTurnOwingAReview(): UiMessage[] {
  return [
    { id: "u1", role: "user", content: "Run this once on 14 July at 9 in the morning." },
    {
      id: "a1",
      role: "assistant",
      content: "",
      parts: [
        {
          kind: "tool_call",
          id: "t1",
          name: "agent_run",
          status: "completed",
          runId: RUN_ID,
          views: [
            {
              viewType: "trigger_schedule_proposal",
              schemaVersion: LIFECYCLE_VIEW_SCHEMA_VERSION,
              ref: SCHEDULE_REF,
            },
          ],
        },
        {
          kind: "text",
          content:
            "It ran at the time you set. A one-time schedule is spent once it fires, so the rows below are the record of it and cannot be changed.",
        },
      ],
    } as unknown as UiMessage,
  ];
}

/** ONE WAIT FOR THE SETTLED SHAPE, WHOLE - the same wait the 3174 turn suite
 *  makes, for the same reason: the turn reaches this shape in three steps and
 *  draws a different one after each, so querying before all three have landed
 *  is a race rather than a reading. */
async function mountSpentScheduleTurn() {
  const result = await mountSurface("chat", { messages: spentScheduleTurnOwingAReview() });
  await waitFor(() => {
    const card = result.container.querySelector(SCHEDULE_CARD);
    if (card === null) throw new Error("the schedule card never drew");
    if (card.getAttribute("data-schedule-reading") !== "fired-one-off") {
      throw new Error("the card has not settled on its fired reading yet");
    }
    if (result.container.querySelector("[data-settled-moment-reading]") === null) {
      throw new Error("the spent card has not taken its own place yet");
    }
    if (result.container.querySelector(`[data-agent-run-screen-slot="${RUN_ID}"]`) === null) {
      throw new Error("the turn has not elected the settled shape yet");
    }
  });
  return result;
}

const turnContainer = (root: HTMLElement) =>
  root.querySelector(`[data-agent-run-slot="${RUN_ID}"]`);

/** The card root - the ONE element the recorder reads host and state off, and
 *  the element whose ancestor chain the round measured. */
async function reviewCardRoot(container: HTMLElement): Promise<Element> {
  return waitFor(
    () => {
      const el = container.querySelector(REVIEW_CARD);
      if (!el) throw new Error("the review card did not arrive in the thread");
      return el;
    },
    { timeout: 20_000 },
  );
}

/** The chain the round walked, bottom up, from the card root to the transcript
 *  - so a failing reading can name the ancestor that took the card out of the
 *  picture rather than only that something did. */
function ancestorChain(container: HTMLElement, card: Element): string[] {
  const out: string[] = [];
  for (let node = card.parentElement; node !== null && node !== container; node = node.parentElement) {
    const el = node;
    out.push(
      [
        el.tagName,
        el.getAttribute("class") === null ? "(class-less)" : `class="${el.getAttribute("class")!}"`,
        el.hasAttribute("hidden") ? "[hidden]" : "",
        el.getAttribute("aria-hidden") === "true" ? "[aria-hidden=true]" : "",
        el.style.display === "none" ? "[display:none]" : "",
        el.hasAttribute("data-inline-run-panel-stood-down") ? "[stood-down]" : "",
      ]
        .filter((part) => part !== "")
        .join(" "),
    );
  }
  return out;
}

describe("cinatra#3484 - the review a run owes is drawn in the conversation", () => {
  it("draws the owed review card with no ancestor that takes it out of the picture", async () => {
    const { container } = await mountSpentScheduleTurn();
    const card = await reviewCardRoot(container);
    const chain = ancestorChain(container, card).join("\n  ");

    // THE THREE PROPERTIES THE MEASURED FOURTH ANCESTOR CARRIED, read off the
    // card root's own ancestor chain. No box is measured: jsdom has no layout.
    expect(card.closest("[hidden]"), `the card is inside a hidden subtree:\n  ${chain}`).toBeNull();
    expect(
      card.closest("[data-inline-run-panel-stood-down]"),
      `the card is inside the panel's stand-down wrapper:\n  ${chain}`,
    ).toBeNull();
    expect(
      card.closest('[aria-hidden="true"]'),
      `the card is inside an aria-hidden subtree:\n  ${chain}`,
    ).toBeNull();
    for (let node = card.parentElement; node !== null && node !== container; node = node.parentElement) {
      expect(
        node.style.display,
        `an ancestor of the card is displayed none:\n  ${chain}`,
      ).not.toBe("none");
    }

    // AND IT IS THE CARD THE READER MAY ACT ON, read off its own root: the
    // reader matrix's "card whole" reading rather than a loading or error one.
    expect(card.getAttribute("data-lifecycle-card")).toBe("artifact_review_gate");
    expect(card.getAttribute("data-lifecycle-card-host")).toBe("chat_thread");
    await waitFor(() =>
      expect(card.getAttribute("data-lifecycle-card-state")).toBe(
        RESOLVE_PENDING_REVIEW.state.state,
      ),
    );
  }, 40_000);

  it("keeps the spent schedule card above it as the record it is", async () => {
    // SVI: "A spent schedule is still worth reading, so nothing is hidden; it
    // simply asks nothing." The record is not moved, not counted twice and not
    // traded for the card that asks - both are drawn, in this one turn.
    const { container } = await mountSpentScheduleTurn();
    const card = await reviewCardRoot(container);

    const spent = container.querySelectorAll(SCHEDULE_CARD);
    expect(spent).toHaveLength(1);
    const spentCard = spent[0]!;
    // Unmoved: still inside the turn's own container, still in its own settled
    // reading's place, and still reachable by a reader.
    expect(turnContainer(container)?.contains(spentCard)).toBe(true);
    expect(spentCard.closest("[data-settled-moment-reading]")).not.toBeNull();
    expect(spentCard.closest("[hidden], [aria-hidden='true']")).toBeNull();
    // And it asks nothing: the fired reading carries no floor of its own.
    expect(spentCard.getAttribute("data-schedule-reading")).toBe("fired-one-off");
    // The card that ASKS is drawn beneath it, and they are two cards in one
    // turn rather than one standing in for the other.
    expect(spentCard.contains(card)).toBe(false);
    expect(card.contains(spentCard)).toBe(false);
  }, 40_000);

  it("reveals the review without tearing down the panel that reported it", async () => {
    // THE READING IS REPORTED BY THE PANEL THE STAND-DOWN HOLDS, so revealing
    // it must not be a change that unmounts that panel: a reveal that swaps one
    // tree for another takes the publisher with it, the panel that replaces it
    // starts at its own seed again and reports nothing, the report falls back
    // to false, and the turn hides it once more - a reader watching a decision
    // appear and vanish while the run's seed is fetched over and over. The
    // stand-in is given the shipped card's own timing for this reading, because
    // a publisher that reports the instant it mounts hides the defect.
    standIn.seedLandsLater = true;
    const { container } = await mountSpentScheduleTurn();
    const card = await reviewCardRoot(container);
    await waitFor(() => {
      expect(card.closest("[data-inline-run-panel-stood-down]")).toBeNull();
    });

    // AND IT STAYS. The count is read after the reveal and again a beat later:
    // a turn that rebuilds its own panel to reveal it climbs, a turn that only
    // stops hiding it does not move.
    const mountsAtReveal = standIn.mounts;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(
      standIn.mounts,
      `the reveal remounted the panel that reports the reading (${mountsAtReveal} -> ${standIn.mounts})`,
    ).toBe(mountsAtReveal);
    const stillThere = container.querySelector(REVIEW_CARD);
    expect(stillThere, "the review card left the thread again").not.toBeNull();
    expect(stillThere!.closest("[hidden]")).toBeNull();
    expect(stillThere!.closest("[data-inline-run-panel-stood-down]")).toBeNull();
  }, 40_000);
});
