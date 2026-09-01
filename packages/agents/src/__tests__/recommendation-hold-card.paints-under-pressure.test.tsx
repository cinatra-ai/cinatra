// @vitest-environment jsdom
/**
 * A REBUILT CARD REDRAWS THE ANSWER IT ALREADY HAD (cinatra#3007, fix leg 10).
 *
 * THE FAILURE THIS PINS, MEASURED RATHER THAN IMAGINED. The held-turn gate
 * photographed a settled chat transcript twice, at two different capture points,
 * and both times found the same thing: a card that had just been asserted on its
 * own root was absent from the DOM entirely, with the conversation around it
 * absent too. The trace names the moment — the conversation subtree was torn down
 * and rebuilt, its in-flight reads aborted and re-issued by a fresh mount — and
 * names why the rebuild was visible: the read this card needs had been taking
 * TWELVE SECONDS under load, so a card rebuilt at that instant had nothing to
 * draw and drew nothing.
 *
 * Everything the previous fix taught this card lived in `useState`/`useRef`, and
 * a rebuilt instance inherits none of it. That is correct for a run this browser
 * has never asked about — the render gate is fail-closed and stays that way, and
 * the last arm below pins it. It is wrong for a run this browser has ALREADY had
 * an authoritative answer for: the answer did not stop being true because a
 * component was rebuilt.
 *
 * So the answer outlives the instance, and only the answer does. The read the
 * rebuilt card issues anyway still lands and still replaces what is drawn; what
 * changes is what is on screen in the gap.
 *
 * AND THE OTHER HALF, WHICH THE LANE REPRODUCED UNDER THE SAME PRESSURE: this
 * read takes TWELVE TO THIRTY SECONDS on a contended runtime — measured five
 * times in one flow — and any trigger arriving inside that window superseded the
 * answer that was about to land. The next look was superseded the same way. The
 * card filed nothing across a hundred and eight seconds and never became decided
 * at all. Staleness is a question about ANSWERS, so the arms below drive an
 * overlap deliberately and require the answer that LANDS to be the one on screen.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/recommendation-hold-card.paints-under-pressure.test.tsx
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
  | { state: "confirmed"; skillNames: string[]; decided?: { skillId: string; name: string; mark: "confirmed" }[] }
  | { state: "skipped"; decided?: { skillId: string; name: string; mark: "skipped" }[] };

const holdStateMock = vi.fn(async (input: { runId: string }): Promise<HoldState> => {
  void input;
  return { state: "none" };
});

vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: (input: { runId: string }) => holdStateMock(input),
  confirmRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
  skipRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
}));

vi.mock("../server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
}));

/** A live park, for the ordering arms below. */
const HELD: HoldState = {
  state: "held",
  agentPackageName: "@cinatra-test/hold-fixture-agent",
  promptText: "{}",
  recommendations: [
    { skillId: "skill-a", skillRevisionId: "rev-a", recommended: true, name: "Skill A" },
  ],
  holdRef: "hold-ref-1",
};

/** The SKIPPED settled row — the exact state the gate's failing capture declares. */
const SKIPPED: HoldState = {
  state: "skipped",
  decided: [{ skillId: "skill-a", name: "Skill A", mark: "skipped" }],
};

const CARD_ROOT = '[data-lifecycle-card="recommendation_hold"]';
const CARD_HOST_CHAT = '[data-lifecycle-card-host="chat_thread"]';
const CARD_DECIDED = '[data-lifecycle-card-state="decided"]';
const CARD_HELD = '[data-lifecycle-card-state="held"]';

/** A read that NEVER answers — the twelve-second read, with the clock removed. */
function parkTheRead(): { release: (state: HoldState) => void } {
  let settle: ((state: HoldState) => void) | null = null;
  holdStateMock.mockImplementation(
    () =>
      new Promise<HoldState>((resolve) => {
        settle = resolve;
      }),
  );
  return {
    release(state: HoldState) {
      settle?.(state);
    },
  };
}

async function mountCard(runId: string) {
  const { RecommendationHoldCard } = await import("../run-recommendation-chip-row");
  const { LifecycleCardSurfaceProvider } = await import("../lifecycle-card-runtime");
  return render(
    <LifecycleCardSurfaceProvider host="chat_thread">
      <RecommendationHoldCard runId={runId} wireRef={null} />
    </LifecycleCardSurfaceProvider>,
  );
}

