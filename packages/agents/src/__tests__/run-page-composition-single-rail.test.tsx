// @vitest-environment jsdom
/**
 * ONE STEP RAIL ON THE RUN PAGE — THE PAGE'S OWN COMPOSITION (cinatra#3478).
 *
 * WHAT WAS MEASURED, AND WHY TWO GREEN SUITES MISSED IT. Three run pages were
 * photographed on 2026-09-13 drawing a THREE-column surface: a rail column, a
 * second rail column beside it, then the run detail — the first carrying the
 * run's gate rows, the second the run's work steps, each numbered from 1. The
 * ratified drawing gives one: "The surface is a two-column frame: a step rail
 * down the left names the run's ordered steps, and the run detail on the right
 * shows the selected step", and "the rail lists the run's steps in order,
 * merged so that a gate is not a page outside the run but a step in the run …
 * inline at the point the run reached it".
 *
 * Two suites already pin "exactly ONE column" (the 2026-08-14 answer,
 * cinatra#2739) and both stayed green while the page drew two:
 *
 *   • `orchestrator-stepper-single-rail.test.tsx` mounts the run panel ALONE,
 *     so it never sees the column the run surface's frame draws beside it;
 *   • `instance-screens-single-step-rail.test.ts` reads the screen's ownership
 *     predicate as TEXT (`fs.readFileSync`), so it never renders anything.
 *
 * The defect lives in neither component — it lives in the COMPOSITION, and only
 * a rendered page can see it. So this suite renders the real run page module,
 * `SetupScreen` from `instance-screens.tsx`, with a real-shaped run row, a real
 * gate and a real approval policy, and counts what the page actually draws. The
 * data layer is stubbed at the modules the screen reads, and nothing of the
 * rail's own composition is: the frame, the run panel, the page-level rail and
 * every row component are the real ones.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/run-page-composition-single-rail.test.tsx
 */
import React from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

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

const RUN_ID = "run-3478";

/**
 * THE RUN, AS THE STORE HOLDS IT — one row, mutated per reading, because the
 * two readings below are the SAME run at two moments of its life.
 */
const row = vi.hoisted(() => ({
  status: "pending_approval" as string,
  lifecycleMoment: "hitl" as string | null,
  lifecycleCardKind: "agent_hitl_screen" as string | null,
  lifecycleCardRef: "wayflow-task-1" as string | null,
  hitlContext: null as unknown,
  /** The input forms the agent declares — none for the finished-run reading. */
  required: ["idea", "audience"] as string[],
}));

/**
 * THE RUN'S REVIEW SLOT, AS THE READER ANSWERS IT — mutated per reading for the
 * same reason the row above is: a run WAITING at its review gate and a run whose
 * gate is settled are the same run at two moments, and the rail draws the run's
 * own record differently at each (cinatra#3478, third leg).
 */
const reviewSlot = vi.hoisted(() => ({
  awaiting: false,
  reviewTaskId: null as string | null,
}));

/**
 * THE RUN'S REVIEW GATES, AS THE RAIL'S OWN READER LISTS THEM — the gate ROW,
 * which is the thing that outlives the outbox window: `readRunReviewSlot`
 * answers `awaiting: false` the moment this row exists, decided or not, so a
 * run standing in front of an UNDECIDED gate is only visible here.
 */
const reviewGates = vi.hoisted(() => ({
  rows: [] as Array<{
    id: string;
    reviewTaskId: string;
    status: "pending" | "resolved";
    disposition: string | null;
    createdAt: Date;
  }>,
}));

/**
 * THE RUN'S TRIGGER ROW, AS THE STORE HOLDS IT (cinatra#3478, the re-cut's
 * first leg) — the one fact that says whether the run CARRIES A SCHEDULE, and
 * of which kind. `null` is a run that carries none; `releasedAt` is the fired
 * stamp the schedule's own record keeps, for an immediate fire as much as for a
 * scheduled one.
 */
const triggerRow = vi.hoisted(() => ({
  row: null as { triggerType: string; releasedAt: Date | null } | null,
}));

/** The trigger row of a run dispatched with "Run right after setup", fired. */
function firedImmediateTrigger() {
  return { triggerType: "immediate", releasedAt: new Date("2026-09-14T08:10:00Z") };
}

