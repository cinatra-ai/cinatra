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
 * The arms, and the last two are the bound:
 *
 *   1. A REMOUNT whose read has not answered redraws the row already shown.
 *   2. A RELOAD of the same conversation redraws it too, from the session
 *      mirror, while the fresh read is still in flight.
 *   3. An AUTHORITATIVE `{ state: "none" }` still withdraws the row AND erases
 *      what was remembered of it — the cookie entry answers `none` for a browser
 *      with no session and for a reader who may not see the run, so the silence
 *      this file closes is the authority's silence and never its refusal.
 *   4. A run this reader has NEVER been shown still draws nothing at all — §IV's
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

  it("redraws the settled row after a RELOAD, from the session mirror", async () => {
    // A reload is a fresh page session with the SAME `sessionStorage`: the
    // in-memory half is gone and the mirror is what is left. The boot measured
    // twenty seconds of no row at all here, so the mirror is asked for from an
    // effect and the row is drawn before the fresh read lands.
    const first = mount();
    await waitFor(() => expect(rowOf(first)).not.toBeNull());
    first.unmount();
    const mirror = window.sessionStorage.getItem(
      `cinatra.recommendation-row-seen.${RUN_ID}`,
    );
    expect(mirror, "the drawn reading is mirrored for the reload").not.toBeNull();

    // The new page session: nothing in memory, the mirror intact.
    resetDrawnRecommendationReadings();
    window.sessionStorage.setItem(`cinatra.recommendation-row-seen.${RUN_ID}`, mirror!);
    authority.pending = new Promise<HoldState | null>(() => {});
    const reloaded = mount();
    await waitFor(() => expect(rowOf(reloaded)).not.toBeNull());
    expect(pillsOf(reloaded)).toHaveLength(1);
    expect(rowOf(reloaded)!.getAttribute("data-lifecycle-card-state")).toBe("decided");
  });

  it("withdraws the row, and FORGETS it, when the authority answers `none`", async () => {
    // `none` is an ANSWER, not the silence this file closes. The cookie entry's
    // own contract gives it for "no run", for "a reader who may not see the run"
    // and — no session actor at all — for a signed-out browser. A memory that
    // outlived it would keep a prompt, a skill list and a live Continue on
    // screen for a reader the authority has just refused.
    const view = mount();
    await waitFor(() => expect(rowOf(view)).not.toBeNull());
    view.unmount();

    authority.answer = { state: "none" };
    const refused = mount();
    await waitFor(() => expect(authority.calls).toBeGreaterThan(1));
    await waitFor(() =>
      expect(rowOf(refused), "the refused reader is shown no row").toBeNull(),
    );
    expect(
      window.sessionStorage.getItem(`cinatra.recommendation-row-seen.${RUN_ID}`),
      "and nothing is left for the next mount to redraw",
    ).toBeNull();
    refused.unmount();

    // The next mount's read has not landed: with the memory erased there is
    // nothing to resurrect, so the refusal holds instead of flickering back.
    authority.pending = new Promise<HoldState | null>(() => {});
    const after = mount();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rowOf(after)).toBeNull();
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

// ---------------------------------------------------------------------------
// THE MEMORY BELONGS TO THE TRANSCRIPT, NOT TO EVERY HOST (cinatra#3062, fix
// leg 3, round 2 — the regression the verify round caught).
// ---------------------------------------------------------------------------
// What the register exists for is stated in one clause of section V: a row the
// reader did see "keeps its place IN THE TURN". The turn is the conversation's
// own unit, and the reason the memory has to live beside the component is a
// property only a conversation has — a transcript that RE-CREATES its turns
// whenever the server's copy of the thread grows, remounting the card with no
// memory of the row it had just drawn.
//
// The run page has neither half of that. Its host resolves this run SERVER-SIDE
// and hands the reading over (`initialState`), and its mount is not re-created
// underneath the reader — the defect cinatra#3047 fixed, and fixed there. So a
// remembered reading on that host buys nothing and costs the one thing a card
// must never do: draw a reading the authority has already moved past. Measured
// on this head before the scope was drawn — the run page's own suite went red
// once in five runs on "shows the settled pills, read-only", reading `held` off
// a memory left by an earlier mount while its own answer was still in flight.
//
// So the memory is read and written on the conversation hosts and on no other.
describe("the memory belongs to the transcript, not to every host", () => {
  const runPageRow = (r: RenderResult) =>
    r.container.querySelector('[data-lifecycle-card="recommendation_hold"]');

  function mountRunPage(runId = RUN_ID): RenderResult {
    return render(
      <LifecycleCardSurfaceProvider host="run_card">
        <RecommendationHoldCard runId={runId} wireRef={null} />
      </LifecycleCardSurfaceProvider>,
    );
  }

  it("draws no remembered row on the run page while its own read is in flight", async () => {
    const first = mountRunPage();
    await waitFor(() => expect(runPageRow(first)).not.toBeNull());
    first.unmount();

    // The same run, mounted again on the same host, with its own round trip not
    // landed. The run page waits for an authority — its host's server-side
    // reading, or its own answer — and draws nothing out of a memory.
    authority.pending = new Promise<HoldState | null>(() => {});
    const second = mountRunPage();
    await waitFor(() => expect(authority.calls).toBeGreaterThan(1));
    expect(runPageRow(second)).toBeNull();
  });

  it("writes nothing a conversation could later read off the run page", async () => {
    const page = mountRunPage();
    await waitFor(() => expect(runPageRow(page)).not.toBeNull());
    page.unmount();

    authority.pending = new Promise<HoldState | null>(() => {});
    const thread = mount();
    await waitFor(() => expect(authority.calls).toBeGreaterThan(1));
    expect(rowOf(thread)).toBeNull();
  });
});
