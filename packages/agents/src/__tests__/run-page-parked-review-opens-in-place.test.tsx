// @vitest-environment jsdom
/**
 * THE PARKED REVIEW OPENS AS THE RUN PAGE'S OWN STEP SCREEN (cinatra#3478).
 *
 * WHAT THE PROOF ROUND OF 2026-09-14 MEASURED, verbatim from its record: "the
 * run page draws one step rail in the right order and the paused step's control
 * reacts to a real click, but that click opens the review as its own separate
 * page instead of inside the run detail under the same rail."
 *
 * The ratified drawing (`specs/app-artifact-review.html`) states the reading
 * twice, in section I and again in section I's review paragraph:
 *
 *   "Selecting a step opens it on the right ... a gate step opens the gate's
 *    own surface in place — a pending review renders the review gate (§III–§VII)
 *    right here in the run detail, under the same rail, never as a standalone
 *    document."
 *
 *   "A review is a step, and it opens where every step opens. A review that
 *    pauses the run is an entry on the rail, and selecting it opens the review
 *    in place, in the run detail (§I)."
 *
 * WHY A RENDERED PAGE AND NOT THE ROW ALONE. The row's own suites mount the
 * rail without the run surface's frame around it, so they cannot see what a
 * press DOES to the page: the rail, the run detail and the selection between
 * them are one composition, and only the composition answers "the location
 * stayed on the run page and the review is what the detail now draws". So this
 * suite renders the real run page module, `SetupScreen` from
 * `instance-screens.tsx`, with a real-shaped run parked at a real review gate.
 * The data layer is stubbed at the modules the screen reads; nothing of the
 * rail, the frame, the run panel or the selection is.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/run-page-parked-review-opens-in-place.test.tsx
 */
import React from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { ARTIFACT_REVIEW_REDIRECT_RENDERER_ID } from "../agent-builder-ids";

/** The router this page is given — asked, at the end, whether it was ever used. */
const routerPush = vi.hoisted(() => vi.fn());
const routerReplace = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound");
  },
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  useRouter: () => ({ push: routerPush, replace: routerReplace, refresh: vi.fn() }),
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

/**
 * THE ONE REVIEW CARD, stubbed so this suite's assertion is "the run detail
 * mounts THE review gate's card", not a second test of what that card draws
 * (which has its own suites). The same stub the review-gate branch's suite uses.
 */
vi.mock("../review-gate-card", () => ({
  LIFECYCLE_VIEW_SCHEMA_VERSION: 1,
  ReviewGateCard: ({ view }: { view?: { ref?: string } }) => (
    <div data-testid="review-gate-card" data-card-ref={view?.ref} />
  ),
}));

/** §VII's audit card, stubbed for the same reason. */
vi.mock("../verification-summary-card", () => ({
  VerificationSummaryCard: ({ view }: { view?: { ref?: string } }) => (
    <div data-testid="verification-summary-card" data-card-ref={view?.ref} />
  ),
}));

// The gate refs the screen mints are authenticated-encrypted under the app
// secret, and a run whose instance cannot mint one draws no card at all. This
// suite is about the rows and what they open, so the secret is present.
process.env.BETTER_AUTH_SECRET ??= "test-secret-for-3693-review-rows";

const RUN_ID = "run-3478";
const REVIEW_TASK_ID = "task-review-1";

/** The run, as the store holds it. */
const row = vi.hoisted(() => ({
  status: "pending_approval" as string,
  required: ["idea"] as string[],
}));

/** The run's review gates, as the rail's own reader lists them. */
const reviewGates = vi.hoisted(() => ({
  rows: [] as Array<{
    id: string;
    reviewTaskId: string;
    status: "pending" | "resolved";
    disposition: string | null;
    createdAt: Date;
  }>,
}));

function gateRow(status: "pending" | "resolved") {
  return {
    id: "gate-1",
    reviewTaskId: REVIEW_TASK_ID,
    status,
    disposition: status === "resolved" ? "approved" : null,
    createdAt: new Date("2026-09-14T12:00:00Z"),
  };
}

/** The run's post-change audit records, as §VII's reader lists them. */
const verifications = vi.hoisted(() => ({
  rows: [] as Array<{ gateId: string; outcome: string }>,
}));

