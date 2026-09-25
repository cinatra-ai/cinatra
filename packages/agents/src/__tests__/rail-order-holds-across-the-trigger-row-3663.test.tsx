// @vitest-environment jsdom
/**
 * THE RAIL KEEPS ONE ORDER ACROSS THE TRIGGER ROW (cinatra#3663).
 *
 * The issue: before its trigger row exists a run's Schedule entry is drawn
 * BELOW its Setup entry, and it moves ABOVE Setup once the trigger row exists.
 * Its acceptance: "At every reading of one run (before the Skills answer, at the
 * setup step, after the trigger row exists) the rail order is Skills, Schedule,
 * the work steps (the setup form included), then Review, and the Schedule entry
 * never changes place. A red-first test crosses the moment the trigger row
 * appears."
 *
 * The ratified drawing, section I: "Where the run carries a schedule, the
 * rail's first entry is Schedule, above the run's work steps and above
 * Review." Section II: the Skills question "is the run's first gate — the first
 * entry on the step rail, where it is named Skills, ahead of the work steps it
 * would authorize".
 *
 * WHAT IS READ HERE. ONE run row, of an agent with a Skills park, one visible
 * required input field and a review step, walked through six moments and
 * rendered each time through the REAL run page (`SetupScreen`), plus the REAL
 * schedule screen (`TriggerScreen`) at the schedule moment. The data layer is
 * stubbed at the modules the screens read — the mocks are copied from
 * `run-page-composition-single-rail.test.tsx`, never imported across files —
 * and nothing of the rail's own composition is.
 *
 * The rows are read inside the frame's own column, `[data-run-step-rail-column]`,
 * through the head rows' own anchors; the page's own step-row panel and the
 * run's record are not part of the order this suite grades.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/rail-order-holds-across-the-trigger-row-3663.test.tsx
 */
import * as fs from "node:fs";

import React from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound");
  },
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/agents",
  useSearchParams: () => new URLSearchParams(),
}));

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
    ownKeys: () => ["default"],
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
      value: StubIcon,
    }),
  });
});

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

const RUN_ID = "run-3663";

/** THE RUN, AS THE STORE HOLDS IT — one row, moved from moment to moment. */
const row = vi.hoisted(() => ({
  status: "pending_input" as string,
  lifecycleMoment: null as string | null,
  lifecycleCardKind: null as string | null,
  lifecycleCardRef: null as string | null,
  hitlContext: null as unknown,
  inputParams: {} as Record<string, unknown>,
}));

/** The run's recommendation park: `parked` is the question held, `released` decided. */
const recommendationPark = vi.hoisted(() => ({
  row: null as { status: string } | null,
  holdState: { state: "none" } as unknown,
}));

/** The run's trigger row — `null` until the run has chosen when it runs. */
const triggerRow = vi.hoisted(() => ({
  row: null as { triggerType: string; releasedAt: Date | null } | null,
}));

/** ONE visible required field whose title only restates its key: the run's setup. */
const INPUT_SCHEMA = {
  properties: { brief: { type: "string", title: "brief" } } as Record<string, unknown>,
  required: ["brief"] as string[],
};

const TEMPLATE = {
  id: "tmpl-3663",
  orgId: "org-1",
  creatorId: "user-1",
  name: "Blog Draft Writer",
  description: "",
  type: "orchestrator",
  sourceNl: "",
  compiledPlan: [],
  inputSchema: INPUT_SCHEMA,
  outputSchema: null,
  taskSpec: null,
  status: "published",
  packageName: "@cinatra-ai/blog-draft-writer",
  packageVersion: "1.0.0",
  gatedSteps: [],
  triggerMode: "none",
  approvalPolicy: {
    steps: [{ stepNumber: 1, xRenderer: "cinatra/review", name: "Draft the post" }],
  },
  agentDependencies: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

function makeRun() {
  return {
    id: RUN_ID,
    templateId: TEMPLATE.id,
    versionId: null,
    runBy: "user-1",
    status: row.status,
    inputParams: row.inputParams,
    stepResults: null,
    startedAt: new Date("2026-01-01"),
    completedAt: null,
    error: null,
    title: "A run",
    createdAt: new Date("2026-01-01"),
    sourceType: "agent_builder",
    sourceId: null,
    packageVersion: "1.0.0",
    a2aTaskId: null,
    a2aContextId: null,
    parentRunId: null,
    agUiEnabled: true,
    lgThreadId: null,
    traceId: null,
    timeoutSeconds: null,
    streamedText: null,
    authPolicy: null,
    orgId: "org-1",
    projectId: null,
    idempotencyKey: null,
    oboCeiling: null,
    dependentInstallId: null,
    humanPresent: true,
    lifecycleMoment: row.lifecycleMoment,
    lifecycleCardKind: row.lifecycleCardKind,
    lifecycleCardRef: row.lifecycleCardRef,
    executionAttemptId: null,
    launchScopeAnchor: null,
  };
}

// ── The data layer the screens read. Nothing of the rail's composition. ─────
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: vi.fn(async () => ({
    user: { id: "user-1", name: "A", email: "a@b.c" },
    session: { activeOrganizationId: "org-1" },
  })),
  isPlatformAdmin: () => false,
  resolveOrgRoleForSession: vi.fn(async () => "member"),
}));

