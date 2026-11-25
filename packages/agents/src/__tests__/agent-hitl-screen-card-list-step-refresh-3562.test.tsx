// @vitest-environment jsdom
/**
 * cinatra#3562 — THE STANDALONE HITL SCREEN CARD SENDS A LIST STEP'S TRY AGAIN
 * AT ONCE.
 *
 * With no list to pick, the list step draws Try again (design
 * specs/app-artifact-review.html I.1, the failed-read alert). A press writes
 * `{ listIds: [], listNames: [], refresh: "refresh" }`. The card sends that
 * write at once as the step's answer, with the refresh value as the resume
 * text, through its one submit core: once per press, never as a pick, never
 * under the gate's field name, and only on a mid-run list step.
 *
 * Harness mirrors agent-hitl-screen-card.test.tsx.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/agent-hitl-screen-card-list-step-refresh-3562.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

const screenStateMock = vi.fn();
vi.mock("../agent-hitl-screen-actions", () => ({
  getAgentHitlScreenStateAction: (input: { runId: string }) => screenStateMock(input),
}));
vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: async () => ({ connectedApps: [], gmailAliases: [] }),
}));
const approveMock = vi.fn(
  async (...args: [taskId: string, values?: unknown, fieldName?: string]): Promise<{ ok: true }> => {
    void args;
    return { ok: true };
  },
);
vi.mock("../hitl-actions", () => ({
  approveReviewTask: (taskId: string, values?: unknown, fieldName?: string) =>
    approveMock(taskId, values, fieldName),
  rejectReviewTask: vi.fn(async () => undefined),
}));

import { Button } from "@/components/ui/button";
import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { fieldRendererRegistry } from "../field-renderer-registry";
import type { FieldRendererProps } from "../field-renderer-registry";
import { AgentHitlScreenCard } from "../agent-hitl-screen-card";

const RUN_ID = "run-3562";
const LIST_STEP_ID = "@cinatra-ai/email-outreach-agent:list-picker";

/** The pause's gate, recorded with `recorded` as its refresh value (none when null). */
function askingOn(reviewTaskId: string, recorded: string | null = "refresh") {
  return {
    state: "asking" as const,
    runId: RUN_ID,
    screenRef: null,
    gate: {
      reviewTaskId,
      xRenderer: LIST_STEP_ID,
      inputSchema: {
        type: "object",
        properties: { accountScope: { type: "string" } },
        ...(recorded === null ? {} : { "x-cinatra-list-step-refresh-value": recorded }),
      },
      currentValues: {},
      fieldName: "accountScope",
    },
  };
}

/** The list step with no list to pick: it reports `false` and draws Try again. */
function TryAgainRenderer({ onChange, onValidityChange }: FieldRendererProps) {
  React.useEffect(() => {
    onValidityChange?.(false);
  }, [onValidityChange]);
  return (
    <Button
      type="button"
      data-testid="list-picker-try-again"
      onClick={() => void onChange({ listIds: [], listNames: [], refresh: "refresh" })}
    >
      Try again
    </Button>
  );
}

function mountCard() {
  return render(
    <LifecycleCardSurfaceProvider host="run_card">
      <AgentHitlScreenCard runId={RUN_ID} wireRef="task-3562" />
    </LifecycleCardSurfaceProvider>,
  );
}

beforeEach(() => {
  fieldRendererRegistry.clear();
  fieldRendererRegistry.register({
    id: LIST_STEP_ID,
    priority: 90,
    condition: (_f, _s, ctx) => ctx.xRenderer === LIST_STEP_ID,
    renderer: TryAgainRenderer,
    drawsOwnSubmit: true,
  });
  approveMock.mockClear();
});

afterEach(() => {
  fieldRendererRegistry.clear();
  cleanup();
  vi.clearAllMocks();
});

describe("AgentHitlScreenCard — a list step's Try again (cinatra#3562)", () => {
  it("sends the refresh value at once as the step's answer, never as a pick or under the field name", async () => {
    screenStateMock.mockImplementation(async () => askingOn("wayflow-task-3562"));
    const view = mountCard();
    fireEvent.click(await view.findByTestId("list-picker-try-again"));
    await waitFor(() => expect(approveMock).toHaveBeenCalledTimes(1));
    const [taskId, payload, fieldName] = approveMock.mock.calls[0]!;
    expect(taskId).toBe("wayflow-task-3562");
    // red-first-expect: expected 'accountScope' to be undefined
    expect(fieldName).toBeUndefined();
    expect(payload).toMatchObject({ userResponse: "refresh", listStepRefresh: "refresh" });
    expect(payload).not.toHaveProperty("approvalNote");
    expect(payload).not.toHaveProperty("accountScope");
  });

  it("sends once for a double press", async () => {
    screenStateMock.mockImplementation(async () => askingOn("wayflow-task-3562"));
    let finish: (value: { ok: true }) => void = () => {};
    approveMock.mockImplementationOnce(() => new Promise<{ ok: true }>((resolve) => (finish = resolve)));
    const view = mountCard();
    const tryAgain = await view.findByTestId("list-picker-try-again");
    act(() => {
      fireEvent.click(tryAgain);
      fireEvent.click(tryAgain);
    });
    // red-first-expect: to be called 1 times, but got 2 times
    await waitFor(() => expect(approveMock).toHaveBeenCalledTimes(1));
    await act(async () => finish({ ok: true }));
    expect(approveMock).toHaveBeenCalledTimes(1);
  });

  it("sends the value recorded with the pause, not the one the renderer's deployed binding writes", async () => {
    screenStateMock.mockImplementation(async () => askingOn("wayflow-task-3562", "reload"));
    const view = mountCard();
    fireEvent.click(await view.findByTestId("list-picker-try-again"));
    await waitFor(() => expect(approveMock).toHaveBeenCalledTimes(1));
    // red-first-expect: to match object { userResponse: 'reload'
    expect(approveMock.mock.calls[0]![1]).toMatchObject({ userResponse: "reload", listStepRefresh: "reload" });
  });

  it("a pause recorded with no refresh value sends nothing, and the screen stays as it is", async () => {
    screenStateMock.mockImplementation(async () => askingOn("wayflow-task-3562", null));
    const view = mountCard();
    fireEvent.click(await view.findByTestId("list-picker-try-again"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    // red-first-expect: to not be called at all, but actually been called 1 times
    expect(approveMock).not.toHaveBeenCalled();
    expect(view.getByTestId("list-picker-try-again")).toBeTruthy();
  });
});