/** One gate row of the shape `listReviewGatesForRun` returns. */
function gateRow(status: "pending" | "resolved") {
  return {
    id: "gate-1",
    reviewTaskId: "task-review-1",
    status,
    disposition: status === "resolved" ? "approved" : null,
    createdAt: new Date("2026-09-13T12:00:00Z"),
  };
}

/** The gate the run is stopped at, as the screen derives it from the row. */
const STORED_IDEAS_GATE = {
  xRenderer: "cinatra/hitl-approval",
  currentValues: { storedIdeas: ["one", "two"] },
  fieldName: "storedIdeas",
  schema: { type: "object", properties: {} },
  reviewTaskId: "task-1",
};

const TEMPLATE = {
  id: "tmpl-3478",
  orgId: "org-1",
  creatorId: "user-1",
  name: "Blog Idea Generator",
  description: "",
  type: "orchestrator",
  sourceNl: "",
  compiledPlan: [],
  inputSchema: {
    properties: {
      idea: { type: "string", title: "idea" },
      audience: { type: "string", title: "audience" },
    },
    required: [] as string[],
  },
  outputSchema: null,
  taskSpec: null,
  status: "published",
  packageName: "@cinatra-ai/blog-idea-generator",
  packageVersion: "1.0.0",
  gatedSteps: [],
  triggerMode: "none",
  approvalPolicy: {
    steps: [
      { stepNumber: 1, xRenderer: "cinatra/review", name: "Draft the post" },
      { stepNumber: 2, xRenderer: "cinatra/review", name: "Pick the image" },
    ],
  },
  agentDependencies: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

/** The template, with the input forms this reading's agent declares. */
function makeTemplate() {
  return {
    ...TEMPLATE,
    inputSchema: { ...TEMPLATE.inputSchema, required: row.required },
  };
}

function makeRun() {
  return {
    id: RUN_ID,
    templateId: TEMPLATE.id,
    versionId: null,
    runBy: "user-1",
    status: row.status,
    inputParams: { idea: "a post about rails", audience: "developers" },
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

vi.mock("../artifact-review-gate-store", async () => {
  // cinatra#3046 — this screen also asks the store whether the run is parked on
  // the review its own output opened. That predicate is PURE: it answers from the
  // run row it is handed, so this factory hands the suite the REAL one (re-exported
  // by the store from its writer) instead of a stub that could answer differently
  // from the page under test.
  const hold = await vi.importActual<typeof import("../run-produced-review-hold")>(
    "../run-produced-review-hold",
  );
  return {
    listReviewGatesForRun: vi.fn(async () => reviewGates.rows),
    readReviewGate: vi.fn(async () => null),
    readRunReviewSlot: vi.fn(async () => ({
      reviewTaskId: reviewSlot.reviewTaskId,
      awaiting: reviewSlot.awaiting,
    })),
    readVerificationRecordsForGates: vi.fn(async () => []),
    isParkedOnProducedReview: hold.isParkedOnProducedReview,
  };
});

vi.mock("../lifecycle-policy-store", () => ({
  readLifecycleDecisionsForRun: vi.fn(async () => []),
}));

vi.mock("../recommendation-hold", () => ({
  readRecommendationParkForRun: vi.fn(async () => null),
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
  resolveTemplateInputSchema: vi.fn(async () => makeTemplate().inputSchema),
}));

// The run's own record reads what the run filed; a finished run asks for it.
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
  recommendationDecidedForRun: vi.fn(() => false),
  resolveRecommendationHoldStateForActor: vi.fn(async () => null),
}));

import { SetupScreen } from "../instance-screens";

/**
 * The run panel opens the run's event stream on mount. jsdom carries no
 * `EventSource`; the page is what is under test, not the transport, so it is
 * stubbed through vitest's own global stubbing and taken away again in
 * `afterAll` — this file leaves no global behind for the package's other suites
 * (the rail's own rule for a new test file).
 */
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

