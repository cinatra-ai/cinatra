// @vitest-environment jsdom
/**
 * THE HITL SCREEN CARD DRAWS A PLAIN-FORM STEP AND REFUSES A STEP WHOSE SCREEN
 * IS GONE.
 *
 * A step recorded under the plain form's own id (a step that declares no
 * screen of its own) is drawn through the schema floor, with one Continue
 * that sends the floor's approval, with the entered value as the resume text,
 * to the gate's review task.
 *
 * A step whose renderer id no binding declares any more (its package dropped
 * the declaration) is refused: the card shows "no renderer configured for this
 * step", no field and no Continue, and nothing is sent. A former decision or
 * picker step is never drawn as a free-text form. A tombstoned gate (a
 * retired review gate) is refused the same way.
 *
 * Harness mirrors agent-hitl-screen-card-boolean-4310.test.tsx.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/agent-hitl-screen-card-unregistered-renderer.test.tsx
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

/**
 * Mid-run decision and picker steps whose packages dropped the declarations:
 * the generated bindings no longer list them.
 */
const DROPPED = vi.hoisted(() => [
  "@cinatra-ai/blog-pipeline-agent:idea-selection",
  "@cinatra-ai/context-selection-agent:context-selector",
  "@cinatra-ai/email-delivery-agent:send-confirmation",
  "@cinatra-ai/blog-wordpress-publish-agent:draft-confirm",
]);
vi.mock("@/lib/generated/agent-bindings", async (orig) => {
  const real = await orig<typeof import("@/lib/generated/agent-bindings")>();
  return {
    ...real,
    GENERATED_FIELD_RENDERER_BINDINGS: real.GENERATED_FIELD_RENDERER_BINDINGS.filter(
      (b) => !DROPPED.includes(b.id),
    ),
  };
});

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { fieldRendererRegistry } from "../field-renderer-registry";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";
import { AgentHitlScreenCard } from "../agent-hitl-screen-card";
import * as midRun from "../orchestrator-mid-run-hitl";
import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";

const RUN_ID = "run-dropped";
const TASK_ID = "wayflow-task-dropped";

const ASKING = {
  state: "asking" as const,
  runId: RUN_ID,
  screenRef: "hitl-screen-ref-dropped",
  gate: {
    reviewTaskId: TASK_ID,
    xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
    inputSchema: { type: "object", properties: { note: { type: "string", title: "Note" } } },
    currentValues: {},
    fieldName: undefined,
  },
};

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  fieldRendererRegistry.clear();
  ensureDefaultFieldRenderersRegistered();
  screenStateMock.mockImplementation(async () => ASKING);
  approveMock.mockClear();
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(ASKING), {
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
      <AgentHitlScreenCard runId={RUN_ID} wireRef={TASK_ID} />
    </LifecycleCardSurfaceProvider>,
  );
}

function continues(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).filter((b) =>
    /Continue|Submitting|Continuing/.test(b.textContent ?? ""),
  );
}

describe("AgentHitlScreenCard — a step recorded under the plain form's own id", () => {
  for (const host of ["run_card", "chat_thread"] as LifecycleCardHost[]) {
    // red-first-expect: expected { note: 'Go ahead.' } to match object { note: 'Go ahead.', …(3) }
    it(`${host}: draws the stored schema's field and one Continue, which sends the answer once`, async () => {
      const { container } = mountOn(host);
      await settle();
      await waitFor(() => expect(container.querySelector("#field-note")).not.toBeNull());
      expect(container.textContent ?? "").not.toMatch(/no renderer configured/);
      fireEvent.change(container.querySelector("#field-note")!, { target: { value: "Go ahead." } });
      await waitFor(() => expect(continues(container)).toHaveLength(1));
      fireEvent.click(continues(container)[0]!);
      await waitFor(() => expect(approveMock).toHaveBeenCalledTimes(1));
      expect(approveMock.mock.calls[0]![0]).toBe(TASK_ID);
      // The floor's approval: the note is the resume text the run receives
      // (`userResponse`), not the bare "[Approved by operator]" marker.
      expect(approveMock.mock.calls[0]![1]).toMatchObject({
        note: "Go ahead.",
        approved: true,
        userResponse: "Go ahead.",
        userResponseFieldName: "note",
      });
      expect(approveMock.mock.calls[0]![2]).toBeUndefined();
      await settle();
      expect(approveMock).toHaveBeenCalledTimes(1);
    });
  }
});

