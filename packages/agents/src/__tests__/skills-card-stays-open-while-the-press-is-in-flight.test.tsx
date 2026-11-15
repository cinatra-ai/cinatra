// @vitest-environment jsdom
//
// THE SKILLS CARD STAYS OPEN WHILE THE PRESS IS IN FLIGHT (cinatra#3062).
//
// The ratified drawing, section V:
//
//   "While the question is open the boxes take a change and Continue stands
//    beneath them. Continue does not close the row."
//
// WHAT WAS MEASURED. A picture round pressed the one Continue on the all-clear
// row in a conversation (its only box clear) and read the card three seconds
// later: the row declared itself submitted, every box was disabled and the
// Continue was drawn but inert — for as long as the decision was on the wire,
// which is the whole release and dispatch. That is none of the three readings
// section V draws: the disabled floor beneath disabled boxes belongs to the
// reader who may NOT shape the run, and a run that has started is read-only
// with no Continue at all.
//
// WHAT IS PINNED. Every commit React makes from the press until the decision
// comes home, on both conversation hosts — `/chat` through the cookie-bound
// server actions, the site widget through the broker routes under its own
// credential. In each of them the row reads editable, every box is enabled and
// exactly one Continue stands beneath them, not disabled. The row still
// DECLARES the window (`data-skills-step-submitted` is "true" while the
// decision is on the wire), and a second press inside it is still not a
// second decision.
//
// Run:
//   cd packages/agents && npx vitest run \
//     src/__tests__/skills-card-stays-open-while-the-press-is-in-flight.test.tsx
import React from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

type DecisionResult = { ok: true; dispatched?: boolean } | { ok: false; error: string };

const holdStateMock = vi.fn();
const confirmMock = vi.fn();
const skipMock = vi.fn();

vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: (...a: unknown[]) => holdStateMock(...a),
  confirmRunRecommendationAction: (...a: unknown[]) => confirmMock(...a),
  skipRunRecommendationAction: (...a: unknown[]) => skipMock(...a),
}));
vi.mock("../server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
}));

import {
  LIFECYCLE_RECOMMENDATION_DECIDE_PATH,
  LIFECYCLE_RECOMMENDATION_HOLD_PATH,
  LifecycleCardSurfaceProvider,
} from "../lifecycle-card-runtime";
import { RecommendationHoldCard } from "../run-recommendation-chip-row";
import {
  recallRunStartFact,
  rememberDrawnRecommendationReading,
  rememberRunStartFact,
  resetDrawnRecommendationReadings,
} from "../run-recommendation-reading-register";

const RUN_ID = "run-3062-in-flight";
const PKG = "@cinatra-ai/blog-draft-writer-agent";

/** THE ALL-CLEAR ROW the round pressed: one proposed skill, not recommended,
 *  so its box opens clear and Continue answers "none applied". */
const HELD = {
  state: "held" as const,
  agentPackageName: PKG,
  promptText: "{}",
  holdRef: "hold-ref-3062-in-flight",
  canDecide: true,
  recommendations: [
    {
      skillId: "@cinatra-ai/blog-writing-skill:blog-writing",
      skillRevisionId: "blog-writing@0.2.0",
      name: "Blog writing",
      vendorName: "Cinatra",
      score: 0.2,
      rank: 1,
      recommended: false,
      scoredFeatures: [],
    },
  ],
};

/** The widget's declaration: its own proof, cookies OMITTED. */
const WIDGET_AUTH = {
  headers: () => ({ "X-Cinatra-Widget-User-Token": "cwu_test" }),
  credentials: "omit" as const,
};

/** A decision held on the wire until the arm lands it. */
function deferred() {
  let resolve!: (r: DecisionResult) => void;
  const promise = new Promise<DecisionResult>((r) => {
    resolve = r;
  });
  return { promise, land: (r: DecisionResult) => resolve(r) };
}

/** The broker routes, answered as the shipped ones answer them; the decision
 *  is held until the arm lands it. */
function installBrokerStub(decision: Promise<DecisionResult>) {
  const decisions: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (!headers["X-Cinatra-Widget-User-Token"]) throw new Error(`${url} reached with no proof`);
      if (init?.credentials !== "omit") throw new Error(`${url} was sent with ambient cookies`);
      const answer = (payload: unknown) =>
        ({ ok: true, json: async () => payload }) as unknown as Response;
      if (url === LIFECYCLE_RECOMMENDATION_HOLD_PATH) return answer(HELD);
      if (url === LIFECYCLE_RECOMMENDATION_DECIDE_PATH) {
        decisions.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return answer({ outcome: await decision });
      }
      throw new Error(`unstubbed path: ${url}`);
    }),
  );
  return { decisions: () => decisions.length };
}

