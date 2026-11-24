// @vitest-environment jsdom
/**
 * THE REVIEW PAGE'S WINDOW STANDS IN THE DETAIL COLUMN ON EVERY BRANCH
 * (cinatra#3487).
 *
 * The ratified drawing puts the run's prompt window "under the decision bar, in
 * the same column" (`app-artifact-review.html` §I). The run surface's frame
 * draws its own chrome inside its detail column, but a run with NO gate step at
 * all (no Skills question, no schedule) keeps the inert two columns this page
 * has always drawn, with no frame. On that branch the page's own chrome is the
 * one that owns the window, so where the page places that chrome is where the
 * window lands.
 *
 * WHAT IS RENDERED IS THE PAGE ITSELF: the route's server component is awaited
 * and its tree mounted, so the chrome, the run surface and the two columns are
 * the production composition. Only the data reads, the shell, the step rail and
 * the gate card are stood in for; the card's stand-in mounts the REAL review
 * window screen, which registers with whichever chrome is nearest — exactly
 * what the real card does.
 */
import React, { type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  getAuthSession: vi.fn(),
  resolveReviewActorContext: vi.fn(),
  loadReviewGateSurface: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: mocks.getAuthSession,
  signInRedirectTarget: vi.fn(async () => "/sign-in"),
}));
vi.mock("@/app/artifacts/[id]/review-gate-ports", () => ({
  loadReviewGateSurface: mocks.loadReviewGateSurface,
}));
vi.mock("@cinatra-ai/agents/store", () => ({
  readAgentRunById: vi.fn(async () => null),
  readAgentTemplateById: vi.fn(async () => null),
}));
vi.mock("@cinatra-ai/agents/run-stepper-steps", () => ({
  buildRunStepperSteps: vi.fn(() => []),
}));
vi.mock("@cinatra-ai/agents/artifact-review-gate-store", () => ({
  readReviewGate: vi.fn(async () => null),
  enforceReviewRunAccess: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@cinatra-ai/agents/lifecycle-verification-store", () => ({
  readVerificationRecordForGate: vi.fn(async () => null),
}));
vi.mock("@/lib/lifecycle/lifecycle-card-ref", () => ({
  encodeLifecycleGateRef: vi.fn(() => "gate-ref-3487"),
  encodeScheduleRunRef: vi.fn(() => "schedule-ref-3487"),
}));
// THE ZERO-GATE INPUTS: no schedule row (so `scheduleCardRef` is null) and no
// park row (so the Skills entry is "none").
vi.mock("@cinatra-ai/agents/trigger-store", () => ({
  readRunTriggerByRunId: vi.fn(async () => null),
}));
vi.mock("@cinatra-ai/agents/recommendation-hold", () => ({
  readRecommendationParkForRun: vi.fn(async () => null),
}));
vi.mock("@cinatra-ai/agents/run-recommendation-core", () => ({
  recommendationDecidedForRun: vi.fn(() => false),
}));
vi.mock("../actions", () => ({ submitReviewDecisionAction: vi.fn() }));
vi.mock("../review-actor", () => ({
  resolveReviewActorContext: () => mocks.resolveReviewActorContext(),
}));

// The window's field and its server bridge, as the review window's own render
// suite stands them in (the real field pulls browser-only deps). The stand-in
// carries the real field's textbox role, so the reader can count it. The real
// field's editor is read in the run page's `SetupScreen` test and the fixtures.
vi.mock("@cinatra-ai/sdk-ui", () => ({
  LoadingSpinner: () => null,
  PromptField: ({ placeholder }: { placeholder?: string }) => (
    <div data-testid="run-window-prompt" role="textbox">{placeholder}</div>
  ),
}));
vi.mock("@cinatra-ai/agents/run-window-actions", () => ({
  loadRunWindowConversation: vi.fn(async () => []),
  sendRunWindowTurn: vi.fn(async () => ({ ok: true, entries: [], fills: [], acted: false })),
}));

