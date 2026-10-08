// @vitest-environment jsdom
/** cinatra#3806: names of the actual run rail controls, without changing their drawing. */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { OrchestratorStepperPanel } from "../orchestrator-stepper-panel";
import { RunStepRailPanel } from "../run-step-rail-panel";
import { RailExtraEntry, RunStepSelectionProvider } from "../run-step-rail-extra-entry";
import { RunSurfaceRailRow } from "../run-surface-rail";
import { Stepper, StepperItem } from "@/components/reui/stepper";
import { buildRunStepRail, type RunStepRailEntry } from "../run-step-rail";

const stream = vi.hoisted(() => ({ interruptContext: null as unknown }));

vi.mock("lucide-react", () => {
  const StubIcon: React.FC = () => null;
  return new Proxy({} as Record<string, React.FC>, {
    get: (_t, prop) => {
      if (prop === "__esModule") return true;
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return undefined;
      return StubIcon;
    },
    has: () => true,
    ownKeys: () => ["default"],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: StubIcon }),
  });
});
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/cinatra-toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
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
  usePathname: () => "/agents/cinatra-ai/email-outreach-agent/run-3221",
}));
vi.mock("@cinatra-ai/sdk-ui", () => ({
  LoadingSpinner: () => null,
  PromptField: ({ placeholder }: { placeholder?: string }) => (
    <div data-testid="run-window-prompt">{placeholder}</div>
  ),
}));
vi.mock("../run-window-actions", () => ({
  loadRunWindowConversation: vi.fn(async () => []),
  sendRunWindowTurn: vi.fn(async () => ({ ok: true, entries: [] })),
}));
vi.mock("../hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => ({ ok: true })),
  rejectReviewTask: vi.fn(async () => undefined),
}));
vi.mock("../a2a-actions", () => ({ getAgentBuilderTask: vi.fn(async () => null) }));
vi.mock("../agent-ui-override-registry", () => ({
  agentUIOverrideRegistry: { resolve: () => null },
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
  confirmRunRecommendationAction: vi.fn(async () => ({ ok: true })),
  skipRunRecommendationAction: vi.fn(async () => ({ ok: true })),
  decideRunRecommendationAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../run-name-actions", () => ({
  ensureOrCheckRunNameAction: vi.fn(async () => ({ ok: true, title: "Run 1" })),
}));
vi.mock("../server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({
    connectedApps: [],
    gmailAliases: [],
    runId: "run-3221",
  })),
  getAuditAvailabilityAction: vi.fn(async () => ({ visible: false, promptCount: 0, skillCount: 0 })),
  getSkillsForAgentAction: vi.fn(async () => []),
  setRunTrigger: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../use-runtime-field-renderer-bindings", () => ({
  useRuntimeFieldRendererBindings: () => ({ bindings: {}, loading: false }),
}));
vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: (_runId: string, opts?: { initialStatus?: string }) => ({
    status: opts?.initialStatus ?? "completed",
    interruptContext: stream.interruptContext,
    messages: [],
    streamedText: "",
    presentationHint: null,
    dataPartFrames: [],
    lifecycleInterrupt: null,
    isLive: true,
    error: null,
  }),
}));

