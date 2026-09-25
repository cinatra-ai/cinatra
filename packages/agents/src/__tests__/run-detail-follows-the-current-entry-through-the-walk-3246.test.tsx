// @vitest-environment jsdom
/**
 * THE RUN DETAIL FOLLOWS THE RAIL'S CURRENT ENTRY THROUGH THE WALK (cinatra#3246).
 *
 * What a person saw: right after answering the Skills question the rail named
 * the next step as the current one, while the run detail beside it kept the
 * answered Skills card. The ratified drawing, section I: "The surface is a
 * two-column frame: a step rail down the left names the run's ordered steps,
 * and the run detail on the right shows the selected step." and "One page per
 * gate -- the step's own card, and nothing else." and "While the run works,
 * the detail carries a placeholder."
 *
 * WHAT IS READ HERE. The client transition through the composed page tree, on
 * the harness of `rail-one-current-entry-across-the-skills-release-3285.test.tsx`
 * (its mocks and its wired `router.refresh()` copied, never imported across
 * files): at every reading the detail column `[data-run-detail-column]` is read
 * for every `data-lifecycle-card` node, for the run-progress placeholder and
 * for the form's own field.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/run-detail-follows-the-current-entry-through-the-walk-3246.test.tsx
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

const RUN_ID = "run-3246-detail";

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
  id: "tmpl-3246-detail",
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

import { SetupScreen } from "../instance-screens";

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
  holdRef: "hold-3246-detail",
  canDecide: true,
  recommendations: [pill("skill-a", "Skill A", 1), pill("skill-b", "Skill B", 2)],
};

type Moment = "held" | "handoff" | "loading" | "awaiting-card" | "form";

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
    case "awaiting-card":
      // Parked at the setup form, the form's own card not derived yet.
      row.status = "pending_approval";
      row.lifecycleMoment = "hitl";
      row.lifecycleCardKind = "agent_hitl_screen";
      row.lifecycleCardRef = "setup-brief";
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

/** One reading of the frame: the current entry and what the detail column holds. */
type DetailReading = {
  current: string[];
  selectedStep: string | null;
  cards: { kind: string | null; state: string | null }[];
  placeholder: number;
  formFields: number;
  /** Characters of text the detail draws -- a run panel's own reading counts. */
  text: number;
  empty: boolean;
};