// THE CARD: a pending review this person may comment on. Its stand-in mounts
// the real window screen the card mounts, so the registration road is the
// production one.
vi.mock("@cinatra-ai/agents/review-gate-card", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cinatra-ai/agents/review-gate-card")>();
  return {
    ...actual,
    ReviewGateCard: ({ view, runId }: { view: { ref: string }; runId?: string | null }) => (
      <div data-lifecycle-card="artifact_review_gate" data-card-ref={view.ref}>
        <div data-review-decision-bar="" />
        <actual.ReviewGatePromptWindow
          storageKey={`cinatra_review_window_${runId ?? ""}`}
          canComment
          runId={runId ?? ""}
          boundCardRef={view.ref}
        />
      </div>
    ),
  };
});
// The Skills step's card: never drawn on the zero-gate branch, and its real
// module reaches the server-side extension graph.
vi.mock("@cinatra-ai/agents/run-recommendation-chip-row", () => ({
  RecommendationHoldCard: () => null,
}));
vi.mock("@cinatra-ai/agents/agent-hitl-screen-card", () => ({
  AgentHitlScreenCard: () => null,
}));
// cinatra#4150: the page also mounts the publish card beside the hitl screen card. This suite mocks the card
// runtime whole, so the card is stubbed the same way; with no open decision the real card draws nothing. The stub
// names the card's file, which the page's package subpath resolves to, so this file also loads before that subpath.
vi.mock("../../../../../../../../../packages/agents/src/publish-decision-card-view", () => ({
  PublishDecisionCard: () => null,
}));
vi.mock("@cinatra-ai/agents/lifecycle-card-runtime", () => ({
  LifecycleCardSurfaceProvider: ({ host, children }: { host: string; children: ReactNode }) => (
    <div data-lifecycle-card-host={host}>{children}</div>
  ),
}));
// A NON-EMPTY review rail: the left column has rows of its own.
vi.mock("../review-run-steps", () => ({
  ReviewRunSteps: () => (
    <nav data-testid="review-run-steps">
      <div>1 Review</div>
    </nav>
  ),
}));
vi.mock("../review-gate-states", () => ({ ReviewGateBlocked: () => null }));
vi.mock("../verification-view", () => ({ VerificationView: () => null }));
vi.mock("@/components/layout/main", () => ({
  Main: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock("@/components/page-content", () => ({
  PageContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/page-header-title-sync", () => ({ PageHeaderTitleSync: () => null }));
vi.mock("@/components/crumb-contributions", () => ({ CrumbContributions: () => null }));

import AgentRunReviewPage from "../page";
import type * as RunWindowOwnershipModule from "../../../../../../../../../tests/e2e/design/conformance/run-window-ownership";
// The module the fix adds is loaded inside the tests that use it, through a
// specifier the transform does not resolve when it loads this file: before the
// fix the file still loads and those tests fail on the missing module.
// red-first-expect: Cannot find module '/tests/e2e/design/conformance/run-window-ownership'
const RUN_WINDOW_OWNERSHIP = "../../../../../../../../../tests/e2e/design/conformance/run-window-ownership";
let assertRunWindowOwnership!: typeof RunWindowOwnershipModule.assertRunWindowOwnership;
let readRunWindowOwnership!: typeof RunWindowOwnershipModule.readRunWindowOwnership;
async function loadRunWindowOwnership(): Promise<void> {
  ({ assertRunWindowOwnership, readRunWindowOwnership } = (await import(
    /* @vite-ignore */ RUN_WINDOW_OWNERSHIP
  )) as typeof RunWindowOwnershipModule);
}

const READY = {
  kind: "ready",
  runId: "run-3487",
  reviewTaskId: "task-3487",
  targets: [],
  agentSummary: null,
  pinnedCapturePairs: {},
  permissions: { canDecide: true, canComment: true },
};

async function mountPage() {
  const ui = (await AgentRunReviewPage({
    params: Promise.resolve({
      vendor: "cinatra-ai",
      packageName: "blog-draft-writer-agent",
      instanceId: "run-3487",
      reviewTaskId: "task-3487",
    }),
    searchParams: Promise.resolve({}),
  })) as ReactElement;
  return render(ui);
}

const settle = () => new Promise((r) => setTimeout(r, 60));

beforeEach(() => {
  cleanup();
  document.body.innerHTML = "";
  mocks.getAuthSession.mockResolvedValue({ user: { id: "u1" } });
  mocks.resolveReviewActorContext.mockResolvedValue({
    actor: { actorType: "human", userId: "u1", source: "route" },
    orgId: "org-1",
    roleHints: { actorOrganizationId: "org-1" },
  });
  mocks.loadReviewGateSurface.mockResolvedValue(READY);
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("a run with no gate step keeps the window in the detail column (cinatra#3487)", () => {
  it("draws exactly one window host, inside the two-column frame and under the gate", async () => {
    const { container } = await mountPage();
    await settle();

    const frame = container.querySelector<HTMLElement>("[data-run-detail-contract]");
    expect(frame).not.toBeNull();
    // The zero-gate branch: no rail frame, so no frame-drawn detail column.
    expect(container.querySelector("[data-run-detail-column]")).toBeNull();

    const hosts = container.querySelectorAll<HTMLElement>('[data-run-window-host="page-chrome"]');
    expect(hosts.length).toBe(1);
    const host = hosts[0]!;
    // The window is drawn for a reader who may comment.
    expect(host.contains(screen.getByTestId("run-window-prompt"))).toBe(true);

    // INSIDE the frame, never appended after it beneath both columns.
    expect(host.closest("[data-run-detail-contract]")).toBe(frame);
    expect(host.parentElement).not.toBe(frame);

    // In the SAME column as the gate and its decision bar, and not in the rail.
    const card = container.querySelector<HTMLElement>('[data-lifecycle-card="artifact_review_gate"]')!;
    const rail = screen.getByTestId("review-run-steps");
    expect(card).not.toBeNull();
    expect(rail.contains(host)).toBe(false);
    expect(host.parentElement!.contains(card)).toBe(true);
    expect(host.parentElement!.contains(rail)).toBe(false);
    // Under the decision bar: the host follows the card in document order.
    expect(card.compareDocumentPosition(host) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

// cinatra#3487 item 3: THE DESIGN-CONFORMANCE READING ON THE REAL PAGE. The
// conformance suite's own reader (`tests/e2e/design/conformance/
// run-window-ownership.ts`, the one the Playwright reading of the fixtures route
// evaluates) is run here on the review ROUTE MODULE's own tree: the window's
// anchor is the drawing's `run-window` (`app-artifact-review.html` §I.6), it is
// a descendant of the page chrome, never of `[data-lifecycle-card-host]`, and
// the page carries no second window.
describe("the design-conformance reading of the real review page (cinatra#3487 item 3)", () => {
  it("one run-window anchor, in the page chrome, none in a card, and no second window", async () => {
    await loadRunWindowOwnership();
    const { container } = await mountPage();
    await settle();

    const anchors = container.querySelectorAll<HTMLElement>('[data-conformance-id="run-window"]');
    expect(anchors.length).toBe(1);
    const anchor = anchors[0]!;
    expect(anchor.closest('[data-run-window-host="page-chrome"]')).not.toBeNull();
    expect(anchor.closest("[data-lifecycle-card-host]")).toBeNull();
    // The anchor is the window itself: the field's stand-in is the one textbox in it.
    expect(anchor.contains(screen.getByTestId("run-window-prompt"))).toBe(true);
    expect(anchor.querySelectorAll('[role="textbox"]').length).toBe(1);

    const reading = readRunWindowOwnership(container);
    expect(reading).toMatchObject({ windows: 1, ownedWindows: 1, promptsInCards: 0 });
    expect(() => assertRunWindowOwnership(reading, "review")).not.toThrow();
  });
});
