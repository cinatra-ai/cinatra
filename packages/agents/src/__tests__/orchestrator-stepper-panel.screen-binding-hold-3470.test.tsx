// @vitest-environment jsdom
/**
 * cinatra#3470 — THE STEPPER HOLDS A SCREEN WHOSE BINDING HAS NOT LOADED.
 *
 * A `flow`-typed template's run page mounts this panel. It registers the
 * bindings of runtime-installed agents after it mounts
 * (`useRuntimeFieldRendererBindings`). A gate whose renderer id reads as
 * mid-run (`:output`) draws the outer Continue even when no renderer resolves
 * for it, and that Continue sends `{ approved: true }` alone: for a declared
 * screen whose binding has not loaded, that resumes the screen without its
 * decision and its fields. Pinned on the stepper's outer Continue:
 *   - while the fetch has not answered, the Continue is held, says why, and a
 *     press sends nothing;
 *   - after the fetch failed, the same;
 *   - when the fetch named a declared screen for the gate that the
 *     registration refused, the same;
 *   - once the fetch answered with nothing for the gate, it continues as before.
 *
 * The tests run in this order on purpose: the bindings' state belongs to the
 * page, and a later answer never takes back an earlier `loaded`.
 *
 * Harness mirrors
 * orchestrator-stepper-panel.mid-run-continue-awaits-renderer-value-3380.test.tsx,
 * with the real bindings hook.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/orchestrator-stepper-panel.screen-binding-hold-3470.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";
import { fieldRendererRegistry } from "../field-renderer-registry";

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
  decideRunRecommendationAction: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../run-name-actions", () => ({
  ensureOrCheckRunNameAction: vi.fn(async () => ({ ok: true, title: "Run 1" })),
}));

const hitlActions = vi.hoisted(() => ({
  approveReviewTask: vi.fn(async () => ({ ok: true as const })),
}));
vi.mock("../hitl-actions", () => hitlActions);

/** What the page's fetch of the installed agents' bindings answers. */
const runtimeBindings = vi.hoisted(() => ({
  fetch: vi.fn(async (): Promise<unknown> => ({ bindings: [], refusedScreenIds: [] })),
}));

vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({
    connectedApps: [],
    gmailAliases: [],
  })),
  getAuditAvailabilityAction: vi.fn(async () => ({
    visible: false,
    promptCount: 0,
    skillCount: 0,
  })),
  getSkillsForAgentAction: vi.fn(async () => []),
  getRuntimeFieldRendererBindingsAction: () => runtimeBindings.fetch(),
}));

/** The live interrupt the mocked stream hands the panel. Set per test. */
let INTERRUPT: Record<string, unknown> | null = null;

vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: (_runId: string, opts: { initialStatus?: string }) => ({
    status: opts?.initialStatus ?? "pending_approval",
    interruptContext: INTERRUPT,
    messages: [],
    streamedText: "",
    presentationHint: null,
    dataPartFrames: [],
    isLive: true,
    error: null,
  }),
}));

/** A runtime-installed agent's screen: mid-run by its suffix, no binding in the build. */
const RUNTIME_ID = "@cinatra-test/runtime-agent:output";
const REVIEW_TASK_ID = "wayflow-task-3470";
const HOLD_LOADING = "This step's screen is still loading.";
const HOLD_FAILED = "This step's screen could not be loaded. Reload the page to try again.";

type PanelProps = import("../orchestrator-stepper-panel").OrchestratorStepperPanelProps;

function baseProps(): PanelProps {
  return {
    runId: "run-3470",
    initialStatus: "pending_approval",
    initialError: null,
    agUiEnabled: false as boolean | null,
    agentPackageName: "@cinatra-test/runtime-agent",
    inputParams: {},
    stepperSteps: [
      { index: 1, stepNumber: 0, label: "Review", xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID },
    ],
    agentId: "cinatra-test/runtime-agent",
    lgThreadId: null,
    templateId: "tmpl-3470",
    templateName: "Runtime Agent",
  };
}

async function mountGate(xRenderer: string = RUNTIME_ID) {
  INTERRUPT = {
    schema: { type: "object", properties: { decision: { type: "string", enum: ["approve", "revise"] } } },
    xRenderer,
    values: { itemId: "item-1" },
    reviewTaskId: REVIEW_TASK_ID,
  };
  const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
  return render(<OrchestratorStepperPanel {...baseProps()} />);
}

/** The gate's outer Continue: the one button that reads "Continue". */
function outerContinue(): HTMLButtonElement | null {
  const found = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).filter((b) =>
    /Continu/.test(b.textContent ?? ""),
  );
  expect(found.length).toBeLessThanOrEqual(1);
  return found[0] ?? null;
}

function holdReason(): string | null {
  return document.querySelector("[data-continue-hold-reason]")?.textContent ?? null;
}

async function expectHeld(reason: string) {
  await waitFor(() => expect(outerContinue()).not.toBeNull());
  expect(outerContinue()!.disabled).toBe(true);
  await waitFor(() => expect(holdReason()).toBe(reason));
  expect(outerContinue()!.disabled).toBe(true);
  fireEvent.click(outerContinue()!);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })),
  );
  ensureDefaultFieldRenderersRegistered();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  INTERRUPT = null;
  vi.clearAllMocks();
  fieldRendererRegistry.clear();
  ensureDefaultFieldRenderersRegistered();
});

describe("OrchestratorStepperPanel — a screen whose binding has not loaded holds its Continue (cinatra#3470)", () => {
  it("holds the Continue while the installed agents' bindings are still loading", async () => {
    runtimeBindings.fetch.mockImplementation(() => new Promise(() => {}));
    await mountGate();
    // red-first-expect: expected false to be true // Object.is equality
    await expectHeld(HOLD_LOADING);
  });

  it("holds the Continue after the bindings fetch failed", async () => {
    runtimeBindings.fetch.mockImplementation(async () => {
      throw new Error("fixture: the bindings fetch failed");
    });
    await mountGate();
    // red-first-expect: expected false to be true // Object.is equality
    await expectHeld(HOLD_FAILED);
  });

  it("holds the Continue when the gate's declared screen did not register", async () => {
    runtimeBindings.fetch.mockImplementation(async () => ({
      bindings: [
        // A screen the registration refuses: a card with no title and no sections.
        { id: RUNTIME_ID, kind: "linkedin-draft-review", priority: 90, midRunHitl: true, screen: { layout: "card" } },
      ],
      refusedScreenIds: [],
    }));
    await mountGate();
    // red-first-expect: expected false to be true // Object.is equality
    await expectHeld(HOLD_FAILED);
  });

  it("continues as before once the bindings loaded with nothing for the gate", async () => {
    runtimeBindings.fetch.mockImplementation(async () => ({ bindings: [], refusedScreenIds: [] }));
    // Another agent's gate: the page still knows the refused screen above.
    await mountGate("@cinatra-test/other-agent:output");
    await waitFor(() => expect(outerContinue()?.disabled).toBe(false));
    expect(holdReason()).toBeNull();
    fireEvent.click(outerContinue()!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
  });
});
