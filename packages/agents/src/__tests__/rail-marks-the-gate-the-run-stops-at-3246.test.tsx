// @vitest-environment jsdom
/**
 * THE RAIL MARKS THE GATE THE RUN STOPS AT (cinatra#3246, with cinatra#3663).
 *
 * What a person saw: after the setup answer and the schedule answer "Run right
 * after setup", the run stopped at its context gate ("Draft Context") and the
 * rail had no entry for it -- no step was highlighted at all -- and the
 * Schedule entry was drawn without the rail's own row marker.
 *
 * The ratified drawing, section I: "The rail lists the run's steps in order,
 * merged so that a gate is not a page outside the run but a step in the run
 * ... The step the run is paused on is highlighted". Owner ruling 629 A: the
 * order is fixed -- Skills, Schedule, the work steps, Review.
 *
 * WHAT IS READ HERE. ONE run of an agent with a Skills park (released), its
 * setup form answered, a spent one-off trigger row (`immediate`), and a review
 * still to come, rendered through the REAL run page (`SetupScreen`) on the
 * harness of `rail-order-holds-across-the-trigger-row-3663.test.tsx` (its mocks
 * copied, never imported across files); the context gate's payload is shaped
 * as `run-page-mid-run-gate-elected-from-the-run-row.test.tsx` shapes it. The
 * rows are read over `[data-run-surface-rail-step],[data-recommendation-rail-step]`
 * inside `[data-run-step-rail-column]`.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/rail-marks-the-gate-the-run-stops-at-3246.test.tsx
 */
import * as fs from "node:fs";

import React from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";

const wired = vi.hoisted(() => ({ refreshed: { current: null as null | (() => void) } }));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound");
  },
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: () => wired.refreshed.current?.(),
  }),
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

const RUN_ID = "run-3246-gate";

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
  id: "tmpl-3246-gate",
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
import { SetupScreen } from "../instance-screens";
import * as frame from "../run-surface-rail";

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
  holdRef: "hold-3246-gate",
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

const GATE_TASK_ID = "wayflow-task-3246";

/** The context gate's values, shaped as the mid-run gate suite shapes them. */
const CONTEXT_GATE_PAYLOAD = {
  candidates: [
    { artifactId: "a1", representationRevisionId: "r1", semanticAssertionId: "s1" },
  ],
  selectedRefs: [],
  slotMeta: {
    slotId: "draftContext",
    resolutionMode: "accumulate",
    selectionMode: "interactive",
  },
};

type MomentName = "e" | "f" | "working" | "running" | "gate";

/**
 * THE MOMENTS OF THE ONE RUN. (e) and (f) are the 3663 harness's own: parked at
 * its schedule with no trigger row, then holding a scheduled one. `working` is
 * the run dispatched right after setup, its one-off trigger row spent and
 * nothing written yet; `running` the same run inside its execution; `gate` the
 * same run stopped at its context gate.
 */
function atMoment(moment: MomentName): void {
  row.lifecycleMoment = null;
  row.lifecycleCardKind = null;
  row.lifecycleCardRef = null;
  row.hitlContext = null;
  row.inputParams = { brief: "a post about rails" };
  triggerRow.row = { triggerType: "immediate", releasedAt: new Date("2026-01-01T00:01:00Z") };
  recommendationPark.row = { status: "released" };
  recommendationPark.holdState = HELD;
  switch (moment) {
    case "e":
      row.status = "pending_trigger";
      row.lifecycleMoment = "schedule";
      triggerRow.row = null;
      return;
    case "f":
      row.status = "armed";
      row.lifecycleMoment = "schedule";
      triggerRow.row = { triggerType: "scheduled", releasedAt: null };
      return;
    case "working":
      row.status = "queued";
      return;
    case "running":
      row.status = "running";
      return;
    case "gate":
      row.status = "pending_approval";
      row.lifecycleMoment = "hitl";
      row.lifecycleCardKind = "agent_hitl_screen";
      row.lifecycleCardRef = GATE_TASK_ID;
      row.hitlContext = {
        xRenderer: "context-selector",
        currentValues: CONTEXT_GATE_PAYLOAD,
        fieldName: null,
        schema: { type: "object", properties: {} },
        reviewTaskId: GATE_TASK_ID,
      };
      return;
  }
}

