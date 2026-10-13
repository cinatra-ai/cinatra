// @vitest-environment jsdom
/**
 * A gate opened after first paint reaches the REAL run page rail (#3942).
 *
 * Adapted from the existing run-page-parked-review-opens-in-place harness.
 * Store/transport seams are stubbed; SetupScreen, both run panel hosts, the
 * merged rail builder and every rail row stay real. The card renderer alone
 * remains the existing marker stub because its own decision rendering has
 * separate suites. router.refresh receives a fresh REAL SetupScreen response
 * and updates the mounted tree, exactly the RSC seam this defect needs.
 */
import React, { useSyncExternalStore } from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";

import { ARTIFACT_REVIEW_REDIRECT_RENDERER_ID } from "../agent-builder-ids";

/** The router this page is given — asked, at the end, whether it was ever used. */
const routerPush = vi.hoisted(() => vi.fn());
const routerReplace = vi.hoisted(() => vi.fn());
const routerRefresh = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound");
  },
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  useRouter: () => ({ push: routerPush, replace: routerReplace, refresh: routerRefresh }),
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

const RUN_ID = "run-3942";
const REVIEW_TASK_ID = "task-review-1";

/** The run, as the store holds it. */
const row = vi.hoisted(() => ({
  status: "pending_approval" as string,
  required: [] as string[],
  templateType: "orchestrator" as "orchestrator" | "agent",
  awaiting: true,
  producedReviewPark: false,
  openGateDuringSlotRead: false,
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

function gateRow(status: "pending" | "resolved", taskId = REVIEW_TASK_ID) {
  return {
    id: `gate-${taskId}`,
    reviewTaskId: taskId,
    status,
    disposition: status === "resolved" ? "approved" : null,
    createdAt: new Date("2026-09-14T12:00:00Z"),
  };
}

/** The run's post-change audit records, as §VII's reader lists them. */
const verifications = vi.hoisted(() => ({
  rows: [] as Array<{ gateId: string; outcome: string }>,
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
  id: "tmpl-3942",
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
  return {
    ...TEMPLATE,
    type: row.templateType,
    approvalPolicy: row.templateType === "agent" ? { steps: [] } : TEMPLATE.approvalPolicy,
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
    inputParams: { idea: "a post about rails" },
    producedReviewPark: row.producedReviewPark ? { status: "completed" } : null,
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

// The merged page reads its run-made artifacts as well; keep that datastore
// seam inert while asserting the real review rail and panel composition.
vi.mock("@/lib/artifacts/run-made-artifacts", () => ({
  listRunMadeArtifacts: vi.fn(async () => []),
}));

vi.mock("../artifact-review-gate-store", async () => ({
  isParkedOnProducedReview: (await import("../run-produced-review-hold")).isParkedOnProducedReview,
  listReviewGatesForRun: vi.fn(async () => reviewGates.rows),
  readReviewGate: vi.fn(async () => null),
  readRunReviewSlot: vi.fn(async () => {
    // A sweeper may open the gate after the rail query in this SAME render.
    if (row.openGateDuringSlotRead) {
      row.openGateDuringSlotRead = false;
      reviewGates.rows = [gateRow("pending")];
    }
    return {
      reviewTaskId: reviewGates.rows.at(-1)?.reviewTaskId ?? null,
      awaiting: row.awaiting,
    };
  }),
  readVerificationRecordsForGates: vi.fn(async () => verifications.rows),
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

vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({ connectedApps: [], gmailAliases: [] })),
  getSkillsForAgentAction: vi.fn(async () => []),
  getAuditAvailabilityAction: vi.fn(async () => ({ visible: false, promptCount: 0, skillCount: 0 })),
  getRunRecommendedSkillsAction: vi.fn(async () => []),
  confirmRunSkillSelectionAction: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../run-recommendation-core", () => ({
  recommendationDecidedForRun: vi.fn(() => false),
  resolveRecommendationHoldStateForActor: vi.fn(async () => null),
}));

/** Transport-only stub: real panels subscribe, and a later SSE reading rerenders them. */
const live = vi.hoisted(() => ({
  snapshot: {
    status: "completed" as string,
    interruptContext: null as unknown,
    lifecycleInterrupt: null,
    messages: [],
    streamedText: "",
    presentationHint: null,
    dataPartFrames: [],
    isLive: true,
    error: null,
  },
  listeners: new Set<() => void>(),
}));
vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: () => useSyncExternalStore(
    (changed) => { live.listeners.add(changed); return () => { live.listeners.delete(changed); }; },
    () => live.snapshot,
  ),
}));

import { SetupScreen } from "../instance-screens";
import { AgenticRunPanel } from "../agentic-run-panel";
import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";

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


let fetches: ReturnType<typeof vi.fn>;
let renders: Mock<() => ReturnType<typeof SetupScreen>>;
let refreshWork: Promise<void> | null = null;

beforeEach(() => {
  vi.stubGlobal("EventSource", StubEventSource);
  row.status = "completed";
  row.required = [];
  row.templateType = "orchestrator";
  row.awaiting = true;
  row.producedReviewPark = false;
  row.openGateDuringSlotRead = false;
  reviewGates.rows = [];
  verifications.rows = [];
  live.snapshot = { ...live.snapshot, status: "completed", interruptContext: null };
  refreshWork = null;
  routerRefresh.mockReset();
  fetches = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      status: row.status,
      inputParams: { idea: "a post about rails" },
      messages: [],
      hitlContext: null,
      reviewGate: {
        ref: reviewGates.rows.length ? `fresh-opaque-ref-${fetches.mock.calls.length}` : null,
        reviewTaskId: reviewGates.rows.at(-1)?.reviewTaskId ?? null,
        awaiting: row.awaiting,
        producedReviewPark: row.producedReviewPark,
      },
    }),
  }));
  vi.stubGlobal("fetch", fetches);
  renders = vi.fn(() => SetupScreen({ agentId: "blog-idea-generator", instanceId: RUN_ID }));
});

