/**
 * A PENDING REVIEW'S ADDRESS LANDS ON THE RUN PAGE (cinatra#3693).
 *
 * The owner's decision on cinatra#3693: "There is **no dedicated Reviews page**
 * anywhere: reviews are reached through the Notifications page for every
 * scope, so the workspace-wide Reviews tab under `/agents` and the standalone
 * review page go away; a pending review still opens in place on the run page,
 * as the run-page drawing says." The ratified drawing: "There is no Reviews list
 * and no standalone review page: a review is reached from the Notifications page
 * of every scope (Application Design — Notifications) and opens in place on its
 * run page".
 *
 * B2 — the review address of a PENDING gate lands on the run page at the run's
 *      canonical home (an unanchored run: the bare run page), and only after
 *      the page's access door has cleared; a refused reader is told so and is
 *      never redirected.
 * B3 — a settled gate and its audit reading stay on the review address the
 *      first commit scoped (`<home>/review/<task>`), until the run detail can
 *      draw a chosen settled gate itself (the recorded B-SETTLED narrowing).
 *
 * The run page opens a parked review gate in place by its own selection; that
 * is pinned by run-page-parked-review-opens-in-place.test.tsx.
 */
import React from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { scopeSurfaceBase, type ScopeSurfaceRef } from "@/lib/scope-surfaces";

const ORG_ID = "88c63f08-4d2e-4c7a-9f1b-2a0d6e5c4b31";
const TEAM_ID = "5d1c2b3a-7e6f-4a1b-8c9d-0e1f2a3b4c5d";
const ORG_SCOPE: ScopeSurfaceRef = { kind: "organization", id: ORG_ID };
const TEAM_SCOPE: ScopeSurfaceRef = { kind: "team", id: TEAM_ID };
const ORG_BASE = scopeSurfaceBase(ORG_SCOPE);
const VENDOR = "cinatra-ai";
const PACKAGE = "blog-draft-writer-agent";
const AGENT_ID = `${VENDOR}/${PACKAGE}`;
const RUN_ID = "run-3693";
const TASK_ID = "task-3693";
const ORG_ANCHOR = { v: 1, kind: "organization", id: ORG_ID };

const mocks = vi.hoisted(() => ({
  screens: {
    instanceSetup: vi.fn(async () => "setup-screen"),
    instanceTrigger: vi.fn(async () => "trigger-screen"),
    instancePermissions: vi.fn(async () => "permissions-screen"),
    instanceData: vi.fn(async () => "data-screen"),
    instanceResults: undefined,
    instanceOptimization: undefined,
  } as Record<string, unknown>,
  getAuthSession: vi.fn(),
  signInRedirectTarget: vi.fn(async () => "/sign-in"),
  resolveReviewActorContext: vi.fn(),
  loadReviewGateSurface: vi.fn(),
  loadPinnedCapturePair: vi.fn(() => null),
  readAgentRunById: vi.fn(async (): Promise<unknown> => null),
  readAgentTemplateById: vi.fn(async () => null),
  buildRunStepperSteps: vi.fn(() => []),
  readReviewGate: vi.fn(async (): Promise<unknown> => null),
  enforceReviewRunAccess: vi.fn(async () => ({ ok: true })),
  readVerificationRecordForGate: vi.fn(async (): Promise<unknown> => null),
  submitReviewDecisionAction: vi.fn(),
  encodeLifecycleGateRef: vi.fn(() => "ref-3693"),
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
  usePathname: () => "/",
}));

vi.mock("@/app/plugins-registry", () => ({
  resolveAgentScreensWithA2AFallback: vi.fn(async () => mocks.screens),
}));

vi.mock("@/lib/scope-surface-entity-name", () => ({
  readScopeSurfaceEntityName: async (scope: ScopeSurfaceRef) =>
    scope.kind === "organization" ? "Acme" : scope.kind === "team" ? "Growth" : null,
}));

