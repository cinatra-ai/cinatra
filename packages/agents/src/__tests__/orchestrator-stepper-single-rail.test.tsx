// @vitest-environment jsdom
/**
 * ONE step rail on the run detail — the DOM half (cinatra#2739).
 *
 * The reported regression (owner evidence, the S4 E2E round, cell E12): the Email
 * Outreach Agent run detail drew the SAME five steps TWICE, side by side — the
 * page-level `RunStepRailPanel` on the left, `OrchestratorStepperPanel`'s own
 * `StepperColumn` on the right. Owner ruling 2026-08-14: exactly ONE column.
 *
 * This suite mounts the REAL panel — the rail that survives — and locks:
 *
 *   1. it renders EXACTLY ONE rail element, in every run state the surface
 *      reaches (pending / paused / running / failed / completed);
 *   2. the rail carries the UNION of what the two used to carry between them:
 *      the ⓘ gate tooltip and the replay click it always had, PLUS the review
 *      deep links (gate, verification, lifecycle reason) that only the retired
 *      page-level rail drew;
 *   3. the dev-preview child panel adds NO second rail — the path by which an
 *      empty column would sneak the duplicate back in;
 *   4. the page-level rail still renders one rail with the same deep links on
 *      the branch it still owns (the single-agent / transcript run).
 *
 * `[data-run-step-rail]` is THE rail marker: both components carry it, so
 * counting it is exactly the "never two" assertion, whichever one is mounted.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/orchestrator-stepper-single-rail.test.tsx
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

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
    ownKeys: () => ["Check", "ClipboardCheck", "Info", "Pause", "ScanSearch", "SkipForward", "default"],
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
      value: StubIcon,
    }),
  });
});

vi.mock("@/lib/cinatra-toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// The generated manifests are build artifacts whose `import()` targets are the
// cloned extension packages (absent in a partial worktree). Stubbed empty — the
// same idiom as schema-field-renderer-floor-bypass.test.tsx; a step rail needs
// neither map.
vi.mock("@/lib/generated/field-renderer-components", () => ({
  GENERATED_FIELD_RENDERER_COMPONENTS: {},
}));

vi.mock("@/lib/generated/extensions.server", () => ({
  STATIC_EXTENSION_MANIFEST: {},
  GENERATED_CONNECTOR_ENTRY_MODULES: {},
  GENERATED_CONNECTOR_MCP_MODULES: {},
  GENERATED_DEV_SETUP_MODULES: {},
  GENERATED_WIDGET_STREAM_AGENTS: {},
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
  decideRunRecommendationAction: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../run-name-actions", () => ({
  ensureOrCheckRunNameAction: vi.fn(async () => ({ ok: true, title: "Run 1" })),
}));

vi.mock("../hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: (_runId: string, opts: { initialStatus?: string }) => ({
    status: opts?.initialStatus ?? "completed",
    interruptContext: null,
    messages: [],
    streamedText: "",
    presentationHint: null,
    dataPartFrames: [],
    error: null,
  }),
}));

vi.mock("../use-runtime-field-renderer-bindings", () => ({
  useRuntimeFieldRendererBindings: () => ({ bindings: {}, loading: false }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

type PanelProps = import("../orchestrator-stepper-panel").OrchestratorStepperPanelProps;
type RailEntry = import("../run-step-rail").RunStepRailEntry;

const REVIEW_HREF_BASE = "/agents/cinatra-ai%2Femail-outreach-agent/run-2739/review";

/** The email-outreach shape from the E12 evidence: five policy steps, the ⓘ
 *  description on the gated ones. */
const EMAIL_OUTREACH_STEPS: PanelProps["stepperSteps"] = [
  { index: 1, stepNumber: 0, label: "Campaign setup", xRenderer: "grouped-setup-form", description: "Collect the campaign brief" },
  { index: 2, stepNumber: 1, label: "Find recipients", xRenderer: "campaign-recipients-review" },
  { index: 3, stepNumber: 2, label: "Review recipients", xRenderer: "campaign-recipients-review", description: "Approve who gets mailed" },
  { index: 4, stepNumber: 3, label: "Draft emails", xRenderer: "email-drafts-review" },
  { index: 5, stepNumber: 4, label: "Review drafts", xRenderer: "email-drafts-review", description: "Approve the drafts before send" },
];

