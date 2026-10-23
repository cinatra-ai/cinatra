// @vitest-environment jsdom
//
// THE SKILLS CARD'S STARTED READING FOLLOWS THE RUN, NOT THE RELEASE
// (cinatra#3062).
//
// The ratified drawing, §V, at the contract's pin:
//
//   "the run is dispatched and held at that gate, and none of its work steps has
//    run, which is what before the run starts means throughout this section"
//   "Continue does not close the row. For as long as the run has not started, a
//    reader who comes back to the Skills step is shown the same pills with the
//    boxes still able to take a change and Continue still beneath them, and may
//    change the selection."
//   "Once the run is running, the selection is fixed and the row is read-only"
//
// WHAT WAS WRONG. The release answers `{ ok: true, dispatched: true }` when the
// dispatcher ACCEPTED the run — and a dispatched run can stop at the agent's
// next gate before any work step runs (its row still carries no start stamp).
// The card took that answer as the start and drew the started reading — boxes
// read-only, no Continue — until the authority's next reading said the run had
// NOT started and handed the editable reading back. A measured round saw that
// wrong reading stand for about fifteen seconds after the one Continue.
//
// WHAT IS DRIVEN HERE. The real card on both conversation hosts, each through
// its own transport: `/chat` reads and decides through the cookie-bound server
// actions (mocked at the module boundary, as the neighbouring suites mock them),
// the site widget through the broker routes under its own credential (a test
// double of `fetch`). The release answers `dispatched: true`; the authority then
// answers the settled step with `runStarted: false` — the run held at a further
// gate. EVERY commit of the card from the answer to that settled reading is
// sampled, and every sample must be the editable reading with ONE Continue.
//
// Run:
//   cd packages/agents && npx vitest run \
//     src/__tests__/skills-card-started-follows-the-run.test.tsx
import React, { Profiler } from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

type DecisionResult = { ok: true; dispatched: boolean } | { ok: false; error: string };

const holdStateMock = vi.fn();
const confirmMock = vi.fn();
const skipMock = vi.fn();

vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: (input: { runId: string }) => holdStateMock(input),
  confirmRunRecommendationAction: (input: unknown) => confirmMock(input),
  skipRunRecommendationAction: (input: unknown) => skipMock(input),
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
import { resetDrawnRecommendationReadings } from "../run-recommendation-reading-register";

const RUN_ID = "run-3062-started";
const PKG = "@cinatra-ai/blog-draft-writer-agent";
const HOLD_REF = "hold-ref-3062-started";

const HELD = {
  state: "held" as const,
  agentPackageName: PKG,
  promptText: "{}",
  holdRef: HOLD_REF,
  canDecide: true,
  recommendations: [
    {
      skillId: "skill-blog",
      skillRevisionId: "skill-blog@1",
      name: "Blog content",
      vendorName: "Northstar",
      score: 0.9,
      rank: 1,
      recommended: true,
      scoredFeatures: [],
    },
    {
      skillId: "skill-crm",
      skillRevisionId: "skill-crm@3",
      name: "CRM enrichment",
      vendorName: "Northstar",
      score: 0.2,
      rank: 2,
      recommended: false,
      scoredFeatures: [],
    },
  ],
};

/** The settled step as the authority reads it, with the run's own start fact. */
const settled = (runStarted: boolean) => ({
  state: "confirmed" as const,
  skillNames: ["Blog content"],
  holdRef: HOLD_REF,
  canDecide: true,
  runStarted,
  decided: [
    { skillId: "skill-blog", name: "Blog content", mark: "confirmed" as const },
    { skillId: "skill-crm", name: "CRM enrichment", mark: "skipped" as const },
  ],
  candidates: HELD.recommendations.map((r) => ({
    skillId: r.skillId,
    skillRevisionId: r.skillRevisionId,
    name: r.name,
    vendorName: r.vendorName,
    rank: r.rank,
    recommended: r.recommended,
  })),
});

const WIDGET_AUTH = {
  headers: () => ({ "X-Cinatra-Widget-User-Token": "cwu_test" }),
  credentials: "omit" as const,
};

/** A promise whose settlement the arm owns. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * THE AUTHORITY AND THE RELEASE, answered on the host's own transport. Before
 * the press the authority reads the open question; the press is answered when
 * the arm says so; every read after the press waits for the arm to hand over
 * the settled step.
 */
