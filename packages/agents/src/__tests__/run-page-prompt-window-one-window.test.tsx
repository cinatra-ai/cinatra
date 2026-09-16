// @vitest-environment jsdom
/**
 * ONE WINDOW ON THE RUN PAGE, NOT A PANEL ABOVE IT AND NOT A CONTROL ON ONE
 * READING (cinatra#3222).
 *
 * The ratified drawing, agent run and review surface:
 *
 *   §IX — "There is no panel above an empty exchange — the window is the field
 *   alone until the first message."
 *
 *   §X — "These are five readings of one window, never five windows. Outside
 *   the chat the window appears on five surfaces, and on every one of them it
 *   is the same window: the same panel above the field, the same field, the
 *   same send control, in the same place under the work it belongs to. One
 *   thing is read per surface — the sentence in the empty field, which names
 *   what the window does where it stands. Nothing else about the window
 *   changes from one reading to the next."
 *
 *   and its closing paragraph: "A reading is not a variant of the window: the
 *   panel, the field, the send control, the placement and the access rule are
 *   one across all five, and the exchange is one per run."
 *
 * Two departures were measured on a real run, and both break the one
 * sentence: the run page drew "No messages yet." above the empty window, and
 * a leading round control stood at the left edge of the field on the gate
 * reading that was absent on the schedule reading of the same run.
 *
 * THE INSTRUMENT. The real `PromptField` pulls browser-only dependencies jsdom
 * cannot load, so the stub below mirrors the field's OWN election of its
 * leading control — `prompt-field.tsx`: `hasLeftMenu = Boolean(autosave?.canToggle)
 * || Boolean(onAttachmentsSelected) || Boolean(remoteChat)` — and draws the
 * control, under its real accessible name, exactly when that election is
 * true. A source test at the end pins the election it mirrors, so the stub
 * cannot drift from the field.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/run-page-prompt-window-one-window.test.tsx
 */
import React from "react";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";
import { RUN_WINDOW_PLACEHOLDERS } from "../hitl-conversation-panel";

type CapturedFieldProps = {
  placeholder?: string;
  rows?: number;
  fieldClassName?: string;
  submitAriaLabel?: string;
  canSubmitEmpty?: boolean;
  onAttachmentsSelected?: unknown;
  autosave?: { canToggle?: boolean };
  remoteChat?: unknown;
};

const captured = vi.hoisted(() => ({ fields: [] as Array<Record<string, unknown>> }));

vi.mock("@cinatra-ai/sdk-ui", () => ({
  LoadingSpinner: () => null,
  PromptField: (props: Record<string, unknown>) => {
    captured.fields.push(props);
    const p = props as CapturedFieldProps;
    // The field's own election, mirrored (prompt-field.tsx `hasLeftMenu`).
    const hasLeftMenu =
      Boolean(p.autosave?.canToggle) || Boolean(p.onAttachmentsSelected) || Boolean(p.remoteChat);
    return (
      <div data-testid="run-window-prompt" data-left-padding={hasLeftMenu ? "pl-1" : "pl-4"}>
        {/* Stand-ins for the field's controls, under their real accessible
            names — plain spans, because the design-system lint gate forbids the
            bare element in favour of the shadcn Button. */}
        {hasLeftMenu ? <span role="button" aria-label="Prompt options" /> : null}
        <span>{p.placeholder}</span>
        <span role="button" aria-label={p.submitAriaLabel ?? "Send"} data-send-control="" />
      </div>
    );
  },
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/cinatra-toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
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
  usePathname: () => "/agents/cinatra-ai/email-recipient-selection-agent/run-3222",
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
  setRunTrigger: vi.fn(async () => ({ ok: true })),
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
vi.mock("../use-runtime-field-renderer-bindings", () => ({
  useRuntimeFieldRendererBindings: () => ({ bindings: {}, loading: false }),
}));
vi.mock("../server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({
    connectedApps: [],
    gmailAliases: [],
    runId: "run-3222",
  })),
  getAuditAvailabilityAction: vi.fn(async () => ({ visible: false, promptCount: 0, skillCount: 0 })),
  getSkillsForAgentAction: vi.fn(async () => []),
  setRunTrigger: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../trigger-actions", () => ({
  setRunTrigger: vi.fn(async () => ({ ok: true })),
  cancelRunTrigger: vi.fn(async () => ({ ok: true })),
}));

/** A run parked on a gate with a form — an EMPTY exchange, no messages yet. */
const OPEN_GATE = {
  schema: {
    type: "object",
    properties: { subject: { type: "string" } },
    required: ["subject"],
  },
  xRenderer: "@cinatra-ai/email-recipient-selection-agent:output",
  values: { campaignId: "c1", recipients: [] },
  reviewTaskId: "lg-run-3222",
};

vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: (_runId: string, opts?: { initialStatus?: string }) => ({
    status: opts?.initialStatus ?? "pending_approval",
    error: null,
    presentationHint: null,
    isLive: true,
    messages: [],
    dataPartFrames: [],
    lifecycleInterrupt: null,
    interruptContext: OPEN_GATE,
    streamedText: "",
  }),
}));

beforeEach(() => {
  cleanup();
  captured.fields.length = 0;
  document.body.innerHTML = "";
  document.body.appendChild(document.createElement("main"));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ status: "pending_approval", inputParams: {} }),
    })),
  );
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

type Reading = {
  name: string;
  surface: keyof typeof RUN_WINDOW_PLACEHOLDERS;
  /** §X's sentence for THIS reading, character for character from the drawing. */
  sentence: string;
  mount: () => Promise<React.ReactElement>;
};

/** The run surface's readings of the window, mounted the way their hosts mount them. */
const READINGS: Reading[] = [
  {
    name: "the gate reading (the run page)",
    surface: "run-page",
    sentence: "Ask Cinatra to fill the fields above, or ask about this step…",
    mount: async () => {
      const { AgenticRunPanel } = await import("../agentic-run-panel");
      return (
        <AgenticRunPanel
          runId="run-3222"
          initialStatus="pending_approval"
          initialError={null}
          initialMessages={[]}
          agUiEnabled={true}
          templateId="tmpl-3222"
          canRespondInWindow={true}
        />
      );
    },
  },
  {
    name: "the step reading (the step-by-step screen)",
    surface: "step-by-step",
    sentence: "Ask Cinatra to fill this step's fields, or ask about the run…",
    mount: async () => {
      const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
      return (
        <OrchestratorStepperPanel
          runId="run-3222"
          initialStatus="pending_approval"
          initialError={null}
          agUiEnabled={true}
          agentPackageName="cinatra-ai/email-recipient-selection-agent"
          inputParams={{}}
          stepperSteps={[
            { index: 1, stepNumber: 0, label: "Setup", xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID },
          ]}
          agentId="cinatra-ai/email-recipient-selection-agent"
          lgThreadId={null}
          templateId="tmpl-3222"
          templateName="Recipient selection"
          canRespondInWindow={true}
        />
      );
    },
  },
  {
    name: "the schedule reading (the scheduling step)",
    surface: "schedule",
    sentence: "Ask Cinatra to set the schedule above, or ask about it…",
    mount: async () => {
      const { TriggerScreenClient } = await import("../trigger-screen-client");
      return (
        <TriggerScreenClient
          agentId="cinatra-ai/email-recipient-selection-agent"
          instanceId="run-3222"
          templateId="tmpl-3222"
          runId="run-3222"
          canRespondInWindow={true}
          setupComplete={true}
        />
      );
    },
  },
  {
    name: "the armed-trigger reading (the schedule tab and the rail's schedule step)",
    surface: "armed-trigger",
    sentence: "Ask Cinatra to change this schedule, or ask about it…",
    mount: async () => {
      const { SchedulePromptWindow } = await import("../schedule-prompt-window");
      return <SchedulePromptWindow templateId="tmpl-3222" runId="run-3222" canRespondInWindow={true} />;
    },
  },
  {
    name: "the review reading (the review page)",
    surface: "review",
    sentence: "Ask Cinatra about this review, or ask for changes to the work…",
    mount: async () => {
      const { ReviewGatePromptWindow } = await import("../review-gate-card");
      return (
        <ReviewGatePromptWindow
          submitAction={vi.fn(async () => ({ ok: true }) as never)}
          storageKey="cinatra_review_window_run-3222"
          canComment={true}
          runId="run-3222"
          boundCardRef="gate-ref-3222"
        />
      );
    },
  },
];

async function mountReading(reading: Reading) {
  render(await reading.mount());
  await waitFor(() => expect(screen.getByTestId("run-window-prompt")).not.toBeNull());
  return screen.getByTestId("run-window-prompt");
}

// ---------------------------------------------------------------------------
// Item 1 — no placeholder line above the empty field.
// ---------------------------------------------------------------------------
describe("no placeholder line is drawn above the window's empty field (item 1)", () => {
  it("draws neither 'No messages yet.' nor 'Waiting to start...' above the window on the gate reading", async () => {
    await mountReading(READINGS[0]!);
    expect(document.body.textContent).not.toMatch(/No messages yet/i);
    expect(document.body.textContent).not.toMatch(/Waiting to start/i);
  });

  it("draws no 'Waiting to start...' line on a queued run either", async () => {
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(
      <AgenticRunPanel
        runId="run-3222"
        initialStatus="queued"
        initialError={null}
        initialMessages={[]}
        agUiEnabled={true}
        templateId="tmpl-3222"
        canRespondInWindow={true}
      />,
    );
    await waitFor(() => expect(document.querySelector("[data-run-prompt-window-mount]")).not.toBeNull());
    expect(document.body.textContent).not.toMatch(/Waiting to start/i);
    expect(document.body.textContent).not.toMatch(/No messages yet/i);
  });
});

