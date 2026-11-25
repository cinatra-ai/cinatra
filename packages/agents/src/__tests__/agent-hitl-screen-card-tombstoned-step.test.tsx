// @vitest-environment jsdom
/**
 * THE HITL SCREEN CARD REFUSES A RETIRED STEP.
 *
 * A step recorded under a tombstoned id (a retired review gate,
 * `hitlStepScreenIsAnswerable`) shows "no renderer configured for this step"
 * and no Continue, and nothing is sent.
 *
 * Harness mirrors agent-hitl-screen-card-boolean-4310.test.tsx.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/agent-hitl-screen-card-tombstoned-step.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";

import type { LifecycleCardHost } from "@cinatra-ai/agent-ui-protocol/renderable-views";

const screenStateMock = vi.fn();
// The app's Select drawn as a native one, so a pick is one change event.
vi.mock("@/components/ui/select", async () => {
  const R = await import("react");
  type Kids = { children?: React.ReactNode };
  function Select(props: Kids & { value?: string; onValueChange?: (v: string) => void; disabled?: boolean }) {
    let id: string | undefined;
    R.Children.forEach(props.children, (child) => {
      const childId = (child as { props?: { id?: string } } | null)?.props?.id;
      if (childId) id = childId;
    });
    return R.createElement(
      "select",
      { id, value: props.value ?? "", disabled: props.disabled, onChange: (e: { target: { value: string } }) => props.onValueChange?.(e.target.value) },
      R.createElement("option", { value: "" }, ""),
      props.children,
    );
  }
  const SelectTrigger = () => null;
  const SelectValue = () => null;
  const SelectContent = (props: Kids) => R.createElement(R.Fragment, null, props.children);
  const SelectItem = (props: Kids & { value: string }) => R.createElement("option", { value: props.value }, props.children);
  return { Select, SelectTrigger, SelectValue, SelectContent, SelectItem };
});

vi.mock("../agent-hitl-screen-actions", () => ({
  getAgentHitlScreenStateAction: (input: { runId: string }) => screenStateMock(input),
}));

const approveMock = vi.fn(
  async (_taskId: string, _values?: unknown, _fieldName?: string) => ({ ok: true as const }),
);
// What the runtime-installed packages declare, as the session-guarded action
// answers it (none unless a case installs one).
const runtimeBindings = vi.hoisted(() => ({
  list: [] as Array<{ id: string; kind: string; priority: number; midRunHitl?: boolean }>,
  calls: 0,
}));
vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: async () => ({
    connectedApps: [],
    gmailAliases: [],
  }),
  getRuntimeFieldRendererBindingsAction: async () => {
    runtimeBindings.calls += 1;
    return runtimeBindings.list;
  },
}));

vi.mock("../hitl-actions", () => ({
  approveReviewTask: (taskId: string, values?: unknown, fieldName?: string) =>
    approveMock(taskId, values, fieldName),
  rejectReviewTask: vi.fn(async () => undefined),
}));

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { fieldRendererRegistry } from "../field-renderer-registry";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";
import { AgentHitlScreenCard } from "../agent-hitl-screen-card";
import * as midRun from "../orchestrator-mid-run-hitl";
import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";
import { __resetFieldRendererComponentMapForTests } from "../field-renderer-components";

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
  runtimeBindings.list = [];
  runtimeBindings.calls = 0;
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
  __resetFieldRendererComponentMapForTests();
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

