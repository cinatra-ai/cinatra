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
import { makeExtensionFieldRenderer } from "../extension-field-renderer";
import { __resetFieldRendererComponentMapForTests, __setFieldRendererComponentMapForTests } from "../field-renderer-components";

/** Real generated bindings with a migrated component and `midRunHitl`. */
const FALLBACK_BINDING_IDS = [
  "@cinatra-ai/blog-pipeline-agent:idea-selection",
  "@cinatra-ai/email-recipient-selection-agent:campaign-recipients-review",
];
/**
 * Every schema kind the plain form draws: the person's answer on its control
 * (typed, ticked or picked), and what the plain form sends for it. Only a
 * submit sends: the plain form's own Continue where it draws one, the host's
 * Continue beneath the field where it does not (a box on a mid-run gate, a
 * pick list).
 */
const FALLBACK_GATES: Array<{
  shape: string;
  schema: Record<string, unknown>;
  fieldName: string | undefined;
  inputId: string;
  answer: (control: HTMLElement) => void;
  /** Which submit sends it: the plain form's own, or the host's Continue beneath the field. */
  submit: "plain form" | "host Continue";
  sent: Record<string, unknown>;
}> = [
  {
    shape: "string",
    schema: { type: "string", title: "Answer" },
    fieldName: "answer",
    inputId: "field-answer",
    answer: (control) => fireEvent.change(control, { target: { value: "Ship it." } }),
    submit: "plain form",
    sent: { answer: "Ship it.", userResponse: "Ship it.", userResponseFieldName: "answer" },
  },
  {
    shape: "number",
    schema: { type: "number", title: "Answer" },
    fieldName: "answer",
    inputId: "field-answer",
    answer: (control) => fireEvent.change(control, { target: { value: "42" } }),
    submit: "plain form",
    sent: { answer: 42, userResponse: "42", userResponseFieldName: "answer" },
  },
  {
    shape: "boolean",
    schema: { type: "boolean", title: "Answer" },
    fieldName: "answer",
    inputId: "field-answer",
    answer: (control) => fireEvent.click(control),
    submit: "host Continue",
    sent: { answer: true, userResponse: "true", userResponseFieldName: "answer" },
  },
  {
    shape: "enum",
    schema: { type: "string", title: "Answer", enum: ["alpha", "beta"] },
    fieldName: "answer",
    inputId: "field-answer",
    answer: (control) => fireEvent.change(control, { target: { value: "beta" } }),
    submit: "host Continue",
    sent: { answer: "beta", userResponse: "beta", userResponseFieldName: "answer" },
  },
  {
    shape: "object",
    schema: { type: "object", properties: { selectedIdeaJson: { type: "string", title: "Selected idea" } } },
    fieldName: undefined,
    inputId: "field-selectedIdeaJson",
    answer: (control) => fireEvent.change(control, { target: { value: "idea-7" } }),
    submit: "plain form",
    sent: { selectedIdeaJson: "idea-7", userResponse: "idea-7" },
  },
  {
    shape: "array",
    schema: { type: "array", title: "Answer", items: { type: "string" } },
    fieldName: "answer",
    inputId: "field-answer",
    answer: (control) => fireEvent.change(control, { target: { value: "alpha\nbeta" } }),
    submit: "plain form",
    sent: { answer: ["alpha", "beta"], userResponse: '["alpha","beta"]', userResponseFieldName: "answer" },
  },
];

/**
 * Registers a REAL generated binding (every flag it carries) whose migrated
 * component fails to load in this build (its props version does not match), so
 * the extension wrapper shows the plain form.
 */
async function registerRealBindingInFallback(id: string): Promise<void> {
  const real = await vi.importActual<typeof import("@/lib/generated/agent-bindings")>(
    "@/lib/generated/agent-bindings",
  );
  const { GENERATED_FIELD_RENDERER_COMPONENTS } = await import("@/lib/generated/field-renderer-components");
  const binding = real.GENERATED_FIELD_RENDERER_BINDINGS.find((b) => b.id === id);
  const component = GENERATED_FIELD_RENDERER_COMPONENTS[id];
  expect(binding, id).toBeDefined();
  expect(component, id).toBeDefined();
  __setFieldRendererComponentMapForTests({ [id]: { ...component!, propsApiVersion: -1 } });
  registration.registerFieldRendererBindings([binding!]);
}

/** The Continue the reader sees nearest the field: the plain form's own, when it draws one. */
function floorContinueOf(inputId: string): HTMLButtonElement | null {
  let node: HTMLElement | null = document.getElementById(inputId);
  while (node) {
    const button = Array.from(node.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      /Continue/.test(b.textContent ?? ""),
    );
    if (button) return button;
    node = node.parentElement;
  }
  return null;
}


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