/** Let every already-resolved microtask land, without advancing any clock. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(async () => {
  const mod = await import("../run-recommendation-chip-row");
  mod.forgetAuthorizedRecommendationAnswers();
  holdStateMock.mockImplementation(async () => ({ state: "none" }));
});

afterEach(async () => {
  cleanup();
  const mod = await import("../run-recommendation-chip-row");
  mod.forgetAuthorizedRecommendationAnswers();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("a rebuilt card redraws the answer it already had (cinatra#3007, fix leg 10)", () => {
  it("draws the settled row on the FIRST paint of a rebuilt card, with the read still on the wire", async () => {
    holdStateMock.mockImplementation(async () => SKIPPED);
    const first = await mountCard("run-3007-rebuilt");
    await waitFor(() => {
      expect(
        document.querySelectorAll(`${CARD_ROOT}${CARD_HOST_CHAT}${CARD_DECIDED}`),
      ).toHaveLength(1);
    });
    expect(screen.getByText("Skill A")).toBeTruthy();

    // THE REBUILD. Not a re-render — the instance is destroyed, exactly as the
    // trace shows the conversation subtree being destroyed, and a fresh one is
    // built for the same run while its read is still unanswered.
    first.unmount();
    const parked = parkTheRead();
    const rebuilt = await mountCard("run-3007-rebuilt");
    await flush();

    expect(
      rebuilt.container.querySelectorAll(`${CARD_ROOT}${CARD_HOST_CHAT}${CARD_DECIDED}`),
      "the settled row is in the document before the rebuilt card's own read lands",
    ).toHaveLength(1);
    // The read really is still open — otherwise this arm would be measuring a
    // fast answer rather than the gap the gate photographed.
    expect(holdStateMock.mock.calls.length, "the rebuilt card did ask again").toBeGreaterThan(0);

    // And the answer that eventually lands is still the authority: it replaces
    // what was drawn rather than being ignored.
    await act(async () => {
      parked.release({ state: "none" });
      await Promise.resolve();
    });
  });

  it("still draws NOTHING for a run this browser has never had an answer for", async () => {
    // The fail-closed posture, unchanged. Without this the fix above would be
    // indistinguishable from a card that draws optimistically.
    parkTheRead();
    const { container } = await mountCard("run-3007-never-answered");
    await flush();
    expect(
      container.querySelectorAll(CARD_ROOT),
      "no answer has ever been given for this run, so there is nothing to redraw",
    ).toHaveLength(0);
  });

  it("carries no verdict from ONE run to ANOTHER", async () => {
    holdStateMock.mockImplementation(async () => SKIPPED);
    const first = await mountCard("run-3007-answered-run");
    await waitFor(() => {
      expect(document.querySelectorAll(`${CARD_ROOT}${CARD_DECIDED}`)).toHaveLength(1);
    });
    first.unmount();

    parkTheRead();
    const other = await mountCard("run-3007-different-run");
    await flush();
    expect(
      other.container.querySelectorAll(CARD_ROOT),
      "a different run inherits nothing — the memory is keyed to the run that answered",
    ).toHaveLength(0);
  });
});

describe("an answer that lands is filed, even if a newer look was issued (cinatra#3007, fix leg 10)", () => {
  it("draws the answer the FIRST look returns while a later look is still on the wire", async () => {
    // Look 1 — the mount's own read, parked: this is the twelve-second read.
    let settleFirst: ((state: HoldState) => void) | null = null;
    holdStateMock.mockImplementation(
      () =>
        new Promise<HoldState>((resolve) => {
          settleFirst = resolve;
        }),
    );
    const view = await mountCard("run-3007-overlapping-looks");
    await flush();
    expect(holdStateMock.mock.calls.length, "the mount asked once").toBe(1);

    // Look 2 — a wake while look 1 is still open. This is the RESUME, the
    // decision's own re-read, or the reader coming back: an ordinary trigger,
    // arriving inside a window that is seconds wide under load. It never answers.
    holdStateMock.mockImplementation(() => new Promise<HoldState>(() => {}));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await flush();
    expect(holdStateMock.mock.calls.length, "the wake really did ask again").toBe(2);

    // Look 1 lands. It is older than a look still in flight — and it is the only
    // authorized reading this card has.
    await act(async () => {
      settleFirst?.(SKIPPED);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      view.container.querySelectorAll(`${CARD_ROOT}${CARD_HOST_CHAT}${CARD_DECIDED}`),
      "the answer that landed is on screen rather than dropped on the floor",
    ).toHaveLength(1);
  });

  it("still refuses an answer OLDER than one already on screen", async () => {
    // The staleness rule itself, unchanged: what may never happen is an older
    // answer overwriting a newer one that already landed.
    let settleFirst: ((state: HoldState) => void) | null = null;
    holdStateMock.mockImplementation(
      () =>
        new Promise<HoldState>((resolve) => {
          settleFirst = resolve;
        }),
    );
    const view = await mountCard("run-3007-out-of-order");
    await flush();

    // The newer look answers FIRST, and its answer is drawn.
    holdStateMock.mockImplementation(async () => HELD);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(view.container.querySelectorAll(`${CARD_ROOT}${CARD_HELD}`)).toHaveLength(1);
    });

    // Only now does the OLDER look land, carrying a different answer.
    await act(async () => {
      settleFirst?.(SKIPPED);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      view.container.querySelectorAll(`${CARD_ROOT}${CARD_HELD}`),
      "the newer answer keeps the card — a late older one does not overwrite it",
    ).toHaveLength(1);
    expect(view.container.querySelectorAll(`${CARD_ROOT}${CARD_DECIDED}`)).toHaveLength(0);
  });
});