// ── The review page's collaborators (the same edges its own suites stub) ────
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: mocks.getAuthSession,
  signInRedirectTarget: mocks.signInRedirectTarget,
}));
vi.mock("@/app/artifacts/[id]/review-gate-ports", () => ({
  loadReviewGateSurface: mocks.loadReviewGateSurface,
  loadPinnedCapturePair: mocks.loadPinnedCapturePair,
}));
vi.mock("@cinatra-ai/agents/store", () => ({
  readAgentRunById: mocks.readAgentRunById,
  readAgentTemplateById: mocks.readAgentTemplateById,
}));
vi.mock("@cinatra-ai/agents/run-stepper-steps", () => ({
  buildRunStepperSteps: mocks.buildRunStepperSteps,
}));
vi.mock("@cinatra-ai/agents/artifact-review-gate-store", () => ({
  readReviewGate: mocks.readReviewGate,
  enforceReviewRunAccess: mocks.enforceReviewRunAccess,
}));
vi.mock("@cinatra-ai/agents/lifecycle-verification-store", () => ({
  readVerificationRecordForGate: mocks.readVerificationRecordForGate,
}));
vi.mock("@cinatra-ai/agents/trigger-store", () => ({
  readRunTriggerByRunId: vi.fn(async () => null),
}));
vi.mock("@cinatra-ai/agents/recommendation-hold", () => ({
  readRecommendationParkForRun: vi.fn(async () => null),
}));
vi.mock("@/lib/lifecycle/lifecycle-card-ref", () => ({
  encodeLifecycleGateRef: mocks.encodeLifecycleGateRef,
  encodeScheduleRunRef: vi.fn(() => "schedule-ref-3693"),
}));
vi.mock("@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/actions", () => ({
  submitReviewDecisionAction: mocks.submitReviewDecisionAction,
}));
vi.mock("@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-actor", () => ({
  resolveReviewActorContext: () => mocks.resolveReviewActorContext(),
}));
vi.mock("@cinatra-ai/agents/review-gate-card", () => ({
  ReviewGateCard: ({ view }: { view: { ref: string } }) => (
    <div data-testid="review-gate-card" data-card-ref={view.ref} />
  ),
}));
vi.mock("@cinatra-ai/agents/agent-hitl-screen-card", () => ({
  AgentHitlScreenCard: () => <div data-testid="agent-hitl-screen-card" />,
}));
vi.mock("@cinatra-ai/agents/lifecycle-card-runtime", () => ({
  LifecycleCardSurfaceProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-gate-states", () => ({
  ReviewGateBlocked: ({ reason }: { reason: string }) => (
    <div data-testid="page-gate-blocked" data-blocked-reason={reason} />
  ),
}));
vi.mock("@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-run-steps", () => ({
  ReviewRunSteps: () => <div data-testid="review-run-steps" />,
}));
vi.mock("@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-run-surface", () => ({
  ReviewRunSurface: ({ rail, detail }: { rail: React.ReactNode; detail: React.ReactNode }) => (
    <div data-testid="review-run-surface">
      {rail}
      {detail}
    </div>
  ),
}));
vi.mock("@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/verification-view", () => ({
  VerificationView: () => <div data-testid="verification-view" />,
}));
vi.mock("@/components/layout/main", () => ({
  Main: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));
vi.mock("@/components/page-content", () => ({
  PageContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/page-header-title-sync", () => ({
  PageHeaderTitleSync: ({ title }: { title: string }) => <span data-page-title-sync={title} />,
}));
vi.mock("@/components/page-header", () => ({
  PageHeader: ({ description }: { description?: string }) => (
    <header data-page-header-description={description} />
  ),
}));

import { ScopedAgentsRoute } from "@/app/scoped-launch-routes";
import AgentRunReviewPage from "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/page";

const ACTOR = {
  actor: { actorType: "human", userId: "u1", source: "route" },
  orgId: "org-1",
  roleHints: { actorOrganizationId: "org-1" },
};

const READY = {
  kind: "ready",
  runId: RUN_ID,
  reviewTaskId: TASK_ID,
  targets: [],
  agentSummary: null,
  pinnedCapturePairs: {},
  permissions: { canDecide: true, canComment: true },
};

function runRow(launchScopeAnchor: unknown) {
  return { id: RUN_ID, templateId: null, stepResults: null, launchScopeAnchor };
}

function reviewParams(instanceId = RUN_ID, reviewTaskId = TASK_ID) {
  return Promise.resolve({ vendor: VENDOR, packageName: PACKAGE, instanceId, reviewTaskId });
}

async function thrownBy(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

beforeEach(() => {
  mocks.getAuthSession.mockResolvedValue({ user: { id: "u1" } });
  mocks.signInRedirectTarget.mockResolvedValue("/sign-in");
  mocks.resolveReviewActorContext.mockResolvedValue(ACTOR);
  mocks.loadReviewGateSurface.mockResolvedValue(READY);
  mocks.encodeLifecycleGateRef.mockReturnValue("ref-3693");
  mocks.buildRunStepperSteps.mockReturnValue([]);
  mocks.enforceReviewRunAccess.mockResolvedValue({ ok: true });
  mocks.readAgentRunById.mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

const SETTLED = {
  kind: "settled",
  targets: [],
  pinnedCapturePairs: {},
  agentSummary: null,
};

const ORG_RUN_PAGE = `${ORG_BASE}/agents/${AGENT_ID}/${RUN_ID}`;
const BARE_RUN_PAGE = `/agents/${AGENT_ID}/${RUN_ID}`;

describe("B2: a pending review's address lands on the run page, after the access door (cinatra#3693)", () => {
  it("the bare address of an organization-anchored run lands on the run page at its home", async () => {
    mocks.readAgentRunById.mockResolvedValue(runRow(ORG_ANCHOR));
    const message = await thrownBy(() =>
      AgentRunReviewPage({ params: reviewParams(), searchParams: Promise.resolve({}) }),
    );
    expect(message).toBe(`REDIRECT:${ORG_RUN_PAGE}`);
    // AFTER the access door, never before it.
    expect(mocks.loadReviewGateSurface).toHaveBeenCalledTimes(1);
  });

  it("the home scope's own review address lands on the run page there too", async () => {
    mocks.readAgentRunById.mockResolvedValue(runRow(ORG_ANCHOR));
    const message = await thrownBy(() =>
      ScopedAgentsRoute({
        scope: ORG_SCOPE,
        segments: [VENDOR, PACKAGE, RUN_ID, "review", TASK_ID],
        searchParams: Promise.resolve({}),
      }),
    );
    expect(message).toBe(`REDIRECT:${ORG_RUN_PAGE}`);
  });

  it("another scope's review address lands on the run page at the run's own home", async () => {
    mocks.readAgentRunById.mockResolvedValue(runRow(ORG_ANCHOR));
    const message = await thrownBy(() =>
      ScopedAgentsRoute({
        scope: TEAM_SCOPE,
        segments: [VENDOR, PACKAGE, RUN_ID, "review", TASK_ID],
        searchParams: Promise.resolve({}),
      }),
    );
    expect(message).toBe(`REDIRECT:${ORG_RUN_PAGE}`);
  });

  it("an unanchored run's pending review lands on the bare run page", async () => {
    mocks.readAgentRunById.mockResolvedValue(runRow(null));
    const message = await thrownBy(() =>
      AgentRunReviewPage({ params: reviewParams(), searchParams: Promise.resolve({}) }),
    );
    expect(message).toBe(`REDIRECT:${BARE_RUN_PAGE}`);
  });

  it("a reader the access door refuses is told so, and is never redirected", async () => {
    mocks.readAgentRunById.mockResolvedValue(runRow(ORG_ANCHOR));
    mocks.loadReviewGateSurface.mockResolvedValue({ kind: "not-authorized" });
    const tree = await AgentRunReviewPage({ params: reviewParams(), searchParams: Promise.resolve({}) });
    expect(renderToStaticMarkup(tree as React.ReactElement)).toContain("Not authorized");
    expect(mocks.readAgentRunById).not.toHaveBeenCalled();
  });
});

describe("B3: a settled gate and its audit reading keep the review address (B-SETTLED, cinatra#3693)", () => {
  it("a settled gate at the bare address goes to its home's review address", async () => {
    mocks.readAgentRunById.mockResolvedValue(runRow(ORG_ANCHOR));
    mocks.loadReviewGateSurface.mockResolvedValue(SETTLED);
    const message = await thrownBy(() =>
      AgentRunReviewPage({ params: reviewParams(), searchParams: Promise.resolve({}) }),
    );
    expect(message).toBe(`REDIRECT:${ORG_RUN_PAGE}/review/${TASK_ID}`);
  });

  it("a settled gate renders read-only at its home's review address", async () => {
    mocks.readAgentRunById.mockResolvedValue(runRow(ORG_ANCHOR));
    mocks.loadReviewGateSurface.mockResolvedValue(SETTLED);
    const tree = await ScopedAgentsRoute({
      scope: ORG_SCOPE,
      segments: [VENDOR, PACKAGE, RUN_ID, "review", TASK_ID],
      searchParams: Promise.resolve({}),
    });
    expect(renderToStaticMarkup(tree as React.ReactElement)).toContain('data-testid="review-gate-card"');
  });

  it("the audit reading keeps its own address, verification view and all", async () => {
    mocks.readAgentRunById.mockResolvedValue(runRow(ORG_ANCHOR));
    const message = await thrownBy(() =>
      AgentRunReviewPage({ params: reviewParams(), searchParams: Promise.resolve({ view: "verification" }) }),
    );
    expect(message).toBe(`REDIRECT:${ORG_RUN_PAGE}/review/${TASK_ID}?view=verification`);
  });
});
