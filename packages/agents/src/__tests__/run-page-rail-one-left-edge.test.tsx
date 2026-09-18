// @vitest-environment jsdom
/**
 * EVERY RAIL ENTRY ON ONE LEFT EDGE (cinatra#3514).
 *
 * The ratified drawing, agent run and review surface, section I, "The step rail
 * — merged steps and gate entries": "The step the run is paused on is
 * highlighted; steps already passed sit above it, steps still to come below."
 * One column, and nothing in it indents a row: a gate "is not a page outside the
 * run but a step in the run", woven "inline at the point the run reached it".
 *
 * WHAT WAS MEASURED (2026-09-15, a development boot, both palettes, a 2880px
 * frame). On the Email Outreach Agent's run page the rail's GATE rows sat
 * further right than its plain step rows — "Account scope" by about 12px,
 * "Review drafts" by about 18px and "Test & send" by about 25px — an indent
 * that grew as the row's own label got shorter, which is the signature of a row
 * whose content is CENTRED in the rail column rather than started at its edge.
 *
 * THE CAUSE. `RUN_PAGE_RAIL_ROW_CLASS` (run-step-rail-extra-entry.tsx) states
 * the rail's row box for all three rail modules and names no horizontal
 * alignment, so every row drawn through `StepperTrigger` keeps the shared
 * `Button` base's own `justify-center` (src/components/ui/button.tsx). On the
 * rows whose wrapper spans the rail column (run-step-rail-extra-entry.tsx, the
 * `flex w-full min-w-0` row wrapper) that centres the circle and the label
 * inside the column — half the leftover width as a left indent, different on
 * every row. The run-surface rail's own row class next door already states
 * `justify-start` (run-surface-rail.tsx); the run page's did not.
 *
 * WHAT THIS FILE PROVES, AND WHAT IT DOES NOT. jsdom lays nothing out, so a left
 * edge cannot be measured here in pixels — the task names the alternative, the
 * class contract: every row box of the rail, whichever of the five branches drew
 * it and whatever kind it stands for, resolves to the SAME horizontal alignment
 * and the SAME left inset, and that alignment starts the row at the column's
 * edge. The pixels are read on a real run, in both palettes, by the proof round.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/run-page-rail-one-left-edge.test.tsx
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
    ownKeys: () => ["Check", "ClipboardCheck", "Info", "Pause", "ScanSearch", "SkipForward", "default"],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: StubIcon }),
  });
});

vi.mock("@/lib/cinatra-toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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

vi.mock("../hitl-actions", () => ({ approveReviewTask: vi.fn(async () => ({ ok: true })) }));

vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: (_runId: string, opts: { initialStatus?: string }) => ({
    status: opts?.initialStatus ?? "pending_approval",
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
  document.documentElement.classList.remove("dark");
});

type RailEntry = import("../run-step-rail").RunStepRailEntry;
type PanelProps = import("../orchestrator-stepper-panel").OrchestratorStepperPanelProps;

const REVIEW_HREF_BASE = "/agents/cinatra-ai%2Femail-outreach-agent/run-3514/review";

const tokens = (className: string): string[] => className.split(/\s+/).filter(Boolean);
const bare = (token: string): string => token.replace(/^!/, "");

/** The row's horizontal content alignment, as the DOM actually resolved it. */
const justifyOf = (el: Element): string =>
  tokens(el.className).map(bare).filter((t) => t.startsWith("justify-")).join(" ") || "(none)";

/** Every token that could inset a row from the rail column's left edge. */
const LEFT_INSET = /^(pl|ps|px|p|ml|ms|mx|m|start|inset|left|translate-x|indent)-/;
const leftInsetOf = (el: Element): string =>
  tokens(el.className)
    .map(bare)
    .filter((t) => LEFT_INSET.test(t))
    .sort()
    .join(" ");

/**
 * THE ROW BOXES OF A MOUNTED RAIL. Each rail row is a `[data-rail-kind]` wrapper
 * holding ONE row box — the control (or the inert div) that carries the circle
 * and the label. Five branches draw one: the spine's own trigger, the parked
 * gate's trigger, the resolved-gate link, the verification link, the inert div
 * and the plain fallback trigger.
 */