describe("AgentHitlScreenCard — a run-time binding the plain form draws", () => {
  const RUNTIME_PICK_ID = "@cinatra-test/ideas-agent:idea-selection";
  for (const host of ["run_card", "chat_thread"] as LifecycleCardHost[]) {
    // red-first-expect: to have a length of 1 but got 2
    it(`${host}: sends the typed value as the resume text, under its field`, async () => {
      registration.registerFieldRendererBindings([
        { id: RUNTIME_PICK_ID, kind: "blog-idea-selection", priority: 80, midRunHitl: true },
      ]);
      askingFor(RUNTIME_PICK_ID, {
        inputSchema: { type: "string", title: "Selected idea" },
        fieldName: "selectedIdeaJson",
      });
      const { container } = mountOn(host);
      await settle();
      await waitFor(() => expect(container.querySelector("#field-selectedIdeaJson")).not.toBeNull());
      fireEvent.change(container.querySelector("#field-selectedIdeaJson")!, { target: { value: "idea-7" } });
      await waitFor(() => expect(continues(container)).toHaveLength(1));
      fireEvent.click(continues(container)[0]!);
      await waitFor(() => expect(approveMock).toHaveBeenCalledTimes(1));
      expect(approveMock.mock.calls[0]![0]).toBe(TASK_ID);
      expect(approveMock.mock.calls[0]![1]).toMatchObject({
        approved: true,
        userResponse: "idea-7",
        userResponseFieldName: "selectedIdeaJson",
        selectedIdeaJson: "idea-7",
      });
    });
  }
});

// AN EXTENSION WRAPPER THAT FALLS BACK TO THE PLAIN FORM ANSWERS AS THE PLAIN
// FORM DOES. Its registry entry carries no `drawnBySchemaFloor` (the component
// may load), but this instance shows the plain form (its component is not in
// the build), so the typed answer is the run's resume text, never the
// setup-loop shape the server would answer with the approval marker.
describe("AgentHitlScreenCard — an extension wrapper in fallback", () => {
  const EXTENSION_ID = "@cinatra-test/ext-agent:screen";
  for (const host of ["run_card", "chat_thread"] as LifecycleCardHost[]) {
    // red-first-expect: expected { answer: 'Ship it.' } to match object { approved: true, …(3) }
    it(`${host}: sends the typed answer as the resume text`, async () => {
      fieldRendererRegistry.register({
        id: EXTENSION_ID,
        priority: 90,
        condition: (_f, schema) => schema["x-renderer"] === EXTENSION_ID,
        renderer: makeExtensionFieldRenderer(EXTENSION_ID),
        drawsOwnSubmit: true,
      });
      askingFor(EXTENSION_ID, { inputSchema: { type: "string", title: "Answer" }, fieldName: "answer" });
      const { container } = mountOn(host);
      await settle();
      await waitFor(() => expect(container.querySelector("#field-answer")).not.toBeNull());
      fireEvent.change(container.querySelector("#field-answer")!, { target: { value: "Ship it." } });
      await waitFor(() => expect(continues(container)).toHaveLength(1));
      fireEvent.click(continues(container)[0]!);
      await waitFor(() => expect(approveMock).toHaveBeenCalledTimes(1));
      expect(approveMock.mock.calls[0]![0]).toBe(TASK_ID);
      expect(approveMock.mock.calls[0]![1]).toMatchObject({
        approved: true,
        userResponse: "Ship it.",
        userResponseFieldName: "answer",
        answer: "Ship it.",
      });
      expect(approveMock.mock.calls[0]![2]).toBeUndefined();
    });
  }
});

// THE REAL GENERATED BINDINGS IN FALLBACK (see the run panel's suite): every
// schema kind's answer in the plain form a real binding's wrapper shows is
// sent by a submit only, as the plain form sends it, on both hosts.
describe("AgentHitlScreenCard — a real generated binding whose component failed to load", () => {
  for (const host of ["run_card", "chat_thread"] as LifecycleCardHost[]) {
    for (const id of FALLBACK_BINDING_IDS) {
      const answerAndSubmit = async (g: (typeof FALLBACK_GATES)[number]) => {
        await registerRealBindingInFallback(id);
        askingFor(id, { inputSchema: g.schema, fieldName: g.fieldName ?? null });
        const { container } = mountOn(host);
        await settle();
        await waitFor(() => expect(container.querySelector(`#${g.inputId}`)).not.toBeNull());
        g.answer(container.querySelector(`#${g.inputId}`)!);
        // The answer alone sends nothing: only a submit does.
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(approveMock).not.toHaveBeenCalled();
        const floorContinue = await waitFor(() => {
          const button = floorContinueOf(g.inputId);
          expect(button).not.toBeNull();
          return button!;
        });
        fireEvent.click(floorContinue);
        await waitFor(() => expect(approveMock).toHaveBeenCalledTimes(1));
        expect(approveMock.mock.calls[0]![0]).toBe(TASK_ID);
        expect(approveMock.mock.calls[0]![1]).toMatchObject({ approved: true, ...g.sent });
        expect(approveMock.mock.calls[0]![2]).toBeUndefined();
      };
      for (const g of FALLBACK_GATES.filter((row) => row.submit === "plain form")) {
        // red-first-expect: expected "vi.fn()" to be called 1 times, but got 0 times
        it(`${host}: ${id}: a ${g.shape} answer is sent by the plain form's own submit only, as the plain form sends it`, () => answerAndSubmit(g));
      }
      for (const g of FALLBACK_GATES.filter((row) => row.submit === "host Continue")) {
        // red-first-expect: to match object {
        it(`${host}: ${id}: a ${g.shape} answer is sent by the host's Continue only, as the plain form sends it`, () => answerAndSubmit(g));
      }
    }
  }
});
