// @vitest-environment jsdom
/**
 * ONE TRAIL SHAPE FOR A RUN'S PAGES — the review page's half (cinatra#3446).
 *
 * The issue's Expected, in its own words: one trail shape for a run's pages —
 * the agent's name, then the run, then the step or surface (Review) — the same
 * words on the run page and on its review page.
 *
 * What was measured on a real run: this page's trail read "Agents >
 * 00220c95... > Review" — the raw run id truncated, the agent's name absent,
 * because the page broadcast only its leaf title and published nothing on the
 * crumb-contributions bus, so the collapsed agents trail fell through to the id
 * placeholder for the run.
 *
 * WHY THE PAGE IS RENDERED HERE. The defect is what the PAGE publishes, not
 * what the trail builder does with entries a test hands it: a suite that drove
 * the builder alone passed on this route while the page named the run nowhere.
 * So the real route is rendered, in a DOM, and the trail is read from the bus
 * the page itself published to — the same reading the live DOM gives.
 *
 * Run:
 *   pnpm exec vitest run --config vitest.config.ts --no-coverage \
 *     "src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/__tests__/review-one-trail-3446.test.tsx"
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

const VENDOR = "cinatra-ai";
const PACKAGE = "blog-draft-writer-agent";
const RUN_ID = "00220c95-6a1f-4a2b-9d11-6c7c1f0a8e42";
const TASK_ID = "task-3446";
const AGENT_PATH = `/agents/${VENDOR}/${PACKAGE}`;
const RUN_PATH = `${AGENT_PATH}/${RUN_ID}`;
const REVIEW_PATH = `${RUN_PATH}/review/${TASK_ID}`;
const AGENT_NAME = "Blog Draft Writer Agent";
const RUN_NAME = "Blog Draft Writer Agent (4)";
const EPOCH = "anon";

const mocks = vi.hoisted(() => ({
  getAuthSession: vi.fn(),
  signInRedirectTarget: vi.fn(async () => "/sign-in"),
  redirect: vi.fn((to: string) => {
    throw new Error(`REDIRECT:${to}`);
  }),
  resolveReviewActorContext: vi.fn(),
  loadReviewGateSurface: vi.fn(),
  loadPinnedCapturePair: vi.fn(() => null),
  readAgentRunById: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
  readAgentTemplateById: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
  // The store helper the RUN page names a started run with: an existing title
  // unchanged, otherwise the agent's own name for a system run (runBy null).
  ensureRunTitle: vi.fn(
    async (run: { title: string | null; runBy: string | null }, baseName: string) =>
      run.title ?? baseName,
  ),
  buildRunStepperSteps: vi.fn(() => [] as unknown[]),
  readReviewGate: vi.fn(async () => null),
  enforceReviewRunAccess: vi.fn(async () => ({ ok: true })),
  readVerificationRecordForGate: vi.fn(async () => null),
  submitReviewDecisionAction: vi.fn(),
  encodeLifecycleGateRef: vi.fn(() => "ref-3446"),
  encodeScheduleRunRef: vi.fn(() => "sched-3446"),
  readRunTriggerByRunId: vi.fn(async (): Promise<{ id: string } | null> => null),
  readRecommendationParkForRun: vi.fn(async (): Promise<{ status: string } | null> => null),
  recommendationDecidedForRun: vi.fn((): boolean => false),
}));

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: mocks.getAuthSession,
  signInRedirectTarget: mocks.signInRedirectTarget,
}));
// The page's own islands read the pathname — the crumb publisher stamps the
// snapshot with it, and the leaf-title broadcast carries it.
vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
  usePathname: () => REVIEW_PATH,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/artifacts/[id]/review-gate-ports", () => ({
  loadReviewGateSurface: mocks.loadReviewGateSurface,
  loadPinnedCapturePair: mocks.loadPinnedCapturePair,
}));
vi.mock("@cinatra-ai/agents/store", () => ({
  readAgentRunById: mocks.readAgentRunById,
  readAgentTemplateById: mocks.readAgentTemplateById,
  ensureRunTitle: mocks.ensureRunTitle,
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
  readRunTriggerByRunId: mocks.readRunTriggerByRunId,
}));
vi.mock("@cinatra-ai/agents/recommendation-hold", () => ({
  readRecommendationParkForRun: mocks.readRecommendationParkForRun,
}));
vi.mock("@cinatra-ai/agents/run-recommendation-core", () => ({
  recommendationDecidedForRun: mocks.recommendationDecidedForRun,
}));
vi.mock("@/lib/lifecycle/lifecycle-card-ref", () => ({
  encodeLifecycleGateRef: mocks.encodeLifecycleGateRef,
  encodeScheduleRunRef: mocks.encodeScheduleRunRef,
}));
vi.mock("../actions", () => ({
  submitReviewDecisionAction: mocks.submitReviewDecisionAction,
}));
// The cards and the two columns are markers here: this suite reads the page's
// TRAIL, and every one of them is proved on its own route elsewhere.
vi.mock("@cinatra-ai/agents/review-gate-card", () => ({
  ReviewGateCard: () => <div data-lifecycle-card="artifact_review_gate" />,
}));
vi.mock("@cinatra-ai/agents/agent-hitl-screen-card", () => ({
  AgentHitlScreenCard: () => null,
}));
vi.mock("@cinatra-ai/agents/lifecycle-card-runtime", () => ({
  LifecycleCardSurfaceProvider: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../review-gate-states", () => ({
  ReviewGateBlocked: () => <div data-testid="page-gate-blocked" />,
}));
vi.mock("../verification-view", () => ({
  VerificationView: () => <div data-testid="verification-view" />,
}));
vi.mock("../review-run-steps", () => ({
  ReviewRunSteps: () => <nav data-testid="review-run-steps" />,
}));
vi.mock("../review-run-surface", () => ({
  ReviewRunSurface: ({ rail, detail }: { rail: ReactNode; detail: ReactNode }) => (
    <div data-testid="review-run-surface">
      {rail}
      {detail}
    </div>
  ),
}));
vi.mock("@/components/layout/main", () => ({
  Main: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock("@/components/page-content", () => ({
  PageContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/page-header", () => ({
  PageHeader: () => <header />,
}));
vi.mock("../review-actor", () => ({
  resolveReviewActorContext: () => mocks.resolveReviewActorContext(),
}));

import {
  clearCrumbContributions,
  selectCrumbContributions,
} from "@/lib/breadcrumb-contributions";
import { buildBreadcrumbTrail } from "@/lib/breadcrumb-trail";

import AgentRunReviewPage from "../page";

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

async function renderReviewPage(
  searchParams: Record<string, string> = {},
): Promise<void> {
  const ui = (await AgentRunReviewPage({
    params: Promise.resolve({
      vendor: VENDOR,
      packageName: PACKAGE,
      instanceId: RUN_ID,
      reviewTaskId: TASK_ID,
    }),
    searchParams: Promise.resolve(searchParams),
  })) as ReactElement;
  render(ui);
}

function trailOn(pathname: string) {
  return buildBreadcrumbTrail(pathname, {
    contributions: selectCrumbContributions(pathname, EPOCH),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearCrumbContributions();
  mocks.getAuthSession.mockResolvedValue({ user: { id: "u1" } });
  mocks.signInRedirectTarget.mockResolvedValue("/sign-in");
  mocks.resolveReviewActorContext.mockResolvedValue(ACTOR);
  mocks.encodeLifecycleGateRef.mockReturnValue("ref-3446");
  mocks.encodeScheduleRunRef.mockReturnValue("sched-3446");
  mocks.buildRunStepperSteps.mockReturnValue([]);
  mocks.readRunTriggerByRunId.mockResolvedValue(null);
  mocks.readRecommendationParkForRun.mockResolvedValue(null);
  mocks.recommendationDecidedForRun.mockReturnValue(false);
  mocks.loadReviewGateSurface.mockResolvedValue(READY);
  // The run and its template — the records this page already reads for the
  // step rail, and the two names the run page composes its own trail from.
  mocks.readAgentRunById.mockResolvedValue({
    id: RUN_ID,
    templateId: "tpl-1",
    title: RUN_NAME,
    runBy: "u1",
    status: "running",
    stepResults: null,
  });
  mocks.ensureRunTitle.mockImplementation(
    async (run: { title: string | null }, baseName: string) => run.title ?? baseName,
  );
  mocks.readAgentTemplateById.mockResolvedValue({ id: "tpl-1", name: AGENT_NAME });
});

afterEach(() => {
  cleanup();
  clearCrumbContributions();
});

describe("the review page draws the run's own trail (cinatra#3446 item 1)", () => {
  it("reads 'Agents > <the agent's name> > <the run> > Review'", async () => {
    await renderReviewPage();
    expect(trailOn(REVIEW_PATH).map((c) => c.label)).toEqual([
      "Agents",
      AGENT_NAME,
      RUN_NAME,
      "Review",
    ]);
  });

  it("names no raw run id anywhere in the trail", async () => {
    await renderReviewPage();
    for (const crumb of trailOn(REVIEW_PATH)) {
      expect(crumb.label).not.toContain(RUN_ID.slice(0, 8));
      expect(crumb.label).not.toMatch(/…$/);
    }
  });

  it("publishes the run's crumbs on the ONE contribution channel, sourced from the run's own records", async () => {
    await renderReviewPage();
    const published = selectCrumbContributions(REVIEW_PATH, EPOCH);
    expect(published.map((c) => ({ prefix: c.prefix, label: c.label }))).toEqual([
      { prefix: AGENT_PATH, label: AGENT_NAME },
      { prefix: RUN_PATH, label: RUN_NAME },
    ]);
    expect(mocks.readAgentRunById).toHaveBeenCalledWith(RUN_ID);
  });

  it("reads the same first words as the run page's own trail", async () => {
    await renderReviewPage();
    // The entries this page publishes are the run page's own — one composer
    // for both — so the run's path composes the run page's trail out of them,
    // and this page's first three crumbs are that trail word for word.
    const runTrail = buildBreadcrumbTrail(RUN_PATH, {
      contributions: selectCrumbContributions(REVIEW_PATH, EPOCH),
    });
    expect(runTrail.map((c) => c.label)).toEqual(["Agents", AGENT_NAME, RUN_NAME]);
    expect(trailOn(REVIEW_PATH).slice(0, 3)).toEqual(runTrail);
  });

  it("publishes nothing for a viewer the gate refuses", async () => {
    mocks.loadReviewGateSurface.mockResolvedValue({ kind: "not-authorized" });
    await renderReviewPage();
    expect(selectCrumbContributions(REVIEW_PATH, EPOCH)).toEqual([]);
  });
});

/**
 * THE TITLE IS RESOLVED THE WAY THE RUN PAGE RESOLVES IT (cinatra#3446). The run screen names a started run through `ensureRunTitle` — an existing
 * title unchanged, the AGENT's own name for a system run that has none — so a
 * review page reading `run.title` alone drew a different word from the run
 * page's on exactly the runs that carry no title, which is the divergence this
 * issue is about.
 */