function rowBoxes(root: ParentNode): { kind: string; label: string; box: HTMLElement }[] {
  return Array.from(root.querySelectorAll<HTMLElement>("[data-rail-kind]")).map((wrapper) => {
    const box = wrapper.querySelector<HTMLElement>(
      '[data-slot="stepper-trigger"], a[href], [data-rail-inert]',
    );
    if (!box) throw new Error(`rail row ${wrapper.getAttribute("data-rail-kind")} drew no row box`);
    return {
      kind: `${wrapper.getAttribute("data-rail-kind")}/${wrapper.getAttribute("data-rail-status")}`,
      label: box.textContent?.trim() ?? "",
      box,
    };
  });
}

/** The outreach run the issue measured: plain work steps with gate entries woven
 *  in at the point the run reached them (the drawing's merged rail). */
function outreachEntries(): RailEntry[] {
  return [
    { key: "step:1", ordinal: 1, kind: "step", label: "Schedule", status: "completed", sources: ["template"] },
    { key: "step:2", ordinal: 2, kind: "step", label: "Setup", status: "completed", sources: ["template"] },
    {
      key: "gate:done",
      ordinal: 3,
      kind: "gate",
      label: "Review",
      status: "resolved",
      sources: ["gate"],
      gate: { gateId: "g-1", reviewTaskId: "task-done", disposition: "approved", resolved: true },
    },
    {
      key: "gate:parked",
      ordinal: 4,
      kind: "gate",
      label: "Account scope",
      status: "pending",
      sources: ["gate"],
      gate: { gateId: "g-2", reviewTaskId: "task-parked", disposition: null, resolved: false },
    },
    { key: "step:5", ordinal: 5, kind: "step", label: "Review recipients", status: "upcoming", sources: ["template"] },
    { key: "gate:ahead", ordinal: 6, kind: "gate", label: "Review drafts", status: "upcoming", sources: ["gate"] },
    {
      key: "verification:done",
      ordinal: 7,
      kind: "verification",
      label: "Test & send",
      status: "completed",
      sources: ["verification"],
      verification: { gateId: "g-1", reviewTaskId: "task-done", outcome: "verified" },
    },
    {
      key: "lifecycle:e9",
      ordinal: 8,
      kind: "lifecycleDecision",
      label: "Review skipped",
      status: "skipped",
      sources: ["lifecycleDecision"],
      lifecycleDecision: {
        eventId: "e-9",
        artifactId: "a-9",
        outcome: "skipped",
        decidedBy: "org-bound",
        latticeOutcome: "skip",
        reason: "The org policy skips review for outreach drafts.",
      },
    },
    { key: "step:9", ordinal: 9, kind: "step", label: "Made", status: "completed", sources: ["stepResult"], openable: false },
  ];
}

const SPINE_STEPS: PanelProps["stepperSteps"] = [
  { index: 1, stepNumber: 0, label: "Schedule", xRenderer: "grouped-setup-form" },
  { index: 2, stepNumber: 1, label: "Setup", xRenderer: "grouped-setup-form", description: "Collect the campaign brief" },
  { index: 3, stepNumber: 2, label: "Review recipients", xRenderer: "campaign-recipients-review" },
];

const PALETTES = ["light", "dark"] as const;

