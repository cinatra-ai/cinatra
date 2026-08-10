// @vitest-environment jsdom
/**
 * `RecommendationHoldCard` — the ONE card for `recommendation_hold`, and the
 * proof that the 4-second poll is gone (cinatra#2568 AC-1 + AC-5, epic #2564).
 *
 * WHAT #2568 ORDERED, AND WHAT THIS PINS. The issue's deliverable put the poll
 * retirement LAST — "the 4s poll is retired LAST, after replay + routing exist"
 * — and its AC-1 ends with "the poll code path is deleted", AC-5 with "the
 * interaction renders via the one-card registry (no parallel chip-row mount
 * remains)". Both landed together, because they are the same change: the row
 * stops being a hand-rolled interval beside the panel and becomes a card whose
 * only inputs are the wire, the reader's focus and its own decision.
 *
 * The suite locks five things:
 *
 *   1. NO STEADY-STATE TIMER. After a SUCCESSFUL resolve, twenty seconds of fake
 *      time produce no second read. The old code would have issued five.
 *   2. THE WIRE IS THE TRIGGER. A change in the typed hold interrupt's ref — an
 *      announcement, and its paired RESUME nulling it — re-reads the authority.
 *      That is what makes a re-parked run visible without a poll.
 *   3. A FAILED RESOLVE IS RETRIED, BOUNDED. The one case the wire cannot
 *      recover on its own — a hold announcement whose resolve 500s on a tab that
 *      stays visible, focused and online — heals without user interaction, and a
 *      backend that is genuinely down is asked four times and then left alone.
 *      (Codex round 2 found exactly this scenario; these tests are its answer.)
 *   4. FAIL-CLOSED HOST GATING. With no `LifecycleCardSurfaceProvider` there is
 *      no host, so there is no card DOM and no resolve at all.
 *   5. THE ROW ITSELF IS UNCHANGED. The card composes the shipped
 *      `RunRecommendationChipRow`; the held/confirmed/skipped drawings are the
 *      ones that already shipped.
 *
 * Plus source assertions that no second chip-row mount and no repeating timer
 * survived on the hosts the riders touched — the "no parallel mount" half of
 * AC-5 is a structural claim, so it is checked structurally.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/recommendation-hold-card.test.tsx
 */
import React from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
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

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: routerRefresh }),
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

const holdStateMock = vi.fn(async (input: { runId: string }): Promise<HoldState> => {
  void input;
  return { state: "none" };
});
const confirmMock = vi.fn(async () => ({ ok: true, dispatched: true }));
const skipMock = vi.fn(async () => ({ ok: true, dispatched: true }));

vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: (input: { runId: string }) => holdStateMock(input),
  confirmRunRecommendationAction: () => confirmMock(),
  skipRunRecommendationAction: () => skipMock(),
}));

