// @vitest-environment jsdom
/**
 * A ROW THE READER DID SEE KEEPS ITS PLACE IN THE TURN (cinatra#3062, fix leg 3).
 *
 * THE SENTENCE, from the ratified drawing's section V:
 *
 *   "A row whose boxes were all left clear is not the same as a card the reader
 *    may not read. Absent (§IV) is no card DOM at all, and it is reserved for the
 *    reader who may not see the thing. A row the reader did see keeps its place
 *    in the turn and states, box by box, that no recommended skill was applied —
 *    otherwise the question, the answer and the fact that nothing was applied all
 *    vanish from the transcript together, and nothing on screen says any of it
 *    happened."
 *
 * WHAT A LIVE BOOT MEASURED, and what these arms pin. The conversation's mount
 * draws NO DOM AT ALL until its own client round trip lands, and a transcript
 * RE-CREATES its turns whenever the server's copy of the thread grows — so the
 * card is remounted with no memory of the row it had just drawn. Measured on a
 * dev boot: the settled row stood for twelve seconds after the one Continue,
 * left the turn for the next fifteen while a fresh mount re-read the authority,
 * and a reload drew no row for twenty seconds. Neither window is §IV's Absent
 * reading; both are a row the reader was shown, withdrawn.
 *
 * Three arms, and the third is the bound:
 *
 *   1. A REMOUNT whose read has not answered redraws the row already shown.
 *   2. A `{ state: "none" }` answer arriving afterwards does not empty the turn.
 *   3. A run this reader has NEVER been shown still draws nothing at all — §IV's
 *      Absent reading is untouched, and this file may not be read as licence to
 *      paint a card out of silence.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/skills-row-keeps-its-place.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor, type RenderResult } from "@testing-library/react";

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
    ownKeys: () => ["ArrowRight", "Check", "default"],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: StubIcon }),
  });
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

type HoldState = Record<string, unknown>;

const authority = {
  answer: null as HoldState | null,
  /** When set, the read HANGS on it — the round trip that has not landed. */
  pending: null as Promise<HoldState | null> | null,
  calls: 0,
};

vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: async () => {
    authority.calls += 1;
    if (authority.pending) return authority.pending;
    return authority.answer;
  },
  confirmRunRecommendationAction: async () => ({ ok: true, dispatched: true }),
  skipRunRecommendationAction: async () => ({ ok: true, dispatched: true }),
}));

vi.mock("../server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
}));

import { RecommendationHoldCard } from "../run-recommendation-chip-row";
import {
  LIFECYCLE_RECOMMENDATION_HOLD_PATH,
  LifecycleCardSurfaceProvider,
} from "../lifecycle-card-runtime";
import { resetDrawnRecommendationReadings } from "../run-recommendation-reading-register";

const RUN_ID = "3f0b0e2a-9c2f-4d21-9a4c-1f0d4f6b7a10";
const OTHER_RUN_ID = "8a1c5d33-4b8e-4d0a-bb61-6cf2f5b6e991";

/** The settled reading a conversation shows after the one Continue: the offer
 *  the hold recorded, the run's own applied set, and a run that has NOT started. */
const SETTLED: HoldState = {
  state: "confirmed",
  skillNames: ["Blog Writing Skill"],
  decided: [
    { skillId: "@cinatra-ai/blog-writing-skill:blog-writing", name: "Blog Writing Skill", mark: "confirmed" },
  ],
  holdRef: "hold-ref-1",
  runStarted: false,
  canDecide: true,
  candidates: [
    {
      skillId: "@cinatra-ai/blog-writing-skill:blog-writing",
      name: "Blog Writing Skill",
      vendorName: "Cinatra",
      skillRevisionId: "rev-1",
      recommended: true,
    },
  ],
};

/**
 * THE WIDGET'S OWN TRANSPORT, answered as the shipped route answers it.
 *
 * `site_widget` is fail-CLOSED on the credential: a mount that declares no
 * `auth` declares no host at all and draws nothing, so the widget arm has to
 * carry one — and with one the card reads through the broker route rather than
 * the server action. jsdom resolves no relative URL, so an unstubbed read throws
 * inside the card's own catch and draws silence that reads exactly like a
 * refusal. The stub answers the state itself, which is what the route returns.
 */
const WIDGET_AUTH = {
  headers: () => ({ "x-cinatra-widget-test": "1" }),
  credentials: "omit" as RequestCredentials,
};

function installBrokerStub(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) !== LIFECYCLE_RECOMMENDATION_HOLD_PATH) {
      throw new Error(`unexpected request: ${String(input)}`);
    }
    authority.calls += 1;
    if (authority.pending) return { ok: true, json: async () => authority.pending } as unknown as Response;
    return { ok: true, json: async () => authority.answer } as unknown as Response;
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function mount(
  runId = RUN_ID,
  host: "chat_thread" | "site_widget" = "chat_thread",
): RenderResult {
  return render(
    <LifecycleCardSurfaceProvider
      host={host}
      {...(host === "site_widget" ? { auth: WIDGET_AUTH } : {})}
    >
      <RecommendationHoldCard runId={runId} wireRef={null} />
    </LifecycleCardSurfaceProvider>,
  );
}

const rowOf = (r: RenderResult) =>
  r.container.querySelector("[data-chat-thread-recommendation-hold]");