vi.mock("@/lib/better-auth-db", () => ({
  betterAuthDb: { select: () => ({ from: () => ({ where: async () => [] }) }) },
  betterAuthUsers: {},
  readOrgsWithTeamsForUserActiveOnly: vi.fn(async () => []),
  readProjectsForUser: vi.fn(async () => []),
}));

vi.mock("../store", () => ({
  readAgentTemplateBySlug: vi.fn(async () => TEMPLATE),
  readAgentRunById: vi.fn(async () => makeRun()),
  readAgentRunMessages: vi.fn(async () => []),
  readAgentTemplates: vi.fn(async () => ({ items: [] })),
  ensureRunTitle: vi.fn(async () => "A run"),
  readRunCoOwners: vi.fn(async () => []),
}));

vi.mock("../auth-policy", () => ({
  resolveEffectivePolicy: vi.fn(() => ({ runDataVisibility: "owner" })),
  buildScopeReason: vi.fn(() => null),
  resolveTemplateVisibilityActor: vi.fn(async () => ({})),
}));

vi.mock("../artifact-review-gate-store", () => ({
  listReviewGatesForRun: vi.fn(async () => []),
  readReviewGate: vi.fn(async () => null),
  readRunReviewSlot: vi.fn(async () => ({ reviewTaskId: null, awaiting: false })),
  readVerificationRecordsForGates: vi.fn(async () => []),
}));

vi.mock("../lifecycle-policy-store", () => ({
  readLifecycleDecisionsForRun: vi.fn(async () => []),
}));

vi.mock("../recommendation-hold", () => ({
  readRecommendationParkForRun: vi.fn(async () => recommendationPark.row),
}));

vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: vi.fn(async () => recommendationPark.holdState),
  confirmRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
  skipRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
}));

vi.mock("../hitl-context", () => ({
  deriveRunHitlContext: vi.fn(async () => row.hitlContext),
}));

vi.mock("../run-actions", () => ({
  createAndTriggerRunWithContext: vi.fn(async () => ({ ok: false })),
  buildSubmissionMapByStepIndex: vi.fn(async () => []),
  createAndTriggerRun: vi.fn(async () => ({ ok: false })),
  readRunOutputEvidence: vi.fn(async () => ({ hasOutput: false, hasArtifacts: false })),
}));

vi.mock("../trigger-store", () => ({
  readRunTriggerByRunId: vi.fn(async () => triggerRow.row),
}));

vi.mock("../trigger-schedule-proposal-store", () => ({
  readProposalConsumeByRunId: vi.fn(async () => null),
}));

vi.mock("../input-schema-resolver", () => ({
  resolveTemplateInputSchema: vi.fn(async () => INPUT_SCHEMA),
}));

vi.mock("@/lib/artifacts/run-made-artifacts", () => ({
  listRunMadeArtifacts: vi.fn(async () => []),
}));

vi.mock("../trigger-duration-estimate", () => ({
  estimateRunDuration: vi.fn(async () => ({ seconds: 60 })),
}));

vi.mock("@/lib/lifecycle/run-window-turn", () => ({
  canRespondInRunWindow: vi.fn(async () => true),
}));

vi.mock("../run-sharing-actions", () => ({ removeRunOwner: vi.fn() }));

vi.mock("../run-recommendation-core", () => ({
  // A released park is a decided one: the run's own evidence says so.
  recommendationDecidedForRun: vi.fn(() => recommendationPark.row?.status === "released"),
  resolveRecommendationHoldStateForActor: vi.fn(async () => null),
}));

import * as instanceScreens from "../instance-screens";
import { SetupScreen, TriggerScreen } from "../instance-screens";

/** The run page's own event stream, stubbed and taken away again. */
class StubEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  onmessage: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onopen: ((e: unknown) => void) | null = null;
  readyState = 0;
  constructor(public url: string) {}
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