const RAIL_ROWS = "[data-run-surface-rail-step],[data-recommendation-rail-step]";

/** One rail row, as the round's walk reads it. */
type RailRow = {
  title: string;
  numeral: number | null;
  key: string | null;
  selected: string | null;
  reached: string | null;
  settled: string | null;
  current: boolean;
};

type RailReading = { rows: RailRow[]; count: number; currentCount: number; selectedStep: string | null };

function readRail(container: HTMLElement): RailReading {
  const column = container.querySelector<HTMLElement>("[data-run-step-rail-column]");
  const detail = container.querySelector<HTMLElement>("[data-run-detail-column]");
  const selectedStep = detail?.getAttribute("data-run-surface-selected-step") ?? null;
  if (!column) return { rows: [], count: 0, currentCount: 0, selectedStep };
  const rows = Array.from(column.querySelectorAll<HTMLElement>(RAIL_ROWS)).map((el) => {
    const text = (el.textContent ?? "").trim();
    const numeral = /^(\d+)/.exec(text)?.[1];
    return {
      title: text.replace(/^\d+/, ""),
      numeral: numeral === undefined ? null : Number(numeral),
      key:
        el.getAttribute("data-run-surface-rail-step-key") ??
        (el.hasAttribute("data-recommendation-rail-step") ? "recommendation" : null),
      selected:
        el.getAttribute("data-run-surface-rail-selected") ??
        el.getAttribute("data-recommendation-step-selected"),
      reached: el.getAttribute("data-run-surface-rail-reached"),
      settled:
        el.getAttribute("data-run-surface-rail-settled") ??
        el.getAttribute("data-recommendation-step-settled"),
      current: el.getAttribute("aria-current") === "step",
    };
  });
  return {
    rows,
    count: rows.length,
    currentCount: column.querySelectorAll('[aria-current="step"]').length,
    selectedStep,
  };
}

/** The readings this run takes, kept for the lane's own table of readings. */
const READINGS: Record<string, RailReading> = {};

async function serverTree(): Promise<React.ReactElement> {
  return (await SetupScreen({
    agentId: "blog-draft-writer",
    instanceId: RUN_ID,
  })) as React.ReactElement;
}

async function freshReading(moment: MomentName, name = `fresh render (${moment})`) {
  atMoment(moment);
  const { container } = render(await serverTree());
  await waitFor(() => {
    expect(container.querySelector("[data-run-step-rail-column]")).not.toBeNull();
  });
  const reading = readRail(container);
  READINGS[name] = reading;
  cleanup();
  return reading;
}

const DRAWN_AT_THE_GATE = ["Skills", "Schedule", "Setup", "Draft Context", "Review"];

beforeEach(() => {
  vi.stubGlobal("EventSource", StubEventSource);
  wired.refreshed.current = null;
  atMoment("working");
});