// The chip-row fetches candidates from `./server-actions` when they are not
// prefetched. That module's graph is server-only; the row's own behaviour is not
// under test here (it shipped with cinatra#2067), so the one function the row
// calls is stubbed.
vi.mock("../server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

beforeEach(() => {
  holdStateMock.mockImplementation(async () => ({ state: "none" }));
});

const HELD: HoldState = {
  state: "held",
  agentPackageName: "@cinatra-test/hold-fixture-agent",
  promptText: "{}",
  recommendations: [
    { skillId: "skill-a", skillRevisionId: "rev-a", recommended: true, name: "Skill A" },
  ],
  holdRef: "hold-ref-1",
};

async function mountCard(props: {
  wireRef?: string | null;
  host?: "run_card" | "chat_thread" | "site_widget" | "page_gate_region" | null;
}) {
  const { RecommendationHoldCard } = await import("../run-recommendation-chip-row");
  const { LifecycleCardSurfaceProvider } = await import("../lifecycle-card-runtime");
  const card = (
    <RecommendationHoldCard
      runId="run-2568"
      agentPackageName="@cinatra-test/hold-fixture-agent"
      wireRef={props.wireRef ?? null}
    />
  );
  const host = props.host === undefined ? "run_card" : props.host;
  return render(
    host === null ? (
      card
    ) : (
      <LifecycleCardSurfaceProvider host={host}>{card}</LifecycleCardSurfaceProvider>
    ),
  );
}

describe("RecommendationHoldCard — the poll is gone (cinatra#2568 AC-1)", () => {
  it("resolves ONCE and never again on a timer — 20 seconds produce no second read", async () => {
    holdStateMock.mockImplementation(async () => HELD);
    vi.useFakeTimers({ shouldAdvanceTime: true });

    await mountCard({ wireRef: "hold-ref-1" });
    await waitFor(() =>
      expect(document.querySelector("[data-run-recommendation-chip-row]")).not.toBeNull(),
    );
    const afterMount = holdStateMock.mock.calls.length;

    // Five old poll intervals' worth of time.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });

    expect(holdStateMock.mock.calls.length).toBe(afterMount);
  });

  it("re-reads the authority when the typed hold interrupt's ref changes", async () => {
    holdStateMock.mockImplementation(async () => HELD);
    const { rerender } = await mountCard({ wireRef: null });
    await waitFor(() => expect(holdStateMock).toHaveBeenCalled());
    const afterMount = holdStateMock.mock.calls.length;

    const { RecommendationHoldCard } = await import("../run-recommendation-chip-row");
    const { LifecycleCardSurfaceProvider } = await import("../lifecycle-card-runtime");
    rerender(
      <LifecycleCardSurfaceProvider host="run_card">
        <RecommendationHoldCard
          runId="run-2568"
          agentPackageName="@cinatra-test/hold-fixture-agent"
          wireRef="hold-ref-1"
        />
      </LifecycleCardSurfaceProvider>,
    );

    await waitFor(() =>
      expect(holdStateMock.mock.calls.length).toBeGreaterThan(afterMount),
    );
  });

  it("re-reads when the RESUME retires the hold (the ref goes back to null)", async () => {
    holdStateMock.mockImplementation(async () => HELD);
    const { rerender } = await mountCard({ wireRef: "hold-ref-1" });
    await waitFor(() =>
      expect(document.querySelector("[data-run-recommendation-chip-row]")).not.toBeNull(),
    );
    const afterMount = holdStateMock.mock.calls.length;

    holdStateMock.mockImplementation(async () => ({
      state: "confirmed",
      skillNames: ["Skill A"],
    }));
    const { RecommendationHoldCard } = await import("../run-recommendation-chip-row");
    const { LifecycleCardSurfaceProvider } = await import("../lifecycle-card-runtime");
    rerender(
      <LifecycleCardSurfaceProvider host="run_card">
        <RecommendationHoldCard
          runId="run-2568"
          agentPackageName="@cinatra-test/hold-fixture-agent"
          wireRef={null}
        />
      </LifecycleCardSurfaceProvider>,
    );

    await waitFor(() =>
      expect(holdStateMock.mock.calls.length).toBeGreaterThan(afterMount),
    );
    await waitFor(() =>
      expect(
        document.querySelector('[data-run-recommendation-decision="confirmed"]'),
      ).not.toBeNull(),
    );
  });
});

describe("RecommendationHoldCard — a failed resolve is retried, a successful one is not", () => {
  it("recovers a transiently-failed wire resolve with NO user interaction (codex round 2)", async () => {
    // The exact blocking scenario: the card has authoritatively resolved
    // `none`, a hold is created, its ref lands, THAT resolve 500s, the stream
    // stays healthy and says nothing more, and the reader never leaves the tab.
    // Without the failure budget the run sits parked behind a card that draws
    // nothing, forever.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    holdStateMock.mockImplementation(async () => ({ state: "none" }));
    const { rerender } = await mountCard({ wireRef: null });
    await waitFor(() => expect(holdStateMock).toHaveBeenCalled());

    holdStateMock.mockImplementationOnce(async () => {
      throw new Error("500");
    });
    holdStateMock.mockImplementation(async () => HELD);

    const { RecommendationHoldCard } = await import("../run-recommendation-chip-row");
    const { LifecycleCardSurfaceProvider } = await import("../lifecycle-card-runtime");
    rerender(
      <LifecycleCardSurfaceProvider host="run_card">
        <RecommendationHoldCard
          runId="run-2568"
          agentPackageName="@cinatra-test/hold-fixture-agent"
          wireRef="hold-ref-1"
        />
      </LifecycleCardSurfaceProvider>,
    );

    // No focus, no visibility change, no connectivity event — only time.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await waitFor(() =>
      expect(document.querySelector("[data-run-recommendation-chip-row]")).not.toBeNull(),
    );
  });

  it("recovers the mirror case: a failed RESUME resolve stops showing a decided row as pending", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    holdStateMock.mockImplementation(async () => HELD);
    const { rerender } = await mountCard({ wireRef: "hold-ref-1" });
    await waitFor(() =>
      expect(document.querySelector("[data-run-recommendation-chip-row]")).not.toBeNull(),
    );

    holdStateMock.mockImplementationOnce(async () => {
      throw new Error("500");
    });
    holdStateMock.mockImplementation(async () => ({
      state: "confirmed",
      skillNames: ["Skill A"],
    }));

    const { RecommendationHoldCard } = await import("../run-recommendation-chip-row");
    const { LifecycleCardSurfaceProvider } = await import("../lifecycle-card-runtime");
    rerender(
      <LifecycleCardSurfaceProvider host="run_card">
        <RecommendationHoldCard
          runId="run-2568"
          agentPackageName="@cinatra-test/hold-fixture-agent"
          wireRef={null}
        />
      </LifecycleCardSurfaceProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await waitFor(() =>
      expect(
        document.querySelector('[data-run-recommendation-decision="confirmed"]'),
      ).not.toBeNull(),
    );
  });

  it("stops after a BOUNDED number of failures — a down backend is not hammered", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    holdStateMock.mockImplementation(async () => {
      throw new Error("down");
    });
    await mountCard({ wireRef: "hold-ref-1" });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    // One initial attempt + the three-step failure budget, then silence — never
    // the unbounded 4-second re-ask this replaced (which would be ~30 calls).
    expect(holdStateMock.mock.calls.length).toBe(4);
  });
});