function readFrame(container: HTMLElement): DetailReading {
  const column = container.querySelector<HTMLElement>("[data-run-step-rail-column]");
  const current = column
    ? Array.from(column.querySelectorAll<HTMLElement>('[aria-current="step"]')).map((el) =>
        (el.textContent ?? "").trim().replace(/^\d+/, ""),
      )
    : ["NO RAIL COLUMN"];
  const detail = container.querySelector<HTMLElement>("[data-run-detail-column]");
  if (!detail) {
    return {
      current,
      selectedStep: null,
      cards: [],
      placeholder: 0,
      formFields: 0,
      text: 0,
      empty: true,
    };
  }
  const cards = Array.from(detail.querySelectorAll<HTMLElement>("[data-lifecycle-card]")).map(
    (el) => ({
      kind: el.getAttribute("data-lifecycle-card"),
      state: el.getAttribute("data-lifecycle-card-state"),
    }),
  );
  const placeholder = detail.querySelectorAll(
    '[data-conformance-id="review-gate-placeholder"]',
  ).length;
  const formFields = detail.querySelectorAll("textarea, input:not([type='checkbox'])").length;
  return {
    current,
    selectedStep: detail.getAttribute("data-run-surface-selected-step"),
    cards,
    placeholder,
    formFields,
    text: (detail.textContent ?? "").trim().length,
    empty: detail.children.length === 0,
  };
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
const READINGS: Record<string, DetailReading> = {};

function record(name: string, container: HTMLElement): DetailReading {
  const reading = readFrame(container);
  READINGS[name] = reading;
  return reading;
}

const skillsCards = (reading: DetailReading) =>
  reading.cards.filter((card) => card.kind === "recommendation_hold");

/**
 * The detail carries a page -- the placeholder, a card, the form, or the run
 * panel's own reading -- and never an empty column.
 */
const carriesAPage = (reading: DetailReading) =>
  !reading.empty &&
  (reading.placeholder > 0 ||
    reading.cards.length > 0 ||
    reading.formFields > 0 ||
    reading.text > 0);

/**
 * Render the run held at its question and press Continue. The refresh the row
 * fires is counted and held back, so the reading before it lands can be taken.
 */
async function continueOnTheSkillsStep() {
  atMoment("held");
  const refreshes = { count: 0 };
  wired.refreshed.current = () => {
    refreshes.count += 1;
  };
  const view = render(await serverTree());
  await waitFor(() => expect(boxes(view.container).length).toBeGreaterThan(0));
  const atQuestion = record("at the question", view.container);

  const button = view.container.querySelector<HTMLElement>("[data-skills-step-continue]");
  expect(button).not.toBeNull();
  await act(async () => {
    fireEvent.click(button as HTMLElement);
  });
  await waitFor(() => expect(refreshes.count).toBe(1));

  const land = async (moment: Moment) => {
    atMoment(moment);
    const tree = await serverTree();
    await act(async () => {
      view.rerender(tree);
    });
  };
  return { view, atQuestion, land, refreshes };
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

const AFTER_THE_REFRESH = ["handoff", "loading", "awaiting-card", "form"] as const;

describe("cinatra#3246 -- the run detail shows the current entry through the Skills walk", () => {
  it("carries the Skills card at the question, and the placeholder the instant the decision lands", async () => {
    const { view, atQuestion, refreshes } = await continueOnTheSkillsStep();
    expect(atQuestion.current).toEqual(["Skills"]);
    expect(skillsCards(atQuestion)).toHaveLength(1);
    expect(atQuestion.cards).toHaveLength(1);

    // THE INSTANT THE DECISION ACTION RESOLVES, BEFORE THE REFRESH LANDS.
    const released = record("released, before the refresh", view.container);
    expect.soft(released.current).toEqual(["Setup"]);
    expect.soft(skillsCards(released)).toEqual([]);
    expect.soft(released.placeholder).toBe(1);
    expect.soft(refreshes.count).toBe(1);
  });

  it("never carries the Skills card after the refresh, and never an empty column", async () => {
    const { view, land, refreshes } = await continueOnTheSkillsStep();
    for (const moment of AFTER_THE_REFRESH) {
      await land(moment);
      const reading = record(`after the refresh at ${moment}`, view.container);
      expect.soft({ moment, skills: skillsCards(reading) }).toEqual({ moment, skills: [] });
      expect.soft({ moment, page: carriesAPage(reading) }).toEqual({ moment, page: true });
      expect.soft({ moment, current: reading.current }).toEqual({ moment, current: ["Setup"] });
    }
    // The refresh the decision fired, exactly once.
    expect(refreshes.count).toBe(1);
  });

  it("reads the same on a fresh render of each of those rows", async () => {
    for (const moment of AFTER_THE_REFRESH) {
      atMoment(moment);
      const { container } = render(await serverTree());
      const reading = record(`fresh render at ${moment}`, container);
      expect.soft({ moment, skills: skillsCards(reading) }).toEqual({ moment, skills: [] });
      expect.soft({ moment, page: carriesAPage(reading) }).toEqual({ moment, page: true });
      expect.soft({ moment, current: reading.current }).toEqual({ moment, current: ["Setup"] });
      cleanup();
    }
  });

  it("opens the Skills card, and nothing beside it, when the settled Skills row is pressed", async () => {
    const { view } = await continueOnTheSkillsStep();
    const settledRow = view.container.querySelector<HTMLElement>(
      "[data-recommendation-rail-step]",
    );
    expect(settledRow).not.toBeNull();
    await act(async () => {
      fireEvent.click(settledRow as HTMLElement);
    });
    const pressed = record("the settled Skills row pressed after the release", view.container);
    expect(pressed.current).toEqual(["Skills"]);
    expect(skillsCards(pressed)).toHaveLength(1);
    expect(pressed.cards).toHaveLength(1);
    expect(pressed.placeholder).toBe(0);
  });
});