describe.each(PALETTES)(
  "the run page's rail puts every entry on ONE left edge, in the %s palette (cinatra#3514)",
  (palette) => {
    it("draws the page rail's plain steps and gate entries on the same edge", async () => {
      document.documentElement.classList.toggle("dark", palette === "dark");
      const { RunStepRailPanel } = await import("../run-step-rail-panel");
      const { container } = render(
        <RunStepRailPanel
          entries={outreachEntries()}
          activeOrdinal={4}
          reviewHrefBase={REVIEW_HREF_BASE}
        />,
      );
      const rows = rowBoxes(container);
      // The rail the issue measured: plain steps AND gate entries, woven.
      expect(rows.filter((r) => r.kind.startsWith("step/")).length).toBeGreaterThan(1);
      expect(rows.filter((r) => !r.kind.startsWith("step/")).length).toBeGreaterThan(1);

      for (const { kind, label, box } of rows) {
        expect(
          justifyOf(box),
          `the "${label}" row (${kind}) centres its content in the rail column instead of starting it at the edge`,
        ).toBe("justify-start");
        expect(leftInsetOf(box), `the "${label}" row (${kind}) insets itself from the edge`).toBe("px-0");
      }
      // …and one edge means ONE reading of it, not merely a permitted set.
      expect(new Set(rows.map((r) => justifyOf(r.box))).size).toBe(1);
      expect(new Set(rows.map((r) => leftInsetOf(r.box))).size).toBe(1);
    });

    it("draws the LIVE rail's spine rows and trailing gate rows on the same edge", async () => {
      document.documentElement.classList.toggle("dark", palette === "dark");
      const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
      render(
        <OrchestratorStepperPanel
          runId="run-3514"
          initialStatus="pending_approval"
          initialError={null}
          agUiEnabled={false}
          agentPackageName="@cinatra-ai/email-outreach-agent"
          inputParams={{}}
          stepperSteps={SPINE_STEPS}
          agentId="cinatra-ai/email-outreach-agent"
          lgThreadId={null}
          templateId="tmpl-3514"
          templateName="Email Outreach Agent"
          railExtras={outreachEntries().filter((e) => e.kind !== "step")}
          reviewHrefBase={REVIEW_HREF_BASE}
        />,
      );
      const rail = document.querySelector("[data-run-step-rail]");
      expect(rail).not.toBeNull();
      const rows = rowBoxes(rail!);
      expect(rows.filter((r) => r.kind.startsWith("step/")).length).toBe(SPINE_STEPS.length);
      expect(rows.filter((r) => !r.kind.startsWith("step/")).length).toBeGreaterThan(1);

      for (const { kind, label, box } of rows) {
        expect(
          justifyOf(box),
          `the "${label}" row (${kind}) centres its content in the rail column instead of starting it at the edge`,
        ).toBe("justify-start");
        expect(leftInsetOf(box), `the "${label}" row (${kind}) insets itself from the edge`).toBe("px-0");
      }
      expect(new Set(rows.map((r) => justifyOf(r.box))).size).toBe(1);
      expect(new Set(rows.map((r) => leftInsetOf(r.box))).size).toBe(1);
    });
  },
);

describe("the parked gate's own control takes the same edge (cinatra#3514)", () => {
  it("starts its content at the column edge when the run detail opens it in place", async () => {
    const { RunStepRailPanel } = await import("../run-step-rail-panel");
    const { RunStepSelectionProvider } = await import("../run-step-rail-extra-entry");
    const { container } = render(
      <RunStepSelectionProvider value={{ selected: "detail", select: () => {} }}>
        <RunStepRailPanel
          entries={outreachEntries()}
          activeOrdinal={4}
          reviewHrefBase={REVIEW_HREF_BASE}
        />
      </RunStepSelectionProvider>,
    );
    // The parked gate is drawn as the rail's own trigger here, not as a link.
    const parked = container.querySelector<HTMLElement>('[data-rail-gate-open="task-parked"]');
    expect(parked).not.toBeNull();
    expect(justifyOf(parked!)).toBe("justify-start");
    for (const { label, box } of rowBoxes(container)) {
      expect(justifyOf(box), `the "${label}" row does not start at the column edge`).toBe("justify-start");
    }
  });
});

describe("the rail's ONE row declaration states the edge (cinatra#3514)", () => {
  it("names the alignment once, for the three modules that read it", async () => {
    const { RUN_PAGE_RAIL_ROW_CLASS } = await import("../run-step-rail-extra-entry");
    const { RUN_SURFACE_RAIL_ROW_CLASS, RUN_SURFACE_RAIL_ROW_CLOSED_CLASS } = await import(
      "../run-surface-rail"
    );
    // The row box the three run-page rail modules share states the edge itself,
    // so no row can inherit the shared Button's `justify-center` again.
    expect(tokens(RUN_PAGE_RAIL_ROW_CLASS).map(bare)).toContain("justify-start");
    expect(tokens(RUN_PAGE_RAIL_ROW_CLASS).map(bare)).not.toContain("justify-center");
    // ONE RAIL, ONE EDGE: the run-surface frame's rows already state the same
    // sentence, or the two compositions read at two edges again.
    for (const rowClass of [RUN_SURFACE_RAIL_ROW_CLASS, RUN_SURFACE_RAIL_ROW_CLOSED_CLASS]) {
      expect(tokens(rowClass).map(bare)).toContain("justify-start");
    }
  });
});
