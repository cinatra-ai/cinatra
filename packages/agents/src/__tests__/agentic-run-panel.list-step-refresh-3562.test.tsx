// @vitest-environment jsdom
/**
 * cinatra#3562 — THE RUN PANEL HANDS A WAITING LIST STEP ITS TRY AGAIN.
 *
 * A `:list-picker` gate the run waits at gets the shared props contract's
 * `onRequestRefresh`. A press reads the lists again through the host's server
 * read for that gate (run and review task), and the renderer draws the answer
 * in place. The press answers no gate and resumes nothing. A step of another
 * renderer gets no prop.
 *
 * Harness mirrors agentic-run-panel-setup-continue-3532.test.tsx.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";
import { fieldRendererRegistry } from "../field-renderer-registry";
import { Button } from "@/components/ui/button";
import type { FieldRendererProps } from "../field-renderer-registry";
import { registerFieldRendererBindings } from "../register-default-renderers";
import {
  __resetFieldRendererComponentMapForTests,
  __setFieldRendererComponentMapForTests,
} from "../field-renderer-components";

vi.mock("@cinatra-ai/sdk-ui", () => ({
  LoadingSpinner: () => null,
  PromptField: ({ placeholder }: { placeholder?: string }) => (
    <div data-testid="field-assist-prompt-stub">{placeholder}</div>
  ),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

vi.mock("lucide-react", () => {
  const StubIcon = () => null;
  return new Proxy({} as Record<string, () => null>, {
    get: (_t, prop) => {
      if (prop === "__esModule") return true;
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return undefined;
      return StubIcon;
    },
    has: () => true,
    ownKeys: () => ["ArrowRight", "Check", "Loader2", "default"],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: StubIcon }),
  });
});

const hitlActions = vi.hoisted(() => ({
  approveReviewTask: vi.fn(async () => ({ ok: true as const })),
  rejectReviewTask: vi.fn(async () => undefined),
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

vi.mock("../a2a-actions", () => ({ getAgentBuilderTask: vi.fn(async () => null) }));

vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({
    connectedApps: [],
    gmailAliases: [],
    runId: "run-3562",
  })),
  getAuditAvailabilityAction: vi.fn(async () => ({ visible: false, promptCount: 0, skillCount: 0 })),
  getSkillsForAgentAction: vi.fn(async () => []),
}));

vi.mock("../agent-ui-override-registry", () => ({
  agentUIOverrideRegistry: { resolve: () => null },
}));

const LIST_STEP_ID = "@cinatra-test/pack-agent-refresh:list-picker";
const OTHER_STEP_ID = "@cinatra-test/pack-agent-refresh:output";

vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: vi.fn(() => streamResultFor(LIST_STEP_ID)),
}));

function streamResultFor(xRenderer: string) {
  return {
    status: "pending_approval",
    error: null,
    presentationHint: null,
    isLive: true,
    interruptContext: {
      schema: { type: "object" },
      xRenderer,
      values: { lists: [], listsRead: "failed" },
      reviewTaskId: "task-list-1",
    },
    streamedText: "",
    dataPartFrames: [],
  };
}

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

async function renderPanelOn(xRenderer: string) {
  const { useAgUiRunStream } = await import("../use-ag-ui-run-stream");
  (useAgUiRunStream as unknown as ReturnType<typeof vi.fn>).mockReturnValue(streamResultFor(xRenderer));
  const { AgenticRunPanel } = await import("../agentic-run-panel");
  return render(
    <AgenticRunPanel
      runId="run-3562"
      initialStatus="pending_approval"
      initialError={null}
      initialMessages={[]}
      agUiEnabled
      templateId="tmpl-3562"
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
  fieldRendererRegistry.clear();
  ensureDefaultFieldRenderersRegistered();
});

describe("AgenticRunPanel — a waiting list step's Try again (cinatra#3562)", () => {
  // red-first-expect: expected 'no' to be 'yes'
  it("reads the lists again for the gate and draws the answer, with no answer to the gate", async () => {
    await renderPanelOn(LIST_STEP_ID);
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
    expect(hitlActions.rejectReviewTask).not.toHaveBeenCalled();
  });

  // red-first-expect: expected 'no' to be 'yes'
  it("a failed read is drawn as the step's failed shape", async () => {
    listActions.readListStepContent.mockRejectedValueOnce(new Error("list_step_not_waiting"));
    await renderPanelOn(LIST_STEP_ID);
    await waitFor(() => expect(screen.getByTestId("offers-refresh").textContent).toBe("yes"));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(listActions.readListStepContent).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByTestId("shown").textContent).toBe(JSON.stringify({ lists: [], listsRead: "failed" })),
    );
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
  });

  it("a step of another renderer is offered no new read", async () => {
    await renderPanelOn(OTHER_STEP_ID);
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

describe("AgenticRunPanel — the prop reaches a pack-shipped component through the registry (cinatra#3562)", () => {
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
      await renderPanelOn(SHIPPED_STEP_ID);
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

/**
 * THE SHIPPED LIST PICKER (cinatra#3562). A list binding with no shipped
 * component resolves, through the real registration road, to the host's own
 * `ListPickerRenderer`, the renderer the application mounts for the list step
 * today. It draws the design's failed-read alert with Try again, the loading
 * reading while the new read is pending, and the lists the read returns.
 */