const row = (c: HTMLElement) =>
  c.querySelector<HTMLElement>('[data-lifecycle-card="recommendation_hold"]');
const boxes = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLElement>('[role="checkbox"]'));
const continues = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLButtonElement>("[data-skills-step-continue]"));

/** The reading of one commit, as the DOM actually was. */
function reading(c: HTMLElement): string {
  const el = row(c);
  const buttons = continues(c);
  return [
    `cards=${c.querySelectorAll('[data-lifecycle-card="recommendation_hold"]').length}`,
    `editable=${el?.getAttribute("data-skills-step-editable") ?? "none"}`,
    `boxesEnabled=${boxes(c).length > 0 && boxes(c).every((b) => !b.hasAttribute("disabled"))}`,
    `continues=${buttons.length}`,
    `continueEnabled=${buttons.length === 1 && !buttons[0]!.disabled}`,
  ].join(" ");
}
const OPEN = "cards=1 editable=true boxesEnabled=true continues=1 continueEnabled=true";

beforeEach(() => {
  resetDrawnRecommendationReadings();
  holdStateMock.mockReset();
  holdStateMock.mockResolvedValue(HELD);
  confirmMock.mockReset();
  skipMock.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  resetDrawnRecommendationReadings();
});
afterAll(() => {
  vi.doUnmock("next/navigation");
  vi.doUnmock("../run-recommendation-actions");
  vi.doUnmock("../server-actions");
  vi.resetModules();
});

describe("the skills card keeps the question open from the one Continue until the decision comes home", () => {
  for (const host of ["chat_thread", "site_widget"] as const) {
    it(`on the ${host} host: every commit of the in-flight window is editable, with one live Continue`, async () => {
      const decision = deferred();
      const broker = host === "site_widget" ? installBrokerStub(decision.promise) : null;
      skipMock.mockImplementation(() => decision.promise);
      confirmMock.mockImplementation(() => decision.promise);
      const decisionCalls = () =>
        broker ? broker.decisions() : skipMock.mock.calls.length + confirmMock.mock.calls.length;

      const { container } = render(
        <LifecycleCardSurfaceProvider
          host={host}
          {...(host === "site_widget" ? { auth: WIDGET_AUTH } : {})}
        >
          <RecommendationHoldCard runId={RUN_ID} agentPackageName={PKG} wireRef={null} />
        </LifecycleCardSurfaceProvider>,
      );
      await waitFor(() => expect(continues(container)).toHaveLength(1));
      expect(reading(container)).toBe(OPEN);
      // The all-clear row: its one box opens clear.
      expect(boxes(container)[0]!.getAttribute("aria-checked")).toBe("false");

      // EVERY COMMIT from the press until the decision lands.
      const frames: string[] = [];
      const observer = new MutationObserver(() => frames.push(reading(container)));
      observer.observe(container, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });

      fireEvent.click(continues(container)[0]!);
      await waitFor(() => expect(decisionCalls()).toBe(1));

      // IN FLIGHT: the row declares the window it is in…
      await waitFor(() =>
        expect(row(container)!.getAttribute("data-skills-step-submitted")).toBe("true"),
      );
      // …and it is still the open question: the boxes take a change and
      // Continue stands beneath them.
      expect(reading(container)).toBe(OPEN);
      // A second press inside the window is not a second decision.
      fireEvent.click(continues(container)[0]!);
      expect(decisionCalls()).toBe(1);
      // The box takes a change while the first answer is on the wire.
      fireEvent.click(boxes(container)[0]!);
      await waitFor(() =>
        expect(boxes(container)[0]!.getAttribute("aria-checked")).toBe("true"),
      );
      expect(reading(container)).toBe(OPEN);

      // HOME, and the run has not started.
      await act(async () => {
        decision.land({ ok: true, dispatched: false });
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(row(container)!.getAttribute("data-skills-step-submitted")).toBe("false"),
      );
      observer.disconnect();

      // The walk is not vacuous…
      expect(frames.length).toBeGreaterThan(0);
      // …and not one commit of the window closed the row.
      expect(frames.filter((f) => f !== OPEN)).toEqual([]);
      expect(reading(container)).toBe(OPEN);
      expect(decisionCalls()).toBe(1);
    });
  }
});

