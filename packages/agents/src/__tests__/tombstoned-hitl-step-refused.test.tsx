// @vitest-environment jsdom
/**
 * A RETIRED STEP IS REFUSED.
 *
 * Pinned here:
 *   - a TOMBSTONED id (a retired review gate) never resolves and a tombstoned
 *     binding never registers;
 *   - on the orchestrator stepper such a gate shows "no renderer configured"
 *     and no Continue;
 *   - a renderer of any other `@cinatra/` package registers, resolves and is
 *     answered like any other package's renderer.
 *
 * Harness mirrors orchestrator-stepper-panel-next-input-gate-4244.test.tsx.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/tombstoned-hitl-step-refused.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";
import * as registration from "../register-default-renderers";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";
import { fieldRendererRegistry, type FieldRendererContext } from "../field-renderer-registry";
import * as midRun from "../orchestrator-mid-run-hitl";
import { __resetFieldRendererComponentMapForTests } from "../field-renderer-components";

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
    ownKeys: () => ["AlertCircle", "ArrowRight", "Check", "CheckIcon", "Info", "Loader2", "Pause", "X", "default"],
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
      value: StubIcon,
    }),
  });
});

vi.mock("@/lib/cinatra-toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("../orchestrator-actions", () => ({
  cancelOrchestratorAction: vi.fn(async () => ({ ok: true })),
  resumeStoppedOrchestratorAction: vi.fn(async () => ({ ok: true })),
}));

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

vi.mock("../use-runtime-field-renderer-bindings", () => ({
  useRuntimeFieldRendererBindings: () => ({ bindings: {}, loading: false }),
}));

/** The plain form's own id: a step that declares no screen of its own. */
const FLOOR_ID = SCHEMA_FIELD_FALLBACK_RENDERER_ID;
const TASK_ID = "wayflow-task-dropped";
const NOTE_FIELD = "note";
const STORED_SCHEMA = {
  type: "object",
  properties: {
    note: { type: "string", title: "Note" },
  },
};

/** The live interrupt the mocked stream hands the panel. */
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

type PanelProps = import("../orchestrator-stepper-panel").OrchestratorStepperPanelProps;

function baseProps(): PanelProps {
  return {
    runId: "run-dropped",
    initialStatus: "pending_approval",
    initialError: null,
    agUiEnabled: false as boolean | null,
    agentPackageName: "@cinatra-test/retired-pack-agent",
    inputParams: {},
    stepperSteps: [{ index: 1, stepNumber: 0, label: "Confirm", xRenderer: FLOOR_ID }],
    agentId: "cinatra-test/retired-pack-agent",
    lgThreadId: null,
    templateId: "tmpl-dropped",
    templateName: "Retired Pack Agent",
  };
}

const CONTEXT: FieldRendererContext = { connectedApps: [] };
const gateSchema = (xRenderer: string) => ({ ...STORED_SCHEMA, "x-renderer": xRenderer });

function continues(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button")).filter((b) =>
    /Continue|Submitting|Continuing/.test(b.textContent ?? ""),
  );
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })),
  );
  fieldRendererRegistry.clear();
  ensureDefaultFieldRenderersRegistered();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  __resetFieldRendererComponentMapForTests();
  INTERRUPT = null;
  vi.clearAllMocks();
  hitlActions.approveReviewTask.mockReset();
  hitlActions.approveReviewTask.mockResolvedValue({ ok: true as const });
  fieldRendererRegistry.clear();
  ensureDefaultFieldRenderersRegistered();
});

describe("a tombstoned id", () => {
  it("gives no renderer to any tombstoned id", () => {
    const tombstoned = [...midRun.TOMBSTONED_HITL_RENDERER_IDS];
    expect(tombstoned.length).toBeGreaterThan(0);
    for (const id of tombstoned) {
      expect(fieldRendererRegistry.resolve("hitl", gateSchema(id), CONTEXT), id).toBeNull();
      expect(fieldRendererRegistry.resolve("hitl", gateSchema(id), CONTEXT), id).toBeNull();
    }
  });

  it("never registers a binding whose id is tombstoned", () => {
    const tombstoned = "@cinatra/email-reviewer-agent:ai-review-panel";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    registration.registerFieldRendererBindings([
      { id: tombstoned, kind: "cta", priority: 90 },
      { id: "@cinatra-ai/some-live-agent:screen", kind: "cta", priority: 90 },
    ]);
    warn.mockRestore();
    const ids = fieldRendererRegistry.list().map((e) => e.id);
    expect(ids.includes(tombstoned)).toBe(false);
    expect(ids.includes("@cinatra-ai/some-live-agent:screen")).toBe(true);
    expect(fieldRendererRegistry.resolve("hitl", gateSchema(tombstoned), CONTEXT)).toBeNull();
  });
});

describe("OrchestratorStepperPanel - a tombstoned gate stays unanswerable", () => {
  // red-first-expect: TOMBSTONED_HITL_RENDERER_IDS is not iterable
  it("shows the no-renderer paragraph and no Continue for every tombstoned id", async () => {
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    for (const id of midRun.TOMBSTONED_HITL_RENDERER_IDS) {
      INTERRUPT = { schema: STORED_SCHEMA, xRenderer: id, values: {}, reviewTaskId: TASK_ID };
      const props = baseProps();
      render(
        <OrchestratorStepperPanel
          {...props}
          stepperSteps={[{ index: 1, stepNumber: 0, label: "Confirm", xRenderer: id }]}
        />,
      );
      await waitFor(() => expect(document.body.textContent ?? "", id).toMatch(/no renderer configured/));
      expect(document.getElementById(`field-${NOTE_FIELD}`), id).toBeNull();
      expect(continues(), id).toHaveLength(0);
      cleanup();
    }
  });
});

