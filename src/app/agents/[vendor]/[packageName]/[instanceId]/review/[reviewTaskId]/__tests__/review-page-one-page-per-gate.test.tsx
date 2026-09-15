/**
 * ONE PAGE PER GATE, ON THE REVIEW ROUTE TOO (cinatra#3047, the re-shoot's first
 * and second defects).
 *
 * The change request's point D: "Do not show the skills on top of the review
 * card or the schedule card or any other card either." The ratified drawing at
 * the capture contract's pin puts it as a rule about the whole run surface —
 * one page per gate — and draws the review page's own rail with the Skills entry
 * at its head.
 *
 * WHY THIS SUITE EXISTS BESIDE THE COMPOSITION'S OWN. The review route is a
 * SECOND composition of the run surface, in a different file from the run
 * page's, and no earlier leg of this change touched it: the run page's mount was
 * moved onto its Skills step while this route went on mounting the card straight
 * into the gate region, above the review card. A suite that drives only the
 * composition helper cannot catch that, because the defect is which node the
 * PAGE hands to which slot. So this one renders the real route.
 *
 * The three cards on this page are stubbed to markers, each emitting the one
 * anchor a live DOM reading counts, and nothing else — the same discipline
 * `page.settled-gate.test.tsx` follows for the same route.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";

const mocks = vi.hoisted(() => ({
  getAuthSession: vi.fn(),
  signInRedirectTarget: vi.fn(async () => "/sign-in"),
  redirect: vi.fn((to: string) => {
    throw new Error(`REDIRECT:${to}`);
  }),
  resolveReviewActorContext: vi.fn(),
  loadReviewGateSurface: vi.fn(),
  loadPinnedCapturePair: vi.fn(() => null),
  readAgentRunById: vi.fn(async () => null),
  readAgentTemplateById: vi.fn(async () => null),
  buildRunStepperSteps: vi.fn(() => []),
  readReviewGate: vi.fn(async () => null),
  enforceReviewRunAccess: vi.fn(async () => ({ ok: true })),
  readVerificationRecordForGate: vi.fn(async () => null),
  submitReviewDecisionAction: vi.fn(),
  encodeLifecycleGateRef: vi.fn(() => "ref-3047"),
  encodeScheduleRunRef: vi.fn(() => "sched-3047"),
  // Typed by what the page READS off them, not by the fixture that happens to
  // be first: both readers answer a row or nothing.
  readRunTriggerByRunId: vi.fn(async (): Promise<{ id: string } | null> => null),
  readRecommendationParkForRun: vi.fn(
    async (): Promise<{ status: string } | null> => null,
  ),
  // The run's OWN answer, by the one definition of "decided" — the same ladder
  // the card applies (cinatra#3047, convergence).
  recommendationDecidedForRun: vi.fn((): boolean => false),
}));

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: mocks.getAuthSession,
  signInRedirectTarget: mocks.signInRedirectTarget,
}));
// The shell broadcasts this route's title to the breadcrumb bus, and the
// broadcaster reads the pathname — so the router half of this module has to
// answer here too, or the page throws before it draws anything at all.
vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
  usePathname: () => "/agents/vendor/package/instance/review/task",
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

vi.mock("@cinatra-ai/agents/review-gate-card", () => ({
  ReviewGateCard: ({ view }: { view: { ref: string } }) => (
    <div data-lifecycle-card="artifact_review_gate" data-card-ref={view.ref} />
  ),
}));
// THE ROW'S OWN ROOT ANCHOR — the attribute the re-shoot's live DOM reading
// counted inside `[data-run-detail-column]`. A count here and a count on the
// photograph are the same measurement.
vi.mock("@cinatra-ai/agents/run-recommendation-chip-row", () => ({
  RecommendationHoldCard: () => <div data-run-recommendation-chip-row="" />,
}));
vi.mock("@cinatra-ai/agents/agent-hitl-screen-card", () => ({
  AgentHitlScreenCard: () => <div data-lifecycle-card="agent_hitl_screen" />,
}));
vi.mock("@cinatra-ai/agents/lifecycle-card-runtime", () => ({
  LifecycleCardSurfaceProvider: ({ host, children }: { host: string; children: ReactNode }) => (
    <div data-lifecycle-card-host={host}>{children}</div>
  ),
}));
vi.mock("../review-gate-states", () => ({
  ReviewGateBlocked: ({ reason }: { reason: string }) => (
    <div data-testid="page-gate-blocked" data-blocked-reason={reason} />
  ),
}));
vi.mock("../review-prompt-window", () => ({
  ReviewPromptWindow: () => <div data-testid="review-prompt-window" />,
}));
vi.mock("../verification-view", () => ({
  VerificationView: () => <div data-testid="verification-view" />,
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

import AgentRunReviewPage from "../page";

const ACTOR = {
  actor: { actorType: "human", userId: "u1", source: "route" },
  orgId: "org-1",
  roleHints: { actorOrganizationId: "org-1" },
};

const READY = {
  kind: "ready",
  runId: "run-1",
  reviewTaskId: "task-1",
  targets: [],
  agentSummary: null,
  pinnedCapturePairs: {},
  permissions: { canDecide: true, canComment: true },
};

async function renderPage(): Promise<string> {
  const ui = (await AgentRunReviewPage({
    params: Promise.resolve({
      vendor: "cinatra-ai",
      packageName: "blog-draft-writer-agent",
      instanceId: "run-1",
      reviewTaskId: "task-1",
    }),
    searchParams: Promise.resolve({}),
  })) as ReactElement;
  return renderToStaticMarkup(ui);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAuthSession.mockResolvedValue({ user: { id: "u1" } });
  mocks.signInRedirectTarget.mockResolvedValue("/sign-in");
  mocks.resolveReviewActorContext.mockResolvedValue(ACTOR);
  mocks.encodeLifecycleGateRef.mockReturnValue("ref-3047");
  mocks.encodeScheduleRunRef.mockReturnValue("sched-3047");
  mocks.buildRunStepperSteps.mockReturnValue([]);
  mocks.readRunTriggerByRunId.mockResolvedValue(null);
  mocks.recommendationDecidedForRun.mockReturnValue(false);
  // The run held its skills question and it was DECIDED — the reading the
  // re-shoot photographed, and the one the drawing calls read-only history.
  mocks.readRecommendationParkForRun.mockResolvedValue({ status: "released" });
});

describe("defect 1 — the review page draws no skills row above the review card", () => {
  it("mounts the review card in the gate region with NO chip row in it", async () => {
    mocks.loadReviewGateSurface.mockResolvedValue(READY);

    const html = await renderPage();

    expect(html).toContain('data-lifecycle-card="artifact_review_gate"');
    // The whole page: not one row is drawn while the review card is the open
    // surface. The row lives on the Skills step, which is not the open one.
    expect(html).not.toContain("data-run-recommendation-chip-row");
  });

  it("draws none on a SETTLED gate either — the reading the re-shoot photographed", async () => {
    mocks.loadReviewGateSurface.mockResolvedValue({ kind: "settled" });

    const html = await renderPage();

    expect(html).toContain('data-lifecycle-card="artifact_review_gate"');
    expect(html).not.toContain("data-run-recommendation-chip-row");
  });

  it("draws none while the hold is still LIVE — a live hold is a step, not a banner", async () => {
    mocks.readRecommendationParkForRun.mockResolvedValue({ status: "parked" });
    mocks.loadReviewGateSurface.mockResolvedValue(READY);

    expect(await renderPage()).not.toContain("data-run-recommendation-chip-row");
  });

  it("draws none with a schedule step on the rail as well", async () => {
    mocks.readRunTriggerByRunId.mockResolvedValue({ id: "trig-1" });
    mocks.loadReviewGateSurface.mockResolvedValue(READY);

    const html = await renderPage();

    expect(html).toContain('data-conformance-id="schedule-rail-step"');
    expect(html).not.toContain("data-run-recommendation-chip-row");
  });
});

describe("defect 2 — the Skills entry is on this page's rail", () => {
  it("draws the Skills row for a run that had a recommendation", async () => {
    mocks.loadReviewGateSurface.mockResolvedValue(READY);

    const html = await renderPage();

    expect(html).toContain('data-conformance-id="recommendation-rail-step"');
    expect(html).toContain('data-recommendation-step-settled="true"');
  });

  it("reads the run's own park rather than inventing an entry", async () => {
    mocks.loadReviewGateSurface.mockResolvedValue(READY);
    await renderPage();
    expect(mocks.readRecommendationParkForRun).toHaveBeenCalledWith("run-1");
  });

  it("draws NO Skills row for a run that never held", async () => {
    mocks.readRecommendationParkForRun.mockResolvedValue(null);
    mocks.loadReviewGateSurface.mockResolvedValue(READY);

    const html = await renderPage();

    expect(html).not.toContain('data-conformance-id="recommendation-rail-step"');
    expect(html).toContain('data-lifecycle-card="artifact_review_gate"');
  });

  it("puts it AHEAD of the schedule step — the drawing's order", async () => {
    mocks.readRunTriggerByRunId.mockResolvedValue({ id: "trig-1" });
    mocks.loadReviewGateSurface.mockResolvedValue(READY);

    const html = await renderPage();

    const skills = html.indexOf('data-conformance-id="recommendation-rail-step"');
    const schedule = html.indexOf('data-conformance-id="schedule-rail-step"');
    expect(skills).toBeGreaterThan(-1);
    expect(schedule).toBeGreaterThan(-1);
    expect(skills).toBeLessThan(schedule);
  });
});

describe("convergence — a decision that raced the TTL sweeper is still a decision", () => {
  // The park's status and the decision's evidence are not written atomically. A
  // confirm or a skip that lands as the sweeper fires leaves `policy_unresolved`
  // behind WITH the answer on file, and the card draws that run's settled row.
  // The run page mounts that card for any park; this page read the status alone,
  // so its Skills row stood settled on the rail and CLOSED — the run's own
  // answer reachable on one of its two pages and nowhere on the other.
  it("opens the Skills step over a `policy_unresolved` park the run DID answer", async () => {
    mocks.readRecommendationParkForRun.mockResolvedValue({ status: "policy_unresolved" });
    mocks.recommendationDecidedForRun.mockReturnValue(true);
    mocks.loadReviewGateSurface.mockResolvedValue(READY);

    const html = await renderPage();

    expect(html).toContain('data-conformance-id="recommendation-rail-step"');
    // The row acts: the walk's own name for a step that can be opened.
    expect(html).toContain('data-action="open-recommendation-step"');
    // …and it is asked with THIS run's id and THIS park's status — not derived
    // a second time from the status the page already read.
    expect(mocks.recommendationDecidedForRun).toHaveBeenCalledWith({
      runId: "run-1",
      parkStatus: "policy_unresolved",
    });
    // Still one page per gate: the review card is the open surface and the row
    // is not drawn above it.
    expect(html).toContain('data-lifecycle-card="artifact_review_gate"');
    expect(html).not.toContain("data-run-recommendation-chip-row");
  });

  it("leaves a park NOBODY answered closed and muted — the empty column stays forbidden", async () => {
    mocks.readRecommendationParkForRun.mockResolvedValue({ status: "policy_unresolved" });
    mocks.recommendationDecidedForRun.mockReturnValue(false);
    mocks.loadReviewGateSurface.mockResolvedValue(READY);

    const html = await renderPage();

    // The row keeps its place — hiding it would hide the run's series of steps.
    expect(html).toContain('data-conformance-id="recommendation-rail-step"');
    // It just does not act, so a walk selecting `open-recommendation-step` finds
    // no element it cannot actually press.
    expect(html).not.toContain('data-action="open-recommendation-step"');
  });
});
