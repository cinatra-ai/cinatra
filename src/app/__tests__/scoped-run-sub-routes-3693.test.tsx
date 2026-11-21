/**
 * A SCOPED RUN'S SUB-ROUTES LIVE UNDER ITS SCOPE (cinatra#3693, the slice
 * cinatra#2809 deferred).
 *
 * cinatra#2809's acceptance, verbatim: "the bare route redirects anchored
 * non-personal instances after authorization; after authorization, a wrong
 * scoped instance path redirects to the canonical home and renders no instance
 * content before the redirect". The scoped shell used to answer every
 * sub-route of an instance — its schedule, its permissions, its review — with
 * not-found, and the code said why: "the slice that moves them moves them once,
 * for all five bases". This is that slice.
 *
 * Two readings here:
 *
 *   A1 — the scoped shell resolves `/trigger`, `/permissions`, `/data` and
 *        `/review/<task>` below an instance through the SAME delegation the
 *        run page uses, handing each the scope base, the vantage and the
 *        scope's name; every other shape stays not-found.
 *   A2 — the review page, the one sub-route that is a page of its own, runs
 *        the home check after its access door: the bare address or another
 *        scope's address of an anchored run's PENDING review lands on the run
 *        page at the run's canonical home (cinatra#3693, the owner's decision:
 *        "a pending review still opens in place on the run page"), and a
 *        settled gate goes to that home plus the same sub-path and renders.
 *
 * Only the I/O at the edges is stubbed: the registry, the name read, the stores
 * and the review page's own collaborators.
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
const TEAM_BASE = scopeSurfaceBase(TEAM_SCOPE);
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

// The review page, spied on WITHOUT being replaced: A1 asks what the shell
// hands it, A2 asks what the real page does with that.
vi.mock(
  "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/page",
  async (importOriginal) => {
    const actual = await importOriginal<{ default: (props: unknown) => unknown }>();
    return { ...actual, default: vi.fn(actual.default) };
  },
);

// The SKILLS pane, replaced outright: A3 asks what the shell hands it, and the
// pane's own body reads a skill ledger this suite is not about.
vi.mock("@/app/agents/[vendor]/[packageName]/[instanceId]/skills/page", () => ({
  default: vi.fn(async () => "skills-page"),
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

import AgentPackageInstanceSkillsPage from "@/app/agents/[vendor]/[packageName]/[instanceId]/skills/page";

const reviewPageSpy = vi.mocked(AgentRunReviewPage);
const skillsPageSpy = vi.mocked(AgentPackageInstanceSkillsPage);

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

// ---------------------------------------------------------------------------
// A1 — the scoped shell resolves an instance's sub-routes.
// ---------------------------------------------------------------------------

describe("A1: a scoped instance sub-route resolves through the same delegation (cinatra#3693)", () => {
  it.each([
    ["trigger", "instanceTrigger", "trigger-screen"],
    ["permissions", "instancePermissions", "permissions-screen"],
    ["data", "instanceData", "data-screen"],
  ])(
    "/organizations/<id>/agents/<vendor>/<package>/<run>/%s reaches the %s screen with the scope",
    async (sub, key, marker) => {
      const searchParams = Promise.resolve({});
      const out = await ScopedAgentsRoute({
        scope: ORG_SCOPE,
        segments: [VENDOR, PACKAGE, RUN_ID, sub],
        searchParams,
      });
      expect(out).toBe(marker);
      const screen = mocks.screens[key] as ReturnType<typeof vi.fn>;
      expect(screen).toHaveBeenCalledTimes(1);
      expect(screen).toHaveBeenCalledWith({
        agentId: AGENT_ID,
        instanceId: RUN_ID,
        scopeBase: ORG_BASE,
        launchScope: ORG_SCOPE,
        scopeTitle: "Acme",
        searchParams,
      });
      expect(mocks.screens.instanceSetup).not.toHaveBeenCalled();
    },
  );

  it("moves them for every base, not only the organization's: a team's /trigger", async () => {
    await ScopedAgentsRoute({ scope: TEAM_SCOPE, segments: [VENDOR, PACKAGE, RUN_ID, "trigger"] });
    expect(mocks.screens.instanceTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ scopeBase: TEAM_BASE, launchScope: TEAM_SCOPE, scopeTitle: "Growth" }),
    );
  });

  it("hands /review/<task> to the review page with its params and the scope", async () => {
    const marker = <div data-testid="review-page-stub" />;
    reviewPageSpy.mockImplementationOnce(async () => marker);
    const searchParams = Promise.resolve({ view: "verification" });
    const out = await ScopedAgentsRoute({
      scope: ORG_SCOPE,
      segments: [VENDOR, PACKAGE, RUN_ID, "review", TASK_ID],
      searchParams,
    });
    expect(out).toBe(marker);
    expect(reviewPageSpy).toHaveBeenCalledTimes(1);
    const props = reviewPageSpy.mock.calls[0][0] as {
      params: Promise<Record<string, string>>;
      searchParams: unknown;
      scopeBase: string;
      launchScope: ScopeSurfaceRef;
      scopeTitle: string;
    };
    expect(await props.params).toEqual({
      vendor: VENDOR,
      packageName: PACKAGE,
      instanceId: RUN_ID,
      reviewTaskId: TASK_ID,
    });
    expect(props.searchParams).toBe(searchParams);
    expect(props.scopeBase).toBe(ORG_BASE);
    expect(props.launchScope).toEqual(ORG_SCOPE);
    expect(props.scopeTitle).toBe("Acme");
  });

  it("still sends the instance itself to the run page", async () => {
    await ScopedAgentsRoute({ scope: ORG_SCOPE, segments: [VENDOR, PACKAGE, RUN_ID] });
    expect(mocks.screens.instanceSetup).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: RUN_ID, scopeBase: ORG_BASE }),
    );
  });

  it.each([
    [["results"]],
    [["optimization"]],
    [["nope"]],
    [["trigger", "extra"]],
    [["review"]],
    [["review", TASK_ID, "extra"]],
  ])("keeps every other shape below an instance not-found: %j", async (rest) => {
    const message = await thrownBy(() =>
      ScopedAgentsRoute({ scope: ORG_SCOPE, segments: [VENDOR, PACKAGE, RUN_ID, ...rest] }),
    );
    expect(message).toBe("NEXT_NOT_FOUND");
    expect(reviewPageSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// A2 — the review page's home check, after its access door.
// ---------------------------------------------------------------------------

describe("A2: the review route sends every reader to the run, after the access door (cinatra#3693)", () => {
  const GATE_STEP = `?step=review%3A${TASK_ID}`;
  const AUDIT_STEP = `?step=audit%3A${TASK_ID}`;

  it("the bare address of an organization-anchored run's review lands on the scoped run page", async () => {
    mocks.readAgentRunById.mockResolvedValue(runRow(ORG_ANCHOR));
    const message = await thrownBy(() =>
      AgentRunReviewPage({ params: reviewParams(), searchParams: Promise.resolve({}) }),
    );
    expect(message).toBe(`REDIRECT:${ORG_BASE}/agents/${AGENT_ID}/${RUN_ID}${GATE_STEP}`);
    // AFTER the access door, never before it.
    expect(mocks.loadReviewGateSurface).toHaveBeenCalledTimes(1);
  });

  it("the verification reading becomes the run's audit step", async () => {
    mocks.readAgentRunById.mockResolvedValue(runRow(ORG_ANCHOR));
    const message = await thrownBy(() =>
      AgentRunReviewPage({ params: reviewParams(), searchParams: Promise.resolve({ view: "verification" }) }),
    );
    expect(message).toBe(`REDIRECT:${ORG_BASE}/agents/${AGENT_ID}/${RUN_ID}${AUDIT_STEP}`);
    expect(mocks.enforceReviewRunAccess).toHaveBeenCalledTimes(1);
  });

  it("another scope's address lands on the run page at the run's own home", async () => {
    mocks.readAgentRunById.mockResolvedValue(runRow(ORG_ANCHOR));
    const message = await thrownBy(() =>
      ScopedAgentsRoute({
        scope: TEAM_SCOPE,
        segments: [VENDOR, PACKAGE, RUN_ID, "review", TASK_ID],
        searchParams: Promise.resolve({}),
      }),
    );
    expect(message).toBe(`REDIRECT:${ORG_BASE}/agents/${AGENT_ID}/${RUN_ID}${GATE_STEP}`);
  });

  it("a settled gate goes to the run page too — no standalone review document", async () => {
    mocks.readAgentRunById.mockResolvedValue(runRow(ORG_ANCHOR));
    mocks.loadReviewGateSurface.mockResolvedValue({ kind: "settled", targets: [], pinnedCapturePairs: {}, agentSummary: null });
    const message = await thrownBy(() =>
      ScopedAgentsRoute({
        scope: ORG_SCOPE,
        segments: [VENDOR, PACKAGE, RUN_ID, "review", TASK_ID],
        searchParams: Promise.resolve({}),
      }),
    );
    expect(message).toBe(`REDIRECT:${ORG_BASE}/agents/${AGENT_ID}/${RUN_ID}${GATE_STEP}`);
    expect(message).not.toContain("/review/");
  });

  it("a reader the access door refuses is told so, and is never redirected", async () => {
    mocks.readAgentRunById.mockResolvedValue(runRow(ORG_ANCHOR));
    mocks.loadReviewGateSurface.mockResolvedValue({ kind: "not-authorized" });
    const tree = await AgentRunReviewPage({ params: reviewParams(), searchParams: Promise.resolve({}) });
    expect(renderToStaticMarkup(tree as React.ReactElement)).toContain("Not authorized");
  });

  it("an unanchored run's review lands on the bare run page, gate named", async () => {
    mocks.readAgentRunById.mockResolvedValue(runRow(null));
    const message = await thrownBy(() =>
      AgentRunReviewPage({ params: reviewParams(), searchParams: Promise.resolve({}) }),
    );
    expect(message).toBe(`REDIRECT:/agents/${AGENT_ID}/${RUN_ID}${GATE_STEP}`);
  });

  it("an unanchored run's settled review lands there as well", async () => {
    mocks.readAgentRunById.mockResolvedValue(runRow(null));
    mocks.loadReviewGateSurface.mockResolvedValue({ kind: "settled", targets: [], pinnedCapturePairs: {}, agentSummary: null });
    const message = await thrownBy(() =>
      AgentRunReviewPage({ params: reviewParams(), searchParams: Promise.resolve({}) }),
    );
    expect(message).toBe(`REDIRECT:/agents/${AGENT_ID}/${RUN_ID}${GATE_STEP}`);
  });
});

// ---------------------------------------------------------------------------
// A3 — the skills pane under a scope.
// ---------------------------------------------------------------------------

describe("A3: the scoped skills sub-route resolves (cinatra#3693)", () => {
  it("mounts the skills page with the run, the base, the vantage and the name", async () => {
    const tree = await ScopedAgentsRoute({
      scope: ORG_SCOPE,
      segments: [VENDOR, PACKAGE, RUN_ID, "skills"],
    });
    expect(skillsPageSpy).toHaveBeenCalledTimes(1);
    const props = skillsPageSpy.mock.calls[0]![0] as {
      params: Promise<Record<string, string>>;
      scopeBase?: string | null;
      launchScope?: unknown;
      scopeTitle?: string | null;
    };
    expect(await props.params).toEqual({
      vendor: VENDOR,
      packageName: PACKAGE,
      instanceId: RUN_ID,
    });
    expect(props.scopeBase).toBe(ORG_BASE);
    expect(props.launchScope).toEqual(ORG_SCOPE);
    expect(props.scopeTitle).toBe("Acme");
    expect(tree).toBe("skills-page");
  });

  it("keeps a deeper skills shape not-found", async () => {
    const message = await thrownBy(() =>
      ScopedAgentsRoute({ scope: ORG_SCOPE, segments: [VENDOR, PACKAGE, RUN_ID, "skills", "extra"] }),
    );
    expect(message).toBe("NEXT_NOT_FOUND");
    expect(skillsPageSpy).not.toHaveBeenCalled();
  });
});
