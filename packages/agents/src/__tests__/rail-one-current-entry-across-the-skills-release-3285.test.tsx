// @vitest-environment jsdom
/**
 * ONE CURRENT ENTRY ACROSS THE SKILLS RELEASE (cinatra#3285).
 *
 * The issue: after Continue on the Skills step, in the instant before the page
 * refreshes, no rail entry carried the current marker — the paused step's
 * entry read unselected and unreached while its form stood in the detail — and
 * the Skills entry kept reading as the open question after its card had read
 * decided. Its acceptance: "After Continue on the Skills step, without a
 * reload, exactly one rail entry carries the current marker (the live step:
 * 1 Setup), in both palettes; a fresh load reads the same." and "A
 * client-transition test through the composed page tree presses Continue and
 * asserts `railCurrent` names the live step before and after the refresh."
 *
 * The ratified drawing, section I: "The step the run is paused on is
 * highlighted; steps already passed sit above it, steps still to come below."
 * and "A resolved gate stays on the rail as read-only history — its entry keeps
 * its place".
 *
 * WHAT IS READ HERE. The client transition through the composed page tree, on
 * the harness of `skills-step-after-continue-dispatch-handoff.test.tsx`: the
 * real hold card, its real Continue, the mocked decision action, and a wired
 * `router.refresh()` — held back so the reading BEFORE it lands can be taken —
 * that hands the tree the server props recomputed from the run row the moment
 * actually holds. The server props are the REAL run page's (`SetupScreen`),
 * with the data layer stubbed as `run-page-composition-single-rail.test.tsx`
 * stubs it (copied, never imported across files). The current marker is read
 * as `[aria-current="step"]` inside the frame's own column,
 * `[data-run-step-rail-column]`.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/rail-one-current-entry-across-the-skills-release-3285.test.tsx
 */
import * as fs from "node:fs";

import React from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const RUN_ID = "run-3285";

/** THE RUN, AS THE STORE HOLDS IT — one row, moved from moment to moment. */
const row = vi.hoisted(() => ({
  status: "pending_input" as string,
  lifecycleMoment: null as string | null,
  lifecycleCardKind: null as string | null,
  lifecycleCardRef: null as string | null,
  hitlContext: null as unknown,
  inputParams: {} as Record<string, unknown>,
  /** The visible required fields this run's agent declares. */
  required: ["brief"] as string[],
}));

const recommendationPark = vi.hoisted(() => ({
  row: null as { status: string } | null,
  holdState: { state: "none" } as unknown,
}));

const decision = vi.hoisted(() => ({
  confirm: null as null | ((...a: unknown[]) => Promise<unknown>),
  skip: null as null | ((...a: unknown[]) => Promise<unknown>),
}));

const PROPERTIES = { brief: { type: "string", title: "brief" } } as Record<string, unknown>;

function inputSchema() {
  return { properties: PROPERTIES, required: row.required };
}

const TEMPLATE = {
  id: "tmpl-3285",
  orgId: "org-1",
  creatorId: "user-1",
  name: "Blog Draft Writer",
  description: "",
  type: "orchestrator",
  sourceNl: "",
  compiledPlan: [],
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

function makeTemplate() {
  return { ...TEMPLATE, inputSchema: inputSchema() };
}

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

// ── The data layer the screen reads. Nothing of the rail's composition. ──────
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
  readAgentTemplateBySlug: vi.fn(async () => makeTemplate()),
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

// The decision action is mocked; the hold card and its Continue are real.
vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: vi.fn(async () => recommendationPark.holdState),
  confirmRunRecommendationAction: (...a: unknown[]) => decision.confirm!(...a),
  skipRunRecommendationAction: (...a: unknown[]) => decision.skip!(...a),
}));

vi.mock("../server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
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
  readRunTriggerByRunId: vi.fn(async () => null),
}));

vi.mock("../trigger-schedule-proposal-store", () => ({
  readProposalConsumeByRunId: vi.fn(async () => null),
}));

