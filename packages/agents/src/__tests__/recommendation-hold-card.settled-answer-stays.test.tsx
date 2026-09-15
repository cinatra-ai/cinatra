// @vitest-environment jsdom
/**
 * A SETTLED CARD IS NOT WITHDRAWN BY AN EMPTY ANSWER (cinatra#3007, fix leg 10).
 *
 * THE FAILURE THIS PINS, MEASURED RATHER THAN IMAGINED. The held-turn gate
 * photographed it: the card settled in the transcript with its confirmed chip on
 * it, the in-page reader read every field off its own root, and the very next
 * look found NO card at all — sixty-three looks over thirty seconds, not one of
 * them seeing it again, with the run panel drawn where the card had been. The
 * page that failure saved says the same thing from the other end: the turn is
 * there, the run panel is there, and the settled row is gone.
 *
 * WHY IT GOES, AND WHY IT NEVER COMES BACK. The authority answers `none` to five
 * different questions — there is no reader, the run cannot be read, the park
 * cannot be read, no park exists, the park is released carrying no evidence — and
 * two of those are the COLLAPSE OF A READ THAT STUMBLED rather than a statement
 * about the run: both of them are written `.catch(() => null)` and both end at
 * the same word. The reader believed it, filed it as an answer, and an ANSWER
 * schedules nothing — the steady state of this card is zero timers — so the one
 * bad look is the last look and the settled row is gone for the life of the
 * mount.
 *
 * THE RULE, AND IT IS THE ONE THIS BRANCH ALREADY WROTE ONE SEAM OVER. The
 * review-slot reader states it in its own words: an empty answer does not
 * withdraw a positive one it has already delivered. The reason is identical here
 * — `none` is exactly what a stumbled read looks like — so beside an answer THIS
 * RUN has already given, it is read as a look that did not land: the last
 * authorized answer stays on the screen and the bounded retry asks again.
 *
 * WHAT IS NOT CHANGED, and is pinned below so it cannot drift. A FIRST answer of
 * `none` is still an answer: a run that was never held draws nothing, which is
 * the whole fail-closed posture of this card. And the suppression is keyed to the
 * RUN, so a later run on the same card starts from nothing rather than
 * inheriting a verdict about another one.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/recommendation-hold-card.settled-answer-stays.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("lucide-react", () => {
  const StubIcon: React.FC = () => null;
  return new Proxy({} as Record<string, React.FC>, {
    get: (_target, prop) => {
      if (prop === "__esModule") return true;
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return undefined;
      return StubIcon;
    },
    has: () => true,
    ownKeys: () => ["Check", "ChevronDown", "default"],
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
      value: StubIcon,
    }),
  });
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
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
      canDecide?: boolean;
    }
  | {
      state: "confirmed";
      skillNames: string[];
      decided?: { skillId: string; name: string; mark: "confirmed" }[];
    }
  | {
      state: "skipped";
      decided?: { skillId: string; name: string; mark: "skipped" }[];
    };

const holdStateMock = vi.fn(async (input: { runId: string }): Promise<HoldState> => {
  void input;
  return { state: "none" };
});

vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: (input: { runId: string }) => holdStateMock(input),
  confirmRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
  skipRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
}));

// The row fetches candidates from `./server-actions` when they are not
// prefetched; that module's graph is server-only and the row's own drawing is
// not what is under test here, so the one function it calls is stubbed — the
// same stub the sibling card suite installs.
vi.mock("../server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
}));

const CONFIRMED: HoldState = {
  state: "confirmed",
  skillNames: ["Skill A"],
  decided: [{ skillId: "skill-a", name: "Skill A", mark: "confirmed" }],
};

const HELD: HoldState = {
  state: "held",
  agentPackageName: "@cinatra-test/hold-fixture-agent",
  promptText: "{}",
  recommendations: [
    { skillId: "skill-a", skillRevisionId: "rev-a", recommended: true, name: "Skill A" },
  ],
  holdRef: "hold-ref-1",
};

const CARD_ROOT = '[data-lifecycle-card="recommendation_hold"]';
const CARD_HOST_CHAT = '[data-lifecycle-card-host="chat_thread"]';
const CARD_DECIDED = '[data-lifecycle-card-state="decided"]';
const CARD_HELD = '[data-lifecycle-card-state="held"]';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

beforeEach(() => {
  holdStateMock.mockImplementation(async () => ({ state: "none" }));
});

async function mountCard(runId: string) {
  const { RecommendationHoldCard } = await import("../run-recommendation-chip-row");
  const { LifecycleCardSurfaceProvider } = await import("../lifecycle-card-runtime");
  return render(
    <LifecycleCardSurfaceProvider host="chat_thread">
      <RecommendationHoldCard runId={runId} wireRef={null} />
    </LifecycleCardSurfaceProvider>,
  );
}

/**
 * The reader's OWN wake channel — a real trigger this card ships with, not a
 * private hook reached into. A focus is one of the three events documented to
 * reset the failure budget and ask again.
 */
