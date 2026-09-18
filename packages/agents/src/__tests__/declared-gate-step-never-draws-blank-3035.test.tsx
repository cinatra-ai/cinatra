// @vitest-environment jsdom
/**
 * NO DECLARED GATE STEP EVER DRAWS A BLANK CARD (cinatra#3035, epic #3023 W11).
 *
 * `specs/app-artifact-review.html` §I: every gate is a step in the run and "a
 * gate step opens the gate's own surface in place"; §I.1 closes its four
 * readings with "No reading ever chooses a row on the reader's behalf, and none
 * leaves the page blank." A step whose card draws nothing at all but a Continue
 * is that blank.
 *
 * WHAT THE PICTURE ROUND FOUND. On one real run of the blog pipeline agent the
 * FIRST declared pause (the stored-ideas gate, which declares its own renderer)
 * drew correctly, while the SECOND (`brand_voice_gate`, which declares ONE
 * field and no renderer) drew a card with no question, no control of its own and
 * no message — a hairline floor and Continue, and no prompt window at its foot.
 *
 * THE CAUSE IS ONE PREDICATE. `orchestrator-stepper-panel.tsx`'s
 * `isGenericObjectSchema` fired on ANY object-typed declared schema that
 * resolved to the host's schema-field fallback renderer, which suppressed the
 * renderer, suppressed the "no renderer configured" message and withheld the
 * prompt window — three consequences and one condition. Its own comment says it
 * exists for a GENERIC step-confirmation interrupt ("object schema with only
 * { approved: boolean }"); it never looked at the schema's properties.
 *
 * WHY THIS FILE IS A CENSUS. The defect reached a picture round because no suite
 * enumerated the KINDS of declared gate step this panel can draw. This file does:
 * every kind gets a case, so a kind without a drawing fails here and never first
 * in a picture round. The kinds are re-taken from the panel's own source, and the
 * closing case states the floor over all of them in one sentence — the surface a
 * kind owes is stated by that kind's own case.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/declared-gate-step-never-draws-blank-3035.test.tsx
 */
import React from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import {
  ARTIFACT_REVIEW_REDIRECT_RENDERER_ID,
  SCHEMA_FIELD_FALLBACK_RENDERER_ID,
} from "../agent-builder-ids";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";

// --- Panel mount harness (mirrors orchestrator-stepper-hitl-field-label) ------

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