/** The live gate the run is parked at, as the stream delivers it. */
const stream = vi.hoisted(() => ({
  interruptContext: null as unknown,
}));

function markedReviewGate() {
  return {
    schema: { type: "object" },
    xRenderer: ARTIFACT_REVIEW_REDIRECT_RENDERER_ID,
    values: {
      reviewSurfaceUrl: `/agents/blog-idea-generator/${RUN_ID}/review/${REVIEW_TASK_ID}`,
      reviewTaskId: REVIEW_TASK_ID,
      lifecycleCardRef: "server-minted-ref",
      targetCount: 1,
      agentSummary: "",
    },
    reviewTaskId: REVIEW_TASK_ID,
  };
}

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
    properties: { idea: { type: "string", title: "idea" } },
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

function makeTemplate() {
  return { ...TEMPLATE, inputSchema: { ...TEMPLATE.inputSchema, required: row.required } };
}

function makeRun() {
  return {
    id: RUN_ID,
    templateId: TEMPLATE.id,
    versionId: null,
    runBy: "user-1",
    status: row.status,
    inputParams: { idea: "a post about rails" },
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
    // The run has run: it produced the work the gate is holding.
    streamedText: "The draft the run produced.",
    authPolicy: null,
    orgId: "org-1",
    projectId: null,
    idempotencyKey: null,
    oboCeiling: null,
    dependentInstallId: null,
    humanPresent: true,
    lifecycleMoment: null,
    lifecycleCardKind: null,
    lifecycleCardRef: null,
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

vi.mock("../started-run-store", () => ({
  readStartedRunsFor: vi.fn(async () => []),
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
    readRunReviewSlot: vi.fn(async () => ({ reviewTaskId: null, awaiting: false })),
    readVerificationRecordsForGates: vi.fn(async () => verifications.rows),
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
  deriveRunHitlContext: vi.fn(async () => null),
}));

vi.mock("../run-actions", () => ({
  createAndTriggerRunWithContext: vi.fn(async () => ({ ok: false })),
  buildSubmissionMapByStepIndex: vi.fn(async () => []),
  createAndTriggerRun: vi.fn(async () => ({ ok: false })),
  readRunOutputEvidence: vi.fn(async () => ({ hasOutput: false, hasArtifacts: false })),
}));

vi.mock("../trigger-store", () => ({
  readRunTriggerByRunId: vi.fn(async () => ({
    triggerType: "immediate",
    releasedAt: new Date("2026-09-14T11:00:00Z"),
  })),
}));

vi.mock("../trigger-schedule-proposal-store", () => ({
  readProposalConsumeByRunId: vi.fn(async () => null),
}));

vi.mock("../input-schema-resolver", () => ({
  resolveTemplateInputSchema: vi.fn(async () => makeTemplate().inputSchema),
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
  recommendationDecidedForRun: vi.fn(() => false),
  resolveRecommendationHoldStateForActor: vi.fn(async () => null),
}));

/** The run's live stream — the gate it is parked at reaches the panel here. */
vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: (_runId: string, opts: { initialStatus?: string }) => ({
    status: opts?.initialStatus ?? "pending_approval",
    interruptContext: stream.interruptContext,
    lifecycleInterrupt: null,
    messages: [],
    streamedText: "",
    presentationHint: null,
    dataPartFrames: [],
    isLive: true,
    error: null,
  }),
}));

import { AGENTS_NAV } from "@/lib/agents-nav";
import { SetupScreen } from "../instance-screens";

/** jsdom carries no `EventSource`; the page is what is under test. */
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
  row.required = ["idea"];
  reviewGates.rows = [gateRow("pending")];
  verifications.rows = [];
  stream.interruptContext = markedReviewGate();
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
async function renderRunPage(searchParams?: Record<string, string | string[] | undefined>) {
  const tree = await SetupScreen({
    agentId: "blog-idea-generator",
    instanceId: RUN_ID,
    searchParams,
  });
  return render(tree as React.ReactElement);
}

const RAIL_MARKERS = "[data-run-step-rail],[data-run-step-rail-column]";

function railColumn(container: HTMLElement): HTMLElement {
  const columns = Array.from(container.querySelectorAll<HTMLElement>(RAIL_MARKERS)).filter(
    (el) => el.parentElement?.closest(RAIL_MARKERS) == null,
  );
  expect(columns).toHaveLength(1);
  return columns[0]!;
}