/** The merged rail's NON-spine rows — the deep links the retired page-level rail
 *  used to be the only carrier of. */
const RAIL_EXTRAS: RailEntry[] = [
  {
    key: "gate:task-resolved",
    ordinal: 6,
    kind: "gate",
    label: "Review",
    status: "resolved",
    sources: ["gate"],
    gate: {
      gateId: "gate-1",
      reviewTaskId: "task-resolved",
      // `approved` is not a stored disposition, so it records no act — the
      // fixture keeps its value and states the consequence (cinatra#3080).
      disposition: "approved",
      settledAct: null,
      resolved: true,
    },
  },
  {
    key: "verification:task-resolved",
    ordinal: 6,
    kind: "verification",
    label: "Audit",
    status: "completed",
    sources: ["verification"],
    verification: { gateId: "gate-1", reviewTaskId: "task-resolved", outcome: "verified" },
  },
  {
    key: "gate:task-pending",
    ordinal: 7,
    kind: "gate",
    label: "Review",
    status: "pending",
    sources: ["gate"],
    gate: {
      gateId: "gate-2",
      reviewTaskId: "task-pending",
      disposition: null,
      settledAct: null,
      resolved: false,
    },
  },
  {
    key: "lifecycle:event-9",
    ordinal: 8,
    kind: "lifecycleDecision",
    label: "Review skipped",
    status: "skipped",
    sources: ["lifecycleDecision"],
    lifecycleDecision: {
      eventId: "event-9",
      artifactId: "artifact-9",
      outcome: "skipped",
      decidedBy: "org-bound",
      latticeOutcome: "skip",
      reason: "The org policy skips review for outreach drafts.",
    },
  },
];

function baseProps(overrides: Partial<PanelProps> = {}): PanelProps {
  return {
    runId: "run-2739",
    initialStatus: "completed",
    initialError: null,
    agUiEnabled: false as boolean | null,
    agentPackageName: "@cinatra-ai/email-outreach-agent",
    inputParams: {},
    stepperSteps: EMAIL_OUTREACH_STEPS,
    agentId: "cinatra-ai/email-outreach-agent",
    lgThreadId: null,
    templateId: "tmpl-2739",
    templateName: "Email Outreach Agent",
    railExtras: RAIL_EXTRAS,
    reviewHrefBase: REVIEW_HREF_BASE,
    ...overrides,
  };
}

function rails(): NodeListOf<Element> {
  return document.querySelectorAll("[data-run-step-rail]");
}

describe("the flow-agent run detail renders ONE step rail, never two (cinatra#2739)", () => {
  // Every state the run surface reaches. `stopped` is the paused/cancelled one;
  // `pending_input` / `queued` are the pre-execution ones the panel still draws.
  const STATES = ["pending_input", "queued", "running", "pending_approval", "stopped", "failed", "completed"];

  for (const initialStatus of STATES) {
    it(`renders exactly one rail in the "${initialStatus}" state`, async () => {
      const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
      render(
        <OrchestratorStepperPanel
          {...baseProps({ initialStatus, initialError: initialStatus === "failed" ? "boom" : null })}
        />,
      );
      expect(rails().length).toBe(1);
      // …and the rail it renders is the LIVE one (the spine it draws is the
      // panel's own step list, not a server snapshot beside it).
      expect(rails()[0].querySelectorAll('[data-rail-kind="step"]').length).toBe(
        EMAIL_OUTREACH_STEPS.length,
      );
    });
  }

  it("draws NO rail on the step-less branch — even carrying railExtras — because the SCREEN keeps its rail there", async () => {
    // THE MUTUAL-EXCLUSION INVARIANT, closed end to end. The two halves of this
    // fix are tested apart: `screenHostsStepRail` decides for the screen, this
    // panel decides for itself. They are only jointly correct if they never both
    // say yes, and there is exactly one branch where that could happen —
    // `panel === "stepper"` with ZERO policy steps. There the screen KEEPS the
    // page-level rail (asserted in instance-screens-single-step-rail.test.ts,
    // deliberately, so a flow run whose policy fired no renderer gate does not
    // lose its review links), so this panel must draw none.
    //
    // The dangerous input is a NON-EMPTY railExtras: that is precisely when
    // drawing a rail here looks right in isolation ("we have rows, show them"),
    // and `StepperColumn`'s own guard admits that shape. The panel's step-less
    // section returns before the column is ever reached, and this pins it — the
    // duplicate rail cannot come back through that door.
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(
      <OrchestratorStepperPanel {...baseProps({ stepperSteps: [], railExtras: RAIL_EXTRAS })} />,
    );
    expect(rails().length).toBe(0);
  });

  it("adds no second rail when the dev preview inlines a child panel", async () => {
    // The child panel mounts in embedMode with an EMPTY step list. An empty rail
    // element would be a second `[data-run-step-rail]` in the DOM — the exact
    // shape of the defect, re-introduced from inside.
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps({ embedMode: true, stepperSteps: [], railExtras: [] })} />);
    expect(rails().length).toBe(0);
  });
});

