// @vitest-environment jsdom
//
// A QUEUED RUN WITH NO START STAMP HAS NOT STARTED (cinatra#3062).
//
// The ratified drawing, §V, at the contract's pin:
//
//   "the run is dispatched and held at that gate, and none of its work steps has
//    run, which is what before the run starts means throughout this section"
//   "For as long as the run has not started, a reader who comes back to the
//    Skills step is shown the same pills with the boxes still able to take a
//    change and Continue still beneath them, and may change the selection."
//
// WHAT WAS WRONG. `recommendationRunHasStartedForRow` read the run's own
// `started_at` for ONE status (`pending_approval`) and fell back to the
// status-only boundary for every other one — and that boundary answers `queued`
// as started. But `started_at` is written inside the `queued->running` dispatch
// CAS and nowhere else, so a queued row with no stamp has not executed. Right
// after the one Continue the run row reads exactly that, and a measured round
// saw the card draw the started reading — read-only, no Continue — for about
// twelve seconds on a run that had not started.
//
// WHAT IS DRIVEN HERE.
//   1. The boundary itself, over EVERY status of the `AgentRunStatus` union, with
//      and without a stamp. The table is typed `Record<AgentRunStatus, …>`, so a
//      status added to the union and left out here fails the typecheck.
//   2. The real card on both conversation hosts, answered by the REAL resolver
//      (`resolveRecommendationHoldStateForActor`) with only its stores stubbed:
//      held → the one Continue → settled with the row queued and unstamped →
//      settled with the row at its next gate, still unstamped. Every commit of
//      the card from the answer on is sampled, and every sample must be §V's
//      before-the-start reading with ONE Continue.
//
// Run:
//   cd packages/agents && npx vitest run \
//     src/__tests__/skills-card-queued-row-is-not-started.test.tsx
import React, { Profiler } from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import {
  PRE_START_RUN_STATUSES_WITHOUT_A_START_STAMP,
  recommendationRunHasStarted,
  recommendationRunHasStartedForRow,
  type AgentRunStatus,
} from "../run-status";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const RUN_ID = "3062a0b1-c2d3-4e5f-8a9b-0c1d2e3f4a5b";
const PKG = "@cinatra-ai/blog-draft-writer-agent";
const HOLD_ID = "hold-3062-queued";
const HOLD_REF = "hold-ref-3062-queued";
const BLOG = "@cinatra-ai/blog-writing-skill:blog-writing";
const RESEARCH = "@cinatra-ai/chat:company-research";

type DecisionResult = { ok: true; dispatched: boolean } | { ok: false; error: string };

/** The run ROW as the stores hold it — the one fact the resolver reads. */
const row = vi.hoisted(() => ({
  status: "pending_approval" as string,
  startedAt: null as Date | null,
}));
/** The hand-off between the arm and the card's transport. */
const wire = vi.hoisted(() => ({
  pressed: false,
  decisions: [] as unknown[],
  release: null as null | Promise<unknown>,
}));