/** The gate submissions this file measures. */
const approveReviewTask = vi.fn(async (...args: unknown[]) => {
  void args;
  return { ok: true };
});
vi.mock("../hitl-actions", () => ({
  approveReviewTask: (...args: unknown[]) => approveReviewTask(...args),
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

// --- The kinds, each taken from a declaration read in cinatra#3035 -----------

const IDEA_RENDERER_ID = "@cinatra-ai/blog-pipeline-agent:idea-selection";

/**
 * (i) A GATE THAT DECLARES ITS OWN RENDERER — the pipeline pack's
 * `idea_selection_gate`: `metadata.cinatra.renderer` plus an
 * `inputMessageSchema` whose `x-renderer` repeats the same id.
 */
const IDEA_GATE = {
  xRenderer: IDEA_RENDERER_ID,
  schema: {
    type: "object",
    "x-renderer": IDEA_RENDERER_ID,
    properties: { selectedIdeaJson: { type: "string", title: "Selected idea (JSON)" } },
  },
  values: {
    ideas: [
      {
        artifactId: "idea-a",
        representationRevisionId: "rev-a",
        title: "Build an Audit Trail for Every AI Agent Run",
        text: "Build an Audit Trail for Every AI Agent Run\n\nWhat a run should keep.",
      },
    ],
  },
  reviewTaskId: "gate-run-3035",
};

/**
 * (ii) A GATE THAT DECLARES A FIELD AND NO RENDERER — the pipeline pack's
 * `brand_voice_gate`: no `renderer`, no `inputRenderers`, no `x-renderer` in its
 * schema, so the compiler resolves the host's own fallback id; an object schema
 * with ONE declared string property carrying a title, a description and the
 * multi-line hint.
 */
const BRAND_VOICE_TITLE = "Brand voice";
const BRAND_VOICE_GATE = {
  xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
  schema: {
    type: "object",
    properties: {
      brandVoice: {
        type: "string",
        title: BRAND_VOICE_TITLE,
        description:
          "The brand-voice material this post is written in: the voice instructions, " +
          "or example sentences to mirror.",
        "x-multiline": true,
      },
    },
  },
  values: {},
  reviewTaskId: "gate-run-3035",
};

/** (iii) A BARE CONFIRMATION GATE — the shape the bypass exists for. */
const BARE_CONFIRMATION_GATE = {
  xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
  schema: { type: "object", properties: { approved: { type: "boolean" } } },
  values: {},
  reviewTaskId: "gate-run-3035",
};

/**
 * (iv) A GATE WITH NO DECLARED SCHEMA AT ALL — the bare `{ type: "object" }`
 * oas-compiler.ts mints when a node declares none.
 */
const NO_SCHEMA_GATE = {
  xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
  schema: { type: "object" },
  values: {},
  reviewTaskId: "gate-run-3035",
};

/** (v) A SETUP GATE WITH AN OBJECT-TYPED FIELD — the cinatra#2484 guard. */
const SETUP_OBJECT_GATE = {
  xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
  schema: {
    type: "object",
    properties: { brandVoice: { type: "string", title: BRAND_VOICE_TITLE } },
  },
  values: {},
  reviewTaskId: "setup-run-3035",
  fieldName: "brandVoice",
};

/** (vi) THE MARKED REVIEW GATE — the artifact-review redirect renderer id. */
const MARKED_REVIEW_GATE = {
  xRenderer: ARTIFACT_REVIEW_REDIRECT_RENDERER_ID,
  schema: { type: "object" },
  values: { reviewSurfaceUrl: "/artifacts/post-1/reviews/rev-1" },
  reviewTaskId: "gate-run-3035",
};

/**
 * (vii) A GATE WHOSE ONE DECLARED PROPERTY IS CALLED `approved` BUT IS NOT THE
 * CONFIRMATION FLAG — a kind the convergence round named: the bypass exempts
 * `{ approved: boolean }`, and a property of that name declaring another type is
 * something the person is asked to write.
 */
const APPROVAL_RATIONALE_GATE = {
  xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
  schema: {
    type: "object",
    properties: {
      approved: { type: "string", title: "Approval rationale" },
    },
  },
  values: {},
  reviewTaskId: "gate-run-3035",
};

/**
 * (viii) A GATE WHOSE FIELDS LIVE BEHIND A REFERENCE — no declared `properties`
 * of its own, so nothing on this road can read what it asks for. The host's own
 * floor for an object it cannot take apart is the renderer's JSON control; a
 * blank card is not a reading this kind may have (convergence round).
 */
const REFERENCED_SCHEMA_GATE = {
  xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
  schema: {
    type: "object",
    $ref: "#/$defs/BrandVoice",
    $defs: {
      BrandVoice: {
        type: "object",
        properties: { brandVoice: { type: "string", title: BRAND_VOICE_TITLE } },
      },
    },
  },
  values: {},
  reviewTaskId: "gate-run-3035",
};

const KINDS: Array<{ name: string; gate: Record<string, unknown> }> = [
  { name: "(i) declares its own renderer", gate: IDEA_GATE },
  { name: "(ii) declares a field and no renderer", gate: BRAND_VOICE_GATE },
  { name: "(iii) a bare confirmation", gate: BARE_CONFIRMATION_GATE },
  { name: "(iv) no declared schema at all", gate: NO_SCHEMA_GATE },
  { name: "(v) a setup gate with an object-typed field", gate: SETUP_OBJECT_GATE },
  { name: "(vi) the marked review gate", gate: MARKED_REVIEW_GATE },
  { name: "(vii) a non-boolean property named approved", gate: APPROVAL_RATIONALE_GATE },
  { name: "(viii) a schema whose fields live behind a reference", gate: REFERENCED_SCHEMA_GATE },
];

// --- Mount and read ----------------------------------------------------------

async function mountGate(gate: Record<string, unknown>) {
  INTERRUPT = { ...gate };
  const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
  const props: PanelProps = {
    runId: "run-3035",
    initialStatus: "pending_approval",
    initialError: null,
    agUiEnabled: false as boolean | null,
    agentPackageName: "@cinatra-ai/blog-pipeline-agent",
    inputParams: {},
    stepperSteps: [
      { index: 1, stepNumber: 0, label: "Gate", xRenderer: gate.xRenderer as string },
    ],
    agentId: "cinatra-ai/blog-pipeline-agent",
    lgThreadId: null,
    templateId: "tmpl-3035",
    templateName: "Blog Pipeline Agent",
  };
  const view = render(<OrchestratorStepperPanel {...props} />);
  await waitFor(() => expect(gateRegion()).not.toBeNull());
  return view;
}

/** The step card's own region — the surface the gate opens in place. */
function gateRegion(): Element | null {
  const marked = document.querySelector('[data-review-gate-step="link-only"]');
  if (marked) return marked;
  const windowMount = document.querySelector("[data-run-prompt-window-mount]");
  return windowMount?.previousElementSibling ?? null;
}

/** The run page's own prompt-window mount, and whether a window stands in it. */
function promptWindowMount(): Element | null {
  return document.querySelector("[data-run-prompt-window-mount]");
}
function promptWindowPresent(): boolean {
  const mount = promptWindowMount();
  return mount !== null && mount.childElementCount > 0;
}

/** Every control a person can act on inside the card's own region. */
function controlsIn(region: Element): Element[] {
  return Array.from(
    region.querySelectorAll("button, input, textarea, select, [role='radio'], [role='radiogroup']"),
  );
}

/** Every sentence the card's own region says to the person. */
function messagesIn(region: Element): string[] {
  return Array.from(region.querySelectorAll("p, span, h1, h2, h3, label"))
    .map((el) => (el.textContent ?? "").trim())
    .filter((t) => t.length > 0);
}

function continueButtonsIn(region: Element): HTMLButtonElement[] {
  return Array.from(region.querySelectorAll("button")).filter((b) =>
    /continue/i.test(b.textContent ?? ""),
  ) as HTMLButtonElement[];
}

beforeEach(() => {
  ensureDefaultFieldRenderersRegistered();
});

afterEach(() => {
  cleanup();
  INTERRUPT = null;
  vi.clearAllMocks();
  vi.useRealTimers();
});

// NEW TEST FILES RESTORE WHAT THEY MOCK: the module mocks above are file-scoped,
// and this file hands the registry and the module graph back as it found them so
// the package's full run stays green with the file present.
afterAll(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("a declared gate step draws its own surface — every kind (cinatra#3035)", () => {
  it("(i) a gate that declares its own renderer is drawn by that renderer", async () => {
    await mountGate(IDEA_GATE);
    const region = gateRegion()!;

    // The pack-bound renderer's own drawing is what the card holds.
    expect(region.textContent).toContain("Select one blog idea to draft.");
    const group = region.querySelector("[role='radiogroup']");
    expect(group, "the idea gate draws its own radio group").not.toBeNull();
    expect(group!.getAttribute("aria-label")).toBe("Select one blog idea to draft");
    expect(region.querySelectorAll("[role='radio']").length).toBe(1);
    expect(region.textContent).toContain("Build an Audit Trail for Every AI Agent Run");
  });

  it("(ii) a gate that declares a field and no renderer draws that field, not a blank card", async () => {
    await mountGate(BRAND_VOICE_GATE);
    const region = gateRegion()!;

    // THE ROUND'S FINDING, STATED AS A TEST. A control of the gate's own — not
    // only the decision floor's Continue.
    const fieldControls = Array.from(
      region.querySelectorAll("input, textarea, select, [role='radiogroup']"),
    );
    expect(
      fieldControls.length,
      "the declared property must be drawn as a control of the gate's own",
    ).toBeGreaterThan(0);

    // The declared property's own title is readable in the card.
    expect(region.textContent).toContain(BRAND_VOICE_TITLE);

    // …and the card is never empty of BOTH a control and a message.
    expect(controlsIn(region).length + messagesIn(region).length).toBeGreaterThan(0);

    // THE SAME ONE PREDICATE WITHHELD THE WINDOW: the run page's prompt window
    // stands at the foot of a gate that declares a field.
    expect(promptWindowPresent(), "the prompt window stands at this gate's foot").toBe(true);

    // EXACTLY ONE CONTROL SUBMITS THE GATE, AND IT SUBMITS ONCE. The renderer's
    // own control floor carries the submit here; the panel's outer Continue is
    // not drawn beside it, so the card never holds two Continues or none.
    const continues = continueButtonsIn(region);
    expect(continues.length, "exactly one control submits this gate").toBe(1);

    const field = region.querySelector<HTMLTextAreaElement | HTMLInputElement>(
      "#field-brandVoice",
    );
    expect(field, "the declared property is drawn under its own id").not.toBeNull();
    fireEvent.change(field!, { target: { value: "Warm, plain, no hype." } });
    fireEvent.click(continues[0]);

    // The value that leaves the card is the REAL object the declared schema
    // describes — one submission, not one per keystroke.
    await waitFor(() => expect(approveReviewTask).toHaveBeenCalledTimes(1));
    expect(approveReviewTask.mock.calls[0][1]).toEqual({ brandVoice: "Warm, plain, no hype." });
  });

  it("(iii) a bare confirmation gate keeps its Continue alone and no window", async () => {
    await mountGate(BARE_CONFIRMATION_GATE);
    const region = gateRegion()!;

    // No field is drawn for a gate that asks the person for nothing…
    expect(region.querySelectorAll("input, textarea, select").length).toBe(0);
    // …its Continue is the whole of its surface…
    expect(continueButtonsIn(region).length).toBe(1);
    expect(controlsIn(region).length).toBe(1);
    // …and the prompt window is withheld, exactly as it is today.
    expect(promptWindowPresent()).toBe(false);
  });

  it("(iv) a gate with no declared schema reads the same as a bare confirmation", async () => {
    await mountGate(NO_SCHEMA_GATE);
    const region = gateRegion()!;

    // This arm pins that the narrowed predicate does NOT newly expose the
    // schema-field renderer's JSON leg to a gate that declares nothing.
    expect(region.querySelectorAll("input, textarea, select").length).toBe(0);
    expect(continueButtonsIn(region).length).toBe(1);
    expect(controlsIn(region).length).toBe(1);
    expect(promptWindowPresent()).toBe(false);
  });

  it("(v) a setup gate with an object-typed field is untouched (cinatra#2484)", async () => {
    await mountGate(SETUP_OBJECT_GATE);
    const region = gateRegion()!;

    // The setup gate pauses to COLLECT a declared input: its sub-field is drawn
    // and its own floor carries the submit.
    const field = region.querySelector("#field-brandVoice");
    expect(field, "an object-typed setup field draws its own input").not.toBeNull();
    expect(region.textContent).toContain(BRAND_VOICE_TITLE);
    expect(continueButtonsIn(region).length).toBe(1);
  });

  it("(vi) the marked review gate draws its own review surface", async () => {
    await mountGate(MARKED_REVIEW_GATE);
    const region = gateRegion()!;

    expect(region.getAttribute("data-review-gate-step")).toBe("link-only");
    expect(region.textContent).toContain("This step is waiting on a review");
    expect(region.querySelector("a[href='/artifacts/post-1/reviews/rev-1']")).not.toBeNull();
  });

  it("(vii) a property named approved that is not the confirmation flag is drawn", async () => {
    await mountGate(APPROVAL_RATIONALE_GATE);
    const region = gateRegion()!;

    // The bypass is for the CONFIRMATION FLAG `{ approved: boolean }`, not for
    // the name: a string called `approved` is something the person writes.
    const field = region.querySelector("#field-approved");
    expect(field, "a non-boolean approved property draws its own control").not.toBeNull();
    expect(region.textContent).toContain("Approval rationale");
    expect(continueButtonsIn(region).length).toBe(1);
  });

  it("(viii) a gate whose fields live behind a reference draws the host's own floor", async () => {
    await mountGate(REFERENCED_SCHEMA_GATE);
    const region = gateRegion()!;

    // Nothing on this road resolves `$ref`, so the host cannot take this schema
    // apart — but it may not answer with a blank card either. The renderer's
    // object arm floors at a JSON control, with one Continue and no second.
    const controls = Array.from(region.querySelectorAll("input, textarea, select"));
    expect(controls.length, "a referenced schema is never drawn as a blank card").toBeGreaterThan(0);
    expect(continueButtonsIn(region).length).toBe(1);
  });
});

/**
 * THE CONTRACT, IN ONE SENTENCE, OVER EVERY KIND ABOVE: for EVERY kind of
 * declared gate step the panel can draw, the card's own region holds at least
 * one of a control or a message, and never neither.
 *
 * WHAT THIS CASE DOES AND DOES NOT PROVE (convergence round). It is the FLOOR
 * over the whole census — a kind added later that draws nothing at all fails
 * here. It is NOT what caught the round's own defect: the blank card the round
 * photographed still carried the decision floor's Continue, which is a control,
 * so this sentence would have read it as drawn. The kind's OWN case is what
 * states the surface it owes — (ii) for the declared field, (vii) and (viii)
 * for the two shapes the convergence round named.
 */
describe("no kind of declared gate step leaves the card blank (cinatra#3035)", () => {
  it("every kind's card holds at least one of a control or a message", async () => {
    for (const { name, gate } of KINDS) {
      await mountGate(gate);
      const region = gateRegion();
      expect(region, `${name}: the step draws a card`).not.toBeNull();
      const controls = controlsIn(region!);
      const messages = messagesIn(region!);
      expect(
        controls.length + messages.length,
        `${name}: the card's own region holds neither a control nor a message`,
      ).toBeGreaterThan(0);
      cleanup();
      INTERRUPT = null;
    }
  });
});