// THE CONVERGENCE READ ON THIS LEG. Three readings the open window and the
// replay's start fact must keep, each pinned where it can go wrong.
//
// §V: "Once the run is running, the selection is fixed and the row is
// read-only: each pill states in its own box whether that skill was applied to
// the run" — and "`none` withdraws the row and ERASES the memory of it".
const SKILL_ID = "@cinatra-ai/blog-writing-skill:blog-writing";
/** The all-clear decision as the resolver answers it once the run has STARTED:
 *  nothing applied, the one candidate still listed. */
const SKIPPED_STARTED = {
  state: "skipped" as const,
  runId: RUN_ID,
  holdRef: HELD.holdRef,
  canDecide: true,
  runStarted: true,
  decided: [{ skillId: SKILL_ID, name: "Blog writing", mark: "skipped" as const }],
  candidates: [
    {
      skillId: SKILL_ID,
      skillRevisionId: "blog-writing@0.2.0",
      name: "Blog writing",
      vendorName: "Cinatra",
      recommended: false,
    },
  ],
};
const pillApplied = (c: HTMLElement) =>
  c.querySelector<HTMLElement>("[data-skills-step-pill]")?.getAttribute("data-skill-applied") ??
  "none";

describe("the open window never draws an unsent edit, a stale start fact or a refused row's memory", () => {
  it("a run that starts while the press is on the wire is read-only and states the RECORD, never the edit made in flight", async () => {
    const decision = deferred();
    skipMock.mockImplementation(() => decision.promise);
    const view = (runStatus: string) => (
      <LifecycleCardSurfaceProvider host="chat_thread">
        <RecommendationHoldCard runId={RUN_ID} agentPackageName={PKG} wireRef={null} runStatus={runStatus} />
      </LifecycleCardSurfaceProvider>
    );
    const { container, rerender } = render(view("pending_input"));
    await waitFor(() => expect(continues(container)).toHaveLength(1));
    fireEvent.click(continues(container)[0]!);
    await waitFor(() => expect(skipMock).toHaveBeenCalledTimes(1));
    // An edit the run never receives: the box is checked AFTER the press.
    fireEvent.click(boxes(container)[0]!);
    await waitFor(() => expect(pillApplied(container)).toBe("true"));

    // The run starts while the press is still on the wire.
    holdStateMock.mockResolvedValue(SKIPPED_STARTED);
    rerender(view("running"));
    await waitFor(() =>
      expect(row(container)!.getAttribute("data-skills-step-editable")).toBe("false"),
    );
    expect(continues(container)).toHaveLength(0);
    expect(pillApplied(container)).toBe("false");

    await act(async () => {
      decision.land({ ok: true, dispatched: true });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(row(container)!.getAttribute("data-skills-step-submitted")).toBe("false"),
    );
    expect(pillApplied(container)).toBe("false");
    expect(skipMock).toHaveBeenCalledTimes(1);
  });

  it("a replay whose remembered answer saw the start stays read-only even when an older filed row fact says not started", async () => {
    // The resolver had answered started; the turn's row reading filed before it
    // said not started. The re-created turn has not read again yet.
    rememberDrawnRecommendationReading(RUN_ID, SKIPPED_STARTED);
    rememberRunStartFact(RUN_ID, false);
    holdStateMock.mockImplementation(() => new Promise(() => {}));
    const { container } = render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <RecommendationHoldCard runId={RUN_ID} agentPackageName={PKG} wireRef={null} />
      </LifecycleCardSurfaceProvider>,
    );
    expect(row(container)).not.toBeNull();
    expect(row(container)!.getAttribute("data-skills-step-editable")).toBe("false");
    expect(continues(container)).toHaveLength(0);
  });

  it("the authority's none erases the row's start fact, and a later row reading does not file it again", async () => {
    holdStateMock.mockResolvedValue({ state: "none" });
    const view = (runStatus: string, runStartedAt: string | null) => (
      <LifecycleCardSurfaceProvider host="chat_thread">
        <RecommendationHoldCard
          runId={RUN_ID}
          agentPackageName={PKG}
          wireRef={null}
          runStatus={runStatus}
          runStartedAt={runStartedAt}
        />
      </LifecycleCardSurfaceProvider>
    );
    const { container, rerender } = render(view("pending_input", null));
    await waitFor(() => expect(holdStateMock).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    expect(row(container)).toBeNull();
    expect(recallRunStartFact(RUN_ID)).toBeUndefined();
    rerender(view("running", "2026-09-28T00:11:39.000Z"));
    await waitFor(() => expect(holdStateMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    await act(async () => {
      await Promise.resolve();
    });
    expect(row(container)).toBeNull();
    expect(recallRunStartFact(RUN_ID)).toBeUndefined();
  });
});