describe("a run with no title of its own reads the same on both pages (cinatra#3446 item 1)", () => {
  beforeEach(() => {
    mocks.readAgentRunById.mockResolvedValue({
      id: RUN_ID,
      templateId: "tpl-1",
      title: null,
      runBy: null,
      status: "running",
      stepResults: null,
    });
  });

  it("names the run through the run page's own helper, never from the bare title", async () => {
    await renderReviewPage();
    expect(mocks.ensureRunTitle).toHaveBeenCalledWith(
      expect.objectContaining({ id: RUN_ID, title: null, templateId: "tpl-1", runBy: null }),
      AGENT_NAME,
    );
  });

  it("draws the agent's name ONCE, on both pages, with no raw id", async () => {
    await renderReviewPage();
    const published = selectCrumbContributions(REVIEW_PATH, EPOCH);
    const reviewTrail = trailOn(REVIEW_PATH).map((c) => c.label);
    const runTrail = buildBreadcrumbTrail(RUN_PATH, { contributions: published }).map(
      (c) => c.label,
    );
    expect(reviewTrail).toEqual(["Agents", AGENT_NAME, "Review"]);
    expect(runTrail).toEqual(["Agents", AGENT_NAME]);
    expect(reviewTrail.slice(0, runTrail.length)).toEqual(runTrail);
    for (const label of reviewTrail) {
      expect(label).not.toContain(RUN_ID.slice(0, 8));
      expect(label).not.toMatch(/…$/);
    }
  });
});

