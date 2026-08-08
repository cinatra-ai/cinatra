// @vitest-environment jsdom
/**
 * THE SEAM THAT REGRESSED (cinatra#2541): the panel → field-label handoff.
 *
 * A per-field HITL setup gate rendered its label as "Hitl Field" instead of the
 * field's real name ("Idea"). `resolveFieldLabel` was innocent — the panel fed
 * it a HARDCODED placeholder:
 *
 *     fieldName="hitl-field"          // while interruptContext.fieldName === "idea"
 *
 * Why the earlier fixes could not catch this:
 *
 *   - #817 removed the raw `hitl-field` label from the context-selection gate by
 *     making that gate resolve to its real renderer — a renderer-RESOLUTION fix.
 *     It never touched what a gate passes as its field name.
 *   - #1162 made the humanizer run even when the OAS emits `title === fieldName`
 *     — a LABEL-DERIVATION fix, and its test
 *     (schema-field-renderer-humanize-label.test.tsx) mounts SchemaFieldRenderer
 *     DIRECTLY with a real `fieldName`. It proves the humanizer given a good
 *     input; it cannot see a caller that supplies a bad one.
 *
 * So no test ever asserted what the PANELS PASS. That is the gap this file
 * closes: it mounts the REAL OrchestratorStepperPanel on a real HITL interrupt
 * and asserts the real field name reaches the rendered label and input id. A
 * future re-hardcode of the placeholder fails here — and, belt and braces, the
 * source guard at the bottom names the exact regression.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/orchestrator-stepper-hitl-field-label.test.tsx
 */
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";
import { GENERIC_FIELD_LABEL } from "../humanize-field-name";

// --- Panel mount harness (mirrors orchestrator-stepper-panel-completed-terminal) ---

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
    ownKeys: () => ["AlertCircle", "ArrowRight", "Check", "Info", "Loader2", "Pause", "X", "default"],
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

vi.mock("../hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../use-runtime-field-renderer-bindings", () => ({
  useRuntimeFieldRendererBindings: () => ({ bindings: {}, loading: false }),
}));

/** The live interrupt the mocked stream hands the panel. Set per test. */
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
    runId: "run-2541",
    initialStatus: "pending_approval",
    initialError: null,
    agUiEnabled: false as boolean | null,
    agentPackageName: "@cinatra-ai/blog-draft-writer-agent",
    inputParams: {},
    stepperSteps: [
      { index: 1, stepNumber: 0, label: "Setup", xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID },
    ],
    agentId: "cinatra-ai/blog-draft-writer-agent",
    lgThreadId: null,
    templateId: "tmpl-2541",
    templateName: "Blog draft writer",
  };
}

/** Mount the panel on a live single-field setup gate for `fieldName`. */
async function mountGate(args: {
  fieldName?: string;
  schema: Record<string, unknown>;
  reviewTaskId?: string;
}) {
  INTERRUPT = {
    schema: args.schema,
    xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
    values: {},
    reviewTaskId: args.reviewTaskId ?? "setup-run-2541",
    ...(args.fieldName === undefined ? {} : { fieldName: args.fieldName }),
  };
  const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
  render(<OrchestratorStepperPanel {...baseProps()} />);
}

/** The rendered <label> bound to the field input with this id. */
function labelFor(fieldId: string): HTMLLabelElement | null {
  return document.querySelector<HTMLLabelElement>(`label[for="${fieldId}"]`);
}

beforeEach(() => {
  ensureDefaultFieldRenderersRegistered();
});

afterEach(() => {
  cleanup();
  INTERRUPT = null;
  vi.clearAllMocks();
});

