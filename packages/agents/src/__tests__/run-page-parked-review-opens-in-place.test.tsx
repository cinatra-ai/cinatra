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
  ReviewGateCard: () => <div data-testid="review-gate-card" />,
}));

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
  listReviewGatesForRun: vi.fn(async () => reviewGates.rows),
  readReviewGate: vi.fn(async () => null),
  readRunReviewSlot: vi.fn(async () => ({ reviewTaskId: null, awaiting: false })),
  readVerificationRecordsForGates: vi.fn(async () => []),
}));

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
async function renderRunPage() {
  const tree = await SetupScreen({ agentId: "blog-idea-generator", instanceId: RUN_ID });
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
    // ONE NODE PER ENTRY. A panel entry draws a wrapper that stands for the
    // entry (`data-rail-kind`) with its own ROW inside it, and the row is where
    // the rail's state marks sit (run-step-rail-extra-entry) -- so the union
    // above matches the entry twice. The node that stands for the entry is the
    // one kept; anything nested inside it is the same entry read again.
    .filter((el) => el.parentElement?.closest("[data-rail-kind]") == null)
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
    // THE READING IS KEYED ON THE ENTRY, the way the collapsing predicate above
    // is: an entry marks its state on the ROW it draws inside its wrapper, so a
    // spine row is a marked row that stands inside no entry at all.
    expect(control.getAttribute("aria-current")).toBe("step");
    expect(control.getAttribute("data-run-surface-rail-selected")).toBe("true");
    const current = Array.from(
      columnAfter.querySelectorAll<HTMLElement>(
        '[data-run-surface-rail-step][data-run-surface-rail-selected="true"]',
      ),
    );
    expect(current.filter((el) => el.closest("[data-rail-kind]") == null)).toEqual([]);
    expect(current).toEqual([control]);
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

  it("keeps the review's own page reachable — Agents → Reviews, and the settled gate's link", async () => {
    // C29. Nothing of the review's own navigation is touched by this leg: the
    // Agents tab strip still carries Reviews, and a gate the run has already
    // decided keeps the deep link that replays it read-only on that page.
    expect(
      AGENTS_NAV.some((tab) => tab.href === "/agents/reviews" && tab.label === "Reviews"),
    ).toBe(true);

    reviewGates.rows = [gateRow("resolved")];
    stream.interruptContext = null;
    row.status = "completed";

    const { container } = await renderRunPage();
    const column = railColumn(container);
    const history = column.querySelector<HTMLElement>('[data-rail-gate-history="true"]');
    expect(history).not.toBeNull();
    expect(
      history!.querySelector<HTMLAnchorElement>("a[data-rail-gate-link]")?.getAttribute("href"),
    ).toBe(`/agents/blog-idea-generator/${RUN_ID}/review/${REVIEW_TASK_ID}`);
  });
});