type PanelProps = import("../orchestrator-stepper-panel").OrchestratorStepperPanelProps;
const steps: PanelProps["stepperSteps"] = [
  { index: 1, stepNumber: 3, label: "Select blog idea", xRenderer: "names:idea" },
  { index: 2, stepNumber: 7, label: "Pick the brand voice", xRenderer: "names:voice" },
  { index: 3, stepNumber: 12, label: "Review blog draft", xRenderer: "names:draft" },
];
function props(initialStatus: string): PanelProps {
  return { runId: "run-3806", initialStatus, initialError: null, agUiEnabled: false,
    agentPackageName: "@cinatra-ai/blog-pipeline-agent", inputParams: {}, stepperSteps: steps,
    agentId: "cinatra-ai/blog-pipeline-agent", lgThreadId: null, templateId: "names-3806",
    templateName: "Blog Pipeline", railExtras: [] };
}
function railEntries(status: RunStepRailEntry["status"]): RunStepRailEntry[] {
  return steps.map((step, i) => ({ key: `step:${i}`, ordinal: i + 1, kind: "step",
    label: step.label, status, sources: ["template"] }));
}
function extra(entry: RunStepRailEntry, framed: boolean) {
  const row = <Stepper defaultValue={1} orientation="vertical"><StepperItem step={1} completed={entry.status === "resolved" || entry.status === "completed"}>
    <RailExtraEntry entry={entry} reviewHrefBase="/agents/v/p/run/review" displayStep={5} />
  </StepperItem></Stepper>;
  return render(framed ? <RunStepSelectionProvider value={{ selected: "detail", select: vi.fn() }}>{row}</RunStepSelectionProvider> : row);
}
function gate(disposition: string | null, status: RunStepRailEntry["status"] = "resolved"): RunStepRailEntry {
  return { key: "gate:names", ordinal: 5, kind: "gate", label: "Review", status, sources: ["gate"],
    gate: { gateId: "gate-names", reviewTaskId: "review-names", disposition, resolved: status === "resolved" } };
}
beforeEach(() => {
  stream.interruptContext = null;
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ status: "running", inputParams: {} }) })));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("run rail accessible names (cinatra#3806)", () => {
  it.each(["running", "completed"])("the live %s rail separates display numbers from labels", (status) => {
    const view = render(<OrchestratorStepperPanel {...props(status)} />);
    const rail = within(view.container.querySelector<HTMLElement>("[data-run-step-rail]")!);
    expect(rail.getAllByRole("tab")).toHaveLength(steps.length);
    for (const step of steps) expect(rail.getByRole("tab", { name: `${step.index} ${step.label}` })).toBeDefined();
  });
  it("a paused live rail retains the spoken numeral when its circle draws Pause", async () => {
    const view = render(<OrchestratorStepperPanel {...props("running")} />);
    fireEvent.click(view.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(view.queryByRole("button", { name: "Pause" })).toBeNull());
    view.rerender(<OrchestratorStepperPanel {...props("stopped")} />);
    await waitFor(() => expect(view.getByRole("button", { name: "Resume" })).toBeDefined());
    const railNode = view.container.querySelector<HTMLElement>("[data-run-step-rail]")!;
    expect(railNode.querySelector("[data-slot=stepper-indicator]")!.textContent).toBe("");
    for (const step of steps) expect(within(railNode).getByRole("tab", { name: `${step.index} ${step.label}` })).toBeDefined();
  });
  it.each(["pending", "completed"] as const)("the server %s rail speaks its displayed offset numbers", (status) => {
    const view = render(<RunStepRailPanel entries={railEntries(status)} activeOrdinal={1} stepOffset={2} reviewHrefBase="" />);
    const rail = within(view.container.querySelector<HTMLElement>("[data-run-step-rail]")!);
    expect(rail.getAllByRole("tab")).toHaveLength(steps.length);
    for (const step of steps) expect(rail.getByRole("tab", { name: `${step.index + 2} ${step.label}` })).toBeDefined();
  });
  it.each([false, true])("the record row retains its numeral when settled=%s", (settled) => {
    const view = render(<RunSurfaceRailRow selectionKey="made" label="What this run made" displayStep={7}
      conformanceId="run-made-step" action="open-made-step" reached settled={settled} />);
    expect(view.getByRole("button", { name: "7 What this run made" })).toBeDefined();
  });
  it.each([false, true])("a trailing completed step retains its numeral with frame=%s", (framed) => {
    const view = extra({ key: "step:extra", ordinal: 5, kind: "step", label: "Finish the post", status: "completed", sources: ["template"] }, framed);
    expect(view.getByRole("tab", { name: "5 Finish the post" })).toBeDefined();
  });
  it.each([false, true].flatMap((framed) =>
    [undefined, "Campaign draft"].flatMap((artifactName) => [
      [framed, artifactName, "approve", "Continued"],
      [framed, artifactName, "reject", "Changes requested"],
      [framed, artifactName, "changes_requested", "Changes requested"],
      [framed, artifactName, null, "resolved"],
    ] as const),
  ))("a settled review names its actual complete drawn title (frame=%s, artifact=%s, disposition=%s)", (framed, artifactName, disposition, word) => {
    const entry = buildRunStepRail({ gates: [{ gateId: "gate-names", reviewTaskId: "review-names", status: "resolved", disposition, artifactName, createdAt: "2026-10-07T00:00:00Z" }] }).entries[0];
    const label = artifactName ? `Review · ${artifactName}` : "Review";
    expect(entry.label).toBe(label);
    const title = `${label} · ${word.toLowerCase()}`;
    const view = extra(entry, framed);
    const row = view.getByRole(framed ? "tab" : "link", { name: title });
    expect(row.textContent).toBe(title);
    const wrapper = row.closest("[data-rail-gate-settlement]");
    expect(wrapper?.getAttribute("data-rail-gate-settlement")).toBe(word);
    expect(wrapper?.textContent).toBe(title);
    expect(wrapper?.querySelector("[data-slot=stepper-title]")?.textContent).toBe(title);
  });
  it.each([false, true])("an audit keeps its status as a separate word with frame=%s", (framed) => {
    const view = extra({ key: "verification:names", ordinal: 6, kind: "verification", label: "Audit", status: "completed", sources: ["verification"],
      verification: { gateId: "gate-names", reviewTaskId: "review-names", outcome: "verified" } }, framed);
    expect(view.getByRole(framed ? "tab" : "link", { name: "Audit verified" }).textContent).toBe("Auditverified");
  });
  it("a pending review keeps its existing label without a fabricated numeral or outcome", () => {
    const view = extra(gate(null, "pending"), true);
    expect(view.getByRole("tab", { name: "Review" }).getAttribute("aria-label")).toBeNull();
  });
  it("a glyph-only recommendation receives no invented display number", () => {
    const view = render(<RunSurfaceRailRow selectionKey="recommendation" label="Recommended skills" displayStep={9}
      conformanceId="run-recommendation-step" action="open-recommendation" reached />);
    expect(view.getByRole("button", { name: "Recommended skills" }).getAttribute("aria-label")).toBeNull();
  });
  it("a lifecycle row retains its reason in the accessible name", () => {
    const view = extra({ key: "lifecycle:names", ordinal: 6, kind: "lifecycleDecision", label: "Review skipped", status: "skipped", sources: ["lifecycleDecision"],
      lifecycleDecision: { eventId: "event-names", artifactId: "artifact-names", outcome: "skipped", decidedBy: "org-bound", latticeOutcome: "skip", reason: "The org policy skips this review." } }, false);
    const row = view.getByRole("tab", { name: /The org policy skips this review/ });
    expect(row.getAttribute("aria-label")).toBeNull();
  });
});