afterEach(async () => {
  await refreshWork;
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function mountPage() {
  // A refresh updates this mounted page through the real server composer;
  // no test calls refresh itself and no fake rail entry is ever injected.
  routerRefresh.mockImplementation(() => {
    refreshWork = Promise.resolve().then(async () => {
      const response = await renders();
      page.rerender(response as React.ReactElement);
    });
  });
  const page = render(await renders() as React.ReactElement);
  return page;
}

function topRail(container: HTMLElement): HTMLElement {
  const marker = "[data-run-step-rail],[data-run-step-rail-column]";
  const columns = Array.from(container.querySelectorAll<HTMLElement>(marker)).filter(
    (node) => !node.parentElement?.closest(marker),
  );
  expect(columns).toHaveLength(1);
  return columns[0]!;
}

function pendingGate(container: HTMLElement, taskId = REVIEW_TASK_ID) {
  return topRail(container).querySelector(
    `[data-rail-gate-pending="true"] [data-rail-gate-open="${taskId}"]`,
  );
}

for (const host of ["orchestrator", "agent"] as const) {
  describe(`the ${host} run page after first paint`, () => {
    it.each(["no interrupt", "spent non-review interrupt"])("pending produced-review park with %s adds its later gate to the real rail", async (interrupt) => {
      row.templateType = host;
      row.status = "pending_approval";
      row.producedReviewPark = true;
      live.snapshot = {
        ...live.snapshot,
        status: "pending_approval",
        interruptContext: interrupt === "no interrupt" ? null : {
          schema: { type: "object" },
          xRenderer: "cinatra/approval",
          values: {},
        },
      };
      const { container } = await mountPage();
      expect(topRail(container).querySelector("[data-rail-gated-step]")).toBeNull();
      await waitFor(() => expect(fetches).toHaveBeenCalled());
      reviewGates.rows = [gateRow("pending")];
      await waitFor(() => expect(container.querySelector('[data-testid="review-gate-card"]')).not.toBeNull(), { timeout: 4000 });
      await waitFor(() => expect(pendingGate(container)).not.toBeNull(), { timeout: 4000 });
      await refreshWork;
      expect(routerRefresh).toHaveBeenCalledTimes(1);
      expect(renders).toHaveBeenCalledTimes(2);
      expect(routerPush).not.toHaveBeenCalled();
      expect(routerReplace).not.toHaveBeenCalled();
    }, 11000);

    it("adds a later gate to the real pending rail without navigation", async () => {
      row.templateType = host;
      const { container } = await mountPage();
      const mountedPage = container.querySelector("[data-run-detail-contract]");
      const location = window.location.href;
      expect(topRail(container).querySelector("[data-rail-gated-step]")).toBeNull();
      await waitFor(() => expect(fetches).toHaveBeenCalled());
      reviewGates.rows = [gateRow("pending")];
      await waitFor(() => expect(pendingGate(container)).not.toBeNull(), { timeout: 4000 });
      await refreshWork;
      expect(container.querySelector("[data-run-detail-contract]")).toBe(mountedPage);
      expect(topRail(container).querySelectorAll('[data-rail-gate-pending="true"]')).toHaveLength(1);
      expect(container.querySelector('[data-testid="review-gate-card"]')).not.toBeNull();
      expect(routerRefresh).toHaveBeenCalledTimes(1);
      expect(renders).toHaveBeenCalledTimes(2);
      expect(window.location.href).toBe(location);
      expect(routerPush).not.toHaveBeenCalled();
      expect(routerReplace).not.toHaveBeenCalled();
    });

    it("refreshes a gate that opens between the rail and slot reads in the same render", async () => {
      row.templateType = host;
      row.openGateDuringSlotRead = true;
      const location = window.location.href;
      const { container } = await mountPage();
      await waitFor(() => expect(pendingGate(container)).not.toBeNull());
      await refreshWork;
      expect(topRail(container).querySelectorAll('[data-rail-gate-pending="true"]')).toHaveLength(1);
      expect(routerRefresh).toHaveBeenCalledTimes(1);
      expect(renders).toHaveBeenCalledTimes(2);
      expect(window.location.href).toBe(location);
      expect(routerPush).not.toHaveBeenCalled();
      expect(routerReplace).not.toHaveBeenCalled();
    });

    it("ignores renewed opaque tickets for a known gate, then adds a distinct later gate once", async () => {
      row.templateType = host;
      reviewGates.rows = [gateRow("resolved")];
      const { container } = await mountPage();
      const location = window.location.href;
      await waitFor(() => expect(fetches).toHaveBeenCalled());
      expect(routerRefresh).not.toHaveBeenCalled();
      reviewGates.rows = [gateRow("resolved"), gateRow("pending", "task-review-2")];
      await waitFor(() => expect(pendingGate(container, "task-review-2")).not.toBeNull(), { timeout: 4000 });
      await refreshWork;
      expect(topRail(container).querySelectorAll('[data-rail-gate-history="true"]')).toHaveLength(1);
      expect(topRail(container).querySelectorAll('[data-rail-gate-pending="true"]')).toHaveLength(1);
      const readCount = fetches.mock.calls.length;
      await waitFor(() => expect(fetches.mock.calls.length).toBeGreaterThan(readCount), { timeout: 4000 });
      expect(routerRefresh).toHaveBeenCalledTimes(1);
      expect(renders).toHaveBeenCalledTimes(2);
      expect(window.location.href).toBe(location);
      expect(routerPush).not.toHaveBeenCalled();
      expect(routerReplace).not.toHaveBeenCalled();
    }, 8000);

    it("uses the existing marked SSE gate arrival without adding a poller", async () => {
      row.templateType = host;
      row.status = "running";
      live.snapshot = { ...live.snapshot, status: "running" };
      const { container } = await mountPage();
      const location = window.location.href;
      expect(topRail(container).querySelector("[data-rail-gated-step]")).toBeNull();
      reviewGates.rows = [gateRow("pending")];
      row.status = "pending_approval";
      await act(async () => {
        live.snapshot = { ...live.snapshot, status: "pending_approval", interruptContext: markedReviewGate() };
        live.listeners.forEach((changed) => changed());
      });
      await waitFor(() => expect(pendingGate(container)).not.toBeNull());
      await refreshWork;
      expect(routerRefresh).toHaveBeenCalledTimes(1);
      expect(window.location.href).toBe(location);
      expect(routerPush).not.toHaveBeenCalled();
      expect(routerReplace).not.toHaveBeenCalled();
    });
  });
}


for (const host of ["chat_thread", "site_widget"] as const) {
  it(`does not refresh the containing page when a ${host} panel finds a gate`, async () => {
    const reader = vi.fn(async () => ({ ref: "reader-owned-opaque-ticket", awaiting: false, reviewTaskId: REVIEW_TASK_ID }));
    render(
      <LifecycleCardSurfaceProvider host={host}>
        <AgenticRunPanel
          runId={RUN_ID}
          initialStatus="completed"
          initialError={null}
          initialMessages={[]}
          initialReviewGate={{ ref: null, awaiting: true, reviewTaskId: null }}
          readReviewSlot={reader}
        />
      </LifecycleCardSurfaceProvider>,
    );
    await waitFor(() => expect(reader).toHaveBeenCalled());
    expect(routerRefresh).not.toHaveBeenCalled();
    expect(renders).not.toHaveBeenCalled();
    expect(routerPush).not.toHaveBeenCalled();
    expect(routerReplace).not.toHaveBeenCalled();
  });
}
