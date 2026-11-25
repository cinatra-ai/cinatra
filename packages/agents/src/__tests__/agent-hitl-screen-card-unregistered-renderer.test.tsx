// @vitest-environment jsdom
/**
 * THE HITL SCREEN CARD REFUSES A STEP WHOSE SCREEN IS GONE.
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
  "@cinatra-ai/blog-linkedin-publish-agent:draft-review",
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
import * as registration from "../register-default-renderers";
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

/** Serves the card one asking state for the step drawn by `id`. */
function askingFor(id: string, gate: Record<string, unknown> = {}) {
  const asking = { ...ASKING, gate: { ...ASKING.gate, xRenderer: id, ...gate } };
  screenStateMock.mockImplementation(async () => asking);
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(asking), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("AgentHitlScreenCard — a step whose renderer id no entry claims", () => {
  const REMOVED_ID = "@acme/removed:output";
  const CLAIMED_ID = "@acme/live:output";
  for (const host of ["run_card", "chat_thread"] as LifecycleCardHost[]) {
    // red-first-expect: to have a length of +0 but got 1
    it(`${host}: shows the no-renderer paragraph and no Continue, though its id reads as mid-run`, async () => {
      askingFor(REMOVED_ID);
      const { container } = mountOn(host);
      await settle();
      await expectRefused(container, REMOVED_ID);
    });

    it(`${host}: keeps the Continue of a claimed id with the same name`, async () => {
      fieldRendererRegistry.register({
        id: CLAIMED_ID,
        priority: 90,
        condition: (_f, schema) => schema["x-renderer"] === CLAIMED_ID,
        renderer: () => <div data-testid="live-renderer">Live screen</div>,
        credentialSafe: true,
      });
      askingFor(CLAIMED_ID);
      const { container } = mountOn(host);
      await settle();
      await waitFor(() => expect(container.querySelector('[data-testid="live-renderer"]')).not.toBeNull());
      await waitFor(() => expect(continues(container)).toHaveLength(1));
    });
  }
});

// A PUBLISH PACK'S OWN CONFIRMATION SCREEN, PARKED BEFORE AN UPGRADE: under a
// bundled pack that no longer declares it, the step is retired (no field, no
// Continue; the `DROPPED` cases above). Where an installed older pack still
// declares it, its old flow is the one that runs, and the step stays answerable.
const OLD_PUBLISH_SCREENS = [
  { id: "@cinatra-ai/blog-wordpress-publish-agent:draft-confirm", kind: "wordpress-draft-confirm" },
  { id: "@cinatra-ai/blog-linkedin-publish-agent:draft-review", kind: "linkedin-draft-review" },
];
describe("AgentHitlScreenCard — a publish pack's own confirmation screen after an upgrade", () => {
  for (const host of ["run_card", "chat_thread"] as LifecycleCardHost[]) {
    for (const screen of OLD_PUBLISH_SCREENS) {
      it(`${host}: ${screen.id}: a runtime-installed older pack that declares it keeps the step answerable`, async () => {
        expect(fieldRendererRegistry.list().some((e) => e.id === screen.id)).toBe(false);
        registration.registerFieldRendererBindings([{ id: screen.id, kind: screen.kind, priority: 90, midRunHitl: true }]);
        askingFor(screen.id, { inputSchema: { type: "string", title: "Answer" }, fieldName: "answer" });
        const { container } = mountOn(host);
        await settle();
        await waitFor(() => expect(container.querySelector("#field-answer")).not.toBeNull());
        expect(container.textContent ?? "").not.toMatch(/no renderer configured/);
        await waitFor(() => expect(continues(container).length).toBeGreaterThan(0));
      });
    }
  }
});
