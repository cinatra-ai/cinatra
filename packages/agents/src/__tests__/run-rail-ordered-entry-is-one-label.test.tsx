// @vitest-environment jsdom
/**
 * AN ORDERED RAIL ENTRY IS ITS ONE LABEL — NOTHING BESIDE IT
 * (cinatra#3149, the re-cut of the seventh round, finding 2).
 *
 * The seventh proof round of this branch was graded on its own pictures and
 * found "an information (i) affordance beside each ORDERED rail entry". The
 * ratified drawing's rail rule gives an entry a name and a state and nothing
 * else:
 *
 *   "The rail lists the run's steps in order, merged so that a gate is not a
 *    page outside the run but a step in the run ... The step the run is paused
 *    on is highlighted; steps already passed sit above it, steps still to come
 *    below. A resolved gate stays on the rail as read-only history — its entry
 *    keeps its place and records how it was settled (continued, superseded by a
 *    regeneration, changes requested)"
 *
 * Fix leg 4 closed this for the rail's EXTRA entries
 * (`run-rail-entry-is-one-label.test.tsx`, which pins `RailExtraEntry`). The
 * ORDERED spine — `OrchestratorStepperPanel`'s own `stepperSteps` rows, the
 * rows the two-gate List Curator reading is read on — still carried a second
 * child beside the entry: a `[data-rail-step-info]` trigger drawing an ⓘ over
 * the step's `description`. The drawing draws no such affordance, on either
 * half of the rail.
 *
 * THE INSTRUMENT. The ⓘ carries no text of its own (its words live in a
 * tooltip that is mounted only while it is open), so counting the entry's
 * characters would never have caught it. What catches it is STRUCTURE: the
 * ordered row's element children. The drawing gives the row one thing — the
 * entry itself — so the row has exactly one element child, and the marker the
 * affordance rendered under is absent from the rail entirely.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/run-rail-ordered-entry-is-one-label.test.tsx
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

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
    ownKeys: () => ["Check", "Info", "Pause", "default"],
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
      value: StubIcon,
    }),
  });
});

vi.mock("@/lib/cinatra-toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/generated/field-renderer-components", () => ({
  GENERATED_FIELD_RENDERER_COMPONENTS: {},
}));

vi.mock("@/lib/generated/extensions.server", () => ({
  STATIC_EXTENSION_MANIFEST: {},
  GENERATED_CONNECTOR_ENTRY_MODULES: {},
  GENERATED_CONNECTOR_MCP_MODULES: {},
  GENERATED_DEV_SETUP_MODULES: {},
  GENERATED_WIDGET_STREAM_AGENTS: {},
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

vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: (_runId: string, opts: { initialStatus?: string }) => ({
    status: opts?.initialStatus ?? "completed",
    interruptContext: null,
    messages: [],
    streamedText: "",
    presentationHint: null,
    dataPartFrames: [],
    error: null,
  }),
}));

vi.mock("../use-runtime-field-renderer-bindings", () => ({
  useRuntimeFieldRendererBindings: () => ({ bindings: {}, loading: false }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

type PanelProps = import("../orchestrator-stepper-panel").OrchestratorStepperPanelProps;
type RailEntry = import("../run-step-rail").RunStepRailEntry;

const REVIEW_HREF_BASE = "/agents/acme%2Flist-curator/run-3149/review";

/**
 * THE TWO-GATE SHAPE the cell-4 reading is taken on: an ordered spine whose
 * gated steps carry a `description`. The description is exactly what drew the
 * ⓘ, so every step here carries one — the hardest input for the pin.
 */
const ORDERED_STEPS: PanelProps["stepperSteps"] = [
  { index: 1, stepNumber: 0, label: "Scrape schema", xRenderer: "grouped-setup-form", description: "Read the seed address" },
  { index: 2, stepNumber: 1, label: "Review schema", xRenderer: "schema-review", description: "Approve the schema before the crawl" },
  { index: 3, stepNumber: 2, label: "Build list", xRenderer: "list-build" },
  { index: 4, stepNumber: 3, label: "Review list", xRenderer: "final-list-review", description: "Approve the finished list" },
];

const RAIL_EXTRAS: RailEntry[] = [
  {
    key: "gate:task-pending",
    ordinal: 5,
    kind: "gate",
    label: "Review",
    status: "pending",
    sources: ["gate"],
    gate: { gateId: "gate-1", reviewTaskId: "task-pending", disposition: null, resolved: false },
  },
];

function baseProps(overrides: Partial<PanelProps> = {}): PanelProps {
  return {
    runId: "run-3149",
    initialStatus: "running",
    initialError: null,
    agUiEnabled: false as boolean | null,
    agentPackageName: "@acme/list-curator",
    inputParams: {},
    stepperSteps: ORDERED_STEPS,
    agentId: "acme/list-curator",
    lgThreadId: null,
    templateId: "tmpl-3149",
    templateName: "List Curator",
    railExtras: RAIL_EXTRAS,
    reviewHrefBase: REVIEW_HREF_BASE,
    ...overrides,
  };
}

function rail(): HTMLElement {
  const el = document.querySelector<HTMLElement>("[data-run-step-rail]");
  if (el === null) throw new Error("no run step rail in the detail");
  return el;
}

function orderedEntries(): HTMLElement[] {
  return [...rail().querySelectorAll<HTMLElement>('[data-rail-kind="step"]')];
}

describe("an ordered rail entry carries its one label and nothing beside it (cinatra#3149, finding 2)", () => {
  it("draws NO information affordance beside any ordered entry", async () => {
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps()} />);

    // The marker the ⓘ rendered under. Three of the four steps carry a
    // description, so the refused reading drew three of these.
    expect(rail().querySelectorAll("[data-rail-step-info]").length).toBe(0);
  });

  it("gives each ordered entry exactly ONE element child — the entry itself", async () => {
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps()} />);

    const entries = orderedEntries();
    expect(entries).toHaveLength(ORDERED_STEPS.length);
    for (const [i, entry] of entries.entries()) {
      expect(
        entry.children.length,
        `the "${ORDERED_STEPS[i].label}" entry draws something beside its label`,
      ).toBe(1);
    }
  });

  it("still reads out every step's own label — the entries are not emptied", async () => {
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    render(<OrchestratorStepperPanel {...baseProps()} />);

    // The label, plus the entry's own drawn state (the numeral in its
    // indicator). Nothing else: no second line, no reason, no machine code.
    for (const [i, entry] of orderedEntries().entries()) {
      const text = (entry.textContent ?? "").replace(/\d+/g, "").trim();
      expect(text).toBe(ORDERED_STEPS[i].label);
      expect(/[A-Z_]{6,}/.test(entry.textContent ?? "")).toBe(false);
    }
  });

});