const pillsOf = (r: RenderResult) =>
  Array.from(r.container.querySelectorAll("[data-skills-step-pill]"));
/** The card root, addressed the way each conversation host marks it: the chat
 *  transcript's own evidence marker, and the shared card-root declaration the
 *  widget carries. */
const rowOf2 = (r: RenderResult, host: "chat_thread" | "site_widget") =>
  r.container.querySelector(
    host === "chat_thread"
      ? "[data-chat-thread-recommendation-hold]"
      : '[data-lifecycle-card="recommendation_hold"]',
  );
const continueOf = (r: RenderResult) =>
  r.container.querySelector("[data-skills-step-continue]");

beforeEach(() => {
  resetDrawnRecommendationReadings();
  authority.answer = SETTLED;
  authority.pending = null;
  authority.calls = 0;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the row the reader did see keeps its place in the turn", () => {
  it("redraws the settled row on a REMOUNT whose read has not answered", async () => {
    const first = mount();
    await waitFor(() => expect(rowOf(first)).not.toBeNull());
    expect(pillsOf(first)).toHaveLength(1);
    expect(rowOf(first)!.getAttribute("data-run-recommendation-decision")).toBe("confirmed");
    first.unmount();

    // The transcript re-creates its turns and the card is mounted again. Its own
    // round trip has NOT landed — the fifteen-second window the boot measured.
    authority.pending = new Promise<HoldState | null>(() => {});
    const second = mount();
    await waitFor(() => expect(rowOf(second)).not.toBeNull());
    expect(
      pillsOf(second).map((p) => p.getAttribute("data-skill-applied")),
      "the row states, box by box, what the run applied",
    ).toEqual(["true"]);
    expect(rowOf(second)!.getAttribute("data-lifecycle-card-state")).toBe("decided");
    expect(rowOf(second)!.getAttribute("data-run-recommendation-settled")).toBe("true");
  });

  it("does not empty the turn when a later answer says `none`", async () => {
    const view = mount();
    await waitFor(() => expect(rowOf(view)).not.toBeNull());

    // The resolver's `none` is its single indistinguishable "never held / not
    // yours / cannot tell". It is not a statement that the row was never there.
    authority.answer = { state: "none" };
    view.unmount();
    const again = mount();
    await waitFor(() => expect(authority.calls).toBeGreaterThan(1));
    expect(rowOf(again), "the question and its answer stay in the transcript").not.toBeNull();
    expect(pillsOf(again)).toHaveLength(1);
  });

  it("still draws NOTHING for a run this reader has never been shown", async () => {
    // §IV's Absent reading: no card DOM at all, reserved for the reader who may
    // not see the thing. Nothing above may be read as licence to paint a card
    // out of silence.
    authority.answer = { state: "none" };
    const view = mount(OTHER_RUN_ID);
    await waitFor(() => expect(authority.calls).toBeGreaterThan(0));
    expect(rowOf(view)).toBeNull();
    expect(view.container.querySelector("[data-lifecycle-card]")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// THE BOUNDARY IS THE RUN'S OWN START, ON BOTH CONVERSATION HOSTS
// (cinatra#3062, fix leg 3, item 3).
// ---------------------------------------------------------------------------
// The ratified drawing's section V draws three readings and no fourth:
//
//   "For as long as the run has not started, a reader who comes back to the
//    Skills step is shown the same pills with the boxes still able to take a
//    change and Continue still beneath them, and may change the selection. Once
//    the run has started the same pills are drawn with the state their boxes were
//    left in, read-only, and with no Continue."
//
// The RESOLVER is what answers "has it started", from the run row's own
// `started_at` (`recommendationRunHasStartedForRow`) and never from a status
// string — `pending_approval` has two producers and cannot resolve it. What is
// pinned here is the last link of that chain: the CONVERSATION hosts hand the row
// the resolver's own answer rather than a reading of their own. A live boot read
// the same thing from the other end — the settled row stayed editable with its
// Continue while the run's status was `pending_approval` and its `started_at` was
// still null.
describe("the settled reading's read-only boundary is the run's own start", () => {
  const started = (runStarted: boolean) => ({ ...SETTLED, runStarted });

  for (const host of ["chat_thread", "site_widget"] as const) {
    it(`keeps the boxes and the Continue before the run starts (${host})`, async () => {
      authority.answer = started(false);
      const restore = host === "site_widget" ? installBrokerStub() : () => {};
      try {
        const view = mount(RUN_ID, host);
        await waitFor(() => expect(rowOf2(view, host)).not.toBeNull());
        expect(rowOf2(view, host)!.getAttribute("data-skills-step-editable")).toBe("true");
        expect(continueOf(view)).not.toBeNull();
      } finally {
        restore();
      }
    });

    it(`draws the same pills read-only with no Continue once it has (${host})`, async () => {
      authority.answer = started(true);
      const restore = host === "site_widget" ? installBrokerStub() : () => {};
      try {
        const view = mount(RUN_ID, host);
        await waitFor(() => expect(rowOf2(view, host)).not.toBeNull());
        expect(rowOf2(view, host)!.getAttribute("data-skills-step-editable")).toBe("false");
        expect(continueOf(view)).toBeNull();
        expect(
          pillsOf(view).map((p) => p.getAttribute("data-skill-applied")),
          "the pills state the set the run applied",
        ).toEqual(["true"]);
      } finally {
        restore();
      }
    });
  }
});
