// @vitest-environment jsdom
/**
 * cinatra#3471: A RETIRED STEP GETS NO CONTINUE ON THE STEPPER OR THE HITL CARD.
 *
 * A step parked under a tombstoned id (`isRetiredHitlStep`, the predicate the
 * server roads ask too) shows "no renderer configured for this step" and no
 * Continue. `@cinatra/email-reviewer-agent:output` ends in `:output`, so before
 * the change both hosts drew a Continue for it.
 *
 * Harnesses mirror orchestrator-stepper-panel-next-input-gate-4244.test.tsx and
 * agent-hitl-screen-card-boolean-4310.test.tsx.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { LifecycleCardHost } from "@cinatra-ai/agent-ui-protocol/renderable-views";

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
    ownKeys: () => ["AlertCircle", "ArrowRight", "Check", "CheckIcon", "Info", "Loader2", "Pause", "X", "default"],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: StubIcon }),
  });
});
vi.mock("@/lib/cinatra-toast", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
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
  readRunOutputEvidence: vi.fn(async () => ({ ok: true, outputs: [], hasTranscript: false, hasStepResults: false })),
}));
vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: vi.fn(async () => ({ state: "none" })),
  decideRunRecommendationAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../run-name-actions", () => ({
  ensureOrCheckRunNameAction: vi.fn(async () => ({ ok: true, title: "Run 1" })),
}));
vi.mock("../hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => ({ ok: true as const })),
  rejectReviewTask: vi.fn(async () => undefined),
}));
vi.mock("../use-runtime-field-renderer-bindings", () => ({
  useRuntimeFieldRendererBindings: () => ({ bindings: {}, loading: false }),
}));
vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: async () => ({ connectedApps: [], gmailAliases: [] }),
  getRuntimeFieldRendererBindingsAction: async () => [],
}));
const screenStateMock = vi.hoisted(() => vi.fn());
vi.mock("../agent-hitl-screen-actions", () => ({
  getAgentHitlScreenStateAction: (input: { runId: string }) => screenStateMock(input),
}));

/** The live interrupt the mocked stream hands the stepper. */
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

import { fieldRendererRegistry } from "../field-renderer-registry";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";
import { __resetFieldRendererComponentMapForTests } from "../field-renderer-components";
import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { AgentHitlScreenCard } from "../agent-hitl-screen-card";

const RUN_ID = "run-retired";
const TASK_ID = "wayflow-task-retired";
const SCHEMA = { type: "object", properties: { note: { type: "string", title: "Note" } } };
const TOMBSTONED = ["@cinatra/email-reviewer-agent:output", "@cinatra/email-reviewer-agent:ai-review-panel", "ai-review-panel"];

function continues(root: ParentNode = document): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll<HTMLButtonElement>("button")).filter((b) =>
    /Continue|Submitting|Continuing/.test(b.textContent ?? ""),
  );
}

let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  fieldRendererRegistry.clear();
  ensureDefaultFieldRenderersRegistered();
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  __resetFieldRendererComponentMapForTests();
  INTERRUPT = null;
  vi.clearAllMocks();
});

describe("the orchestrator stepper and a retired step", () => {
  // red-first-expect: to have a length of +0 but got 1
  it("shows the no-renderer paragraph and no Continue for every tombstoned id", async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    for (const id of TOMBSTONED) {
      INTERRUPT = { schema: SCHEMA, xRenderer: id, values: {}, reviewTaskId: TASK_ID };
      render(
        <OrchestratorStepperPanel
          runId={RUN_ID}
          initialStatus="pending_approval"
          initialError={null}
          agUiEnabled={false}
          agentPackageName="@cinatra-test/retired-agent"
          inputParams={{}}
          stepperSteps={[{ index: 1, stepNumber: 0, label: "Review", xRenderer: id }]}
          agentId="cinatra-test/retired-agent"
          lgThreadId={null}
          templateId="tmpl-retired"
          templateName="Retired Agent"
        />,
      );
      await waitFor(() => expect(document.body.textContent ?? "", id).toMatch(/no renderer configured/));
      expect(continues(), id).toHaveLength(0);
      cleanup();
    }
  });
});

describe("the HITL screen card and a retired step", () => {
  for (const host of ["run_card", "chat_thread"] as LifecycleCardHost[]) {
    // red-first-expect: to have a length of +0 but got 1
    it(`${host}: shows the no-renderer paragraph and no Continue for every tombstoned id`, async () => {
      for (const id of TOMBSTONED) {
        const asking = {
          state: "asking" as const,
          runId: RUN_ID,
          screenRef: "hitl-screen-ref-retired",
          gate: { reviewTaskId: TASK_ID, xRenderer: id, inputSchema: SCHEMA, currentValues: {}, fieldName: undefined },
        };
        screenStateMock.mockImplementation(async () => asking);
        globalThis.fetch = (async () =>
          new Response(JSON.stringify(asking), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
        const { container } = render(
          <LifecycleCardSurfaceProvider host={host}>
            <AgentHitlScreenCard runId={RUN_ID} wireRef={TASK_ID} />
          </LifecycleCardSurfaceProvider>,
        );
        await act(async () => {
          await new Promise((r) => setTimeout(r, 20));
        });
        await waitFor(() => expect(container.textContent ?? "", id).toMatch(/no renderer configured/));
        expect(continues(container), id).toHaveLength(0);
        cleanup();
      }
    });
  }
});
