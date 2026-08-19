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
      canDecide?: boolean;
    }
  | { state: "confirmed"; skillNames: string[]; decided?: DecidedSkill[] }
  | { state: "skipped"; decided?: DecidedSkill[] };

type DecidedSkill = { skillId: string; mark: "confirmed" | "adjusted" | "skipped" };

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
  /** The host's credential declaration, when it has one (cinatra#2577). */
  auth?: { headers: () => Record<string, string>; credentials: RequestCredentials };
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
      <LifecycleCardSurfaceProvider host={host} auth={props.auth}>
        {card}
      </LifecycleCardSurfaceProvider>
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

  it("draws nothing on a host that declares a CREDENTIAL — its actions cannot carry one", async () => {
    // codex round 0, finding 4. This card's state read and its Confirm/Skip are
    // cookie-bound server actions. On a broker surface (same-origin to the app)
    // a drawn card would read and act as whoever else is signed in on that
    // browser — the ambient-session fallback the contract forbids. Fail closed
    // until the broker-aware entry lands; the guard keys on the CREDENTIAL, not
    // on the surface, so it disappears with that slice rather than with a matrix.
    holdStateMock.mockImplementation(async () => HELD);
    const { container } = await mountCard({
      wireRef: "hold-ref-1",
      host: "site_widget",
      auth: { headers: () => ({ "X-Cinatra-Widget-User-Token": "cwu_x" }), credentials: "omit" },
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.innerHTML).toBe("");
    expect(holdStateMock).not.toHaveBeenCalled();
  });

  it("draws IDENTICALLY on every cookie host — the per-surface matrix is gone", async () => {
    // The removed rule said "a widget visitor never shapes a run's skills", and
    // it made this kind FALSE on `site_widget` in a presence table. The table is
    // gone: what a host draws is no longer a property of which host it is. The
    // widget's own remaining gate is the credential guard above, not a matrix.
    holdStateMock.mockImplementation(async () => HELD);
    const widget = await mountCard({ wireRef: "hold-ref-1", host: "page_gate_region" });
    await act(async () => {
      await Promise.resolve();
    });
    expect(holdStateMock).toHaveBeenCalled();
    // React mints a fresh `useId` per mount, so the two renders differ in their
    // generated ARIA ids and in nothing else. Normalising them is what makes
    // "the same drawing" a byte comparison instead of a spot check.
    const stripGeneratedIds = (html: string) =>
      html.replaceAll(/radix-_r_[0-9a-z]+_/g, "radix-_r_ID_");
    const widgetHtml = stripGeneratedIds(widget.container.innerHTML);
    expect(widgetHtml).not.toBe("");
    // REDRAWN (cinatra#2841): the decision affordances are PER CHIP now — the
    // row-level pair this used to name does not exist on any host.
    expect(widgetHtml).toContain('data-action="confirm-skill -> confirmed"');
    expect(widgetHtml).toContain('data-action="adjust-skill -> adjusted"');
    expect(widgetHtml).toContain('data-action="skip-skill -> skipped"');
    expect(widgetHtml).not.toContain("confirm-run-recommendation");
    expect(widgetHtml).not.toContain("skip-run-recommendation");

    cleanup();
    holdStateMock.mockClear();
    const chat = await mountCard({ wireRef: "hold-ref-1", host: "chat_thread" });
    await act(async () => {
      await Promise.resolve();
    });
    expect(stripGeneratedIds(chat.container.innerHTML)).toBe(widgetHtml);
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

  it("draws the redrawn chip-row for a held run and the settled row for a decided one", async () => {
    // The old assertion named the heading plate ("Confirm the skills for this
    // run"). That heading is not drawn any more (§V: "the row is the whole
    // card"), so the assertion is replaced by the thing that IS drawn — a chip
    // carrying its own three affordances — rather than deleted.
    holdStateMock.mockImplementation(async () => HELD);
    const { unmount } = await mountCard({ wireRef: "hold-ref-1" });
    await waitFor(() =>
      expect(document.querySelectorAll("[data-recommendation-chip]")).toHaveLength(1),
    );
    expect(screen.queryByText(/confirm the skills for this run/i)).toBeNull();
    unmount();
    cleanup();

    holdStateMock.mockImplementation(async () => ({
      state: "skipped",
      decided: [{ skillId: "skill-a", mark: "skipped" }],
    }));
    await mountCard({ wireRef: null });
    await waitFor(() =>
      expect(
        document.querySelector('[data-run-recommendation-decision="skipped"]'),
      ).not.toBeNull(),
    );
    expect(
      document.querySelector('[data-recommendation-chip][data-chip-mark="skipped"]'),
    ).not.toBeNull();
  });

  it("draws nothing at all for a run that was never held", async () => {
    holdStateMock.mockImplementation(async () => ({ state: "none" }));
    const { container } = await mountCard({ wireRef: null });
    await waitFor(() => expect(holdStateMock).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });
});

// ---------------------------------------------------------------------------
// THE RATIFIED §V DRAWING (cinatra#2841)
// ---------------------------------------------------------------------------
//
// design `specs/app-lifecycle-cards.html` §V at design commit 60b27dfbb8a2:
//
//   "one chip per skill, each carrying its own Confirm, Adjust and Skip";
//   "THE ROW IS THE WHOLE CARD. There is no heading plate above it and no
//    row-level submit beneath it … A skill is settled by pressing one of ITS
//    OWN three affordances, and each chip then shows what it recorded."
//
// Both halves are asserted: what §V draws must render, and what it does NOT
// draw must be absent. The absence half is written as an EXPLICIT negative,
// because "the heading is gone" is the whole point of the redraw and a suite
// that only checks the new chips would pass with the old plate still on screen.
// The last test in the block is the negative control for those negatives.

const THREE_SKILLS = [
  { skillId: "skill-enrich", skillRevisionId: "rev-1", recommended: true, name: "Enrich contacts" },
  { skillId: "skill-draft", skillRevisionId: "rev-2", recommended: true, name: "Draft email" },
  { skillId: "skill-send", skillRevisionId: "rev-3", recommended: true, name: "Schedule send" },
];

const HELD_THREE: HoldState = {
  state: "held",
  agentPackageName: "@cinatra-test/hold-fixture-agent",
  promptText: "{}",
  recommendations: THREE_SKILLS,
  holdRef: "hold-ref-3",
  canDecide: true,
};

const chips = () => [...document.querySelectorAll("[data-recommendation-chip]")];
const chipFor = (skillId: string) =>
  document.querySelector(`[data-recommendation-chip][data-skill-id="${skillId}"]`);
const press = async (skillId: string, action: "confirm" | "adjust" | "skip") => {
  const btn = document.querySelector(
    `[data-skill-action="${action}"][data-skill-id="${skillId}"]`,
  ) as HTMLButtonElement | null;
  if (!btn) throw new Error(`no ${action} affordance on ${skillId}`);
  await act(async () => {
    btn.click();
    await Promise.resolve();
  });
};

describe("§V — one chip per skill, each with its own Confirm / Adjust / Skip", () => {
  it("draws ONE chip per offered skill, and each chip carries all three affordances", async () => {
    holdStateMock.mockImplementation(async () => HELD_THREE);
    await mountCard({ wireRef: "hold-ref-3" });
    await waitFor(() => expect(chips()).toHaveLength(3));

    for (const skill of THREE_SKILLS) {
      const chip = chipFor(skill.skillId);
      expect(chip).not.toBeNull();
      expect(chip!.textContent).toContain(skill.name);
      // Its OWN three, scoped to the chip — not three shared by the row.
      expect(chip!.querySelector('[data-skill-action="confirm"]')).not.toBeNull();
      expect(chip!.querySelector('[data-skill-action="adjust"]')).not.toBeNull();
      expect(chip!.querySelector('[data-skill-action="skip"]')).not.toBeNull();
      expect(chip!.getAttribute("data-chip-mark")).toBe("undecided");
    }
    // Three chips × three affordances, and nothing else that presses.
    expect(document.querySelectorAll("[data-skill-action]")).toHaveLength(9);
  });

  it("draws NO heading plate — nothing states the question a second time", async () => {
    holdStateMock.mockImplementation(async () => HELD_THREE);
    await mountCard({ wireRef: "hold-ref-3" });
    await waitFor(() => expect(chips()).toHaveLength(3));

    expect(screen.queryByText(/confirm the skills for this run/i)).toBeNull();
    expect(screen.queryByText(/recommended for your request/i)).toBeNull();
    expect(screen.queryByText(/adjust the selection, then confirm/i)).toBeNull();
    // …and no collapsible "Skills (n/m)" selector plate either.
    expect(screen.queryByText(/^Skills \(\d+\/\d+\)$/)).toBeNull();
  });

  it("draws NO card-level submit — nothing decides every skill at once", async () => {
    holdStateMock.mockImplementation(async () => HELD_THREE);
    const { container } = await mountCard({ wireRef: "hold-ref-3" });
    await waitFor(() => expect(chips()).toHaveLength(3));

    expect(container.querySelector('[data-action="confirm-run-recommendation"]')).toBeNull();
    expect(container.querySelector('[data-action="skip-run-recommendation"]')).toBeNull();
    // Structural form of the same claim: every button on the card belongs to a
    // chip. A row-level pair would be a button with no chip ancestor.
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) {
      expect(b.closest("[data-recommendation-chip]")).not.toBeNull();
    }
  });

  it("records each chip's OWN mark and releases only once EVERY chip is decided", async () => {
    holdStateMock.mockImplementation(async () => HELD_THREE);
    await mountCard({ wireRef: "hold-ref-3" });
    await waitFor(() => expect(chips()).toHaveLength(3));

    await press("skill-enrich", "confirm");
    expect(chipFor("skill-enrich")!.getAttribute("data-chip-mark")).toBe("confirmed");
    // Two chips are still undecided — the run is NOT released.
    expect(confirmMock).not.toHaveBeenCalled();
    expect(skipMock).not.toHaveBeenCalled();

    await press("skill-draft", "skip");
    expect(chipFor("skill-draft")!.getAttribute("data-chip-mark")).toBe("skipped");
    expect(confirmMock).not.toHaveBeenCalled();

    await press("skill-send", "confirm");
    expect(chipFor("skill-send")!.getAttribute("data-chip-mark")).toBe("confirmed");
    // The last chip completes the row, and the whole-row release fires ONCE
    // (the named store deviation — the hold has no partial-decision record).
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(skipMock).not.toHaveBeenCalled();
  });

  it("a row whose every chip was SKIPPED releases through the skip path, not an empty confirm", async () => {
    // An empty confirmed selection writes no selection row at all, which reads
    // back as NO decision — so "the reader kept nothing" is recorded as the
    // hold's skip evidence, which is exactly what it means.
    holdStateMock.mockImplementation(async () => HELD_THREE);
    await mountCard({ wireRef: "hold-ref-3" });
    await waitFor(() => expect(chips()).toHaveLength(3));

    await press("skill-enrich", "skip");
    await press("skill-draft", "skip");
    await press("skill-send", "skip");

    await waitFor(() => expect(skipMock).toHaveBeenCalledTimes(1));
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("ADJUST opens that skill's own panel, and settling it there marks the chip adjusted", async () => {
    holdStateMock.mockImplementation(async () => HELD_THREE);
    await mountCard({ wireRef: "hold-ref-3" });
    await waitFor(() => expect(chips()).toHaveLength(3));

    await press("skill-draft", "adjust");
    // The panel is THIS skill's — it names the skill Adjust was pressed on.
    await waitFor(() =>
      expect(
        document.querySelector('[data-skill-action="adjust-keep"][data-skill-id="skill-draft"]'),
      ).not.toBeNull(),
    );
    const keep = document.querySelector(
      '[data-skill-action="adjust-keep"][data-skill-id="skill-draft"]',
    ) as HTMLButtonElement;
    await act(async () => {
      keep.click();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(chipFor("skill-draft")!.getAttribute("data-chip-mark")).toBe("adjusted"),
    );
    // Adjust decides ONE skill; the other two still hold the row open.
    expect(confirmMock).not.toHaveBeenCalled();
  });
});

describe("§V — the settled and the read-only readings", () => {
  it("SETTLED: one chip per skill, each stating what it recorded, and nothing left to press", async () => {
    holdStateMock.mockImplementation(async () => ({
      state: "confirmed",
      skillNames: ["skill-enrich", "skill-draft"],
      decided: [
        { skillId: "skill-enrich", mark: "confirmed" },
        { skillId: "skill-draft", mark: "adjusted" },
        { skillId: "skill-send", mark: "skipped" },
      ],
    }));
    const { container } = await mountCard({ wireRef: null });
    await waitFor(() => expect(chips()).toHaveLength(3));

    expect(chipFor("skill-enrich")!.getAttribute("data-chip-mark")).toBe("confirmed");
    expect(chipFor("skill-enrich")!.textContent).toContain("Confirmed");
    expect(chipFor("skill-draft")!.getAttribute("data-chip-mark")).toBe("adjusted");
    expect(chipFor("skill-draft")!.textContent).toContain("Adjusted");
    expect(chipFor("skill-send")!.getAttribute("data-chip-mark")).toBe("skipped");
    expect(chipFor("skill-send")!.textContent).toContain("Skipped");

    // "there is nothing left to press", and nothing summarised above the row.
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.querySelectorAll("[data-skill-action]")).toHaveLength(0);
    expect(screen.queryByText(/skills confirmed/i)).toBeNull();
  });

  it("READ-ONLY: every chip keeps its three affordances on screen, DISABLED, over the reason", async () => {
    holdStateMock.mockImplementation(async () => ({ ...HELD_THREE, canDecide: false }));
    const { container } = await mountCard({ wireRef: "hold-ref-3" });
    await waitFor(() => expect(chips()).toHaveLength(3));

    // Drawn, not removed — "the reader sees exactly what is being asked, and
    // that it is not theirs to answer."
    const controls = [...container.querySelectorAll("[data-skill-action]")];
    expect(controls).toHaveLength(9);
    for (const c of controls) expect((c as HTMLButtonElement).disabled).toBe(true);
    for (const chip of chips()) expect(chip.getAttribute("aria-disabled")).toBe("true");
    expect(container.querySelector("[data-run-recommendation-restricted]")?.textContent).toMatch(
      /needs run access on it/i,
    );

    // And a disabled affordance decides nothing.
    await press("skill-enrich", "confirm").catch(() => undefined);
    expect(confirmMock).not.toHaveBeenCalled();
    expect(chipFor("skill-enrich")!.getAttribute("data-chip-mark")).toBe("undecided");
  });

  it("NEGATIVE CONTROL: the absence assertions above can fail — the same queries find what IS drawn", async () => {
    // Every negative in this block is only worth its ink if the query behind it
    // is live. Same query APIs, same DOM, asserted POSITIVELY here: a suite that
    // silently stopped matching anything would go red on this test first.
    holdStateMock.mockImplementation(async () => HELD_THREE);
    const { container } = await mountCard({ wireRef: "hold-ref-3" });
    await waitFor(() => expect(chips()).toHaveLength(3));

    // `queryByText` (used for the absent heading) does find text on this card.
    expect(screen.queryByText("Enrich contacts")).not.toBeNull();
    // `querySelector('[data-action=…]')` (used for the absent row-level submit)
    // does find an action attribute on this card.
    expect(container.querySelector('[data-action="confirm-skill -> confirmed"]')).not.toBeNull();
    // The chip count is read off the fixture, not hardcoded: a four-skill hold
    // draws four chips, so "three" is a measurement rather than a constant.
    cleanup();
    holdStateMock.mockImplementation(async () => ({
      ...HELD_THREE,
      recommendations: [
        ...THREE_SKILLS,
        { skillId: "skill-extra", skillRevisionId: "rev-4", recommended: false, name: "Log outcome" },
      ],
    }));
    await mountCard({ wireRef: "hold-ref-3" });
    await waitFor(() => expect(chips()).toHaveLength(4));
    // …and the non-recommended candidate keeps its shipped marking.
    expect(chipFor("skill-extra")!.getAttribute("data-forced")).toBe("true");
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

  it("the run-detail SCREEN has no parallel read, no prefetch and no direct chip-row mount", () => {
    // THE FOURTH RENDERER (cinatra#2573, epic #2564 D-1; found by the S7
    // acceptance lane). `instance-screens.tsx` ran its own park read, its own
    // actor-scoped candidate prefetch and its own confirmed/skipped derivation,
    // then mounted the row directly — a second implementation of the same
    // interaction on the one surface where the HELD state has no other host (a
    // held run is `pending_input`, and `AgenticRunPanel` renders only above that
    // status). All of it is deleted; what remains is the card under a declared
    // host, so this screen draws the interaction the way every other host does.
    const instanceScreens = read("instance-screens.tsx");
    expect(instanceScreens).not.toMatch(/<RunRecommendationChipRow/);
    expect(instanceScreens).not.toMatch(/getRunRecommendations\b/);
    expect(instanceScreens).not.toMatch(/resolveRecommendationCandidateSkillIds/);
    expect(instanceScreens).not.toMatch(/encodeRecommendationHoldRef/);
    expect(instanceScreens).not.toMatch(/readRunSelectedSkillRevisions/);
    expect(instanceScreens).not.toMatch(/hasRunRecommendationSkip/);
    expect(instanceScreens).not.toMatch(/setInterval/);
    // The one mount that remains is the card, under its own declared host — and
    // it is GATED, so the branch whose panel already declares `run_card` does not
    // draw the row twice (`screenHostsRecommendationCard`, pinned in
    // `instance-screens-recommendation-host.test.ts`).
    expect(instanceScreens).toMatch(/<RecommendationHoldCard/);
    expect(instanceScreens).toMatch(/host="run_card"/);
    expect(instanceScreens).toMatch(
      /screenHostsRecommendationCard\(runDetailPanel\)\s*\?\s*\(\s*<LifecycleCardSurfaceProvider host="run_card">\s*<RecommendationHoldCard/,
    );
    // The park is still read — for ONE thing: the Run button is withheld while a
    // hold is live. That is the run's dispatchability, not a rendering of the
    // interaction, and it is the only surviving use.
    expect([...instanceScreens.matchAll(/readRecommendationParkForRun/g)]).toHaveLength(2);
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