describe("the surviving rail carries the UNION of both rails' behaviours", () => {
  it("keeps the ⓘ gate tooltip trigger the page-level rail never had", async () => {
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps()} />);
    const rail = rails()[0];
    // One per step that carries a description — three in the email-outreach shape.
    expect(rail.querySelectorAll("[data-rail-step-info]").length).toBe(3);
  });

  it("keeps the completed-step REPLAY click", async () => {
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(
      <OrchestratorStepperPanel
        {...baseProps({
          submissionMap: [
            [1, { submittedValues: { campaignName: "Spring outreach" }, schemaSnapshot: null, stepKey: "step-0" }],
          ],
        })}
      />,
    );
    // A completed run drives activeStep past the end, so every step is completed
    // and every step row advertises the replay affordance.
    const rail = rails()[0];
    const replayRows = rail.querySelectorAll('[data-rail-replay="open"]');
    expect(replayRows.length).toBe(EMAIL_OUTREACH_STEPS.length);

    fireEvent.click(replayRows[0].querySelector("button")!);
    await waitFor(() =>
      expect(document.body.textContent).toContain("Spring outreach"),
    );
    // Replay opened in the right pane — and did not fork a second rail.
    expect(rails().length).toBe(1);
  });

  it("carries the REVIEW deep links that only the page-level rail used to draw", async () => {
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps()} />);
    const rail = rails()[0];

    const pending = rail.querySelector('[data-rail-gate-link="task-pending"]');
    expect(pending?.getAttribute("href")).toBe(`${REVIEW_HREF_BASE}/task-pending`);
    // A RESOLVED gate still links — the review page replays it read-only.
    const resolved = rail.querySelector('[data-rail-gate-link="task-resolved"]');
    expect(resolved?.getAttribute("href")).toBe(`${REVIEW_HREF_BASE}/task-resolved`);
    expect(rail.querySelector('[data-rail-gate-history="true"]')).not.toBeNull();
    expect(rail.querySelector('[data-rail-gate-pending="true"]')).not.toBeNull();

    // The verification row deep-links into the same surface's verification view.
    expect(
      rail.querySelector('[data-rail-verification-link="task-resolved"]')?.getAttribute("href"),
    ).toBe(`${REVIEW_HREF_BASE}/task-resolved?view=verification`);

    // And the lifecycle decision keeps its reason — a deliberately-skipped
    // review must stay distinguishable from no machinery running.
    expect(rail.querySelector('[data-rail-lifecycle-reason]')?.textContent).toContain(
      "The org policy skips review for outreach drafts.",
    );
    expect(rail.querySelector('[data-rail-lifecycle-decided-by="org-bound"]')).not.toBeNull();
  });
});

describe("the page-level rail still owns the branch it kept", () => {
  it("renders ONE rail with the same deep links for a single-agent / transcript run", async () => {
    const { RunStepRailPanel } = await import("../run-step-rail-panel");
    const entries: RailEntry[] = [
      { key: "message:m1", ordinal: 1, kind: "step", label: "Response 1", status: "completed", sources: ["message"] },
      ...RAIL_EXTRAS,
    ];
    render(
      <RunStepRailPanel entries={entries} activeOrdinal={7} reviewHrefBase={REVIEW_HREF_BASE} />,
    );
    expect(rails().length).toBe(1);
    expect(
      rails()[0].querySelector('[data-rail-gate-link="task-pending"]')?.getAttribute("href"),
    ).toBe(`${REVIEW_HREF_BASE}/task-pending`);
    expect(rails()[0].querySelectorAll('[data-rail-kind="step"]').length).toBe(1);
  });
});