vi.mock("../input-schema-resolver", () => ({
  resolveTemplateInputSchema: vi.fn(async () => inputSchema()),
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
  recommendationDecidedForRun: vi.fn(() => recommendationPark.row?.status === "released"),
  resolveRecommendationHoldStateForActor: vi.fn(async () => null),
}));

import { runDetailInitialStep, SetupScreen } from "../instance-screens";

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

function pill(skillId: string, name: string, rank: number) {
  return {
    skillId,
    skillRevisionId: `${skillId}@1`,
    name,
    vendorName: "Acme",
    score: 0.9,
    rank,
    recommended: true,
    scoredFeatures: [],
  };
}

const HELD = {
  state: "held",
  agentPackageName: TEMPLATE.packageName,
  promptText: "{}",
  holdRef: "hold-3285",
  canDecide: true,
  recommendations: [pill("skill-a", "Skill A", 1), pill("skill-b", "Skill B", 2)],
};

type Moment = "held" | "handoff" | "loading" | "form";

/** The run row at each moment the walk reads. */
function atMoment(moment: Moment): void {
  row.lifecycleMoment = null;
  row.lifecycleCardKind = null;
  row.lifecycleCardRef = null;
  row.hitlContext = null;
  row.inputParams = {};
  recommendationPark.row = { status: "released" };
  recommendationPark.holdState = HELD;
  switch (moment) {
    case "held":
      row.status = "pending_input";
      recommendationPark.row = { status: "parked" };
      return;
    case "handoff":
      row.status = "queued";
      return;
    case "loading":
      row.status = "running";
      return;
    case "form":
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
  }
}

/** `railCurrent`: every entry inside the frame's column carrying the current marker. */
function railCurrent(container: HTMLElement): string[] {
  const column = container.querySelector<HTMLElement>("[data-run-step-rail-column]");
  if (!column) return ["NO RAIL COLUMN"];
  return Array.from(column.querySelectorAll<HTMLElement>('[aria-current="step"]')).map((el) =>
    (el.textContent ?? "").trim().replace(/^\d+/, ""),
  );
}

function skillsSettled(container: HTMLElement): string | null {
  return (
    container
      .querySelector<HTMLElement>("[data-recommendation-rail-step]")
      ?.getAttribute("data-recommendation-step-settled") ?? null
  );
}

async function serverTree(): Promise<React.ReactElement> {
  return (await SetupScreen({
    agentId: "blog-draft-writer",
    instanceId: RUN_ID,
  })) as React.ReactElement;
}

const boxes = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLElement>("[data-skills-step-checkbox]"));

/** The readings this run takes, kept for the lane's own table of readings. */
const READINGS: Record<string, { current: string[]; skillsSettled: string | null }> = {};

function record(name: string, container: HTMLElement) {
  const reading = { current: railCurrent(container), skillsSettled: skillsSettled(container) };
  READINGS[name] = reading;
  return reading;
}

/**
 * Render the run held at its question, press Continue, and stop the refresh the
 * row fires so the reading before it lands can be taken. Returns the view and a
 * function that lands that refresh with the row the given moment holds.
 */
async function continueOnTheSkillsStep() {
  atMoment("held");
  let refreshes = 0;
  wired.refreshed.current = () => {
    refreshes += 1;
  };
  const view = render(await serverTree());
  await waitFor(() => expect(boxes(view.container).length).toBeGreaterThan(0));
  const before = record(`${row.required.length} form(s): at the question`, view.container);

  const button = view.container.querySelector<HTMLElement>("[data-skills-step-continue]");
  expect(button).not.toBeNull();
  await act(async () => {
    fireEvent.click(button as HTMLElement);
  });
  await waitFor(() => expect(refreshes).toBe(1));

  const land = async (moment: Moment) => {
    atMoment(moment);
    const tree = await serverTree();
    await act(async () => {
      view.rerender(tree);
    });
  };
  return { view, before, land };
}