const HOST_STEP_ID = "@cinatra-test/pack-agent-host:list-picker";

describe("AgenticRunPanel — the shipped list picker's Try again (cinatra#3562)", () => {
  function mountHostPicker() {
    __setFieldRendererComponentMapForTests({});
    registerFieldRendererBindings([{ id: HOST_STEP_ID, kind: "list-picker", priority: 80 }]);
    listActions.fetchAvailableLists.mockRejectedValue(new Error("search failed"));
  }

  afterEach(() => {
    listActions.fetchAvailableLists.mockImplementation(async () => []);
    __resetFieldRendererComponentMapForTests();
  });

  // red-first-expect: Unable to find role="alert"
  it("a failed first read draws the alert with Try again; a press reads again for the gate, draws the loading reading, then the lists", async () => {
    mountHostPicker();
    let resolveRead: (value: unknown) => void = () => {};
    listActions.readListStepContent.mockImplementationOnce(
      () => new Promise((resolve) => { resolveRead = resolve as (value: unknown) => void; }) as never,
    );
    await renderPanelOn(HOST_STEP_ID);
    const alert = await screen.findByRole("alert", undefined, { timeout: 3000 });
    expect(alert.textContent).toContain("This list could not be read.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByTestId("list-picker-loading")).toBeTruthy());
    expect(listActions.readListStepContent).toHaveBeenCalledTimes(1);
    expect(listActions.readListStepContent).toHaveBeenCalledWith("run-3562", "task-list-1");
    resolveRead({ lists: [{ id: "l-9", name: "Read again" }], listsRead: "ok" });
    await screen.findByText("Read again");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTestId("list-picker-loading")).toBeNull();
    // Continue stays unavailable until a row is picked, and a pick makes it available.
    const continueButton = () => screen.getByRole("button", { name: /continue/i }) as HTMLButtonElement;
    expect(continueButton().disabled).toBe(true);
    fireEvent.click(screen.getByText("Read again"));
    await waitFor(() => expect(continueButton().disabled).toBe(false));
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
    expect(hitlActions.rejectReviewTask).not.toHaveBeenCalled();
  });

  // red-first-expect: Unable to find role="alert"
  it("a failed re-read draws the alert again, with Try again", async () => {
    mountHostPicker();
    listActions.readListStepContent.mockResolvedValueOnce({ lists: [], listsRead: "failed" } as never);
    await renderPanelOn(HOST_STEP_ID);
    await screen.findByRole("alert", undefined, { timeout: 3000 });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(listActions.readListStepContent).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId("list-picker-loading")).toBeNull());
    expect(screen.getByRole("alert").textContent).toContain("This list could not be read.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
