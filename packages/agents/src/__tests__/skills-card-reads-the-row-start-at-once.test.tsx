// @vitest-environment jsdom
//
// THE SKILLS CARD READS THE RUN ROW'S START AT ONCE (cinatra#3062).
//
// The ratified drawing, section V:
//
//   "Once the run has started the same pills are drawn with the state their
//    boxes were left in, read-only, and with no Continue"
//   "For as long as the run has not started, a reader who comes back to the
//    Skills step is shown the same pills with the boxes still able to take a
//    change and Continue still beneath them, and may change the selection."
//
// WHAT WAS MEASURED. A picture round answered the Skills step in a
// conversation, let the run really start, and read the card every three
// seconds. The run row carried its start stamp, and the turn's own run-row
// watch had read it, yet the card kept its boxes and its live Continue for a
// further eight to eleven seconds: it waited for its own authority to be asked
// again and to answer, although the start fact was already in the client.
//
// WHAT IS PINNED. On both conversation hosts — `/chat` through the cookie-bound
// server action, the site widget through the broker route under its own
// credential — a card whose LIVE settled answer reads `runStarted: false` is
// handed the run row's reading beside it. The re-asked authority answer is HELD
// BACK at its transport, so nothing but the row reading can move the card:
//
//   · a reading `running` WITH a start stamp draws the read-only reading — every
//     box disabled, no Continue — at the first commit after it;
//   · a reading with NO stamp (queued, pending_input, pending_approval,
//     pending_trigger) keeps the question open: editable, one Continue.
//
// Time is the runner's fake clock, advanced in the tape's order.
//
// Run:
//   cd packages/agents && npx vitest run \
//     src/__tests__/skills-card-reads-the-row-start-at-once.test.tsx
import React from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const holdStateMock = vi.fn();

vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: (...a: unknown[]) => holdStateMock(...a),
  confirmRunRecommendationAction: vi.fn(),
  skipRunRecommendationAction: vi.fn(),
}));
vi.mock("../server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
}));

import {
  LIFECYCLE_RECOMMENDATION_HOLD_PATH,
  LifecycleCardSurfaceProvider,
} from "../lifecycle-card-runtime";
import { RecommendationHoldCard } from "../run-recommendation-chip-row";
import { resetDrawnRecommendationReadings } from "../run-recommendation-reading-register";

const RUN_ID = "run-3062-row-start-at-once";
const PKG = "@cinatra-ai/blog-draft-writer-agent";
const SKILL_ID = "@cinatra-ai/blog-writing-skill:blog-writing";
/** The stamp the round read on the run row once the run had started. */
const STARTED_AT = "2026-09-28T09:24:38.762Z";

/** The all-clear decision as the resolver answers it BEFORE the start. */
function skippedAnswer(runStarted: boolean) {
  return {
    state: "skipped" as const,
    runId: RUN_ID,
    holdRef: "hold-ref-3062-row-start",
    canDecide: true,
    runStarted,
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
}

/** The widget's declaration: its own proof, cookies OMITTED. */
const WIDGET_AUTH = {
  headers: () => ({ "X-Cinatra-Widget-User-Token": "cwu_test" }),
  credentials: "omit" as const,
};

/**
 * THE AUTHORITY, AT ITS TRANSPORT. The first read answers the settled,
 * not-started step at once; every later read is HELD BACK until the arm lands
 * it, so the card can only learn the start from the row reading beside it.
 */
function authority() {
  let reads = 0;
  const heldBack: Array<(answer: unknown) => void> = [];
  const answer = (): Promise<unknown> => {
    reads += 1;
    if (reads === 1) return Promise.resolve(skippedAnswer(false));
    return new Promise((resolve) => heldBack.push(resolve));
  };
  return {
    answer,
    reads: () => reads,
    land: (payload: unknown) => {
      for (const resolve of heldBack.splice(0)) resolve(payload);
    },
  };
}

function installTransport(host: "chat_thread" | "site_widget", auth: ReturnType<typeof authority>) {
  if (host === "chat_thread") {
    holdStateMock.mockImplementation(() => auth.answer());
    return;
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (!headers["X-Cinatra-Widget-User-Token"]) throw new Error(`${url} reached with no proof`);
      if (init?.credentials !== "omit") throw new Error(`${url} was sent with ambient cookies`);
      if (url === LIFECYCLE_RECOMMENDATION_HOLD_PATH) {
        const payload = await auth.answer();
        return { ok: true, json: async () => payload } as unknown as Response;
      }
      throw new Error(`unstubbed path: ${url}`);
    }),
  );
}

const row = (c: HTMLElement) =>
  c.querySelector<HTMLElement>('[data-lifecycle-card="recommendation_hold"]');