beforeEach(() => {
  vi.stubGlobal("EventSource", StubEventSource);
  row.status = "pending_approval";
  row.lifecycleMoment = "hitl";
  row.lifecycleCardKind = "agent_hitl_screen";
  row.lifecycleCardRef = "wayflow-task-1";
  row.hitlContext = STORED_IDEAS_GATE;
  row.required = ["idea", "audience"];
  reviewSlot.awaiting = false;
  reviewSlot.reviewTaskId = null;
  reviewGates.rows = [];
  triggerRow.row = null;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

/** Render the REAL run page for the row as it currently stands. */
async function renderRunPage() {
  const tree = await SetupScreen({ agentId: "blog-idea-generator", instanceId: RUN_ID });
  return render(tree as React.ReactElement);
}

/**
 * THE RAIL COLUMNS THE PAGE DRAWS.
 *
 * Every rail carries one of the two markers — `data-run-step-rail-column` (the
 * frame's own column) or `data-run-step-rail` (a rail panel). A rail panel
 * mounted INSIDE the frame's column is one rail drawn in two boxes, not two
 * rails, so a marked element that stands inside another marked element is not
 * counted: what a reader sees as "a column of steps" is a marked element with
 * no marked element above it.
 */
const RAIL_MARKERS = "[data-run-step-rail],[data-run-step-rail-column]";

function railColumns(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(RAIL_MARKERS)).filter(
    (el) => el.parentElement?.closest(RAIL_MARKERS) == null,
  );
}

/** Every entry of a rail column, in the order it is drawn. */
function railEntries(column: HTMLElement): string[] {
  return Array.from(
    column.querySelectorAll<HTMLElement>(
      // AND THE GATE ROWS THAT DRAW THEIR OWN ROW COMPONENT (cinatra#3478, the
      // re-cut's first leg). The schedule's row and the Skills row carry their
      // own anchors rather than the shared rail row's, so a rail read through
      // the shared anchor alone reported a rail those entries were missing
      // from — which is exactly the omission this leg fixes.
      "[data-run-surface-rail-step],[data-rail-kind],[data-rail-status]," +
        "[data-schedule-rail-step],[data-recommendation-rail-step]",
    ),
  )
    .filter((el) => el.parentElement?.closest("[data-run-surface-rail-step]") == null)
    .map((el) => (el.textContent ?? "").trim())
    .filter((text) => text.length > 0);
}

/** The same entries, read as the words a person sees — the rail's numerals
 *  belong to the series, not to the order this suite grades. */
function railEntryLabels(column: HTMLElement): string[] {
  return railEntries(column).map((text) => text.replace(/^\d+/, ""));
}

describe("the run page draws exactly one step rail (cinatra#3478)", () => {
  it("draws ONE rail column for a run parked at a gate on the stepper branch", async () => {
    const { container } = await renderRunPage();

    const columns = railColumns(container);
    // The live reading before this fix: 2 — the frame's column at the left and
    // the run panel's own column beside it, then the detail.
    expect(columns.length).toBe(1);
  });

  it("lists the run's steps in ONE numbered series with the pause inline", async () => {
    const { container } = await renderRunPage();

    const [column] = railColumns(container);
    expect(column).toBeDefined();
    const entries = railEntries(column);

    // The gate the run is stopped at, then the steps still to come — one list,
    // one series of numerals, in the run's own order. Before the fix these were
    // two lists in two columns, each numbered from 1.
    expect(entries).toEqual(["1Stored Ideas", "2Draft the post", "3Pick the image"]);
    expect(new Set(entries).size).toBe(entries.length);
  });

  it("keeps the run's own steps on the rail beside its answered setup forms", async () => {
    // The same run, past its setup forms and working: the frame carries the
    // answered forms, the run's work steps follow them in the same column.
    row.status = "running";
    row.lifecycleMoment = null;
    row.lifecycleCardKind = null;
    row.lifecycleCardRef = null;
    row.hitlContext = null;

    const { container } = await renderRunPage();

    const columns = railColumns(container);
    // The live reading before the first leg: 2 — "Setup Setup" in one column
    // and "1 Draft the post 2 Pick the image" in the other.
    expect(columns.length).toBe(1);
    const entries = railEntries(columns[0]);
    // AND EACH STEP ONCE (cinatra#3478, second leg). The first leg merged the
    // two columns and kept the reading the merged column then had, which still
    // carried "Setup" TWICE — the agent asks two inputs, neither declares a
    // name of its own, and both entries took the setup's own name. The drawing
    // lists "the run's steps in order", so the run's setup is one entry and the
    // work steps follow it.
    expect(entries).toEqual(["Setup", "2Draft the post", "3Pick the image"]);
    expect(new Set(entries).size).toBe(entries.length);
  });

  it("keeps the run's steps above the run's own record on a finished run", async () => {
    // The rail's LAST entry is the run's own record, and it is the only row the
    // frame carries here — the run declares no input form and holds no gate. It
    // is composed after the page's rows, so it is the one frame row that can be
    // missed when the screen decides where those rows are drawn.
    row.status = "completed";
    row.lifecycleMoment = null;
    row.lifecycleCardKind = null;
    row.lifecycleCardRef = null;
    row.hitlContext = null;
    row.required = [];

    const { container } = await renderRunPage();

    const columns = railColumns(container);
    // The live reading before this fix: 2 — "What this run made" alone in one
    // column and the run's work steps in the other.
    expect(columns.length).toBe(1);
    const entries = railEntries(columns[0]);
    expect(entries).toEqual(["1Draft the post", "2Pick the image", "What this run made"]);
  });

  it("draws the run's own record as a step still to come while its review gate waits", async () => {
    // THE THIRD PROOF ROUND'S FIRST FINDING (cinatra#3478). The run had made its
    // artifact and parked at the review gate, and the rail drew "What this run
    // made" as a step already passed — the completed circle, reached and settled
    // — for a record the run has not reached: the reader was told the run's work
    // was filed while the run was still waiting to be told whether to file it.
    //
    // The ratified drawing, the step rail: "The step the run is paused on is
    // highlighted; steps already passed sit above it, steps still to come
    // below." So the record stands on the rail, LAST, and is drawn as a step
    // still to come for as long as a gate is holding the run in front of it.
    row.status = "pending_approval";
    row.lifecycleMoment = null;
    row.lifecycleCardKind = null;
    row.lifecycleCardRef = null;
    row.hitlContext = null;
    row.required = ["idea"];
    reviewSlot.awaiting = true;
    reviewSlot.reviewTaskId = "task-review-1";

    const { container } = await renderRunPage();

    const columns = railColumns(container);
    expect(columns).toHaveLength(1);
    const [column] = columns;
    const rows = Array.from(
      column.querySelectorAll<HTMLElement>("[data-run-surface-rail-step]"),
    );
    const made = rows.find(
      (el) => el.getAttribute("data-run-surface-rail-step-key") === "made",
    );
    // It is on the rail, and it is BELOW the step the run is paused on: the last
    // row of the one column. The live reading before this fix: no such row at
    // all on this branch of the composition, and the completed circle on the
    // branch that did draw it.
    expect(made).toBeDefined();
    expect(rows[rows.length - 1]).toBe(made);
    // And it is not drawn as passed.
    expect(made!.getAttribute("data-run-surface-rail-reached")).toBe("false");
    expect(made!.getAttribute("data-run-surface-rail-settled")).toBe("false");
  });

  it("draws the run's own record as a step still to come while its gate is undecided", async () => {
    // THE SAME FINDING AT THE STATE THAT WAS ACTUALLY MEASURED (cinatra#3478,
    // third leg, convergence round). The gate ROW already exists and nobody has
    // answered it yet — so the outbox row the sweeper consumed is gone and the
    // run's review slot reads `awaiting: false`. This is the run whose page was
    // photographed with the record drawn as a step already passed, and the only
    // reading that discriminates it is the gate's own `pending` status.
    row.status = "completed";
    row.lifecycleMoment = null;
    row.lifecycleCardKind = null;
    row.lifecycleCardRef = null;
    row.hitlContext = null;
    row.required = [];
    reviewSlot.awaiting = false;
    reviewSlot.reviewTaskId = "task-review-1";
    reviewGates.rows = [gateRow("pending")];

    const { container } = await renderRunPage();

    const columns = railColumns(container);
    expect(columns).toHaveLength(1);
    const rows = Array.from(
      columns[0].querySelectorAll<HTMLElement>("[data-run-surface-rail-step]"),
    );
    const made = rows.find(
      (el) => el.getAttribute("data-run-surface-rail-step-key") === "made",
    );
    expect(made).toBeDefined();
    expect(rows[rows.length - 1]).toBe(made);
    expect(made!.getAttribute("data-run-surface-rail-reached")).toBe("false");
    expect(made!.getAttribute("data-run-surface-rail-settled")).toBe("false");
  });

  it("draws the run's own record as reached once that gate is decided", async () => {
    // THE OTHER HALF OF THE GATE READING: the decision is committed, the gate
    // row stays on the rail as read-only history, and the run HAS reached its
    // record — the completed circle belongs there.
    row.status = "completed";
    row.lifecycleMoment = null;
    row.lifecycleCardKind = null;
    row.lifecycleCardRef = null;
    row.hitlContext = null;
    row.required = [];
    reviewSlot.awaiting = false;
    reviewSlot.reviewTaskId = "task-review-1";
    reviewGates.rows = [gateRow("resolved")];

    const { container } = await renderRunPage();

    const columns = railColumns(container);
    expect(columns).toHaveLength(1);
    const made = Array.from(
      columns[0].querySelectorAll<HTMLElement>("[data-run-surface-rail-step]"),
    ).find((el) => el.getAttribute("data-run-surface-rail-step-key") === "made");
    expect(made).toBeDefined();
    expect(made!.getAttribute("data-run-surface-rail-reached")).toBe("true");
    expect(made!.getAttribute("data-run-surface-rail-settled")).toBe("true");
  });

  it("draws the run's own record as reached once the run is over and no gate waits", async () => {
    // THE OTHER HALF OF THE SAME RULE. The row's reading follows the run's own
    // status: a run that is over, with nothing holding it, HAS reached its
    // record, and the rail keeps the completed circle there.
    row.status = "completed";
    row.lifecycleMoment = null;
    row.lifecycleCardKind = null;
    row.lifecycleCardRef = null;
    row.hitlContext = null;
    row.required = [];

    const { container } = await renderRunPage();

    const columns = railColumns(container);
    expect(columns).toHaveLength(1);
    const [column] = columns;
    const made = Array.from(
      column.querySelectorAll<HTMLElement>("[data-run-surface-rail-step]"),
    ).find((el) => el.getAttribute("data-run-surface-rail-step-key") === "made");
    expect(made).toBeDefined();
    expect(made!.getAttribute("data-run-surface-rail-reached")).toBe("true");
    expect(made!.getAttribute("data-run-surface-rail-settled")).toBe("true");
  });
});

describe("a drawn control of a parked step takes a real click (cinatra#3478)", () => {
  it("stands under no second rail column, and its click draws its effect", async () => {
    row.status = "running";
    row.lifecycleMoment = null;
    row.lifecycleCardKind = null;
    row.lifecycleCardRef = null;
    row.hitlContext = null;

    const { container } = await renderRunPage();

    const detail = container.querySelector<HTMLElement>("[data-run-detail-column]");
    expect(detail).not.toBeNull();
    const openAtFirstPaint = detail!.getAttribute("data-run-surface-selected-step");

    // A drawn control of a step the run has reached — the row the reader
    // presses, not a box around it.
    const control = Array.from(
      container.querySelectorAll<HTMLElement>("[data-run-surface-rail-step]"),
    ).find(
      (el) =>
        el.getAttribute("data-run-surface-rail-step-key") !== openAtFirstPaint &&
        el.getAttribute("data-run-surface-rail-selectable") !== "false",
    );
    expect(control).toBeDefined();
    const key = control!.getAttribute("data-run-surface-rail-step-key");

    // THE HIT TEST, AS THIS ENVIRONMENT CAN MAKE IT. jsdom lays nothing out —
    // every `getBoundingClientRect()` is 0×0 and there is no point to resolve —
    // so the geometric half is measured on the live boot. What decides the
    // measured inertness is composition, and that is read here: the control's
    // own column is the ONLY rail column on the page, so no second column can
    // stand over the point a reader presses. Before this fix the page drew a
    // second one beside it.
    const columns = railColumns(container);
    expect(columns.length).toBe(1);
    expect(columns[0].contains(control!)).toBe(true);

    // And the press itself reaches the control and draws its effect: the step
    // it names opens in the run detail.
    fireEvent.pointerDown(control!);
    fireEvent.pointerUp(control!);
    fireEvent.click(control!);

    expect(detail!.getAttribute("data-run-surface-selected-step")).toBe(key);
  });
});

describe("the run's schedule heads the one rail (cinatra#3478)", () => {
  /**
   * WHAT THE THIRD PROOF ROUND OF THIS PULL REQUEST COUNTED. The run was
   * dispatched with "Run right after setup" and its page drew a merged rail
   * with NO Schedule entry on it at all: the page-level rail carried one, the
   * stepper's rail did not, and the first leg's merge of the two dropped it.
   *
   * The ratified drawing, `specs/app-artifact-review.html` section I: "Where the
   * run carries a schedule, the rail's first entry is Schedule, above the run's
   * work steps and above Review", and "A run set to Run right after setup or
   * Schedule for later is spent when it fires: its Schedule entry settles on
   * the rail".
   */
  it("lists Schedule FIRST, settled, for a run that fired Run right after setup", async () => {
    triggerRow.row = firedImmediateTrigger();
    row.status = "running";
    row.lifecycleMoment = null;
    row.lifecycleCardKind = null;
    row.lifecycleCardRef = null;
    row.hitlContext = null;

    const { container } = await renderRunPage();

    const columns = railColumns(container);
    // Still ONE column: the first leg's answer is not spent by this one.
    expect(columns.length).toBe(1);
    const labels = railEntryLabels(columns[0]);
    // The live reading at db8fb255: ["Setup", "Draft the post", "Pick the
    // image"] — the run's own schedule nowhere on the rail.
    expect(labels).toEqual(["Schedule", "Setup", "Draft the post", "Pick the image"]);
    // Each work step once, the schedule included.
    expect(new Set(labels).size).toBe(labels.length);

    // And it is drawn as the spent step it is: the completed circle, not a
    // numeral the reader would read as the step the run is standing on.
    const schedule = columns[0].querySelector<HTMLElement>("[data-schedule-rail-step]");
    expect(schedule).not.toBeNull();
    expect(schedule!.getAttribute("data-schedule-step-settled")).toBe("true");
  });

  it("stands the schedule above the pause and the run's own record", async () => {
    // The reading the proof cell photographs: the run fired its schedule, ran,
    // and is parked at its review gate. Schedule settled at the head, the run's
    // work beneath it, the record last and still to come.
    triggerRow.row = firedImmediateTrigger();
    row.status = "pending_approval";
    row.lifecycleMoment = null;
    row.lifecycleCardKind = null;
    row.lifecycleCardRef = null;
    row.hitlContext = null;
    // THE RUN THE CELL PHOTOGRAPHS ASKS ITS SETUP AND IS HELD AT ITS REVIEW
    // (convergence round 1): with no declared field and no gate row this
    // composition drew neither a Setup entry nor the pause, so a case that read
    // only the first and last entries graded a rail the cell never shows.
    row.required = ["idea"];
    reviewSlot.awaiting = true;
    reviewSlot.reviewTaskId = "task-review-1";

    const { container } = await renderRunPage();

    const columns = railColumns(container);
    expect(columns.length).toBe(1);
    const labels = railEntryLabels(columns[0]);
    // THE WHOLE RAIL, IN ORDER — the reading CELL1 photographs: the run's
    // schedule at the head, its setup once, the pause merged inline at the
    // point the run reached it, and the run's own record last.
    expect(labels).toEqual([
      "Schedule",
      "Setup",
      "Review",
      "Draft the post",
      "Pick the image",
      "What this run made",
    ]);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels[0]).toBe("Schedule");
    expect(labels[labels.length - 1]).toBe("What this run made");
    // The record is still to come while the gate holds the run — the third
    // leg's answer, unchanged by this one.
    const made = Array.from(
      columns[0].querySelectorAll<HTMLElement>("[data-run-surface-rail-step]"),
    ).find((el) => el.getAttribute("data-run-surface-rail-step-key") === "made");
    expect(made).toBeDefined();
    expect(made!.getAttribute("data-run-surface-rail-reached")).toBe("false");
  });

  it("draws NO Schedule entry for a run that carries no schedule", async () => {
    // "Where the run carries a schedule" is the whole condition: a run with no
    // trigger row has no schedule, and the rail invents none for it.
    triggerRow.row = null;
    row.status = "running";
    row.lifecycleMoment = null;
    row.lifecycleCardKind = null;
    row.lifecycleCardRef = null;
    row.hitlContext = null;

    const { container } = await renderRunPage();

    const columns = railColumns(container);
    expect(columns.length).toBe(1);
    expect(columns[0].querySelector("[data-schedule-rail-step]")).toBeNull();
    expect(railEntryLabels(columns[0])).toEqual([
      "Setup",
      "Draft the post",
      "Pick the image",
    ]);
  });

  it("leaves the schedule unsettled while it has not fired yet", async () => {
    // "settled once it fired" — and not before. A schedule still waiting is the
    // step the reader can still change, so it carries no completed circle.
    triggerRow.row = { triggerType: "scheduled", releasedAt: null };
    row.status = "running";
    row.lifecycleMoment = null;
    row.lifecycleCardKind = null;
    row.lifecycleCardRef = null;
    row.hitlContext = null;

    const { container } = await renderRunPage();

    const columns = railColumns(container);
    expect(columns.length).toBe(1);
    expect(railEntryLabels(columns[0])[0]).toBe("Schedule");
    const schedule = columns[0].querySelector<HTMLElement>("[data-schedule-rail-step]");
    expect(schedule).not.toBeNull();
    expect(schedule!.getAttribute("data-schedule-step-settled")).toBe("false");
  });

  it("keeps a fired RECURRING schedule an ordinary reachable row", async () => {
    // "A run set to Recurring is not spent — it has runs still to come — so its
    // Schedule entry stays an ordinary reachable row on the rail."
    triggerRow.row = { triggerType: "recurring", releasedAt: new Date("2026-09-14T08:10:00Z") };
    row.status = "running";
    row.lifecycleMoment = null;
    row.lifecycleCardKind = null;
    row.lifecycleCardRef = null;
    row.hitlContext = null;

    const { container } = await renderRunPage();

    const columns = railColumns(container);
    expect(columns.length).toBe(1);
    expect(railEntryLabels(columns[0])[0]).toBe("Schedule");
    const schedule = columns[0].querySelector<HTMLElement>("[data-schedule-rail-step]");
    expect(schedule).not.toBeNull();
    expect(schedule!.getAttribute("data-schedule-step-settled")).toBe("false");
  });

  it("draws ONE Schedule entry for a run parked at its schedule that holds a trigger row", async () => {
    // CONVERGENCE ROUND 1 (cinatra#3478, the re-cut's first leg). The block
    // that draws the schedule step of a run PARKED at its schedule was guarded
    // on "this run has no schedule CARD" — and a run dispatched with "Run right
    // after setup" holds a trigger row while resolving to no card, so once the
    // entry above is composed from the trigger row the two blocks pushed the
    // key "schedule" twice for one run.
    //
    // The live reading with the guard removed, measured on this composition:
    // ["1Schedule", "Setup", "3Schedule", "4Review", "5Draft the post",
    // "6Pick the image"] — two Schedule rows on one rail, both answering the
    // same selection, and a duplicate rail key with them.
    triggerRow.row = { triggerType: "immediate", releasedAt: null };
    row.status = "armed";
    row.lifecycleMoment = "schedule";
    row.lifecycleCardKind = null;
    row.lifecycleCardRef = null;
    row.hitlContext = null;

    const { container } = await renderRunPage();

    const columns = railColumns(container);
    expect(columns.length).toBe(1);
    const labels = railEntryLabels(columns[0]);
    expect(labels.filter((label) => label === "Schedule")).toHaveLength(1);
    expect(labels).toEqual(["Schedule", "Setup", "Review", "Draft the post", "Pick the image"]);
    // AND ONE NUMBERED SERIES WITH IT: no numeral drawn twice, and none out of
    // order. This is the reading that dies if the offset handed to the input
    // steps is dropped — the schedule and the first numbered work step would
    // both draw a 1.
    const numerals = railEntries(columns[0])
      .map((text) => /^(\d+)/.exec(text)?.[1])
      .filter((numeral): numeral is string => numeral != null)
      .map(Number);
    expect(numerals).toEqual([...new Set(numerals)]);
    expect(numerals).toEqual([...numerals].sort((a, b) => a - b));
    expect(numerals[0]).toBe(1);
  });
});
