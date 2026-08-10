// @vitest-environment jsdom
/**
 * The flow-agent run-DETAIL page gets its review branch (cinatra#2623).
 *
 * THE DEFECT, verbatim from the issue: a reviewer who opens
 * `/agents/<vendor>/<package>/<instanceId>` while the run is paused on a MARKED
 * review gate saw "Waiting for input — no renderer configured for this step."
 * `OrchestratorStepperPanel` routed every pending approval through
 * `HitlApprovalCard`, which resolves through the field-renderer registry — and
 * `ARTIFACT_REVIEW_REDIRECT_RENDERER_ID` is deliberately NOT registered there
 * (the cinatra#1796 note), because a marked gate is handled inline, host by
 * host. S2 (#2566) gave three hosts their inline handling; this stepper was not
 * one of them, so the gate fell to the registry's generic fallback with no way
 * to approve, reject or comment from that page.
 *
 * What this suite locks:
 *
 *   1. a marked gate carrying its server-minted card ref renders the SAME
 *      `ReviewGateCard` the run card / chat thread / review page mount — not a
 *      second renderer, and never the generic fallback (#2623 AC-1 + AC-2);
 *   2. a marked gate with NO ref (a gate emitted before S2, or an instance whose
 *      auth secret rotated) still gets a GATE-SPECIFIC card that names the review
 *      and links to the decision surface — AC-2's second arm, so the gap reads
 *      as designed rather than as a missing renderer;
 *   3. every OTHER interrupt kind still routes to `HitlApprovalCard` exactly as
 *      before (#2623 AC-3, no regression).
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/orchestrator-stepper-review-gate-branch.test.tsx
 */
import React from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { ARTIFACT_REVIEW_REDIRECT_RENDERER_ID } from "../agent-builder-ids";

vi.mock("lucide-react", () => {
  const StubIcon: React.FC = () => null;
  return new Proxy({} as Record<string, React.FC>, {
    get: (_target, prop) => {
      if (prop === "__esModule") return true;
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return undefined;
      return StubIcon;
    },
    has: () => true,
    ownKeys: () => ["AlertCircle", "ArrowRight", "Check", "Info", "Loader2", "Pause", "X", "default"],
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
      value: StubIcon,
    }),
  });
});

vi.mock("@/lib/cinatra-toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("../orchestrator-actions", () => ({
  cancelOrchestratorAction: vi.fn(async () => ({ ok: true })),
  resumeStoppedOrchestratorAction: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../run-actions", () => ({
  startDevChildPreviewRun: vi.fn(async () => ({ ok: false })),
  buildSubmissionMapByStepIndex: vi.fn(async () => []),
  createAndTriggerRun: vi.fn(async () => ({ ok: true, runId: "run-next" })),
  readRunOutputEvidence: vi.fn(async () => ({
    ok: true,
    outputs: [],
    hasTranscript: false,
    hasStepResults: false,
  })),
}));

vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: vi.fn(async () => ({ state: "none" })),
  confirmRunRecommendationAction: vi.fn(async () => ({ ok: true })),
  skipRunRecommendationAction: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
}));

vi.mock("../run-name-actions", () => ({
  ensureOrCheckRunNameAction: vi.fn(async () => ({ ok: true, title: "Run 1" })),
}));

vi.mock("../hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../use-runtime-field-renderer-bindings", () => ({
  useRuntimeFieldRendererBindings: () => ({ bindings: {}, loading: false }),
}));

// The ONE card, stubbed so the assertion is "this host mounts THE review
// renderer with the server-minted ref", not a re-test of S2's drawing (which
// has its own suite). The stub records the view it was handed.
const reviewCardViews: unknown[] = [];
vi.mock("../review-gate-card", () => ({
  LIFECYCLE_VIEW_SCHEMA_VERSION: 1,
  ReviewGateCard: (props: { view: unknown }) => {
    reviewCardViews.push(props.view);
    return <div data-testid="review-gate-card" />;
  },
}));

let interruptContext: {
  schema: Record<string, unknown>;
  xRenderer: string;
  values: Record<string, unknown>;
  reviewTaskId: string;
  fieldName?: string;
} | null = null;

vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: (_runId: string, opts: { initialStatus?: string }) => ({
    status: opts?.initialStatus ?? "pending_approval",
    interruptContext,
    lifecycleInterrupt: null,
    messages: [],
    streamedText: "",
    presentationHint: null,
    dataPartFrames: [],
    isLive: true,
    error: null,
  }),
}));

afterEach(() => {
  cleanup();
  reviewCardViews.length = 0;
  interruptContext = null;
  vi.clearAllMocks();
});

type PanelProps = import("../orchestrator-stepper-panel").OrchestratorStepperPanelProps;