const boxes = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLElement>('[role="checkbox"]'));
const continues = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLButtonElement>("[data-skills-step-continue]"));

/** The reading of one commit, as the DOM actually was. */
function reading(c: HTMLElement): string {
  const buttons = continues(c);
  const all = boxes(c);
  return [
    `cards=${c.querySelectorAll('[data-lifecycle-card="recommendation_hold"]').length}`,
    `editable=${row(c)?.getAttribute("data-skills-step-editable") ?? "none"}`,
    `boxes=${all.length}`,
    `boxesDisabled=${all.length > 0 && all.every((b) => b.hasAttribute("disabled"))}`,
    `continues=${buttons.length}`,
    `continueEnabled=${buttons.length === 1 && !buttons[0]!.disabled}`,
  ].join(" ");
}
const OPEN = "cards=1 editable=true boxes=1 boxesDisabled=false continues=1 continueEnabled=true";
const READ_ONLY = "cards=1 editable=false boxes=1 boxesDisabled=true continues=0 continueEnabled=false";

function view(
  host: "chat_thread" | "site_widget",
  runStatus: string,
  runStartedAt: string | null,
) {
  return (
    <LifecycleCardSurfaceProvider
      host={host}
      {...(host === "site_widget" ? { auth: WIDGET_AUTH } : {})}
    >
      <RecommendationHoldCard
        runId={RUN_ID}
        agentPackageName={PKG}
        wireRef={null}
        runStatus={runStatus}
        runStartedAt={runStartedAt}
      />
    </LifecycleCardSurfaceProvider>
  );
}

/** Let the clock move and every answer that is due come home. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  resetDrawnRecommendationReadings();
  holdStateMock.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
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

describe("the skills card reads the run row's start at the first commit after the row reading", () => {
  for (const host of ["chat_thread", "site_widget"] as const) {
    it(`on the ${host} host: a stamped running row draws the read-only reading before the authority answers again`, async () => {
      const auth = authority();
      installTransport(host, auth);

      // The settled step on a run held at its next gate: no stamp.
      const { container, rerender } = render(view(host, "pending_approval", null));
      await advance(10);
      expect(auth.reads()).toBe(1);
      expect(reading(container)).toBe(OPEN);

      // The schedule is answered: the row reads its trigger step, no stamp.
      await advance(3000);
      rerender(view(host, "pending_trigger", null));
      await advance(10);
      expect(reading(container)).toBe(OPEN);
      const readsBeforeTheStart = auth.reads();

      // EVERY COMMIT from the row reading that carries the stamp.
      const frames: string[] = [];
      const observer = new MutationObserver(() => frames.push(reading(container)));
      observer.observe(container, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });

      // The run starts, and the turn's run-row watch reads it: running, stamped.
      await advance(2000);
      rerender(view(host, "running", STARTED_AT));
      // THE FIRST COMMIT AFTER THAT READING.
      expect(reading(container)).toBe(READ_ONLY);
      await act(async () => {
        await Promise.resolve();
      });
      // The authority was asked again, and its answer is still on the wire.
      expect(auth.reads()).toBeGreaterThan(readsBeforeTheStart);
      expect(frames.length).toBeGreaterThan(0);
      expect(frames[0]).toBe(READ_ONLY);

      // The watch keeps reading; the answer is still held back.
      await advance(8000);
      expect(reading(container)).toBe(READ_ONLY);

      // The authority's own answer, when it lands, says the same.
      auth.land(skippedAnswer(true));
      await advance(10);
      observer.disconnect();
      expect(reading(container)).toBe(READ_ONLY);
      expect(frames.filter((f) => f !== READ_ONLY)).toEqual([]);
    });

    it(`on the ${host} host: a row reading with no start stamp keeps the boxes and the one Continue`, async () => {
      const auth = authority();
      installTransport(host, auth);

      const { container, rerender } = render(view(host, "pending_input", null));
      await advance(10);
      expect(reading(container)).toBe(OPEN);

      const frames: string[] = [];
      const observer = new MutationObserver(() => frames.push(reading(container)));
      observer.observe(container, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });

      for (const status of ["queued", "pending_approval", "pending_trigger", "pending_input"]) {
        await advance(3000);
        rerender(view(host, status, null));
        expect(reading(container)).toBe(OPEN);
        await advance(10);
        expect(reading(container)).toBe(OPEN);
      }
      // Every re-ask is still on the wire: only the row readings moved.
      expect(auth.reads()).toBeGreaterThan(1);

      auth.land(skippedAnswer(false));
      await advance(10);
      observer.disconnect();
      expect(reading(container)).toBe(OPEN);
      expect(frames.filter((f) => f !== OPEN)).toEqual([]);
    });
  }
});
