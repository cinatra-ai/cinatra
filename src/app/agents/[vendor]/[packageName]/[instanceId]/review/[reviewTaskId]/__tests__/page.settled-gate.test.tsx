/**
 * THE REVIEW PAGE'S NON-PENDING PATH (cinatra#2904).
 *
 * Plan `PLAN: Agents Lifecycle` §4.4 step 7 — "Everyone looking at that run, in
 * any channel, sees the same settled card." The page used to break that on the
 * one host it owns: `loadReviewGateSurface` answered `blocked` for EVERY
 * non-pending gate and the route returned the generic panel before
 * `ReviewGateCard` was mounted, so a gate the transcript drew as "Approved by …"
 * drew a grey "This review is no longer open" here. No card root, no
 * `data-lifecycle-card-host="page_gate_region"`, nothing for a conformance
 * capture to count.
 *
 * WHAT IS PINNED HERE, precisely: the mapping from the loader's answer to the
 * page's composition. The settled READING itself — the outcome word, the decider,
 * the withheld Refresh — is the card's, resolved from the ref against the live
 * reader, and is pinned where it is drawn
 * (`packages/agents/src/__tests__/review-gate-card.test.tsx`,
 * `…/review-gate-card.envelope-parity.test.tsx`) plus the live capture round in
 * `https://github.com/cinatra-ai/cinatra/blob/ec30b7513c6541ec01af7dbef1d0a1979dc074f0/evidence/2904-settled-gate-review-page`. This suite would pass against a card
 * that drew nothing at all, which is why it is not the only proof.
 *
 * The card, the provider and the page's chrome are stubbed so a node process can
 * render an async server component without the client graph. Each stub emits the
 * one fact this suite asks about and nothing else.
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
  encodeLifecycleGateRef: vi.fn(() => "ref-2904"),
}));

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: mocks.getAuthSession,
  signInRedirectTarget: mocks.signInRedirectTarget,
}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
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
vi.mock("@/lib/lifecycle/lifecycle-card-ref", () => ({
  encodeLifecycleGateRef: mocks.encodeLifecycleGateRef,
}));
vi.mock("../actions", () => ({
  submitReviewDecisionAction: mocks.submitReviewDecisionAction,
}));

// ── The stubs ───────────────────────────────────────────────────────────────
// `ReviewGateCard` is the component under discussion, so its stub emits the
// three markers a conformance capture of this host counts, and the ref it was
// mounted with. It does NOT emit a state: the state is the card's own answer
// from the live resolve, and a stub that produced one would be this suite
// asserting a fact it invented.
vi.mock("@cinatra-ai/agents/review-gate-card", () => ({
  ReviewGateCard: ({ view, runId }: { view: { ref: string }; runId?: string | null }) => (
    <div
      data-lifecycle-card="artifact_review_gate"
      data-testid="review-gate-card"
      data-card-ref={view.ref}
      // cinatra#3141 item 1 — the run the card's prompt window keeps its
      // exchange with. The page names it; the card draws the window.
      data-card-run={runId ?? ""}
    />
  ),
}));
// The recommendation card mounts on this same gate region (cinatra#2790 S9f),
// ABOVE the review gate. It is a different card with its own suites, and its
// real body reads the run store and the declared host, so this suite — which is
// about the REVIEW gate's composition — stubs it to a marker that emits no
// `data-lifecycle-card` of its own. Every assertion below names the review
// gate's card explicitly, so the marker cannot answer for it either way.
vi.mock("@cinatra-ai/agents/run-recommendation-chip-row", () => ({
  RecommendationHoldCard: () => <div data-testid="recommendation-hold-card" />,
}));
// The HITL screen card, stubbed for the same reason the §V card above is: this
// suite is about the REVIEW card's mount on this host, and the sibling cards are
// keyed by the run and self-gating, so a live one would only add a resolve this
// page's test has no answer for.
vi.mock("@cinatra-ai/agents/agent-hitl-screen-card", () => ({
  AgentHitlScreenCard: () => <div data-testid="agent-hitl-screen-card" />,
}));
vi.mock("@cinatra-ai/agents/lifecycle-card-runtime", () => ({
  LifecycleCardSurfaceProvider: ({
    host,
    children,
  }: {
    host: string;
    children: ReactNode;
  }) => <div data-lifecycle-card-host={host}>{children}</div>,
}));
vi.mock("../review-gate-states", () => ({
  ReviewGateBlocked: ({ reason }: { reason: string }) => (
    <div data-testid="page-gate-blocked" data-blocked-reason={reason} />
  ),
}));
vi.mock("../review-run-steps", () => ({
  ReviewRunSteps: () => <div data-testid="review-run-steps" />,
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
vi.mock("@/components/page-header-title-sync", () => ({
  PageHeaderTitleSync: ({ title }: { title: string }) => (
    <span data-page-title-sync={title} />
  ),
}));
vi.mock("@/components/page-header", () => ({
  PageHeader: ({ description }: { description?: string }) => (
    <header data-page-header-description={description} />
  ),
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
  mocks.encodeLifecycleGateRef.mockReturnValue("ref-2904");
  mocks.buildRunStepperSteps.mockReturnValue([]);
});

vi.mock("../review-actor", () => ({
  resolveReviewActorContext: () => mocks.resolveReviewActorContext(),
}));

describe("the gate is the whole surface — no page-title block above it", () => {
  // §III of the ratified artifact-review drawing fixes what the surface carries:
  // "the gate itself — header, the one review target, decision bar and the run's
  // prompt window — fills the run detail on the right. There is no standalone
  // review document." The drawing gives the run detail no eyebrow, no page
  // heading and no page subtitle above the gate, and the graded frames measured
  // all three. The gate's own header ("Review requested" + the awaiting pill) is
  // the heading this surface has.
  it("a pending gate draws no eyebrow, page heading or subtitle", async () => {
    mocks.loadReviewGateSurface.mockResolvedValue(READY);
    const html = await renderPage();
    expect(html).toContain('data-lifecycle-card-host="page_gate_region"');
    expect(html).not.toContain("data-page-header-description");
  });

  it("a settled gate draws none either", async () => {
    mocks.loadReviewGateSurface.mockResolvedValue({ kind: "settled" });
    const html = await renderPage();
    expect(html).not.toContain("data-page-header-description");
  });

  // The drawing fixes what is DRAWN. Removing the block must not also take the
  // two things it carried that no reader ever sees as pixels: the surface's only
  // heading, and the leaf-crumb title broadcast (without it the breadcrumb
  // humanises the raw review-task id). Both stay, drawn as nothing.
  it("still names itself: an sr-only heading and the leaf-crumb title, no pixels", async () => {
    mocks.loadReviewGateSurface.mockResolvedValue(READY);
    const html = await renderPage();
    expect(html).toContain('<h1 class="sr-only">Review</h1>');
    expect(html).toContain('data-page-title-sync="Review"');
    expect(html).not.toContain("data-page-header-description");
  });
});

describe("a DECIDED gate composes the one card on the review page (cinatra#2904)", () => {
  it("mounts ReviewGateCard under host page_gate_region instead of the blocked panel", async () => {
    mocks.loadReviewGateSurface.mockResolvedValue({ kind: "settled" });

    const html = await renderPage();

    expect(html).toContain('data-lifecycle-card-host="page_gate_region"');
    expect(html).toContain('data-lifecycle-card="artifact_review_gate"');
    // The page-level panel is what this replaces. It must be gone, or the page
    // would say "no longer open" beside a card naming the outcome.
    expect(html).not.toContain('data-testid="page-gate-blocked"');
  });

  it("addresses the card with the SAME server-minted gate ref a pending gate uses", async () => {
    mocks.loadReviewGateSurface.mockResolvedValue({ kind: "settled" });

    const html = await renderPage();

    expect(mocks.encodeLifecycleGateRef).toHaveBeenCalledWith({
      runId: "run-1",
      reviewTaskId: "task-1",
    });
    expect(html).toContain('data-card-ref="ref-2904"');
  });

  it("keeps the run-step rail beside it — the settled card is still run context", async () => {
    mocks.loadReviewGateSurface.mockResolvedValue({ kind: "settled" });

    expect(await renderPage()).toContain('data-testid="review-run-steps"');
  });

  it("the PAGE composes no window of its own on a decided gate", async () => {
    // NAMED FOR WHAT IT PROVES. The card is stubbed in this suite — it is the
    // component under discussion, not the component under test — so this
    // assertion is about this page's own composition: it mounts the card and
    // nothing else that could draw a second channel. Whether a DECIDED gate
    // carries a window is the card's answer, and it is proven on the card, in
    // `packages/agents/src/__tests__/review-gate-card.drawing-departures-3141.test.tsx`
    // ("a SETTLED gate carries no window").
    mocks.loadReviewGateSurface.mockResolvedValue({ kind: "settled" });

    expect(await renderPage()).not.toContain('data-conformance-id="review-prompt-window"');
  });

  it("draws no card at all when the instance cannot mint a ref (no second composition)", async () => {
    mocks.loadReviewGateSurface.mockResolvedValue({ kind: "settled" });
    mocks.encodeLifecycleGateRef.mockReturnValue(null as unknown as string);

    const html = await renderPage();

    expect(html).toContain('data-lifecycle-card-host="page_gate_region"');
    expect(html).not.toContain('data-lifecycle-card="artifact_review_gate"');
  });
});

describe("what the settled composition must NOT swallow (cinatra#2904 AC 3–5)", () => {
  it("an UNAVAILABLE gate keeps the generic blocked panel and produces no card DOM", async () => {
    // The loader answers `blocked` for a gate that never existed or cannot be
    // read. Turning that into settled-card DOM would let a replayed or garbage
    // ref draw a decision that was never taken.
    mocks.loadReviewGateSurface.mockResolvedValue({
      kind: "blocked",
      reason: "no-longer-pending",
    });

    const html = await renderPage();

    expect(html).toContain('data-testid="page-gate-blocked"');
    expect(html).toContain('data-blocked-reason="no-longer-pending"');
    expect(html).not.toContain('data-lifecycle-card="artifact_review_gate"');
    expect(html).not.toContain('data-lifecycle-card-host="page_gate_region"');
  });

  it("targets-mismatch still draws the blocked panel with its own reason", async () => {
    mocks.loadReviewGateSurface.mockResolvedValue({
      kind: "blocked",
      reason: "targets-mismatch",
    });

    const html = await renderPage();

    expect(html).toContain('data-blocked-reason="targets-mismatch"');
    expect(html).not.toContain('data-lifecycle-card="artifact_review_gate"');
  });

  it("a reader with no run access still gets the not-authorized panel, never a card", async () => {
    mocks.loadReviewGateSurface.mockResolvedValue({ kind: "not-authorized" });

    const html = await renderPage();

    expect(html).toContain('data-conformance-id="review-not-authorized"');
    expect(html).not.toContain('data-lifecycle-card="artifact_review_gate"');
    expect(html).not.toContain('data-conformance-id="review-prompt-window"');
  });
});

describe("the PENDING composition is unchanged (cinatra#2904 regression floor)", () => {
  // THE WINDOW MOVED INTO THE CARD (cinatra#3141 item 1). The drawing puts the
  // conversational prompt window inside the gate's own frame, beneath the
  // decision bar; this page mounted it separately, at page level, which is why
  // the run page's own gate carried no window at all while this page carried
  // one. `ReviewGateCard` draws it now, so what this page mounts is the card —
  // and the window's own permission reading is proven where the window lives,
  // by `packages/agents/src/__tests__/review-gate-card.drawing-departures-3141.test.tsx`
  // and its render suite.
  it("still mounts the card, which is what carries the gate AND its prompt window (and the page composes no second)", async () => {
    mocks.loadReviewGateSurface.mockResolvedValue(READY);

    const html = await renderPage();

    expect(html).toContain('data-lifecycle-card="artifact_review_gate"');
    expect(html).toContain('data-lifecycle-card-host="page_gate_region"');
    // Exactly one card, so exactly one window — and the window is the CARD's:
    // this page composes none, which is the whole of what this assertion (over
    // a stubbed card) can and does prove. The window's own permission readings
    // live with the window.
    expect(html).not.toContain('data-conformance-id="review-prompt-window"');
  });

  it("names the run the card's window keeps its exchange with", async () => {
    // The window is the run's conversation (cinatra#2933), so a card mounted
    // without a run would draw the gate and no channel — the exact defect on the
    // run page that #3141 item 1 fixes. The page names it here.
    mocks.loadReviewGateSurface.mockResolvedValue(READY);
    const html = await renderPage();
    expect(html).toContain('data-card-run="run-1"');
  });
});
