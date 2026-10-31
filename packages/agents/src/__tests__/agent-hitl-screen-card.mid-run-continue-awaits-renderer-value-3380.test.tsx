// @vitest-environment jsdom
/**
 * cinatra#3380 — THE CONVERSATION CARD'S MID-RUN CONTINUE WAITS FOR THE VALUE
 * ITS RENDERER MUST PRODUCE.
 *
 * `AgentHitlScreenContinue` is the mid-run Continue a chat or widget host draws.
 * It applies the rule the run panel and the stepper apply: a gate whose schema
 * declares a property `"x-required": true` keeps the Continue unavailable until
 * the renderer has written that property; a gate that declares none (here the
 * email gates' object-level `required: ["decision"]`) is unchanged. A gate that
 * carries a presentation hint is out of the rule: the card draws it through the
 * generic dispatch renderer, which writes nothing.
 *
 * This file renders the control alone with a fixed buffer; the card's mount
 * passes it the buffer its renderer writes (`activeBuffered`).
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/agent-hitl-screen-card.mid-run-continue-awaits-renderer-value-3380.test.tsx
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

vi.mock("../agent-hitl-screen-actions", () => ({
  getAgentHitlScreenStateAction: vi.fn(async () => ({ state: "none" })),
}));
vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({ connectedApps: [] })),
}));
vi.mock("../hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => undefined),
  rejectReviewTask: vi.fn(async () => undefined),
}));

import { AgentHitlScreenContinue } from "../agent-hitl-screen-card";
import type { AgentHitlScreenGate } from "../agent-hitl-screen";

const PICKED_JSON = JSON.stringify({ artifactId: "a-2", representationRevisionId: "r-2" });

const DECLARING_SCHEMA: Record<string, unknown> = {
  type: "object",
  "x-renderer": "@cinatra-test/pick-agent:pick",
  properties: {
    selectedIdeaJson: { type: "string", title: "Selected idea (JSON)", "x-required": true },
  },
};

const UNDECLARING_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["approve", "revise", "reject"] },
  },
  required: ["decision"],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function gateWith(
  inputSchema: Record<string, unknown>,
  currentValues: Record<string, unknown> = { ideas: [{ artifactId: "a-1" }, { artifactId: "a-2" }] },
): AgentHitlScreenGate {
  return {
    reviewTaskId: "wayflow-task-3380",
    xRenderer: "@cinatra-test/pick-agent:pick",
    inputSchema,
    currentValues,
    fieldName: null,
  };
}

function cardContinue(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('[data-action="submit-hitl-screen"]');
}

describe("AgentHitlScreenContinue — the card's mid-run Continue (cinatra#3380)", () => {
  it("is unavailable before the renderer writes the declared value, and a press sends nothing", async () => {
    const onContinue = vi.fn(async () => undefined);
    render(
      <AgentHitlScreenContinue
        gate={gateWith(DECLARING_SCHEMA)}
        buffered={{}}
        submitting={false}
        blocked={false}
        onContinue={onContinue}
      />,
    );
    expect(cardContinue()).not.toBeNull();
    expect(cardContinue()!.disabled).toBe(true);
    // `blocked` keeps its credential sentence; a held Continue carries none.
    expect(cardContinue()!.getAttribute("title")).toBeNull();
    fireEvent.click(cardContinue()!);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("is available once the renderer has written the value, and sends it", async () => {
    const onContinue = vi.fn<(payload: Record<string, unknown>) => Promise<undefined>>(async () => undefined);
    render(
      <AgentHitlScreenContinue
        gate={gateWith(DECLARING_SCHEMA)}
        buffered={{ selectedIdeaJson: PICKED_JSON, userResponse: PICKED_JSON }}
        submitting={false}
        blocked={false}
        onContinue={onContinue}
      />,
    );
    expect(cardContinue()!.disabled).toBe(false);
    fireEvent.click(cardContinue()!);
    await waitFor(() => expect(onContinue).toHaveBeenCalledTimes(1));
    const payload = onContinue.mock.calls[0]![0];
    expect(payload.selectedIdeaJson).toBe(PICKED_JSON);
    expect(payload.approved).toBe(true);
  });

  it("is unchanged for a gate that declares no renderer value: available before any write", async () => {
    const onContinue = vi.fn(async () => undefined);
    render(
      <AgentHitlScreenContinue
        gate={gateWith(UNDECLARING_SCHEMA)}
        buffered={{}}
        submitting={false}
        blocked={false}
        onContinue={onContinue}
      />,
    );
    expect(cardContinue()!.disabled).toBe(false);
    fireEvent.click(cardContinue()!);
    await waitFor(() => expect(onContinue).toHaveBeenCalledTimes(1));
  });

  it("keeps a gate with a presentation hint out of the hold: available before any write, and sends", async () => {
    const onContinue = vi.fn(async () => undefined);
    render(
      <AgentHitlScreenContinue
        gate={gateWith(DECLARING_SCHEMA, {
          presentation: { type: "card_list", title: "Review ideas", items: [] },
        })}
        buffered={{}}
        submitting={false}
        blocked={false}
        onContinue={onContinue}
      />,
    );
    expect(cardContinue()!.disabled).toBe(false);
    fireEvent.click(cardContinue()!);
    await waitFor(() => expect(onContinue).toHaveBeenCalledTimes(1));
  });
});