beforeEach(() => {
  vi.stubGlobal("EventSource", StubEventSource);
  row.required = ["brief"];
  decision.confirm = vi.fn(async () => ({ ok: true, dispatched: true }));
  decision.skip = vi.fn(async () => ({ ok: true, dispatched: true }));
  wired.refreshed.current = null;
  atMoment("held");
});

afterEach(() => {
  cleanup();
  wired.refreshed.current = null;
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

describe("cinatra#3285 — exactly one current entry across the Skills release", () => {
  it("names Skills at the question, then Setup before the refresh and after it at every moment", async () => {
    const { view, before, land } = await continueOnTheSkillsStep();
    expect(before.current).toEqual(["Skills"]);

    // THE INSTANT THE DECISION ACTION RETURNS, BEFORE THE REFRESH LANDS.
    // Every reading of the walk is taken and graded, so one red reading does
    // not hide the ones after it.
    const released = record("1 form: released, before the refresh", view.container);
    expect.soft(released.current).toEqual(["Setup"]);
    expect.soft(released.skillsSettled).toBe("true");

    for (const moment of ["handoff", "loading", "form"] as const) {
      await land(moment);
      const reading = record(`1 form: after the refresh at ${moment}`, view.container);
      expect.soft({ moment, current: reading.current }).toEqual({ moment, current: ["Setup"] });
      expect.soft(reading.skillsSettled).toBe("true");
    }
  });

  it("reads the same current entry on a fresh load of each of those rows", async () => {
    for (const moment of ["handoff", "loading", "form"] as const) {
      atMoment(moment);
      const { container } = render(await serverTree());
      const reading = record(`1 form: fresh load at ${moment}`, container);
      expect.soft({ moment, current: reading.current }).toEqual({ moment, current: ["Setup"] });
      cleanup();
    }
  });

  it("never reads two current entries for a run that owes no input form, and settles Skills", async () => {
    row.required = [];
    const { view, before, land } = await continueOnTheSkillsStep();
    expect(before.current).toEqual(["Skills"]);

    const released = record("0 forms: released, before the refresh", view.container);
    expect.soft(released.current.length).toBeLessThanOrEqual(1);
    expect.soft(released.current).not.toContain("Skills");
    expect.soft(released.skillsSettled).toBe("true");

    await land("handoff");
    const after = record("0 forms: after the refresh at handoff", view.container);
    expect.soft(after.current.length).toBeLessThanOrEqual(1);
    expect.soft(after.current).not.toContain("Skills");
    expect.soft(after.skillsSettled).toBe("true");
  });
});

describe("runDetailInitialStep elects the step the released run walks to", () => {
  const base = {
    hasRecommendationStep: true,
    recommendationHeld: false,
    hasScheduleStep: false,
    hasExecution: false,
    openInputStepKey: null,
    parkedGateStep: false,
  } as const;
  const elect = (params: Record<string, unknown>) =>
    runDetailInitialStep({ ...base, ...params } as Parameters<typeof runDetailInitialStep>[0]);

  it("elects the owed form at the handoff and at the loading moment", () => {
    expect(elect({ inputStepAfterRelease: "input:0" })).toBe("input:0");
    expect(elect({ hasExecution: true, inputStepAfterRelease: "input:0" })).toBe("input:0");
  });

  it("reads exactly as today for a held park, an open form, a parked gate and no new input", () => {
    expect(elect({ recommendationHeld: true, inputStepAfterRelease: "input:0" })).toBe(
      "recommendation",
    );
    expect(elect({ openInputStepKey: "input:1", inputStepAfterRelease: "input:0" })).toBe(
      "input:1",
    );
    expect(elect({ parkedGateStep: true, inputStepAfterRelease: "input:0" })).toBe("gate");
    expect(elect({})).toBe("detail");
    expect(elect({ inputStepAfterRelease: null })).toBe("detail");
    expect(elect({ hasScheduleStep: true })).toBe("schedule");
    expect(elect({ hasRecommendationStep: false, inputStepAfterRelease: "input:0" })).toBe(
      "detail",
    );
  });
});