// ── The card's cookie transport. Before the press it reads the open question;
//    from the press on it reads the REAL action, whose resolver is the shipped
//    one — only the stores below are stubbed.
vi.mock("../run-recommendation-actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../run-recommendation-actions")>();
  return {
    ...actual,
    getRunRecommendationHoldStateAction: (input: { runId: string }) =>
      wire.pressed ? actual.getRunRecommendationHoldStateAction(input) : Promise.resolve(HELD),
    confirmRunRecommendationAction: (input: unknown) => {
      wire.pressed = true;
      wire.decisions.push(input);
      return wire.release;
    },
    skipRunRecommendationAction: (input: unknown) => {
      wire.pressed = true;
      wire.decisions.push(input);
      return wire.release;
    },
  };
});
vi.mock("../server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
  confirmRunSkillSelectionAction: vi.fn(),
}));
vi.mock("../run-actions", () => ({ triggerAgentRun: vi.fn() }));
vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: vi.fn(async () => ({ user: { id: "user-3062" } })),
  requireActorContext: vi.fn(async () => ({
    organizationId: "org-3062",
    teamIds: [],
    projectIds: [],
  })),
}));
vi.mock("../auth-policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth-policy")>();
  return {
    ...actual,
    enforceRunAccess: vi.fn(async () => undefined),
    resolveEffectivePolicy: vi.fn(() => ({})),
  };
});
vi.mock("../store", () => ({
  readAgentRunById: vi.fn(async () => ({
    id: RUN_ID,
    templateId: "tpl-3062",
    inputParams: {},
    status: row.status,
    startedAt: row.startedAt,
  })),
  readAgentTemplateById: vi.fn(async () => ({ id: "tpl-3062", packageName: PKG })),
  readRunCoOwners: vi.fn(async () => []),
}));
vi.mock("../recommendation-hold", () => ({
  RECOMMENDATION_DECISION_REFUSAL: "refused",
  decodeRecommendationHoldRef: vi.fn(() => ({ runId: RUN_ID, holdId: HOLD_ID })),
  encodeRecommendationHoldRef: vi.fn(() => HOLD_REF),
  publishRecommendationHoldResume: vi.fn(),
  // The hold was answered: the park is released, which is what makes the
  // resolver read the settled ladder.
  readRecommendationParkForRun: vi.fn(async () => ({
    id: HOLD_ID,
    runId: RUN_ID,
    status: "released",
  })),
  recommendationHoldThreadId: (run: { id: string }) => run.id,
  releaseRecommendationParkForRun: vi.fn(),
  resolveRecommendationCandidateSkillIds: vi.fn(async () => [BLOG, RESEARCH]),
}));
vi.mock("../recommendation-interception", () => ({
  getRunRecommendations: vi.fn(async () => [
    { skillId: BLOG, displayName: "Blog writing", vendorName: "Cinatra" },
    { skillId: RESEARCH, displayName: "Company research", vendorName: "Northstar" },
  ]),
}));
// The run's evidence: every box was left clear, so the answer on file is the
// skip — nothing selected, both offered skills recorded as not applied.
vi.mock("@/lib/run-selected-skill-revisions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/run-selected-skill-revisions")>();
  return {
    ...actual,
    readRunSelectedSkillRevisions: vi.fn(() => []),
    readRunRejectedRecommendations: vi.fn(() => [
      { skillId: BLOG, skillRevisionId: "blog-writing@0.4.2", recommendationSource: "user_skipped", recommendedRank: 1 },
      { skillId: RESEARCH, skillRevisionId: "company-research@2", recommendationSource: "user_skipped", recommendedRank: null },
    ]),
    hasRunRecommendationSkip: vi.fn(() => true),
    hasRunSelectedSkillRevisions: vi.fn(() => false),
    readRunRecommendationOfferedSet: vi.fn(async () => [
      { skillId: BLOG, skillRevisionId: "blog-writing@0.4.2", recommended: true, rank: 1 },
      { skillId: RESEARCH, skillRevisionId: "company-research@2", recommended: false, rank: 2 },
    ]),
    writeRunRecommendationOfferedSet: vi.fn(async () => undefined),
    clearRunSelectedSkillRevisionsBeforeStart: vi.fn(() => 0),
    replaceRunSelectedSkillRevisionsBeforeStart: vi.fn(() => true),
  };
});

import {
  LIFECYCLE_RECOMMENDATION_DECIDE_PATH,
  LIFECYCLE_RECOMMENDATION_HOLD_PATH,
  LifecycleCardSurfaceProvider,
} from "../lifecycle-card-runtime";
import { RecommendationHoldCard } from "../run-recommendation-chip-row";
import { resetDrawnRecommendationReadings } from "../run-recommendation-reading-register";
import { resolveRecommendationHoldStateForActor } from "../run-recommendation-core";

const HELD = {
  state: "held" as const,
  agentPackageName: PKG,
  promptText: "{}",
  holdRef: HOLD_REF,
  canDecide: true,
  recommendations: [
    {
      skillId: BLOG,
      skillRevisionId: "blog-writing@0.4.2",
      name: "Blog writing",
      vendorName: "Cinatra",
      score: 0.9,
      rank: 1,
      recommended: true,
      scoredFeatures: [],
    },
    {
      skillId: RESEARCH,
      skillRevisionId: "company-research@2",
      name: "Company research",
      vendorName: "Northstar",
      score: 0.2,
      rank: 2,
      recommended: false,
      scoredFeatures: [],
    },
  ],
};

const WIDGET_AUTH = {
  headers: () => ({ "X-Cinatra-Widget-User-Token": "cwu_test" }),
  credentials: "omit" as const,
};

/** The widget's broker read answers from the SAME core the cookie action does,
 *  for an actor built from the widget's own credential. */