afterEach(() => {
  cleanup();
  wired.refreshed.current = null;
  vi.useRealTimers();
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

describe("cinatra#3246 -- the gate the run stops at after its trigger row is a work-step entry", () => {
  it("(i) a fresh render at the gate reads Skills, Schedule, Setup, Draft Context, Review with Draft Context current", async () => {
    const reading = await freshReading("gate");
    expect.soft(reading.rows.map((r) => r.title)).toEqual(DRAWN_AT_THE_GATE);
    const schedule = reading.rows.filter((r) => r.key === "schedule");
    expect.soft(schedule.map((r) => [r.title, r.settled])).toEqual([["Schedule", "true"]]);
    expect.soft(reading.currentCount).toBe(1);
    expect.soft(reading.rows.filter((r) => r.current).map((r) => r.title)).toEqual([
      "Draft Context",
    ]);
    expect.soft(reading.selectedStep).toBe("gate");
  });

  for (const from of ["working", "running"] as const) {
    it(`(ii) a page rendered while the run worked (${from}) gains the gate as the one current entry, without a reload`, async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const reads: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          reads.push(String(url));
          return {
            ok: true,
            json: async () => ({ status: "pending_approval", lifecycleMoment: "hitl" }),
          };
        }),
      );
      atMoment(from);
      const view = render(await serverTree());
      const before = readRail(view.container);
      READINGS[`walk (${from}): the page rendered while the run worked`] = before;

      let refreshes = 0;
      wired.refreshed.current = () => {
        refreshes += 1;
      };
      // The run stops at its context gate; the page is not reloaded.
      atMoment("gate");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_100);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_100);
      });
      if (refreshes > 0) {
        const tree = await serverTree();
        await act(async () => {
          view.rerender(tree);
        });
      }
      const after = readRail(view.container);
      READINGS[`walk (${from}): after the run stopped at its gate`] = after;
      expect.soft(refreshes).toBe(1);
      expect.soft(reads).toContain(`/api/agents/runs/${RUN_ID}`);
      expect.soft(after.rows.map((r) => r.title)).toEqual(DRAWN_AT_THE_GATE);
      expect.soft(after.currentCount).toBe(1);
      expect.soft(after.rows.filter((r) => r.current).map((r) => r.title)).toEqual([
        "Draft Context",
      ]);
      expect.soft(after.selectedStep).toBe("gate");

      // AND IT STANDS DOWN: no second refresh, however long the page stays open.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(refreshes).toBeLessThanOrEqual(1);
    });
  }

  it("(iii) counts the Schedule entry once by the rail's row selector at (e), (f) and at the gate", async () => {
    for (const moment of ["e", "f", "gate"] as const) {
      const reading = await freshReading(moment, `schedule marker (${moment})`);
      const schedule = reading.rows.filter((r) => r.title === "Schedule");
      expect.soft({ moment, schedule: schedule.map((r) => r.key) }).toEqual({
        moment,
        schedule: ["schedule"],
      });
      expect.soft({ moment, index: reading.rows.findIndex((r) => r.title === "Schedule") }).toEqual({
        moment,
        index: 1,
      });
    }
  });
});

describe("the pure arms", () => {
  const order = (keys: readonly string[]) =>
    instanceScreens.orderRunRailSteps(keys.map((key) => ({ key }))).map((step) => step.key);

  it("orders Skills, Schedule, the settled input, the gate and Review into the drawn order", () => {
    expect(order(["review", "gate", "input:0", "schedule", "recommendation"])).toEqual([
      "recommendation",
      "schedule",
      "input:0",
      "gate",
      "review",
    ]);
  });

  it("mounts the follower only on a page composed while the run works, with no gate and no form", () => {
    const mounts = (
      instanceScreens as unknown as {
        runPageFollowsTheRunToItsStop?: (p: {
          runStatus: string | null;
          parkedGateStep: boolean;
          openInputStepKey: string | null;
        }) => boolean;
      }
    ).runPageFollowsTheRunToItsStop;
    expect(typeof mounts).toBe("function");
    if (!mounts) return;
    const at = (runStatus: string | null, parkedGateStep = false, openInputStepKey: string | null = null) =>
      mounts({ runStatus, parkedGateStep, openInputStepKey });
    expect(at("queued")).toBe(true);
    expect(at("running")).toBe(true);
    expect(at("pending_approval", true)).toBe(false);
    expect(at("running", true)).toBe(false);
    expect(at("running", false, "input:0")).toBe(false);
    for (const terminal of ["completed", "failed", "cancelled"]) expect(at(terminal)).toBe(false);
    expect(at("pending_input")).toBe(false);
    expect(at(null)).toBe(false);
  });

  it("refreshes on a stop the rail does not carry, and never on an unchanged or terminal read", () => {
    const refreshes = (
      frame as unknown as {
        runRowReadsAnUncarriedStop?: (read: {
          status?: string | null;
          lifecycleMoment?: string | null;
        }) => boolean;
      }
    ).runRowReadsAnUncarriedStop;
    expect(typeof refreshes).toBe("function");
    if (!refreshes) return;
    expect(refreshes({ status: "pending_approval", lifecycleMoment: "hitl" })).toBe(true);
    expect(refreshes({ status: "pending_approval", lifecycleMoment: "review" })).toBe(true);
    expect(refreshes({ status: "running", lifecycleMoment: null })).toBe(false);
    expect(refreshes({ status: "queued" })).toBe(false);
    expect(refreshes({ status: "pending_approval", lifecycleMoment: null })).toBe(false);
    for (const terminal of ["completed", "failed", "cancelled"]) {
      expect(refreshes({ status: terminal, lifecycleMoment: null })).toBe(false);
    }
    expect(refreshes({})).toBe(false);
  });
});