/**
 * THE AUDIT READING OF THIS SAME PAGE (cinatra#3446). `?view=verification`
 * is the review route at the same address; it returns before the ordinary
 * composition, so it published nothing and kept the id-placeholder trail.
 */
describe("the audit view of the review page draws the same trail (cinatra#3446 item 1)", () => {
  it("publishes the run's crumbs after its own access check", async () => {
    mocks.readReviewGate.mockResolvedValue({ id: "gate-1" } as never);
    mocks.readVerificationRecordForGate.mockResolvedValue({
      reviewedTarget: { kind: "cms" },
      fieldDiff: [],
      scopeManifest: { paths: [] },
    } as never);
    await renderReviewPage({ view: "verification" });
    expect(trailOn(REVIEW_PATH).map((c) => c.label)).toEqual([
      "Agents",
      AGENT_NAME,
      RUN_NAME,
      "Review",
    ]);
  });

  it("publishes nothing when that access check refuses", async () => {
    mocks.enforceReviewRunAccess.mockResolvedValue({ ok: false } as never);
    await renderReviewPage({ view: "verification" });
    expect(selectCrumbContributions(REVIEW_PATH, EPOCH)).toEqual([]);
  });
});

/**
 * A REFUSAL WIPES WHAT AN AUTHORIZED VISIT PUBLISHED (cinatra#1737's ratified
 * snapshot semantics).
 * The bus deliberately has no unmount clear — the negative surfaces clear it —
 * so now that this page publishes entity names, its own refusal panel has to.
 */
describe("the refusal panel clears the parked snapshot (cinatra#3446 item 1)", () => {
  it("leaves no run or agent name behind for the refused reading", async () => {
    await renderReviewPage();
    expect(selectCrumbContributions(REVIEW_PATH, EPOCH)).not.toEqual([]);
    cleanup();
    mocks.loadReviewGateSurface.mockResolvedValue({ kind: "not-authorized" });
    await renderReviewPage();
    expect(selectCrumbContributions(REVIEW_PATH, EPOCH)).toEqual([]);
    expect(trailOn(REVIEW_PATH).map((c) => c.label)).not.toContain(AGENT_NAME);
  });
});