// THE `@cinatra/` SCOPE IS A PACKAGE SCOPE, NOT A RETIRED ONE. Installation
// (`detectSourceRef`) and binding validation (`BINDING_ID_RE`) accept it, so a
// package `@cinatra/foo` with a renderer `@cinatra/foo:output` registers,
// resolves and draws its paused step. Only the listed ids and the listed
// retired packages are refused.
describe("a renderer of a `@cinatra/` package", () => {
  const LIVE_ID = "@cinatra/foo:output";
  const LIVE_SCHEMA = {
    type: "object",
    properties: { reply: { type: "string", title: "Reply" } },
  };

  // red-first-expect: isTombstonedHitlRendererId is not a function
  it("registers, resolves and is classified mid-run like any other package's renderer", () => {
    expect(midRun.isTombstonedHitlRendererId(LIVE_ID)).toBe(false);
    registration.registerFieldRendererBindings([{ id: LIVE_ID, kind: "cta", priority: 90 }]);
    expect(fieldRendererRegistry.list().some((e) => e.id === LIVE_ID)).toBe(true);
    expect(fieldRendererRegistry.resolve("hitl", gateSchema(LIVE_ID), CONTEXT)?.id).toBe(LIVE_ID);
    expect(midRun.classifyMidRunHitl(LIVE_ID)).toBe(true);
  });

  it("draws its paused step on the stepper with a Continue that answers the gate", async () => {
    registration.registerFieldRendererBindings([{ id: LIVE_ID, kind: "cta", priority: 90 }]);
    INTERRUPT = { schema: LIVE_SCHEMA, xRenderer: LIVE_ID, values: {}, reviewTaskId: TASK_ID };
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(
      <OrchestratorStepperPanel
        {...baseProps()}
        stepperSteps={[{ index: 1, stepNumber: 0, label: "Reply", xRenderer: LIVE_ID }]}
      />,
    );
    await waitFor(() => expect(continues()).toHaveLength(1));
    expect(document.body.textContent ?? "").not.toMatch(/no renderer configured/);
    fireEvent.click(continues()[0]!);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    expect((hitlActions.approveReviewTask.mock.calls[0] as unknown[])[0]).toBe(TASK_ID);
  });

  // red-first-expect: TOMBSTONED_HITL_RENDERER_PACKAGES is not iterable
  it("each listed id and each id of a listed retired package stays refused", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const packageIds = [...midRun.TOMBSTONED_HITL_RENDERER_PACKAGES].map((p) => `${p}:any-screen`);
    for (const id of [...midRun.TOMBSTONED_HITL_RENDERER_IDS, ...packageIds]) {
      expect(midRun.isTombstonedHitlRendererId(id), id).toBe(true);
      expect(midRun.classifyMidRunHitl(id), id).toBe(false);
      registration.registerFieldRendererBindings([{ id, kind: "cta", priority: 90 }]);
      expect(fieldRendererRegistry.list().some((e) => e.id === id), id).toBe(false);
      expect(fieldRendererRegistry.resolve("hitl", gateSchema(id), CONTEXT), id).toBeNull();
    }
    warn.mockRestore();
  });

  // red-first-expect: Cannot read properties of undefined (reading 'has')
  it("agrees with the installation and validation rules: an id they accept is refused only when listed", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { BINDING_ID_RE } = await import("../../../../scripts/extensions/agent-binding-kinds.mjs");
    const installSrc = readFileSync(
      join(__dirname, "..", "..", "..", "extensions", "src", "add-from-chat.ts"),
      "utf8",
    );
    // The scopes installation takes from the private registry.
    const scopeLine = installSrc.split("\n").find((l) => l.includes("isPrivateScope ="));
    expect(scopeLine).toBeDefined();
    const scopes = [...scopeLine!.matchAll(/startsWith\("(@[^"]+\/)"\)/g)].map((m) => m[1]!);
    expect(scopes).toContain("@cinatra/");
    expect(scopes).toContain("@cinatra-ai/");
    const packages = ["foo", "email-agent", "email-reviewer-agent", "context-selection-agent", "x"];
    const locals = ["output", "ai-review-panel", "draft-review", "setup-form", "review", "screen"];
    for (const scope of scopes) {
      for (const pkg of packages) {
        for (const local of locals) {
          const id = `${scope}${pkg}:${local}`;
          expect(BINDING_ID_RE.test(id), id).toBe(true);
          const listed =
            midRun.TOMBSTONED_HITL_RENDERER_IDS.has(id) ||
            midRun.TOMBSTONED_HITL_RENDERER_PACKAGES.has(`${scope}${pkg}`);
          expect(midRun.isTombstonedHitlRendererId(id), id).toBe(listed);
        }
      }
    }
    // A listed id that validation accepts sits in a scope installation accepts.
    for (const id of midRun.TOMBSTONED_HITL_RENDERER_IDS) {
      if (!BINDING_ID_RE.test(id)) continue;
      expect(scopes.some((s) => id.startsWith(s)), id).toBe(true);
    }
  });
});

