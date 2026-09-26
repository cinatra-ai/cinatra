// @vitest-environment jsdom
/**
 * A NEW RUN STARTED FROM A SCOPED RUN STAYS IN THE SCOPE (cinatra#3693).
 *
 * cinatra#2809's acceptance, verbatim: "A run launched from a non-personal
 * scope S gets anchor S and lives at the S-scoped canonical address". The
 * launcher at `<base>/agents/<vendor>/<package>/new` is the one place that
 * knows which vantage a launch was made from, and it mints the anchor itself.
 * But a finished, failed or stopped run offered its next run through the BARE
 * road — "Start new run" created an unanchored run and "Start fresh" opened the
 * bare launcher — so a run begun in a team's Agents tab restarted as a run of
 * no scope at all.
 *
 * D1 — for a scoped run, Start new run and Start fresh go to the scoped
 *      launcher, and no unanchored run is created on the way.
 * D2 — for an unscoped run both keep today's road exactly.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/scoped-run-restart-3693.test.tsx
 */
import React from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const ORG_ID = "88c63f08-4d2e-4c7a-9f1b-2a0d6e5c4b31";
const ORG_BASE = `/organizations/${ORG_ID}`;
const AGENT_ID = "cinatra-ai/blog-draft-writer-agent";
const RUN_ID = "run-3693";
const SCOPED_LAUNCHER = `${ORG_BASE}/agents/${AGENT_ID}/new`;
const BARE_LAUNCHER = `/agents/${AGENT_ID}/new`;

const routerPush = vi.hoisted(() => vi.fn());
const createAndTriggerRun = vi.hoisted(() => vi.fn());

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
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: StubIcon }),
  });
});

vi.mock("@/lib/cinatra-toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/agents",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("../orchestrator-actions", () => ({
  cancelOrchestratorAction: vi.fn(async () => ({ ok: true })),
  resumeStoppedOrchestratorAction: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../run-actions", () => ({
  startDevChildPreviewRun: vi.fn(async () => ({ ok: false })),
  buildSubmissionMapByStepIndex: vi.fn(async () => []),
  createAndTriggerRun: (args: unknown) => createAndTriggerRun(args),
  resetAgentRun: vi.fn(async () => ({ ok: true })),
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

vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({})),
  getSkillsForAgentAction: vi.fn(async () => []),
}));