/** Every entry of the one rail, as the words a person reads down it. */
function railEntryLabels(column: HTMLElement): string[] {
  return Array.from(
    column.querySelectorAll<HTMLElement>(
      "[data-run-surface-rail-step],[data-rail-kind],[data-rail-status]," +
        "[data-schedule-rail-step],[data-recommendation-rail-step]",
    ),
  )
    .filter((el) => el.parentElement?.closest("[data-run-surface-rail-step]") == null)
    .map((el) => (el.textContent ?? "").trim())
    .filter((text) => text.length > 0)
    .map((text) => text.replace(/^\d+/, ""));
}

/** The row of the gate the run is parked on, and the control inside it. */
function parkedGateRow(column: HTMLElement): HTMLElement {
  const gate = column.querySelector<HTMLElement>('[data-rail-gate-pending="true"]');
  expect(gate, "the rail carries the gate the run is parked on").not.toBeNull();
  return gate!;
}

function parkedGateControl(column: HTMLElement): HTMLElement {
  const row = parkedGateRow(column);
  const control = row.querySelector<HTMLElement>('a[href],button,[role="tab"]');
  expect(control, "the parked step draws a control a reader can press").not.toBeNull();
  return control!;
}

function detailColumn(container: HTMLElement): HTMLElement {
  const detail = container.querySelector<HTMLElement>("[data-run-detail-column]");
  expect(detail).not.toBeNull();
  return detail!;
}

/** A real pointer press on a drawn control. */
function press(control: HTMLElement) {
  fireEvent.pointerDown(control);
  fireEvent.pointerUp(control);
  fireEvent.click(control);
}