describe("OrchestratorStepperPanel — the HITL gate labels itself from the REAL field name (cinatra#2541)", () => {
  it("labels the blog-draft-writer `idea` gate 'Idea', not 'Hitl Field'", async () => {
    // The exact shape from the issue: a titleless string input whose only
    // identity is the interrupt's fieldName.
    await mountGate({ fieldName: "idea", schema: { type: "string" } });

    await waitFor(() => expect(labelFor("field-idea")).not.toBeNull());
    // The label reads the humanized REAL field name …
    expect(labelFor("field-idea")!.textContent).toMatch(/^Idea/);
    // … and the internal wiring token never reaches the page, as a label or
    // as an element id.
    expect(document.body.textContent).not.toMatch(/Hitl Field/i);
    expect(document.querySelector("#field-hitl-field")).toBeNull();
  });

  it("humanizes a title-equals-key gate through the same path (#1162 shape, real field name)", async () => {
    // #1162's own case, but reached the way a user reaches it — through the
    // panel. Before this fix the placeholder made the panel's `title === key`
    // guard moot: the label came from "hitl-field" regardless of the schema.
    await mountGate({
      fieldName: "blogPostUrl",
      schema: { type: "string", title: "blogPostUrl" },
    });

    await waitFor(() => expect(labelFor("field-blogPostUrl")).not.toBeNull());
    expect(labelFor("field-blogPostUrl")!.textContent).toMatch(/^Blog Post URL/);
    expect(document.body.textContent).not.toMatch(/Hitl Field/i);
  });

  it("shows a meaningful schema title verbatim and still ids the input by the real field", async () => {
    await mountGate({
      fieldName: "idea",
      schema: { type: "string", title: "What should we write about?" },
    });

    await waitFor(() => expect(labelFor("field-idea")).not.toBeNull());
    expect(labelFor("field-idea")!.textContent).toMatch(/^What should we write about\?/);
    expect(document.body.textContent).not.toMatch(/Hitl Field/i);
  });

  it("falls back to a NEUTRAL label — never 'Hitl Field' — when the interrupt carries no field name", async () => {
    // Mid-run gates and output renderers carry no `fieldName`
    // (InterruptContext.fieldName). There is no real identity to show, so the
    // label must be honestly generic rather than the humanized wiring token.
    await mountGate({ schema: { type: "string" }, reviewTaskId: "gate-run-2541" });

    await waitFor(() => expect(labelFor("field-hitl-field")).not.toBeNull());
    expect(labelFor("field-hitl-field")!.textContent).toMatch(
      new RegExp(`^${GENERIC_FIELD_LABEL}`),
    );
    expect(document.body.textContent).not.toMatch(/Hitl Field/i);
  });

  it("still prefers the schema title when a nameless gate has one", async () => {
    await mountGate({
      schema: { type: "string", title: "Approval note" },
      reviewTaskId: "gate-run-2541",
    });

    await waitFor(() => expect(labelFor("field-hitl-field")).not.toBeNull());
    expect(labelFor("field-hitl-field")!.textContent).toMatch(/^Approval note/);
  });
});

/**
 * Source guard — the regression was a LITERAL typed into a JSX prop. The mounted
 * tests above (and the chat-surface sibling, agentic-run-panel-hitl-field-label)
 * are the real proof: they FAIL on the hardcode. This one exists only so the
 * failure message NAMES the mistake, on both single-field HITL panels at once.
 * Deliberately one negative assertion — pinning the positive shape too would
 * police formatting rather than behaviour.
 */
describe("no HITL panel hardcodes the placeholder as a renderer's field identity (cinatra#2541)", () => {
  const PANELS = ["orchestrator-stepper-panel.tsx", "agentic-run-panel.tsx"];

  for (const panel of PANELS) {
    it(`${panel} never re-hardcodes fieldName="hitl-field"`, () => {
      const src = readFileSync(join(__dirname, "..", panel), "utf8");
      expect(
        src,
        `${panel} re-hardcoded fieldName="hitl-field" — pass the interrupt's real ` +
          `field name via hitlRendererFieldName(<ctx>.fieldName) instead ` +
          `(cinatra#2541).`,
      ).not.toMatch(/fieldName="hitl-field"/);
    });
  }
});