// ---------------------------------------------------------------------------
// Item 2 — no leading control on any reading.
// ---------------------------------------------------------------------------
describe("the window draws no leading control on any reading (item 2)", () => {
  for (const reading of READINGS) {
    it(`draws no 'Prompt options' control on ${reading.name}`, async () => {
      const window = await mountReading(reading);
      expect(window.querySelector('[aria-label="Prompt options"]')).toBeNull();
      expect(screen.queryByLabelText("Prompt options")).toBeNull();
    });
  }
});

// ---------------------------------------------------------------------------
// Items 3 and 4 — identical composition; only the sentence differs, and each
// sentence is pinned.
// ---------------------------------------------------------------------------
describe("the window's composition is identical across readings (items 3 and 4)", () => {
  it("composes the same leading control, left padding, send control and gating on every reading", async () => {
    const compositions: Array<Record<string, unknown>> = [];
    const sentences: string[] = [];
    for (const reading of READINGS) {
      cleanup();
      captured.fields.length = 0;
      document.body.innerHTML = "";
      document.body.appendChild(document.createElement("main"));
      const window = await mountReading(reading);
      const props = captured.fields[captured.fields.length - 1] as CapturedFieldProps;
      compositions.push({
        leadingControl: window.querySelector('[aria-label="Prompt options"]') !== null,
        leftPadding: window.getAttribute("data-left-padding"),
        sendControl: window.querySelector("[data-send-control]")?.getAttribute("aria-label") ?? null,
        sendControlIsLast: window.lastElementChild?.hasAttribute("data-send-control") ?? false,
        attachments: props.onAttachmentsSelected === undefined,
        rows: props.rows,
        fieldClassName: props.fieldClassName,
        canSubmitEmpty: props.canSubmitEmpty,
        // The panel above the field opens only once there is something in it —
        // the same gate on every reading (its source is pinned below).
        panelOpen: document.querySelector("[data-conv-open]")?.getAttribute("data-conv-open"),
      });
      sentences.push(window.textContent ?? "");
    }
    for (const composition of compositions.slice(1)) {
      expect(composition).toEqual(compositions[0]);
    }
    expect(compositions[0]).toMatchObject({
      leadingControl: false,
      leftPadding: "pl-4",
      sendControl: "Apply AI suggestion",
      attachments: true,
      panelOpen: "false",
    });
    // Only the sentence differs — and it does differ, reading by reading.
    expect(new Set(sentences).size).toBe(READINGS.length);
  });

  for (const reading of READINGS) {
    it(`reads exactly the drawing's sentence on ${reading.name}`, async () => {
      const window = await mountReading(reading);
      expect(window.textContent).toBe(reading.sentence);
      expect(RUN_WINDOW_PLACEHOLDERS[reading.surface]).toBe(reading.sentence);
    });
  }

  it("mounts every one of the drawing's five readings, so five sentences stay five", () => {
    expect([...READINGS.map((r) => r.surface)].sort()).toEqual(
      Object.keys(RUN_WINDOW_PLACEHOLDERS).sort(),
    );
    expect(new Set(Object.values(RUN_WINDOW_PLACEHOLDERS)).size).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// The sources the DOM readings above stand on.
// ---------------------------------------------------------------------------
function repoFile(relative: string): string {
  const cwd = process.cwd();
  for (const candidate of [`${cwd}/${relative}`, `${cwd}/../../${relative}`]) {
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
  }
  throw new Error(`file not found: ${relative}`);
}

describe("the sources the readings stand on", () => {
  it("mirrors the field's own election of its leading control, and the padding that follows it", () => {
    const field = repoFile("packages/sdk-ui/src/prompt-field.tsx");
    expect(field).toMatch(
      /const hasLeftMenu =\s*Boolean\(autosave\?\.canToggle\) \|\| Boolean\(onAttachmentsSelected\) \|\| Boolean\(remoteChat\);/,
    );
    expect(field).toContain('hasLeftMenu ? "pl-1" : "pl-4"');
    expect(field).toContain('aria-label="Prompt options"');
  });

  it("has no run-page caller opting the window into the leading control", () => {
    for (const relative of [
      "packages/agents/src/agentic-run-panel.tsx",
      "packages/agents/src/orchestrator-stepper-panel.tsx",
    ]) {
      expect(repoFile(relative)).not.toContain("enableAttachments=");
    }
  });

  it("gates the panel above the field on the exchange having something in it", () => {
    expect(repoFile("packages/agents/src/hitl-conversation-panel.tsx")).toContain(
      "(conversation.length > 0 || promptPending) && convOpen",
    );
  });
});