describe("the parked review opens in the run detail, under the same rail (cinatra#3478)", () => {
  it("shows the review as that step's screen after a real click on its control", async () => {
    const { container } = await renderRunPage();
    const detail = detailColumn(container);
    const column = railColumn(container);

    // The reader opens another step of the run first — the answered setup form,
    // an ordinary row of this same rail — so that what the press on the parked
    // step does is visible rather than already on screen.
    const otherStep = Array.from(
      column.querySelectorAll<HTMLElement>("[data-run-surface-rail-step]"),
    ).find((el) => el.getAttribute("data-run-surface-rail-step-key")?.startsWith("input:"));
    expect(otherStep, "the run's answered setup form stands on the rail").toBeDefined();
    press(otherStep!);
    await waitFor(() =>
      expect(detail.getAttribute("data-run-surface-selected-step")).toBe(
        otherStep!.getAttribute("data-run-surface-rail-step-key"),
      ),
    );
    expect(detail.querySelector('[data-testid="review-gate-card"]')).toBeNull();

    const railBefore = railEntryLabels(column);
    const locationBefore = window.location.href;

    // THE PRESS THE PROOF ROUND MADE: the parked step's own drawn control.
    const control = parkedGateControl(column);
    press(control);

    // THE REVIEW IS THE STEP'S SCREEN, in the run detail beside the rail. The
    // live reading at 0c646866: the detail still carried the step opened above,
    // because the press had gone to the review's own page instead.
    await waitFor(() =>
      expect(detail.querySelector('[data-testid="review-gate-card"]')).not.toBeNull(),
    );
    expect(detail.getAttribute("data-run-surface-selected-step")).toBe("detail");

    // AND THE CONTROL IS NOT A ROAD OFF THIS PAGE. At 0c646866 it was an anchor
    // into the review's own route, which is what took the reader off the run.
    expect(control.closest("a[href]")).toBeNull();

    // AND THE LOCATION STAYED ON THE RUN PAGE: nothing navigated, by anchor or
    // by router.
    expect(window.location.href).toBe(locationBefore);
    expect(routerPush).not.toHaveBeenCalled();
    expect(routerReplace).not.toHaveBeenCalled();

    // AND THE ONE RAIL IS UNCHANGED BY THE PRESS — same column, same entries in
    // the same order, the pause still the entry the run is parked on.
    const columnAfter = railColumn(container);
    // The same column, not merely one that reads the same: the rail was not
    // taken down and put back by the press.
    expect(columnAfter).toBe(column);
    expect(railEntryLabels(columnAfter)).toEqual(railBefore);
    expect(new Set(railBefore).size).toBe(railBefore.length);
    expect(railBefore[0]).toBe("Schedule");
    expect(railBefore[railBefore.length - 1]).toBe("What this run made");
    const gate = parkedGateRow(columnAfter);
    expect(gate.getAttribute("data-rail-status")).toBe("pending");
    expect(gate.getAttribute("data-rail-kind")).toBe("gate");

    // AND THE STEP THE REVIEW BELONGS TO READS CURRENT. "The step's screen
    // replaces the body" and the rail marks the step it is the screen of, in
    // the same vocabulary the spine rows of this rail use (`aria-current` and
    // the selected anchor) -- so one reading of the rail answers for every row
    // of it. Exactly one row reads current: with the review on the detail, no
    // spine row does.
    expect(control.getAttribute("aria-current")).toBe("step");
    expect(control.getAttribute("data-run-surface-rail-selected")).toBe("true");
    expect(
      columnAfter.querySelector(
        '[data-run-surface-rail-step][data-run-surface-rail-selected="true"]',
      ),
    ).toBeNull();
  });

  it("opens that same screen from the keyboard — Enter and Space on the control", async () => {
    // The control the row draws is the one a reader presses, by pointer or by
    // key. The row it replaces was a link, which opened on Enter; the row that
    // stands in its place opens the step's screen on Enter and on Space, and
    // the location stays on the run page either way.
    for (const key of ["Enter", " "]) {
      const { container } = await renderRunPage();
      const detail = detailColumn(container);
      const column = railColumn(container);

      const otherStep = Array.from(
        column.querySelectorAll<HTMLElement>("[data-run-surface-rail-step]"),
      ).find((el) => el.getAttribute("data-run-surface-rail-step-key")?.startsWith("input:"));
      press(otherStep!);
      await waitFor(() =>
        expect(detail.getAttribute("data-run-surface-selected-step")).toBe(
          otherStep!.getAttribute("data-run-surface-rail-step-key"),
        ),
      );
      expect(detail.querySelector('[data-testid="review-gate-card"]')).toBeNull();

      const control = parkedGateControl(column);
      const locationBefore = window.location.href;
      control.focus();
      fireEvent.keyDown(control, { key });
      fireEvent.keyUp(control, { key });

      await waitFor(() =>
        expect(detail.querySelector('[data-testid="review-gate-card"]')).not.toBeNull(),
      );
      expect(detail.getAttribute("data-run-surface-selected-step")).toBe("detail");
      expect(window.location.href).toBe(locationBefore);
      expect(routerPush).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it("keeps no Reviews tab on the Agents strip", async () => {
    // C29. The owner retired the Reviews list (cinatra#3693): "reviews are
    // reached through the Notifications page for every scope, so the
    // workspace-wide Reviews tab under `/agents` and the standalone review page
    // go away".
    expect(AGENTS_NAV.some((tab) => tab.href === "/agents/reviews" || tab.label === "Reviews")).toBe(
      false,
    );
  });
});

/**
 * AND SO DOES EVERY OTHER REVIEW ROW ON THE RAIL (cinatra#3693).
 *
 * The click leg gave the PARKED gate its in-place control and left the other two
 * rows navigating: a settled gate still opened the review's own page, and an
 * Audit row still deep-linked into that page's verification reading. The
 * drawings give neither a page — "a pending review renders the review gate in
 * the run detail, under the same rail, never as a standalone document", and
 * "there is no review page view outside the run's route" — so both rows select a
 * step of the run detail, and the run page draws the reading there.
 */
describe("a settled gate and its audit read in place too (cinatra#3693)", () => {
  /** A run that is over, with one decided gate on its rail. */
  function aSettledRun() {
    reviewGates.rows = [gateRow("resolved")];
    stream.interruptContext = null;
    row.status = "completed";
  }

  it("the settled gate's row is a control, and pressing it draws the settled card in place", async () => {
    aSettledRun();
    const { container } = await renderRunPage();
    const column = railColumn(container);
    const detail = detailColumn(container);

    const history = column.querySelector<HTMLElement>('[data-rail-gate-history="true"]');
    expect(history, "the decided gate keeps its place on the rail").not.toBeNull();

    // NOT A ROAD OFF THIS PAGE. The row used to be an anchor into the review's
    // own route, which is exactly what took the reader off the run.
    expect(history!.querySelector("a[href]")).toBeNull();
    expect(history!.querySelector("[data-rail-gate-link]")).toBeNull();

    const control = history!.querySelector<HTMLElement>("button[data-rail-gate-open]");
    expect(control, "the settled row draws a control a reader can press").not.toBeNull();
    expect(control!.getAttribute("data-rail-gate-open")).toBe(REVIEW_TASK_ID);

    const locationBefore = window.location.href;
    press(control!);

    await waitFor(() =>
      expect(detail.getAttribute("data-run-surface-selected-step")).toBe(
        `review:${REVIEW_TASK_ID}`,
      ),
    );
    // The settled reading is the shipped card, drawn in the run detail beside
    // the rail — the reading the review page drew.
    const cards = detail.querySelectorAll('[data-testid="review-gate-card"]');
    expect(cards).toHaveLength(1);
    expect(cards[0]!.getAttribute("data-card-ref")).toBeTruthy();

    // AND THE LOCATION STAYED ON THE RUN PAGE.
    expect(window.location.href).toBe(locationBefore);
    expect(routerPush).not.toHaveBeenCalled();
    expect(routerReplace).not.toHaveBeenCalled();

    // AND THE ROW READS CURRENT while its screen is the one drawn, in the same
    // vocabulary the spine rows of this rail use.
    expect(control!.getAttribute("aria-current")).toBe("step");
    expect(control!.getAttribute("data-run-surface-rail-selected")).toBe("true");
  });

  it("opens that same settled reading from the keyboard — Enter and Space", async () => {
    for (const key of ["Enter", " "]) {
      aSettledRun();
      const { container } = await renderRunPage();
      const column = railColumn(container);
      const detail = detailColumn(container);
      const control = column.querySelector<HTMLElement>("button[data-rail-gate-open]");
      expect(control, `the settled row is pressable for ${key}`).not.toBeNull();

      const locationBefore = window.location.href;
      control!.focus();
      fireEvent.keyDown(control!, { key });
      fireEvent.keyUp(control!, { key });

      await waitFor(() =>
        expect(detail.getAttribute("data-run-surface-selected-step")).toBe(
          `review:${REVIEW_TASK_ID}`,
        ),
      );
      expect(detail.querySelector('[data-testid="review-gate-card"]')).not.toBeNull();
      expect(window.location.href).toBe(locationBefore);
      expect(routerPush).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it("the Audit row is a control, and pressing it draws that record's card in place", async () => {
    aSettledRun();
    verifications.rows = [{ gateId: "gate-1", outcome: "clean" }];

    const { container } = await renderRunPage();
    const column = railColumn(container);
    const detail = detailColumn(container);

    const auditRow = column.querySelector<HTMLElement>('[data-rail-verification="true"]');
    expect(auditRow, "the rail carries the gate's Audit entry").not.toBeNull();
    expect(auditRow!.querySelector("a[href]")).toBeNull();
    expect(auditRow!.querySelector("[data-rail-verification-link]")).toBeNull();

    const control = auditRow!.querySelector<HTMLElement>("button[data-rail-verification-open]");
    expect(control, "the Audit row draws a control a reader can press").not.toBeNull();
    expect(control!.getAttribute("data-rail-verification-open")).toBe(REVIEW_TASK_ID);

    const locationBefore = window.location.href;
    press(control!);

    await waitFor(() =>
      expect(detail.getAttribute("data-run-surface-selected-step")).toBe(
        `audit:${REVIEW_TASK_ID}`,
      ),
    );
    // ONE record, ONE card: the row stands for one audit, not for the column of
    // every audit the run carries.
    expect(detail.querySelectorAll('[data-testid="verification-summary-card"]')).toHaveLength(1);
    expect(window.location.href).toBe(locationBefore);
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("opens the Audit reading from the keyboard too", async () => {
    for (const key of ["Enter", " "]) {
      aSettledRun();
      verifications.rows = [{ gateId: "gate-1", outcome: "clean" }];
      const { container } = await renderRunPage();
      const detail = detailColumn(container);
      const control = railColumn(container).querySelector<HTMLElement>(
        "button[data-rail-verification-open]",
      );
      expect(control, `the Audit row is pressable for ${key}`).not.toBeNull();
      control!.focus();
      fireEvent.keyDown(control!, { key });
      fireEvent.keyUp(control!, { key });
      await waitFor(() =>
        expect(detail.getAttribute("data-run-surface-selected-step")).toBe(
          `audit:${REVIEW_TASK_ID}`,
        ),
      );
      cleanup();
    }
  });

  it("the rail draws ONE row per entry — a step with no row of its own adds none", async () => {
    // The two selections above are steps the SCREEN hands the frame, and their
    // rows are drawn by the rail's own entry component from the run's gate list.
    // A frame that also drew a row for them would put the same entry on the rail
    // twice, and a separator over nothing between them.
    aSettledRun();
    verifications.rows = [{ gateId: "gate-1", outcome: "clean" }];
    const { container } = await renderRunPage();
    const column = railColumn(container);
    expect(column.querySelectorAll('[data-rail-gate-history="true"]')).toHaveLength(1);
    expect(column.querySelectorAll('[data-rail-verification="true"]')).toHaveLength(1);
    const labels = railEntryLabels(column);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

/**
 * THE ADDRESS CARRIES THE SELECTION (cinatra#3693).
 *
 * A reader sent to one review — from a notification, from the run engine's own
 * interrupt, from the admin console — arrives at the RUN's address with the step
 * named on it. The run detail has to open there at FIRST render, or the reader
 * lands on whatever step the run would otherwise have elected and has to find
 * the review themselves.
 */
describe("the run page opens on the step its address names (cinatra#3693)", () => {
  function aSettledRun() {
    reviewGates.rows = [gateRow("resolved")];
    stream.interruptContext = null;
    row.status = "completed";
  }

  it("lands with the settled gate already selected and drawn", async () => {
    aSettledRun();
    const { container } = await renderRunPage({ step: `review:${REVIEW_TASK_ID}` });
    const detail = detailColumn(container);
    expect(detail.getAttribute("data-run-surface-selected-step")).toBe(
      `review:${REVIEW_TASK_ID}`,
    );
    expect(detail.querySelector('[data-testid="review-gate-card"]')).not.toBeNull();
  });

  it("lands with the audit reading already selected and drawn", async () => {
    aSettledRun();
    verifications.rows = [{ gateId: "gate-1", outcome: "clean" }];
    const { container } = await renderRunPage({ step: `audit:${REVIEW_TASK_ID}` });
    const detail = detailColumn(container);
    expect(detail.getAttribute("data-run-surface-selected-step")).toBe(`audit:${REVIEW_TASK_ID}`);
    expect(detail.querySelectorAll('[data-testid="verification-summary-card"]')).toHaveLength(1);
  });

  it("lands on the review a PENDING gate's address names, drawn in the run detail", async () => {
    // WHAT THE CONVERGENCE ROUND CAUGHT (finding 2). Both roads that mint this
    // address — the run engine's interrupt and a review notification — mint it
    // while the gate is still PENDING, and a pending gate has no step of its own:
    // it is the run detail's own reading. The named key matched no composed step,
    // so the frame fell back to the first row it could open — a settled Schedule
    // row — and the reader landed nowhere near the review they were sent to.
    const { container } = await renderRunPage({ step: `review:${REVIEW_TASK_ID}` });
    const detail = detailColumn(container);
    expect(detail.getAttribute("data-run-surface-selected-step")).toBe("detail");
    expect(detail.querySelector('[data-testid="review-gate-card"]')).not.toBeNull();
  });

  it("falls back to the run's own election for a step the run does not carry", async () => {
    // The address is READ, never trusted: a step this run has no row for cannot
    // be opened, so the page opens where it would have opened anyway.
    aSettledRun();
    const { container } = await renderRunPage({ step: "review:a-gate-this-run-never-had" });
    const detail = detailColumn(container);
    expect(detail.getAttribute("data-run-surface-selected-step")).not.toBe(
      "review:a-gate-this-run-never-had",
    );
  });

  it("falls back for a value outside the rail's vocabulary, and for a repeated key", async () => {
    aSettledRun();
    const values: Array<string | string[]> = [
      "../../etc/passwd",
      "",
      "review:",
      ["review:a", "review:b"],
    ];
    for (const step of values) {
      const { container } = await renderRunPage({ step });
      const selected = detailColumn(container).getAttribute("data-run-surface-selected-step");
      expect(selected).not.toBeNull();
      expect(selected).not.toContain("etc/passwd");
      cleanup();
    }
  });
});