function baseProps(overrides: Partial<PanelProps> = {}): PanelProps {
  return {
    runId: "run-2623",
    initialStatus: "pending_approval",
    initialError: null,
    agUiEnabled: true as boolean | null,
    agentPackageName: "@cinatra-review-fixture/marked-review-gate",
    inputParams: {},
    stepperSteps: [
      { index: 1, stepNumber: 0, label: "Setup", xRenderer: "grouped-setup-form" },
      {
        index: 2,
        stepNumber: 1,
        label: "Review",
        xRenderer: ARTIFACT_REVIEW_REDIRECT_RENDERER_ID,
      },
    ],
    agentId: "cinatra-review-fixture/marked-review-gate",
    lgThreadId: null,
    templateId: "tmpl-2623",
    templateName: "Marked review gate",
    ...overrides,
  };
}

const GENERIC_FALLBACK = /no renderer configured for this step/i;

describe("OrchestratorStepperPanel — the marked review gate (cinatra#2623)", () => {
  it("mounts the ONE ReviewGateCard, addressed by the server-minted ref", async () => {
    interruptContext = {
      schema: { type: "object" },
      xRenderer: ARTIFACT_REVIEW_REDIRECT_RENDERER_ID,
      values: {
        reviewSurfaceUrl:
          "/agents/cinatra-review-fixture/marked-review-gate/run-2623/review/task-1",
        reviewTaskId: "task-1",
        lifecycleCardRef: "server-minted-ref",
        targetCount: 1,
        agentSummary: "",
      },
      reviewTaskId: "task-1",
    };

    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps()} />);

    await waitFor(() =>
      expect(screen.queryByTestId("review-gate-card")).not.toBeNull(),
    );
    // The defect this issue filed is gone.
    expect(screen.queryByText(GENERIC_FALLBACK)).toBeNull();
    // Addressed by the ref the server minted, never by ids the panel holds.
    // (The stub records once per render; every recorded view must be the same
    // identity — one card, one gate.)
    expect(reviewCardViews.length).toBeGreaterThan(0);
    for (const view of reviewCardViews) {
      expect(view).toMatchObject({
        viewType: "artifact_review_gate",
        ref: "server-minted-ref",
      });
    }
  });

  it("gives a refless gate a gate-SPECIFIC card + link, never the generic fallback", async () => {
    interruptContext = {
      schema: { type: "object" },
      xRenderer: ARTIFACT_REVIEW_REDIRECT_RENDERER_ID,
      values: {
        reviewSurfaceUrl:
          "/agents/cinatra-review-fixture/marked-review-gate/run-2623/review/task-1",
        reviewTaskId: "task-1",
      },
      reviewTaskId: "task-1",
    };

    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps()} />);

    await waitFor(() =>
      expect(
        document.querySelector('[data-review-gate-step="link-only"]'),
      ).not.toBeNull(),
    );
    expect(screen.queryByText(GENERIC_FALLBACK)).toBeNull();
    expect(screen.queryByTestId("review-gate-card")).toBeNull();
    const link = screen.getByRole("link", { name: /open the review/i });
    expect(link.getAttribute("href")).toBe(
      "/agents/cinatra-review-fixture/marked-review-gate/run-2623/review/task-1",
    );
  });

  it("refuses an off-site review URL — a link is rendered only for a same-origin path", async () => {
    interruptContext = {
      schema: { type: "object" },
      xRenderer: ARTIFACT_REVIEW_REDIRECT_RENDERER_ID,
      values: {
        reviewSurfaceUrl: "https://evil.example/review",
        reviewTaskId: "task-1",
      },
      reviewTaskId: "task-1",
    };

    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps()} />);

    await waitFor(() =>
      expect(
        document.querySelector('[data-review-gate-step="link-only"]'),
      ).not.toBeNull(),
    );
    expect(screen.queryByRole("link", { name: /open the review/i })).toBeNull();
    expect(screen.queryByText(/step rail/i)).not.toBeNull();
  });

  it("leaves every other interrupt kind on the approval card (AC-3, no regression)", async () => {
    interruptContext = {
      schema: {
        type: "object",
        properties: { note: { type: "string", title: "Note" } },
      },
      xRenderer: "@cinatra-ai/agent-builder:schema-field-fallback",
      values: {},
      reviewTaskId: "task-generic",
      fieldName: "note",
    };

    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps()} />);

    // Not the review branch — no card, no link-only frame.
    expect(screen.queryByTestId("review-gate-card")).toBeNull();
    expect(document.querySelector('[data-review-gate-step="link-only"]')).toBeNull();
    expect(reviewCardViews).toHaveLength(0);
  });
});

describe("the review branch is a MOUNT, not a second renderer", () => {
  it("the stepper composes the shared card and defines no review drawing of its own", () => {
    const stepper = readFileSync(
      path.join(__dirname, "..", "orchestrator-stepper-panel.tsx"),
      "utf8",
    );
    // It mounts the shared component from the one module that draws it…
    expect(stepper).toMatch(/from "\.\/review-gate-card"/);
    expect(stepper).toMatch(/<ReviewGateCard/);
    // …under a declared lifecycle host (fail-closed gating still applies)…
    expect(stepper).toMatch(/<LifecycleCardSurfaceProvider host="run_card">/);
    // …and it never reaches for the review decision core itself.
    expect(stepper).not.toMatch(/submitReviewDecision/);
    expect(stepper).not.toMatch(/ReviewDecisionBar/);
  });
});
