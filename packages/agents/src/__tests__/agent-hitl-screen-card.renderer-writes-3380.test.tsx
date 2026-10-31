// @vitest-environment jsdom
/**
 * cinatra#3380 — THE MOUNTED CARD KEEPS WHAT ITS RENDERER WRITES, FOR ONE GATE.
 *
 * The neighbouring file renders the Continue alone with a fixed buffer. This one
 * mounts the whole card, with a renderer of the pipeline idea step's shape:
 *
 *   - a renderer that writes its answer from a layout effect when it mounts (a
 *     list with nothing to pick answers with a no-pick value) keeps that write:
 *     the card's own gate-change effect runs after it and must not wipe it, or
 *     the Continue is held with nothing to press;
 *   - a later gate on the same renderer, with another review task, mounts a new
 *     renderer and starts with nothing.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

const screenStateMock = vi.fn();
vi.mock("../agent-hitl-screen-actions", () => ({
  getAgentHitlScreenStateAction: (input: { runId: string }) => screenStateMock(input),
}));

const approveMock = vi.fn<
  (taskId: string, values?: unknown, fieldName?: string) => Promise<void>
>(async () => undefined);
vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: async () => ({
    connectedApps: [],
    gmailAliases: [],
  }),
}));

vi.mock("../hitl-actions", () => ({
  approveReviewTask: (taskId: string, values?: unknown, fieldName?: string) =>
    approveMock(taskId, values, fieldName),
  rejectReviewTask: vi.fn(async () => undefined),
}));

import { Button } from "@/components/ui/button";
import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { fieldRendererRegistry } from "../field-renderer-registry";
import { AgentHitlScreenCard } from "../agent-hitl-screen-card";

const RUN_ID = "run-3380";
const X_RENDERER = "@cinatra-test/pick-agent:output";
const PICKED_JSON = JSON.stringify({ artifactId: "a-2" });
const NO_PICK_JSON = JSON.stringify({ noPick: true });

function asking(reviewTaskId: string, ideas: unknown[]) {
  return {
    state: "asking" as const,
    runId: RUN_ID,
    screenRef: "hitl-screen-ref-3380",
    gate: {
      reviewTaskId,
      xRenderer: X_RENDERER,
      inputSchema: {
        type: "object",
        properties: { selectedIdeaJson: { type: "string", "x-required": true } },
      },
      currentValues: { ideas },
      fieldName: undefined,
    },
  };
}

function PickRenderer({
  onChange,
  value,
}: {
  onChange: (next: unknown) => unknown;
  value?: unknown;
}) {
  const [picked, setPicked] = React.useState(false);
  const ideas = (value as { ideas?: unknown } | null)?.ideas;
  const emptyOffer = Array.isArray(ideas) && ideas.length === 0;
  React.useLayoutEffect(() => {
    if (emptyOffer) void onChange({ selectedIdeaJson: NO_PICK_JSON, userResponse: NO_PICK_JSON });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emptyOffer]);
  return (
    <Button
      type="button"
      data-testid="pick-row"
      data-picked={picked ? "yes" : "no"}
      onClick={() => {
        setPicked(true);
        void onChange({ selectedIdeaJson: PICKED_JSON, userResponse: PICKED_JSON });
      }}
    >
      Idea two
    </Button>
  );
}

function card(wireRef: string) {
  return (
    <LifecycleCardSurfaceProvider host="chat_thread">
      <AgentHitlScreenCard runId={RUN_ID} wireRef={wireRef} />
    </LifecycleCardSurfaceProvider>
  );
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    await Promise.resolve();
  });
}

function cardContinue(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('[data-action="submit-hitl-screen"]');
}

function pickRow(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('[data-testid="pick-row"]');
}

beforeEach(() => {
  fieldRendererRegistry.clear();
  fieldRendererRegistry.register({
    id: "@cinatra-test/pick-agent:pick",
    priority: 90,
    condition: (_f, _s, ctx) => ctx.xRenderer === X_RENDERER,
    renderer: PickRenderer as never,
    credentialSafe: true,
  });
  approveMock.mockClear();
});

afterEach(() => {
  cleanup();
  fieldRendererRegistry.clear();
  vi.clearAllMocks();
});

describe("AgentHitlScreenCard — what its renderer writes (cinatra#3380)", () => {
  it("keeps a write made when the renderer mounts: a list with nothing to pick is answered, and the Continue sends that answer", async () => {
    screenStateMock.mockImplementation(async () => asking("task-empty", []));
    render(card("task-empty"));
    await settle();

    await waitFor(() => expect(cardContinue()).not.toBeNull());
    await settle();
    expect(cardContinue()!.disabled).toBe(false);

    await act(async () => {
      fireEvent.click(cardContinue()!);
      await Promise.resolve();
    });
    await waitFor(() => expect(approveMock).toHaveBeenCalledTimes(1));
    const [taskId, values] = approveMock.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(taskId).toBe("task-empty");
    expect(values.selectedIdeaJson).toBe(NO_PICK_JSON);
  });

  it("starts a later gate on the same renderer with nothing: a new renderer, the Continue held again, and the later pick sent for the later gate", async () => {
    screenStateMock.mockImplementation(async () => asking("task-first", [{ id: "a" }]));
    const mounted = render(card("task-first"));
    await settle();

    await waitFor(() => expect(pickRow()).not.toBeNull());
    expect(cardContinue()!.disabled).toBe(true);
    await act(async () => {
      fireEvent.click(pickRow()!);
      await Promise.resolve();
    });
    await waitFor(() => expect(cardContinue()!.disabled).toBe(false));

    screenStateMock.mockImplementation(async () => asking("task-next", [{ id: "a" }]));
    mounted.rerender(card("task-next"));
    await settle();

    await waitFor(() => expect(cardContinue()!.disabled).toBe(true));
    expect(pickRow()!.getAttribute("data-picked")).toBe("no");

    await act(async () => {
      fireEvent.click(pickRow()!);
      await Promise.resolve();
    });
    await waitFor(() => expect(cardContinue()!.disabled).toBe(false));
    await act(async () => {
      fireEvent.click(cardContinue()!);
      await Promise.resolve();
    });
    await waitFor(() => expect(approveMock).toHaveBeenCalledTimes(1));
    const [taskId, values] = approveMock.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(taskId).toBe("task-next");
    expect(values.selectedIdeaJson).toBe(PICKED_JSON);
  });
});