/** One-value plain-form gates, with what is typed and what the run receives. */
const ONE_VALUE_GATES: Array<{ shape: string; schema: Record<string, unknown>; typed: string; text: string }> = [
  { shape: "string", schema: { type: "string", title: "Answer" }, typed: "Ship it.", text: "Ship it." },
  { shape: "number", schema: { type: "number", title: "Answer" }, typed: "42", text: "42" },
  {
    shape: "array",
    schema: { type: "array", title: "Answer", items: { type: "string" } },
    typed: "alpha\nbeta",
    text: '["alpha","beta"]',
  },
];

describe("AgentHitlScreenCard — a one-value plain-form gate sends the entered value", () => {
  for (const host of ["run_card", "chat_thread"] as LifecycleCardHost[]) {
    for (const g of ONE_VALUE_GATES) {
      // red-first-expect: to match object { approved: true,
      it(`${host}: a ${g.shape} gate resumes with the entered value, not the approval marker`, async () => {
        const asking = { ...ASKING, gate: { ...ASKING.gate, inputSchema: g.schema, fieldName: "answer" } };
        screenStateMock.mockImplementation(async () => asking);
        globalThis.fetch = (async () =>
          new Response(JSON.stringify(asking), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })) as unknown as typeof fetch;
        const { container } = mountOn(host);
        await settle();
        await waitFor(() => expect(container.querySelector("#field-answer")).not.toBeNull());
        fireEvent.change(container.querySelector("#field-answer")!, { target: { value: g.typed } });
        await waitFor(() => expect(continues(container)).toHaveLength(1));
        fireEvent.click(continues(container)[0]!);
        await waitFor(() => expect(approveMock).toHaveBeenCalledTimes(1));
        expect(approveMock.mock.calls[0]![0]).toBe(TASK_ID);
        expect(approveMock.mock.calls[0]![1]).toMatchObject({ approved: true, userResponse: g.text });
        expect(approveMock.mock.calls[0]![2]).toBeUndefined();
      });
    }
  }
});

/** Refused: the no-renderer paragraph, no field, no Continue, nothing sent. */
async function expectRefused(container: HTMLElement, id: string) {
  await waitFor(() => expect(container.textContent ?? "", id).toMatch(/no renderer configured/));
  expect(container.querySelector("#field-note"), id).toBeNull();
  expect(container.querySelector("#field-selectedIdeaJson"), id).toBeNull();
  expect(container.querySelector("textarea, input[type='text']"), id).toBeNull();
  expect(continues(container), id).toHaveLength(0);
  expect(approveMock, id).not.toHaveBeenCalled();
}

describe("AgentHitlScreenCard — a step whose screen is no longer declared is refused", () => {
  for (const host of ["run_card", "chat_thread"] as LifecycleCardHost[]) {
    it(`${host}: a former decision or picker step is not drawn as a free-text form`, async () => {
      for (const id of DROPPED) {
        const asking = {
          ...ASKING,
          gate: {
            ...ASKING.gate,
            xRenderer: id,
            inputSchema: {
              type: "object",
              properties: { selectedIdeaJson: { type: "string", title: "Selected idea" } },
            },
          },
        };
        screenStateMock.mockImplementation(async () => asking);
        globalThis.fetch = (async () =>
          new Response(JSON.stringify(asking), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })) as unknown as typeof fetch;
        const { container } = mountOn(host);
        await settle();
        await expectRefused(container, id);
        cleanup();
      }
    });

    it(`${host}: a renderer id the host has never seen is refused`, async () => {
      const id = "@cinatra-test/never-seen-agent:screen";
      const asking = { ...ASKING, gate: { ...ASKING.gate, xRenderer: id } };
      screenStateMock.mockImplementation(async () => asking);
      globalThis.fetch = (async () =>
        new Response(JSON.stringify(asking), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch;
      const { container } = mountOn(host);
      await settle();
      await expectRefused(container, id);
    });
  }
});

describe("AgentHitlScreenCard — a tombstoned gate stays unanswerable", () => {
  for (const host of ["run_card", "chat_thread"] as LifecycleCardHost[]) {
    // red-first-expect: TOMBSTONED_HITL_RENDERER_IDS is not iterable
    it(`${host}: shows the no-renderer paragraph and no Continue for every tombstoned id`, async () => {
      for (const id of midRun.TOMBSTONED_HITL_RENDERER_IDS) {
        const asking = { ...ASKING, gate: { ...ASKING.gate, xRenderer: id } };
        screenStateMock.mockImplementation(async () => asking);
        globalThis.fetch = (async () =>
          new Response(JSON.stringify(asking), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })) as unknown as typeof fetch;
        const { container } = mountOn(host);
        await settle();
        await waitFor(() => expect(container.textContent ?? "", id).toMatch(/no renderer configured/));
        expect(container.querySelector("#field-note"), id).toBeNull();
        expect(continues(container), id).toHaveLength(0);
        cleanup();
      }
    });
  }
});