async function wakeAndSettle() {
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("the settled card survives an empty answer (cinatra#3007, fix leg 10)", () => {
  it("keeps the decided row when a later look answers `none` for the same run", async () => {
    holdStateMock.mockImplementation(async () => CONFIRMED);
    await mountCard("run-3007-settled");
    await waitFor(() => {
      expect(document.querySelectorAll(`${CARD_ROOT}${CARD_HOST_CHAT}${CARD_DECIDED}`)).toHaveLength(
        1,
      );
    });
    expect(screen.getByText("Skill A")).toBeTruthy();

    // The stumbled read: every unreadable run and every unreadable park collapses
    // to the SAME word the honest empty answer uses.
    holdStateMock.mockImplementation(async () => ({ state: "none" }));
    const looksBefore = holdStateMock.mock.calls.length;
    await wakeAndSettle();

    // THE EMPTY ANSWER WAS ACTUALLY DELIVERED. Without this the assertion below
    // would also pass for a reader that never woke at all, which is a different
    // card and a different bug.
    expect(
      holdStateMock.mock.calls.length,
      "the wake really did ask the authority again",
    ).toBeGreaterThan(looksBefore);
    expect(
      document.querySelectorAll(`${CARD_ROOT}${CARD_HOST_CHAT}${CARD_DECIDED}`),
      "the decided card is still in the transcript after an empty answer",
    ).toHaveLength(1);
  });

  it("keeps the HELD row too — a park is not withdrawn by an unreadable look", async () => {
    holdStateMock.mockImplementation(async () => HELD);
    await mountCard("run-3007-held");
    await waitFor(() => {
      expect(document.querySelectorAll(`${CARD_ROOT}${CARD_HOST_CHAT}${CARD_HELD}`)).toHaveLength(1);
    });

    holdStateMock.mockImplementation(async () => ({ state: "none" }));
    const looksBefore = holdStateMock.mock.calls.length;
    await wakeAndSettle();

    expect(
      holdStateMock.mock.calls.length,
      "the wake really did ask the authority again",
    ).toBeGreaterThan(looksBefore);
    expect(
      document.querySelectorAll(`${CARD_ROOT}${CARD_HOST_CHAT}${CARD_HELD}`),
      "a run the authority said was parked keeps its card",
    ).toHaveLength(1);
  });

  it("BELIEVES the empty answer once the run's whole failure budget is spent", async () => {
    // The other half of the rule, and the reason it is a delay rather than a
    // veto: a run really can lose its hold — the reader can lose access to it,
    // and a park can be released carrying neither a selection nor a skip. The
    // card must disbelieve the empty answer only while the retry chain is still
    // asking, and then take the row down.
    vi.useFakeTimers();
    holdStateMock.mockImplementation(async () => CONFIRMED);
    await mountCard("run-3007-really-withdrawn");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(
      document.querySelectorAll(`${CARD_ROOT}${CARD_HOST_CHAT}${CARD_DECIDED}`),
      "the decided row is on screen before the withdrawal",
    ).toHaveLength(1);

    holdStateMock.mockImplementation(async () => ({ state: "none" }));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(0);
    });
    // Still there while the budget is being spent — the retry chain is asking.
    expect(
      document.querySelectorAll(`${CARD_ROOT}${CARD_HOST_CHAT}${CARD_DECIDED}`),
      "the row is held while the chain is still asking",
    ).toHaveLength(1);

    // Run the chain out: 400ms, 1.5s, 4s.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400 + 1_500 + 4_000 + 10);
    });

    expect(
      document.querySelectorAll(CARD_ROOT),
      "a `none` that outlives the failure budget is an answer, and the row goes",
    ).toHaveLength(0);
  });

  it("lets a FRESH card's own first look overrule an answer it only INHERITED", async () => {
    // THE OTHER EDGE OF THE KEPT ANSWER. The answer is kept so a card that was
    // torn down and rebuilt while a slow read was on the wire does not blank a
    // row somebody is reading. It is NOT a second authority: a rebuilt card that
    // has never been told anything itself must yield to the FIRST answer it gets,
    // including an empty one — the reader may have changed, the run may have been
    // released, and this card has no reading of its own to weigh against it.
    //
    // The withheld-empty rule therefore covers only an answer this instance filed
    // ITSELF; an inherited one is a seed, not a verdict.
    holdStateMock.mockImplementation(async () => CONFIRMED);
    await mountCard("run-3007-inherited");
    await waitFor(() => {
      expect(document.querySelectorAll(`${CARD_ROOT}${CARD_HOST_CHAT}${CARD_DECIDED}`)).toHaveLength(
        1,
      );
    });
    cleanup();

    // A FRESH card for the same run, in a document that answers `none` — the
    // reader is not the one the remembered answer was issued to.
    holdStateMock.mockImplementation(async () => ({ state: "none" }));
    const { container } = await mountCard("run-3007-inherited");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      container.querySelectorAll(CARD_ROOT),
      "the inherited row goes as soon as this card's own look answers",
    ).toHaveLength(0);
  });

  it("still draws nothing when the FIRST answer is `none` — a run that was never held", async () => {
    holdStateMock.mockImplementation(async () => ({ state: "none" }));
    const { container } = await mountCard("run-3007-never-held");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      container.querySelectorAll(CARD_ROOT),
      "no hold, no card — the fail-closed posture is unchanged",
    ).toHaveLength(0);
  });
});