describe("RecommendationHoldCard — a failed resolve is recovered by events, not by a timer", () => {
  it("draws nothing when the FIRST resolve fails, then recovers on focus", async () => {
    holdStateMock.mockImplementationOnce(async () => {
      throw new Error("offline");
    });
    holdStateMock.mockImplementation(async () => HELD);

    const { container } = await mountCard({ wireRef: "hold-ref-1" });
    await waitFor(() => expect(holdStateMock).toHaveBeenCalled());
    // A failed resolve is never turned into a state — silent, never optimistic.
    expect(container.innerHTML).toBe("");

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() =>
      expect(document.querySelector("[data-run-recommendation-chip-row]")).not.toBeNull(),
    );
  });

  it("recovers on `online` — the dominant cause of a swallowed resolve", async () => {
    holdStateMock.mockImplementationOnce(async () => {
      throw new Error("offline");
    });
    holdStateMock.mockImplementation(async () => HELD);

    await mountCard({ wireRef: "hold-ref-1" });
    await waitFor(() => expect(holdStateMock).toHaveBeenCalled());

    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() =>
      expect(document.querySelector("[data-run-recommendation-chip-row]")).not.toBeNull(),
    );
  });

  it("does not re-resolve for a visibilitychange that HIDES the tab", async () => {
    holdStateMock.mockImplementation(async () => HELD);
    await mountCard({ wireRef: "hold-ref-1" });
    await waitFor(() => expect(holdStateMock).toHaveBeenCalled());
    const afterMount = holdStateMock.mock.calls.length;

    const spy = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(holdStateMock.mock.calls.length).toBe(afterMount);

    spy.mockReturnValue("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() =>
      expect(holdStateMock.mock.calls.length).toBeGreaterThan(afterMount),
    );
    spy.mockRestore();
  });
});