function transport(host: "chat_thread" | "site_widget") {
  const release = deferred<DecisionResult>();
  const settledRead = deferred<Record<string, unknown>>();
  let pressed = false;
  const decisions: unknown[] = [];
  const read = (): Promise<Record<string, unknown>> =>
    pressed ? settledRead.promise : Promise.resolve(HELD);
  const decide = (body: unknown): Promise<DecisionResult> => {
    pressed = true;
    decisions.push(body);
    return release.promise;
  };
  if (host === "chat_thread") {
    holdStateMock.mockImplementation(() => read());
    confirmMock.mockImplementation((input: unknown) => decide(input));
    skipMock.mockImplementation((input: unknown) => decide(input));
  } else {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (!headers["X-Cinatra-Widget-User-Token"]) throw new Error(`${url} sent no widget proof`);
      if (init?.credentials !== "omit") throw new Error(`${url} sent ambient cookies`);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const answer = (payload: unknown) =>
        ({ ok: true, json: async () => payload }) as unknown as Response;
      if (url === LIFECYCLE_RECOMMENDATION_HOLD_PATH) return answer(await read());
      if (url === LIFECYCLE_RECOMMENDATION_DECIDE_PATH) {
        return answer({ outcome: await decide(body) });
      }
      throw new Error(`unstubbed path: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  }
  return { release, settledRead, decisions };
}

/** One reading of the card, taken on a commit. */
type Sample = { editable: string | null; continues: number; state: string | null };

function readCard(): Sample {
  const row = document.body.querySelector<HTMLElement>(
    '[data-lifecycle-card="recommendation_hold"]',
  );
  return {
    editable: row?.getAttribute("data-skills-step-editable") ?? null,
    continues: document.body.querySelectorAll("[data-skills-step-continue]").length,
    state: row?.getAttribute("data-lifecycle-card-state") ?? null,
  };
}

function mount(host: "chat_thread" | "site_widget", onCommit: () => void) {
  return render(
    <Profiler id="skills-card" onRender={onCommit}>
      <LifecycleCardSurfaceProvider
        host={host}
        {...(host === "site_widget" ? { auth: WIDGET_AUTH } : {})}
      >
        <RecommendationHoldCard runId={RUN_ID} agentPackageName={PKG} wireRef={null} />
      </LifecycleCardSurfaceProvider>
    </Profiler>,
  );
}

beforeEach(() => {
  resetDrawnRecommendationReadings();
  holdStateMock.mockReset();
  confirmMock.mockReset();
  skipMock.mockReset();
});

afterEach(() => {
  cleanup();
  resetDrawnRecommendationReadings();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});

afterAll(() => {
  vi.doUnmock("next/navigation");
  vi.doUnmock("../run-recommendation-actions");
  vi.doUnmock("../server-actions");
  vi.resetModules();
});

describe("a release that dispatches a run held at a further gate", () => {
  for (const host of ["chat_thread", "site_widget"] as const) {
    it(`keeps the editable reading and its ONE Continue at every render after the answer (${host})`, async () => {
      const t = transport(host);
      let sampling = false;
      const samples: Sample[] = [];
      const { container } = mount(host, () => {
        if (sampling) samples.push(readCard());
      });

      await waitFor(() =>
        expect(container.querySelectorAll("[data-skills-step-pill]")).toHaveLength(2),
      );
      expect(readCard()).toEqual({ editable: "true", continues: 1, state: "held" });

      fireEvent.click(container.querySelector<HTMLElement>("[data-skills-step-continue]")!);
      await waitFor(() => expect(t.decisions).toHaveLength(1));
      // IN FLIGHT: the submitted latch, unchanged by this leg.
      await waitFor(() =>
        expect(
          container
            .querySelector("[data-run-recommendation-chip-row]")!
            .getAttribute("data-skills-step-submitted"),
        ).toBe("true"),
      );

      // THE ANSWER: the dispatcher accepted the run. From here on every commit
      // of the card is sampled.
      sampling = true;
      await act(async () => {
        t.release.resolve({ ok: true, dispatched: true });
        await new Promise((r) => setTimeout(r, 0));
      });
      // The authority has not answered yet: the answer alone is on screen.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });

      // THE AUTHORITY: settled, and the run held at its next gate — not started.
      await act(async () => {
        t.settledRead.resolve(settled(false));
        await new Promise((r) => setTimeout(r, 0));
      });
      await waitFor(() => expect(readCard().state).toBe("decided"));
      sampling = false;

      // Commits happened in the window, and every one of them drew §V's
      // before-the-start reading: boxes able to take a change, ONE Continue.
      expect(samples.length).toBeGreaterThan(0);
      samples.forEach((sample, i) => {
        expect(sample.editable, `render ${i + 1} after the answer: editable`).toBe("true");
        expect(sample.continues, `render ${i + 1} after the answer: Continue count`).toBe(1);
      });
      expect(readCard()).toEqual({ editable: "true", continues: 1, state: "decided" });
      expect(t.decisions).toHaveLength(1);
    });
  }
});
