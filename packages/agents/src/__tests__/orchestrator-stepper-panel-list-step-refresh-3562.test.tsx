// @vitest-environment jsdom
/**
 * cinatra#3562 — THE STEPPER HANDS A WAITING LIST STEP ITS TRY AGAIN.
 *
 * The live `:list-picker` gate's renderer gets the shared props contract's
 * `onRequestRefresh`. A press reads the lists again through the host's server
 * read for that gate (run and review task), and the renderer draws the answer
 * in place. The press answers no gate and resumes nothing. A step of another
 * renderer gets no prop.
 *
 * Harness mirrors orchestrator-stepper-panel-setup-continue-3532.test.tsx.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";
import { fieldRendererRegistry } from "../field-renderer-registry";
import { Button } from "@/components/ui/button";
import type { FieldRendererProps } from "../field-renderer-registry";
import { registerFieldRendererBindings } from "../register-default-renderers";
import {
  __resetFieldRendererComponentMapForTests,
  __setFieldRendererComponentMapForTests,
} from "../field-renderer-components";

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
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: StubIcon }),
  });
});

vi.mock("@/lib/cinatra-toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const orchestratorActions = vi.hoisted(() => ({
  cancelOrchestratorAction: vi.fn(async () => ({ ok: true })),
  resumeStoppedOrchestratorAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../orchestrator-actions", () => orchestratorActions);

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

const listActions = vi.hoisted(() => ({
  fetchAvailableLists: vi.fn(async () => []),
  readListStepContent: vi.fn(async () => ({
    lists: [{ id: "l-9", name: "Read again" }],
    listsRead: "ok" as const,
  })),
}));
vi.mock("../list-picker-actions", () => listActions);

vi.mock("../use-runtime-field-renderer-bindings", () => ({
  useRuntimeFieldRendererBindings: () => ({ bindings: {}, loading: false }),
}));

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

const LIST_STEP_ID = "@cinatra-test/pack-agent-refresh:list-picker";
const OTHER_STEP_ID = "@cinatra-test/pack-agent-refresh:output";

/** A pack-shaped list step: draws Try again only when the host offers it. */
function RefreshingStep({ value, onRequestRefresh }: FieldRendererProps) {
  const [shown, setShown] = React.useState<unknown>(value);
  return (
    <div>
      <p data-testid="offers-refresh">{onRequestRefresh ? "yes" : "no"}</p>
      {onRequestRefresh ? (
        <Button type="button" onClick={() => void onRequestRefresh().then(setShown)}>
          Try again
        </Button>
      ) : null}
      <p data-testid="shown">{JSON.stringify(shown)}</p>
    </div>
  );
}

async function mountOn(xRenderer: string, values: Record<string, unknown> = { lists: [], listsRead: "failed" }) {
  INTERRUPT = {
    schema: { type: "object" },
    xRenderer,
    values,
    reviewTaskId: "task-list-1",
  };
  const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
  return render(
    <OrchestratorStepperPanel
      runId="run-3562"
      initialStatus="pending_approval"
      initialError={null}
      agUiEnabled={false}
      agentPackageName="@cinatra-test/pack-agent-refresh"
      inputParams={{}}
      stepperSteps={[{ index: 1, stepNumber: 0, label: "Setup", xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID }]}
      agentId="cinatra-test/pack-agent-refresh"
      lgThreadId={null}
      templateId="tmpl-3562"
      templateName="Pack Agent"
    />,
  );
}

beforeEach(() => {
  ensureDefaultFieldRenderersRegistered();
  for (const id of [LIST_STEP_ID, OTHER_STEP_ID]) {
    fieldRendererRegistry.register({
      id,
      priority: 100,
      condition: (_fieldName, schema) => (schema as { "x-renderer"?: unknown })["x-renderer"] === id,
      renderer: RefreshingStep,
    });
  }
  cleanup();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  INTERRUPT = null;
  fieldRendererRegistry.clear();
  ensureDefaultFieldRenderersRegistered();
});

describe("OrchestratorStepperPanel — a waiting list step's Try again (cinatra#3562)", () => {
  // red-first-expect: expected 'no' to be 'yes'
  it("reads the lists again for the gate and draws the answer, with no answer and no resume", async () => {
    await mountOn(LIST_STEP_ID);
    await waitFor(() => expect(screen.getByTestId("offers-refresh").textContent).toBe("yes"));

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() =>
      expect(screen.getByTestId("shown").textContent).toBe(
        JSON.stringify({ lists: [{ id: "l-9", name: "Read again" }], listsRead: "ok" }),
      ),
    );
    expect(listActions.readListStepContent).toHaveBeenCalledTimes(1);
    expect(listActions.readListStepContent).toHaveBeenCalledWith("run-3562", "task-list-1");
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
    expect(orchestratorActions.resumeStoppedOrchestratorAction).not.toHaveBeenCalled();
  });

  it("a step of another renderer is offered no new read", async () => {
    await mountOn(OTHER_STEP_ID);
    await waitFor(() => expect(screen.getByTestId("offers-refresh").textContent).toBe("no"));
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });
});

/**
 * THE PACK'S COMPONENT, RESOLVED AS A PINNED PACK'S IS. A binding whose
 * component is in the build's component map resolves, through the real
 * registration road (`registerFieldRendererBindings`), to the extension
 * wrapper that loads the pack-shipped component. The stand-in below takes the
 * place of the pack's list step; the prop must reach it through that road.
 */
const SHIPPED_STEP_ID = "@cinatra-test/pack-agent-shipped:list-picker";

describe("OrchestratorStepperPanel — the prop reaches a pack-shipped component through the registry (cinatra#3562)", () => {
  // red-first-expect: Unable to find an element by: [data-testid="shipped-offers-refresh"]
  it("a list binding with a shipped component gets onRequestRefresh, and its press reads again", async () => {
    function ShippedListStep({ onRequestRefresh }: FieldRendererProps) {
      const [shown, setShown] = React.useState<unknown>(null);
      if (!onRequestRefresh) return <p data-testid="shipped-without-refresh">no Try again</p>;
      return (
        <div>
          <p data-testid="shipped-offers-refresh">yes</p>
          <Button type="button" onClick={() => void onRequestRefresh().then(setShown)}>
            Try again
          </Button>
          <p data-testid="shipped-shown">{JSON.stringify(shown)}</p>
        </div>
      );
    }
    __setFieldRendererComponentMapForTests({
      [SHIPPED_STEP_ID]: {
        resolution: "guardedOptional",
        packageName: "@cinatra-test/pack-agent-shipped",
        propsApiVersion: 1,
        load: async () => ({ default: ShippedListStep }),
      },
    });
    try {
      registerFieldRendererBindings([{ id: SHIPPED_STEP_ID, kind: "list-picker", priority: 80 }]);
      await mountOn(SHIPPED_STEP_ID);
      await screen.findByTestId("shipped-offers-refresh", undefined, { timeout: 3000 });
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await waitFor(() =>
        expect(screen.getByTestId("shipped-shown").textContent).toBe(
          JSON.stringify({ lists: [{ id: "l-9", name: "Read again" }], listsRead: "ok" }),
        ),
      );
      expect(listActions.readListStepContent).toHaveBeenCalledWith(expect.any(String), "task-list-1");
    } finally {
      __resetFieldRendererComponentMapForTests();
    }
  });
});