describe("RecommendationHoldCard — host gating and the drawn states (AC-5)", () => {
  it("renders NO DOM and issues NO resolve without a declared host", async () => {
    holdStateMock.mockImplementation(async () => HELD);
    const { container } = await mountCard({ wireRef: "hold-ref-1", host: null });
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.innerHTML).toBe("");
    expect(holdStateMock).not.toHaveBeenCalled();
  });

  it("renders NO DOM on a host §IX withholds this kind from (the site widget)", async () => {
    holdStateMock.mockImplementation(async () => HELD);
    const { container } = await mountCard({ wireRef: "hold-ref-1", host: "site_widget" });
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.innerHTML).toBe("");
    expect(holdStateMock).not.toHaveBeenCalled();
  });

  it("draws nothing before the first authorized resolve answers", async () => {
    let release: (value: HoldState) => void = () => undefined;
    holdStateMock.mockImplementation(
      () => new Promise<HoldState>((resolve) => (release = resolve)),
    );
    const { container } = await mountCard({ wireRef: "hold-ref-1" });
    expect(container.innerHTML).toBe("");
    await act(async () => {
      release(HELD);
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(document.querySelector("[data-run-recommendation-chip-row]")).not.toBeNull(),
    );
  });

  it("draws the shipped chip-row for a held run and the shipped summaries for a decided one", async () => {
    holdStateMock.mockImplementation(async () => HELD);
    const { unmount } = await mountCard({ wireRef: "hold-ref-1" });
    await waitFor(() =>
      expect(screen.queryByText(/confirm the skills for this run/i)).not.toBeNull(),
    );
    unmount();
    cleanup();

    holdStateMock.mockImplementation(async () => ({ state: "skipped" }));
    await mountCard({ wireRef: null });
    await waitFor(() =>
      expect(
        document.querySelector('[data-run-recommendation-decision="skipped"]'),
      ).not.toBeNull(),
    );
  });

  it("draws nothing at all for a run that was never held", async () => {
    holdStateMock.mockImplementation(async () => ({ state: "none" }));
    const { container } = await mountCard({ wireRef: null });
    await waitFor(() => expect(holdStateMock).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Structural assertions — "the poll code path is DELETED", "no parallel mount"
// ---------------------------------------------------------------------------
//
// AC-1 and AC-5 are claims about what no longer EXISTS, so they are checked by
// reading the hosts. The repo's established pattern for exactly this is the
// review-surface conformance suite and the S2 card suite's host half.

describe("the retired poll leaves nothing behind on the hosts (AC-1 / AC-5)", () => {
  const read = (file: string) =>
    readFileSync(path.join(__dirname, "..", file), "utf8");

  it("the run panel has no interval and no direct chip-row mount", () => {
    const panel = read("agentic-run-panel.tsx");
    expect(panel).not.toMatch(/setInterval\s*\(\s*fetchState/);
    expect(panel).not.toMatch(/getRunRecommendationHoldStateAction/);
    expect(panel).not.toMatch(/<RunRecommendationChipRow/);
    // The one mount that remains is the card, on the declared host.
    expect(panel).toMatch(/<RecommendationHoldCard/);
    expect(panel).toMatch(/host="run_card"/);
  });

  it("the stepper's dev-preview row has no interval and no direct chip-row mount", () => {
    const stepper = read("orchestrator-stepper-panel.tsx");
    expect(stepper).not.toMatch(/setInterval\s*\(\s*fetchState/);
    expect(stepper).not.toMatch(/getRunRecommendationHoldStateAction/);
    expect(stepper).not.toMatch(/<RunRecommendationChipRow/);
    expect(stepper).toMatch(/<RecommendationHoldCard/);
  });

  it("the card has no repeating timer — the retired poll cannot come back through it", () => {
    const card = read("run-recommendation-chip-row.tsx");
    // The behavioural half of this invariant ("a successful resolve schedules
    // nothing") is the fake-timer test at the top of this file. This half bans
    // the primitive a poll would be rebuilt from: the only timer in the file is
    // the bounded FAILURE budget, which `setInterval` could never express.
    expect(card).not.toMatch(/setInterval/);
    expect([...card.matchAll(/setTimeout\(/g)]).toHaveLength(1);
  });
});