const WIDGET_ACTOR = {
  actor: { actorType: "human", source: "ui", userId: "user-3062" },
  roleHints: { actorOrganizationId: "org-3062" },
} as never;

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function installWidgetBroker() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (!headers["X-Cinatra-Widget-User-Token"]) throw new Error(`${url} sent no widget proof`);
    if (init?.credentials !== "omit") throw new Error(`${url} sent ambient cookies`);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const answer = (payload: unknown) =>
      ({ ok: true, json: async () => payload }) as unknown as Response;
    if (url === LIFECYCLE_RECOMMENDATION_HOLD_PATH) {
      return answer(
        wire.pressed
          ? await resolveRecommendationHoldStateForActor({ runId: RUN_ID, who: WIDGET_ACTOR })
          : HELD,
      );
    }
    if (url === LIFECYCLE_RECOMMENDATION_DECIDE_PATH) {
      wire.pressed = true;
      wire.decisions.push(body);
      return answer({ outcome: await wire.release });
    }
    throw new Error(`unstubbed path: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

type Sample = { editable: string | null; continues: number; state: string | null; present: number };

function readCard(): Sample {
  const cards = document.body.querySelectorAll<HTMLElement>(
    '[data-lifecycle-card="recommendation_hold"]',
  );
  const card = cards[0] ?? null;
  return {
    editable: card?.getAttribute("data-skills-step-editable") ?? null,
    continues: document.body.querySelectorAll("[data-skills-step-continue]").length,
    state: card?.getAttribute("data-lifecycle-card-state") ?? null,
    present: cards.length,
  };
}

function card(host: "chat_thread" | "site_widget", runStatus: string) {
  return (
    <LifecycleCardSurfaceProvider host={host} {...(host === "site_widget" ? { auth: WIDGET_AUTH } : {})}>
      <RecommendationHoldCard runId={RUN_ID} agentPackageName={PKG} wireRef={null} runStatus={runStatus} />
    </LifecycleCardSurfaceProvider>
  );
}

beforeEach(() => {
  resetDrawnRecommendationReadings();
  row.status = "pending_approval";
  row.startedAt = null;
  wire.pressed = false;
  wire.decisions = [];
  wire.release = null;
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
  vi.doUnmock("../run-actions");
  vi.doUnmock("@/lib/auth-session");
  vi.doUnmock("../auth-policy");
  vi.doUnmock("../store");
  vi.doUnmock("../recommendation-hold");
  vi.doUnmock("../recommendation-interception");
  vi.doUnmock("@/lib/run-selected-skill-revisions");
  vi.resetModules();
});

/**
 * EVERY STATUS OF THE UNION, answered with NO start stamp. `false` is a status a
 * run can hold before the `queued->running` dispatch CAS has stamped it; `true`
 * is a status whose status-only answer stands (the run is under way, or over).
 * Typed over the union, so a new status cannot be left out of this table.
 */
const NOT_STARTED_WITHOUT_A_STAMP: Record<AgentRunStatus, boolean> = {
  // Dispatched, and the dispatch CAS has not run yet: nothing has executed.
  queued: false,
  // The hold's own park (the setup interrupt) — or, stamped, a mid-flight one.
  pending_approval: false,
  // Setup, the trigger form and the armed schedule: all before execution.
  pending_input: false,
  pending_trigger: false,
  armed: false,
  // Under way, or over: the status-only answer stands.
  running: true,
  waiting_trigger: true,
  completed: true,
  failed: true,
  stopped: true,
};

describe("the boundary, asked of the row, over every status", () => {
  it("a QUEUED row with no start stamp has NOT started; the stamp decides every pre-start row", () => {
    // The two readings the round measured, first.
    expect(recommendationRunHasStartedForRow({ status: "queued", startedAt: null })).toBe(false);
    expect(
      recommendationRunHasStartedForRow({ status: "queued", startedAt: new Date("2026-09-27T20:02:46Z") }),
    ).toBe(true);

    for (const [status, statusOnly] of Object.entries(NOT_STARTED_WITHOUT_A_STAMP) as Array<
      [AgentRunStatus, boolean]
    >) {
      // WITH a stamp, the run has executed — whatever the status says beside it.
      expect(
        recommendationRunHasStartedForRow({ status, startedAt: new Date("2026-09-27T20:02:46Z") }),
        `${status} with a start stamp`,
      ).toBe(true);
      expect(
        recommendationRunHasStartedForRow({ status, startedAt: "2026-09-27T20:02:46.553932Z" }),
        `${status} with a start stamp read off the wire`,
      ).toBe(true);
      // WITHOUT one: a pre-start status reads NOT started, and every other
      // status keeps the status-only answer it already had.
      const answer = recommendationRunHasStartedForRow({ status, startedAt: null });
      expect(answer, `${status} with no start stamp`).toBe(statusOnly);
      if (statusOnly) expect(answer, `${status}: the status-only answer`).toBe(recommendationRunHasStarted(status));
      expect(
        recommendationRunHasStartedForRow({ status, startedAt: undefined }),
        `${status} with the stamp absent`,
      ).toBe(statusOnly);
    }
    // Main's status-only boundary is unchanged.
    expect(recommendationRunHasStarted("queued")).toBe(true);
    // THE STORE STAYS THE CONSERVATIVE AUTHORITY. The dispatch reads the run's
    // selected skill revisions for its ledger snapshot while the row is still
    // `queued`, BEFORE the `queued->running` CAS, so a selection written while
    // queued could miss that snapshot: `queued` is not in the SQL guard's set,
    // and a press in that window is answered by the row's existing refusal.
    expect(PRE_START_RUN_STATUSES_WITHOUT_A_START_STAMP.has("queued")).toBe(false);
    expect(recommendationRunHasStartedForRow(null)).toBe(false);
  });
});

describe("the card after the one Continue, while the run is queued and then held at its next gate", () => {
  for (const host of ["chat_thread", "site_widget"] as const) {
    it(`keeps the editable reading and its ONE Continue at every render (${host})`, async () => {
      if (host === "site_widget") installWidgetBroker();
      const release = deferred<DecisionResult>();
      wire.release = release.promise;
      let sampling = false;
      const samples: Sample[] = [];
      const onCommit = () => {
        if (sampling) samples.push(readCard());
      };
      const { container, rerender } = render(
        <Profiler id="skills-card" onRender={onCommit}>
          {card(host, row.status)}
        </Profiler>,
      );

      await waitFor(() =>
        expect(container.querySelectorAll("[data-skills-step-pill]")).toHaveLength(2),
      );
      expect(readCard()).toMatchObject({ editable: "true", continues: 1, state: "held" });

      // EVERY BOX CLEAR, then the one Continue — the round's own answer.
      for (const box of Array.from(
        container.querySelectorAll<HTMLElement>("[data-skills-step-checkbox]"),
      )) {
        if (box.getAttribute("aria-checked") === "true") fireEvent.click(box);
      }
      fireEvent.click(container.querySelector<HTMLElement>("[data-skills-step-continue]")!);
      await waitFor(() => expect(wire.decisions).toHaveLength(1));

      // THE ANSWER: the run is dispatched and its row reads QUEUED, with no
      // start stamp. From here on every commit of the card is sampled.
      row.status = "queued";
      row.startedAt = null;
      sampling = true;
      await act(async () => {
        release.resolve({ ok: true, dispatched: true });
        await new Promise((r) => setTimeout(r, 0));
      });
      await waitFor(() => expect(readCard().state).toBe("decided"));
      // The host's run-row watch reads the same status.
      rerender(
        <Profiler id="skills-card" onRender={onCommit}>
          {card(host, row.status)}
        </Profiler>,
      );
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });

      // THE RUN STOPS AT ITS NEXT GATE before any work step: pending_approval,
      // still no stamp. The watch sees it and the card asks its authority again.
      row.status = "pending_approval";
      rerender(
        <Profiler id="skills-card" onRender={onCommit}>
          {card(host, row.status)}
        </Profiler>,
      );
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
      await waitFor(() => expect(readCard().state).toBe("decided"));
      sampling = false;

      expect(samples.length).toBeGreaterThan(0);
      samples.forEach((sample, i) => {
        expect(sample.present, `render ${i + 1} after the answer: the row's node`).toBe(1);
        expect(sample.editable, `render ${i + 1} after the answer: editable`).toBe("true");
        expect(sample.continues, `render ${i + 1} after the answer: Continue count`).toBe(1);
      });
      expect(readCard()).toMatchObject({ editable: "true", continues: 1, state: "decided" });
      expect(wire.decisions).toHaveLength(1);
    });
  }
});