vi.mock("../a2a-actions", () => ({
  getAgentBuilderTask: vi.fn(() => new Promise<never>(() => {})),
  sendAgentBuilderMessage: vi.fn(async () => ({})),
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

vi.mock("../review-gate-card", () => ({
  LIFECYCLE_VIEW_SCHEMA_VERSION: 1,
  ReviewGateCard: () => <div data-testid="review-gate-card" />,
}));

import { RunCompletionCard } from "../run-completion-affordances";
import { OrchestratorStepperPanel, type OrchestratorStepperPanelProps } from "../orchestrator-stepper-panel";
import { AgenticRunPanel } from "../agentic-run-panel";

beforeEach(() => {
  createAndTriggerRun.mockResolvedValue({ ok: true, runId: "run-next" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ reviewGate: { ref: null, awaiting: false } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
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

function stepperProps(overrides: Partial<OrchestratorStepperPanelProps>): OrchestratorStepperPanelProps {
  return {
    runId: RUN_ID,
    initialStatus: "failed",
    initialError: "WayFlow task failed",
    agUiEnabled: false,
    agentPackageName: "@cinatra-ai/blog-draft-writer-agent",
    inputParams: {},
    stepperSteps: [{ index: 1, stepNumber: 0, label: "Setup", xRenderer: "grouped-setup-form" }],
    agentId: AGENT_ID,
    lgThreadId: null,
    templateId: "tmpl-3693",
    templateName: "Blog draft writer",
    ...overrides,
  };
}

function agenticProps(status: string, scopeBase?: string) {
  return {
    runId: RUN_ID,
    initialStatus: status,
    initialError: status === "failed" ? "WayFlow task failed" : null,
    initialMessages: [],
    agUiEnabled: false as boolean | null,
    agentId: AGENT_ID,
    inputParams: {},
    initialStreamedText: "",
    ...(scopeBase ? { scopeBase } : {}),
  };
}

async function press(name: RegExp) {
  const button = await screen.findByRole("button", { name });
  fireEvent.click(button);
}

describe("D1: a scoped run's next run starts in the same scope", () => {
  it("the completion card's Start new run opens the scoped launcher, creating nothing itself", async () => {
    render(<RunCompletionCard runId={RUN_ID} agentId={AGENT_ID} outputHint="transcript" scopeBase={ORG_BASE} />);
    await press(/start new run/i);
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith(SCOPED_LAUNCHER));
    expect(createAndTriggerRun).not.toHaveBeenCalled();
  });

  it("the stepper's completed card hands the base to Start new run", async () => {
    render(<OrchestratorStepperPanel {...stepperProps({ initialStatus: "completed", initialError: null, scopeBase: ORG_BASE })} />);
    await press(/start new run/i);
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith(SCOPED_LAUNCHER));
    expect(createAndTriggerRun).not.toHaveBeenCalled();
  });

  it("the stepper's failed card: Start fresh opens the scoped launcher", async () => {
    render(<OrchestratorStepperPanel {...stepperProps({ scopeBase: ORG_BASE })} />);
    await press(/start fresh/i);
    expect(routerPush).toHaveBeenCalledWith(SCOPED_LAUNCHER);
  });

  it("the stepper's stopped card: Start fresh opens the scoped launcher", async () => {
    render(<OrchestratorStepperPanel {...stepperProps({ initialStatus: "stopped", initialError: null, scopeBase: ORG_BASE })} />);
    await press(/start fresh/i);
    expect(routerPush).toHaveBeenCalledWith(SCOPED_LAUNCHER);
  });

  it("the run panel's failed block: Start new run opens the scoped launcher", async () => {
    render(<AgenticRunPanel {...agenticProps("failed", ORG_BASE)} />);
    await press(/start new run/i);
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith(SCOPED_LAUNCHER));
    expect(createAndTriggerRun).not.toHaveBeenCalled();
  });

  it("the run panel's completion card: Start new run opens the scoped launcher", async () => {
    render(<AgenticRunPanel {...agenticProps("completed", ORG_BASE)} />);
    await press(/start new run/i);
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith(SCOPED_LAUNCHER));
    expect(createAndTriggerRun).not.toHaveBeenCalled();
  });
});

describe("D2: an unscoped run keeps today's road", () => {
  it("Start new run creates the run and opens it at the bare address", async () => {
    render(<RunCompletionCard runId={RUN_ID} agentId={AGENT_ID} outputHint="transcript" />);
    await press(/start new run/i);
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith(`/agents/${AGENT_ID}/run-next`));
    expect(createAndTriggerRun).toHaveBeenCalledWith({ templateSlug: AGENT_ID });
  });

  it("the run panel's failed block keeps it too", async () => {
    render(<AgenticRunPanel {...agenticProps("failed")} />);
    await press(/start new run/i);
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith(`/agents/${AGENT_ID}/run-next`));
    expect(createAndTriggerRun).toHaveBeenCalledWith({ templateSlug: AGENT_ID });
  });

  it("Start fresh on a failed run opens the bare launcher", async () => {
    render(<OrchestratorStepperPanel {...stepperProps({})} />);
    await press(/start fresh/i);
    expect(routerPush).toHaveBeenCalledWith(BARE_LAUNCHER);
  });

  it("Start fresh on a stopped run opens the bare launcher", async () => {
    render(<OrchestratorStepperPanel {...stepperProps({ initialStatus: "stopped", initialError: null })} />);
    await press(/start fresh/i);
    expect(routerPush).toHaveBeenCalledWith(BARE_LAUNCHER);
  });
});
