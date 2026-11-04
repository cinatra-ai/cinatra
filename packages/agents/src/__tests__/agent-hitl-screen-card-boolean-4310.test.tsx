// @vitest-environment jsdom
/**
 * cinatra#4310 — A BOOLEAN QUESTION ON THE HITL SCREEN CARD.
 *
 * Since cinatra#4310 the schema-drawn boolean draws a Continue of its own
 * wherever it is not told `hideSubmit`. What is pinned here, on the card:
 *
 *   - on a MID-RUN gate (an `:output` renderer drawn by the schema floor, asked
 *     with a boolean schema and no field name) the card's own Continue stays
 *     the gate's one control, on a primary host and on a conversation host: the
 *     field draws no Continue beside it, a tick sends nothing, and the card's
 *     Continue sends the gate's approval once;
 *   - on a per-field SETUP gate on a primary host (the run card), the fallback
 *     field keeps the Continue it draws itself, so the card draws none: the
 *     gate shows one Continue, and an untouched press sends `false` under the
 *     gate's own field name.
 *
 * The setup gate on a conversation host (the card owns the send there and
 * passes `hideSubmit`) is cinatra#4503 and is not pinned here.
 *
 * Harness mirrors agent-hitl-screen-card.test.tsx.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/agent-hitl-screen-card-boolean-4310.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import type { LifecycleCardHost } from "@cinatra-ai/agent-ui-protocol/renderable-views";

const screenStateMock = vi.fn();
vi.mock("../agent-hitl-screen-actions", () => ({
  getAgentHitlScreenStateAction: (input: { runId: string }) => screenStateMock(input),
}));

const approveMock = vi.fn(
  async (_taskId: string, _values?: unknown, _fieldName?: string) => ({ ok: true as const }),
);
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

import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";
import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { fieldRendererRegistry } from "../field-renderer-registry";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";
import { SchemaOnlyFloorRenderer } from "../schema-field-renderer";
import { AgentHitlScreenCard } from "../agent-hitl-screen-card";

const RUN_ID = "run-4310";
const FIELD = "sendFollowUps";
const MID_RUN_RENDERER_ID = "@cinatra-test/pack-agent:output";

/** A MID-RUN gate asked with a boolean schema and no field name. */
const MID_RUN_ASKING = {
  state: "asking" as const,
  runId: RUN_ID,
  screenRef: "hitl-screen-ref-4310",
  gate: {
    reviewTaskId: "task-4310",
    xRenderer: MID_RUN_RENDERER_ID,
    inputSchema: { type: "boolean" },
    currentValues: {},
    fieldName: undefined,
  },
};

/** A per-field SETUP gate for a boolean input, drawn by the fallback field. */
const SETUP_ASKING = {
  state: "asking" as const,
  runId: RUN_ID,
  screenRef: null,
  gate: {
    reviewTaskId: "setup-run-4310",
    xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
    inputSchema: { type: "boolean" },
    currentValues: { offeringCompanyWebsite: "https://example.com" },
    fieldName: FIELD,
  },
};

let asking: typeof MID_RUN_ASKING | typeof SETUP_ASKING = MID_RUN_ASKING;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  fieldRendererRegistry.clear();
  ensureDefaultFieldRenderersRegistered();
  fieldRendererRegistry.register({
    id: MID_RUN_RENDERER_ID,
    priority: 100,
    condition: (_fieldName, schema) =>
      (schema as { "x-renderer"?: unknown })["x-renderer"] === MID_RUN_RENDERER_ID,
    renderer: SchemaOnlyFloorRenderer,
    credentialSafe: true,
    drawsOwnSubmit: true,
  });
  asking = MID_RUN_ASKING;
  screenStateMock.mockImplementation(async () => asking);
  approveMock.mockClear();
  // Both hosts here are cookie hosts and read through the action above; a read
  // that reaches the network anyway is answered with the same state.
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(asking), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  fieldRendererRegistry.clear();
  ensureDefaultFieldRenderersRegistered();
  vi.clearAllMocks();
});

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 20));
    await Promise.resolve();
  });
}

function mountOn(host: LifecycleCardHost) {
  return render(
    <LifecycleCardSurfaceProvider host={host}>
      <AgentHitlScreenCard runId={RUN_ID} wireRef="task-4310" />
    </LifecycleCardSurfaceProvider>,
  );
}

function box(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[role="checkbox"]');
}

/** Every button in the card that reads as a Continue. */
function continues(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).filter((b) =>
    /Continue|Submitting|Continuing/.test(b.textContent ?? ""),
  );
}

describe("AgentHitlScreenCard — a boolean asked on a mid-run gate (cinatra#4310)", () => {
  const HOSTS: LifecycleCardHost[] = ["run_card", "chat_thread"];

  for (const host of HOSTS) {
    it(`${host}: draws exactly one Continue, the card's own, and none beside the box`, async () => {
      const { container } = mountOn(host);
      await settle();
      await waitFor(() => expect(box(container)).not.toBeNull());
      await waitFor(() => expect(continues(container)).toHaveLength(1));
      expect(continues(container)[0]!.getAttribute("data-action")).toBe("submit-hitl-screen");
    });

    it(`${host}: a tick sends nothing, and the card's Continue sends the gate's approval once`, async () => {
      const { container } = mountOn(host);
      await settle();
      await waitFor(() => expect(box(container)).not.toBeNull());
      fireEvent.click(box(container)!);
      await settle();
      expect(approveMock).not.toHaveBeenCalled();
      await waitFor(() => expect(continues(container)).toHaveLength(1));
      fireEvent.click(continues(container)[0]!);
      await waitFor(() => expect(approveMock).toHaveBeenCalledTimes(1));
      expect(approveMock).toHaveBeenLastCalledWith(
        "task-4310",
        expect.objectContaining({ approved: true }),
        undefined,
      );
      await settle();
      expect(approveMock).toHaveBeenCalledTimes(1);
    });
  }
});

describe("AgentHitlScreenCard — a per-field boolean setup question on a primary host (cinatra#4310)", () => {
  it("run_card: the field keeps its own Continue, the card draws none, and an untouched press sends false once", async () => {
    asking = SETUP_ASKING;
    const { container } = mountOn("run_card");
    await settle();
    await waitFor(() => expect(box(container)).not.toBeNull());
    await waitFor(() => expect(continues(container)).toHaveLength(1));
    expect(continues(container)[0]!.getAttribute("data-action")).toBeNull();
    expect(box(container)!.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(continues(container)[0]!);
    await waitFor(() => expect(approveMock).toHaveBeenCalledTimes(1));
    expect(approveMock).toHaveBeenLastCalledWith("setup-run-4310", { [FIELD]: false }, FIELD);
  });
});