const HELD = {
  state: "held",
  agentPackageName: TEMPLATE.packageName,
  promptText: "a post about rails",
  holdRef: "hold-3663",
  canDecide: true,
  recommendations: [
    {
      skillId: "skill-a",
      skillRevisionId: "skill-a@1",
      name: "Skill A",
      vendorName: "Acme",
      score: 0.9,
      rank: 1,
      recommended: true,
      scoredFeatures: [],
    },
  ],
};

type MomentName = "a" | "b" | "c" | "d" | "e" | "f";

/**
 * THE SIX MOMENTS OF THE ONE RUN, in the order it lives them.
 *
 * (a) held at its Skills question, undispatched; (b) released and dispatched,
 * nothing written (the handoff); (c) inside its execution with nothing written
 * (the loading moment); (d) paused at its input form; (e) parked at its
 * schedule with NO trigger row; (f) the SAME run holding its trigger row.
 */
function atMoment(moment: MomentName): void {
  row.lifecycleMoment = null;
  row.lifecycleCardKind = null;
  row.lifecycleCardRef = null;
  row.hitlContext = null;
  row.inputParams = {};
  triggerRow.row = null;
  recommendationPark.row = { status: "released" };
  recommendationPark.holdState = HELD;
  switch (moment) {
    case "a":
      row.status = "pending_input";
      recommendationPark.row = { status: "parked" };
      return;
    case "b":
      row.status = "queued";
      return;
    case "c":
      row.status = "running";
      return;
    case "d":
      row.status = "pending_approval";
      row.lifecycleMoment = "hitl";
      row.lifecycleCardKind = "agent_hitl_screen";
      row.lifecycleCardRef = "setup-brief";
      row.hitlContext = {
        xRenderer: "cinatra/setup-field",
        currentValues: null,
        fieldName: "brief",
        schema: { type: "object", properties: {} },
        reviewTaskId: "setup-brief",
      };
      return;
    case "e":
      row.status = "pending_trigger";
      row.lifecycleMoment = "schedule";
      row.inputParams = { brief: "a post about rails" };
      return;
    case "f":
      row.status = "armed";
      row.lifecycleMoment = "schedule";
      row.inputParams = { brief: "a post about rails" };
      triggerRow.row = { triggerType: "scheduled", releasedAt: null };
      return;
  }
}

/** One head row, as a conformance walk reads it. */
type HeadRow = {
  title: string;
  numeral: number | null;
  current: boolean;
  reached: string | null;
  settled: string | null;
};

const HEAD_ROWS =
  "[data-recommendation-rail-step],[data-schedule-rail-step],[data-run-surface-rail-step]";

/** The frame column's head rows, in the order they are drawn. */
function readHead(container: HTMLElement): HeadRow[] {
  const column = container.querySelector<HTMLElement>("[data-run-step-rail-column]");
  if (!column) return [];
  return Array.from(column.querySelectorAll<HTMLElement>(HEAD_ROWS))
    .filter((el) => el.getAttribute("data-run-surface-rail-step-key") !== "made")
    .map((el) => {
      const text = (el.textContent ?? "").trim();
      const numeral = /^(\d+)/.exec(text)?.[1];
      return {
        title: text.replace(/^\d+/, ""),
        numeral: numeral === undefined ? null : Number(numeral),
        current: el.getAttribute("aria-current") === "step",
        reached: el.getAttribute("data-run-surface-rail-reached"),
        settled:
          el.getAttribute("data-run-surface-rail-settled") ??
          el.getAttribute("data-schedule-step-settled") ??
          el.getAttribute("data-recommendation-step-settled"),
      };
    });
}

/** The drawing's order; the input step of this agent reads "Setup". */
const DRAWN_ORDER = ["Skills", "Schedule", "Setup", "Review"];

/** The readings this run takes, kept for the lane's own table of readings. */
const READINGS: Record<string, HeadRow[]> = {};

async function readRunPage(moment: MomentName): Promise<HeadRow[]> {
  atMoment(moment);
  const tree = await SetupScreen({ agentId: "blog-draft-writer", instanceId: RUN_ID });
  const { container } = render(tree as React.ReactElement);
  await waitFor(() => {
    expect(container.querySelector("[data-run-step-rail-column]")).not.toBeNull();
  });
  const head = readHead(container);
  READINGS[`run page (${moment})`] = head;
  cleanup();
  return head;
}

async function readScheduleScreen(): Promise<HeadRow[]> {
  atMoment("e");
  const tree = await TriggerScreen({ agentId: "blog-draft-writer", instanceId: RUN_ID });
  const { container } = render(tree as React.ReactElement);
  const head = readHead(container);
  READINGS["schedule screen (e)"] = head;
  cleanup();
  return head;
}

/** The titles a reading draws, in the drawing's order and nothing else. */
function expectDrawnOrder(head: readonly HeadRow[]): void {
  const titles = head.map((entry) => entry.title);
  expect(titles).toEqual(DRAWN_ORDER.filter((title) => titles.includes(title)));
  // "the Schedule entry never changes place": directly under Skills wherever
  // both are drawn.
  const skillsAt = titles.indexOf("Skills");
  const scheduleAt = titles.indexOf("Schedule");
  if (skillsAt > -1 && scheduleAt > -1) expect(scheduleAt).toBe(skillsAt + 1);
}

beforeEach(() => {
  vi.stubGlobal("EventSource", StubEventSource);
  atMoment("a");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

afterAll(() => {
  const out = process.env.RAIL_READINGS_OUT;
  if (out) fs.writeFileSync(out, `${JSON.stringify(READINGS, null, 2)}\n`);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("cinatra#3663 — one run's rail keeps the drawing's order at every reading", () => {
  for (const moment of ["a", "b", "c", "d", "e", "f"] as const) {
    it(`reads Skills, Schedule, the input step, Review on the run page at (${moment})`, async () => {
      const head = await readRunPage(moment);
      expect(head.length).toBeGreaterThan(0);
      expectDrawnOrder(head);
    });
  }

  it("reads the same order on the schedule screen at (e)", async () => {
    const head = await readScheduleScreen();
    expect(head.length).toBeGreaterThan(0);
    expectDrawnOrder(head);
  });

  it("crosses the moment the trigger row appears with Schedule directly under Skills", async () => {
    const before = await readRunPage("e");
    const after = await readRunPage("f");
    for (const head of [before, after]) {
      const titles = head.map((entry) => entry.title);
      expect(titles.slice(0, 2)).toEqual(["Skills", "Schedule"]);
    }
    expect(before.map((entry) => entry.title)).toEqual(after.map((entry) => entry.title));
  });

  it("numbers the entries in the drawn order: Skills, 1 Schedule, 2 Setup, 3 Review", async () => {
    const head = await readRunPage("a");
    expect(head.map((entry) => [entry.title, entry.numeral])).toEqual([
      ["Skills", null],
      ["Schedule", 1],
      ["Setup", 2],
      ["Review", 3],
    ]);
  });
});

describe("cinatra#3246 — the loading state never removes the entries this leg governs", () => {
  it("keeps the Skills and Setup entries from the question to the form, (a) to (d)", async () => {
    for (const moment of ["a", "b", "c", "d"] as const) {
      const titles = (await readRunPage(moment)).map((entry) => entry.title);
      expect({ moment, titles: titles.filter((t) => t === "Skills" || t === "Setup") }).toEqual({
        moment,
        titles: ["Skills", "Setup"],
      });
    }
  });
});

describe("the order is computed once, by one exported function", () => {
  const orderRunRailSteps = (
    instanceScreens as unknown as {
      orderRunRailSteps?: <T extends { key: string }>(steps: readonly T[]) => T[];
    }
  ).orderRunRailSteps;
  const order = (keys: readonly string[]) =>
    (orderRunRailSteps ?? (() => []))(keys.map((key) => ({ key }))).map((step) => step.key);

  it("is exported beside the rail's other helpers", () => {
    expect(typeof orderRunRailSteps).toBe("function");
  });

  it("orders the kind lists of the six readings into one order", () => {
    // (a), (b), (d), (e): composed with the input row above the forecast schedule.
    expect(order(["recommendation", "input:0", "schedule", "review"])).toEqual([
      "recommendation",
      "schedule",
      "input:0",
      "review",
    ]);
    // (c): the handoff's entries without the forecasts.
    expect(order(["recommendation", "input:0"])).toEqual(["recommendation", "input:0"]);
    // (f): already in order, and left as it is.
    expect(order(["recommendation", "schedule", "input:0", "review"])).toEqual([
      "recommendation",
      "schedule",
      "input:0",
      "review",
    ]);
    // The schedule screen: the settled input composed first.
    expect(order(["input:0", "recommendation", "schedule", "review"])).toEqual([
      "recommendation",
      "schedule",
      "input:0",
      "review",
    ]);
  });

  it("keeps the input steps in their index order, the parked gate after them and Review last", () => {
    expect(order(["review", "gate", "input:1", "input:0", "schedule"])).toEqual([
      "schedule",
      "input:0",
      "input:1",
      "gate",
      "review",
    ]);
  });
});
