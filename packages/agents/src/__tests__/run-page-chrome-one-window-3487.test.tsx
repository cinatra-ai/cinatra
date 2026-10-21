// @vitest-environment jsdom
/**
 * E3 (the run-page half) AND THE ACCEPTANCE ITEMS a–e OF cinatra#3487.
 *
 * The ruling of 2026-09-14: "On the run page the prompt window is part of the
 * run page's CHROME: one window owned by the page, shown only while the current
 * step's screen holds input or output the person can manipulate, never part of
 * that screen's component or markup — and it ALWAYS provides the assistant's
 * FULL capabilities, exactly as if no lifecycle screen were active; the screen's
 * context … is handed to the window in addition, never as a restriction."
 *
 * WHAT IS MEASURED HERE, and what is measured elsewhere:
 *   - the page draws exactly ONE window and it is a child of the page-chrome
 *     node (`data-run-window-host="page-chrome"`), never of a lifecycle card;
 *   - a step whose screen has nothing to manipulate draws NO window (item d);
 *   - a request typed into the page's window reaches the SCREEN's own road —
 *     the setup screen's field fill (a), the schedule screen's set (b), the
 *     review screen's one comment/change road (c) — and never a new endpoint;
 *   - the request the window sends carries no narrowing field, and its shape is
 *     the same on every screen as on a page with no screen at all (E4's client
 *     half; the tool manifest itself is compared on the server road by
 *     `src/lib/lifecycle/__tests__/run-window-full-capabilities-3487.test.ts`).
 *
 * The real screens are mounted — not doubles — because the thing under test is
 * that THEY no longer draw a window and that the page's one window still drives
 * their own actions.
 *
 * NO WAIVER, NO SKIP (E6).
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/run-page-chrome-one-window-3487.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";

/** The window's own send, captured from the field the one panel renders. */
const promptField = vi.hoisted(() => ({
  submit: null as null | ((value: string) => unknown),
  count: 0,
}));

/** Every payload the one client bridge was handed, in order. */
const sent = vi.hoisted(() => ({ turns: [] as Array<Record<string, unknown>> }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@cinatra-ai/sdk-ui", () => ({
  LoadingSpinner: () => null,
  PromptField: ({
    placeholder,
    onSubmit,
  }: {
    placeholder?: string;
    onSubmit?: (value: string) => unknown;
  }) => {
    promptField.submit = onSubmit ?? null;
    promptField.count += 1;
    return <div data-testid="run-window-prompt">{placeholder}</div>;
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

vi.mock("../run-window-actions", () => ({
  loadRunWindowConversation: vi.fn(async () => []),
  sendRunWindowTurn: vi.fn(async (input: Record<string, unknown>) => {
    sent.turns.push(input);
    return { ok: true, entries: [], fills: [], acted: false };
  }),
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
  setRunTrigger: vi.fn(async () => ({ ok: true })),
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
    runId: "run-3487",
  })),
  getAuditAvailabilityAction: vi.fn(async () => ({
    visible: false,
    promptCount: 0,
    skillCount: 0,
  })),
  getSkillsForAgentAction: vi.fn(async () => []),
  setRunTrigger: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../trigger-actions", () => ({
  setRunTrigger: vi.fn(async () => ({ ok: true })),
  cancelRunTrigger: vi.fn(async () => ({ ok: true })),
}));

/** A run parked on a gate with a form — the state the setup screen exists for. */
const selectedGate = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const OPEN_GATE = {
  schema: {
    type: "object",
    properties: { subject: { type: "string" } },
    required: ["subject"],
  },
  xRenderer: "@cinatra-ai/email-recipient-selection-agent:output",
  values: { campaignId: "c1", recipients: [] },
  reviewTaskId: "lg-run-3487",
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
    interruptContext: selectedGate.current,
    streamedText: "",
  }),
}));

import { RunPageChrome } from "../run-page-chrome";
import { sendRunWindowTurn } from "../run-window-actions";
import { approveReviewTask } from "../hitl-actions";
import { useRunWindowScreen } from "../run-window-screen-context";

beforeEach(() => {
  selectedGate.current = OPEN_GATE;
  cleanup();
  document.body.innerHTML = "";
  document.body.appendChild(document.createElement("main"));
  promptField.submit = null;
  promptField.count = 0;
  sent.turns = [];
  vi.mocked(sendRunWindowTurn).mockImplementation(async (input) => {
    sent.turns.push(input);
    return { ok: true, entries: [], fills: [], acted: false };
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ status: "pending_approval", inputParams: {}, suggestions: {} }),
    })),
  );
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 80));
  });
}

const windows = (root: ParentNode) =>
  root.querySelectorAll('[data-conformance-id="review-prompt-window"]');
const chromeNode = (root: ParentNode) =>
  root.querySelector('[data-run-window-host="page-chrome"]');

/** A screen double for the structural readings — what a screen publishes, exactly. */
function ScreenDouble(props: {
  surface: "run-page" | "step-by-step" | "schedule" | "armed-trigger" | "review";
  canManipulate: boolean;
  onSubmit?: (prompt: string) => Promise<void>;
}) {
  useRunWindowScreen({
    surface: props.surface,
    runId: "run-3487",
    canManipulate: props.canManipulate,
    storageKey: `key_${props.surface}`,
    conversation: [],
    promptPending: false,
    onSubmit: props.onSubmit ?? (async () => {}),
  });
  return <div data-testid={`screen-${props.surface}`} />;
}

describe("E3 — the run page draws exactly one window, in its own chrome", () => {
  it("one window, and it is a child of the page-chrome node", async () => {
    const { container } = render(
      <RunPageChrome>
        <ScreenDouble surface="run-page" canManipulate />
      </RunPageChrome>,
    );
    await settle();
    expect(windows(container)).toHaveLength(1);
    const chrome = chromeNode(container);
    expect(chrome).not.toBeNull();
    expect(windows(container)[0].parentElement).toBe(chrome);
    // …and never inside a lifecycle card.
    expect(windows(container)[0].closest("[data-lifecycle-card-host]")).toBeNull();
  });

  it("still one window when two screens are drawn under the same chrome", async () => {
    const { container } = render(
      <RunPageChrome>
        <ScreenDouble surface="run-page" canManipulate />
        <ScreenDouble surface="schedule" canManipulate />
      </RunPageChrome>,
    );
    await settle();
    expect(windows(container)).toHaveLength(1);
  });

  it("acceptance (d): a step whose screen has nothing to manipulate shows no window", async () => {
    const { container } = render(
      <RunPageChrome>
        <ScreenDouble surface="run-page" canManipulate={false} />
      </RunPageChrome>,
    );
    await settle();
    expect(windows(container)).toHaveLength(0);
    // The page's own node is still there — the column does not move.
    expect(chromeNode(container)).not.toBeNull();
  });

  it("no screen at all: the page draws no window", async () => {
    const { container } = render(
      <RunPageChrome>
        <div data-testid="a-step-with-no-window" />
      </RunPageChrome>,
    );
    await settle();
    expect(windows(container)).toHaveLength(0);
  });

  it("the placeholder follows the screen's surface through the page", async () => {
    const { container, rerender } = render(
      <RunPageChrome>
        <ScreenDouble surface="run-page" canManipulate />
      </RunPageChrome>,
    );
    await settle();
    expect(
      screen.queryByText("Ask Cinatra to fill the fields above, or ask about this step…"),
    ).not.toBeNull();
    rerender(
      <RunPageChrome>
        <ScreenDouble surface="schedule" canManipulate />
      </RunPageChrome>,
    );
    await settle();
    expect(
      screen.queryByText("Ask Cinatra to set the schedule above, or ask about it…"),
    ).not.toBeNull();
    expect(windows(container)).toHaveLength(1);
  });
});

describe("the real screens draw no window of their own, and the page draws theirs", () => {
  it("the setup screen under the chrome: one window, none inside the screen", async () => {
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    const { container } = render(
      <RunPageChrome>
        <AgenticRunPanel
          runId="run-3487"
          initialStatus="pending_approval"
          initialError={null}
          initialMessages={[]}
          agUiEnabled={true}
          templateId="tmpl-3487"
          canRespondInWindow={true}
        />
      </RunPageChrome>,
    );
    await settle();
    expect(windows(container)).toHaveLength(1);
    expect(windows(container)[0].parentElement).toBe(chromeNode(container));
  });

  it("the schedule screen under the chrome: one window, none inside the screen", async () => {
    const { TriggerScreenClient } = await import("../trigger-screen-client");
    const { container } = render(
      <RunPageChrome>
        <TriggerScreenClient
          agentId="cinatra-ai/email-recipient-selection-agent"
          instanceId="run-3487"
          templateId="tmpl-3487"
          runId="run-3487"
          canRespondInWindow={true}
          setupComplete={true}
        />
      </RunPageChrome>,
    );
    await settle();
    expect(windows(container)).toHaveLength(1);
    expect(windows(container)[0].parentElement).toBe(chromeNode(container));
  });

  it("the step-by-step screen under the chrome: one window, none inside the screen", async () => {
    const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
    const { container } = render(
      <RunPageChrome>
        <OrchestratorStepperPanel
          runId="run-3487"
          initialStatus="pending_approval"
          initialError={null}
          agUiEnabled={true}
          agentPackageName="cinatra-ai/email-recipient-selection-agent"
          inputParams={{}}
          stepperSteps={[
            {
              index: 1,
              stepNumber: 0,
              label: "Setup",
              xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
            },
          ]}
          agentId="cinatra-ai/email-recipient-selection-agent"
          lgThreadId={null}
          templateId="tmpl-3487"
          templateName="Recipient selection"
          canRespondInWindow={true}
        />
      </RunPageChrome>,
    );
    await settle();
    expect(windows(container)).toHaveLength(1);
    expect(windows(container)[0].parentElement).toBe(chromeNode(container));
  });
});

describe("acceptance (a)–(c) — the page's window drives the screen's own road", () => {
  it("(a) a request typed into the page's window fills the setup screen's fields", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: { body?: string }) => {
        const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
        calls.push({ url: String(url), body });
        return {
          ok: true,
          status: 200,
          json: async () => ({ suggestions: { subject: "Q3 re-engagement" } }),
        };
      }),
    );
    selectedGate.current = { ...OPEN_GATE, xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID, fieldName: "subject", currentValues: { subject: "" } };
    const { fieldRendererRegistry } = await import("../field-renderer-registry");
    fieldRendererRegistry.register({
      id: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
      priority: 100,
      condition: (_fieldName, schema) => (schema as { "x-renderer"?: string })["x-renderer"] === SCHEMA_FIELD_FALLBACK_RENDERER_ID,
      // Only the field-renderer port is a double. The real panel applies the
      // returned fill to its real staged buffer before passing this value.
      renderer: ({ value }) => <div data-testid="setup-buffer-value">{JSON.stringify(value)}</div>,
      drawsOwnSubmit: true,
    });
    vi.mocked(sendRunWindowTurn).mockImplementation(async (input) => {
      sent.turns.push(input);
      return { ok: true, entries: [], fills: [{ ref: "setup", values: { subject: "Q3 re-engagement" } }], acted: false };
    });
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(
      <RunPageChrome>
        <AgenticRunPanel
          runId="run-3487"
          initialStatus="pending_approval"
          initialError={null}
          initialMessages={[]}
          agUiEnabled={true}
          templateId="tmpl-3487"
          canRespondInWindow={true}
        />
      </RunPageChrome>,
    );
    await settle();
    await act(async () => {
      await promptField.submit?.("make the subject about Q3 re-engagement");
    });
    await settle();
    expect(sent.turns).toHaveLength(1);
    expect(sent.turns[0]).toMatchObject({ runId: "run-3487", surface: "run-page", prompt: "make the subject about Q3 re-engagement" });
    expect(calls.filter((c) => c.url.includes("/hitl-assist"))).toEqual([]);
    // The server's returned fill reaches the real setup form; it does not press.
    expect(vi.mocked(approveReviewTask)).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId("setup-buffer-value").textContent).toContain("Q3 re-engagement"));
  });

  it("(b) the window sets the schedule on the schedule screen", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: { body?: string }) => {
        const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
        calls.push({ url: String(url), body });
        return {
          ok: true,
          status: 200,
          json: async () => ({ suggestions: { timezone: "Europe/Berlin" } }),
        };
      }),
    );
    vi.mocked(sendRunWindowTurn).mockImplementation(async (input) => {
      sent.turns.push(input);
      return { ok: true, entries: [], fills: [{ ref: "schedule", values: { triggerType: "recurring", timezone: "Europe/Berlin" } }], acted: false };
    });
    const { TriggerScreenClient } = await import("../trigger-screen-client");
    render(
      <RunPageChrome>
        <TriggerScreenClient
          agentId="cinatra-ai/email-recipient-selection-agent"
          instanceId="run-3487"
          templateId="tmpl-3487"
          runId="run-3487"
          canRespondInWindow={true}
          setupComplete={true}
        />
      </RunPageChrome>,
    );
    await settle();
    await act(async () => {
      await promptField.submit?.("every weekday at 9, Berlin time");
    });
    await settle();
    expect(sent.turns).toHaveLength(1);
    expect(sent.turns[0]).toMatchObject({ runId: "run-3487", surface: "schedule", prompt: "every weekday at 9, Berlin time" });
    expect(calls.filter((c) => c.url.includes("/hitl-assist"))).toEqual([]);
    // The same actual form reflects the returned fill, without submitting.
    await waitFor(() => expect(screen.getAllByText("Europe/Berlin").length).toBeGreaterThan(0));
    const { setRunTrigger } = await import("../run-actions");
    expect(vi.mocked(setRunTrigger)).not.toHaveBeenCalled();
  });

  it("(c) a request for changes on the review screen reaches the one comment road", async () => {
    const onGateMoved = vi.fn();
    vi.mocked(sendRunWindowTurn).mockImplementation(async (input) => {
      sent.turns.push(input);
      return { ok: true, entries: [], fills: [], acted: true };
    });
    const { ReviewGatePromptWindow } = await import("../review-gate-card");
    const { container } = render(
      <RunPageChrome>
        <ReviewGatePromptWindow
          onGateMoved={onGateMoved}
          storageKey="cinatra_review_prompt_ref-3487"
          canComment={true}
          runId="run-3487"
          boundCardRef="ref-3487"
        />
      </RunPageChrome>,
    );
    await settle();
    // The review screen draws no window of its own; the page draws the one.
    expect(windows(container)).toHaveLength(1);
    expect(windows(container)[0].parentElement).toBe(chromeNode(container));
    await act(async () => {
      await promptField.submit?.("shorten the intro and drop the second CTA");
    });
    await settle();
    // The existing runtime turn performs the comment; its acted receipt re-reads
    // the gate. The retired direct submitAction road is not reinstated.
    expect(sent.turns).toHaveLength(1);
    expect(sent.turns[0]).toMatchObject({ runId: "run-3487", surface: "review", prompt: "shorten the intro and drop the second CTA", boundCard: { candidateRefs: ["ref-3487"], focusedRef: "ref-3487" } });
    expect(onGateMoved).toHaveBeenCalledTimes(1);
  });

  it("(c) a reader who may not comment is offered no window", async () => {
    const { ReviewGatePromptWindow } = await import("../review-gate-card");
    const { container } = render(
      <RunPageChrome>
        <ReviewGatePromptWindow
          onGateMoved={vi.fn()}
          storageKey="cinatra_review_prompt_ref-3487"
          canComment={false}
          runId="run-3487"
        />
      </RunPageChrome>,
    );
    await settle();
    expect(windows(container)).toHaveLength(0);
  });
});

describe("E4 (client half) — the request carries screen context and nothing narrower", () => {
  const SCREENS: Array<["run-page" | "step-by-step" | "schedule" | "review", string]> = [
    ["run-page", "setup"],
    ["step-by-step", "step-by-step"],
    ["schedule", "schedule"],
    ["review", "review"],
  ];

  async function payloadFor(surface: (typeof SCREENS)[number][0] | null) {
    cleanup();
    document.body.innerHTML = "";
    document.body.appendChild(document.createElement("main"));
    sent.turns = [];
    const { useRunWindowConversation } = await import("../use-run-window-conversation");
    function Screen() {
      const run = useRunWindowConversation({
        runId: "run-3487",
        surface: (surface ?? "run-page") as never,
      });
      useRunWindowScreen({
        surface: (surface ?? "run-page") as never,
        runId: "run-3487",
        canManipulate: true,
        storageKey: "k",
        conversation: run.entries,
        promptPending: run.pending,
        onSubmit: async (prompt, attachments) => {
          await run.send(prompt, attachments as readonly Record<string, unknown>[] | undefined);
        },
      });
      return null;
    }
    render(
      <RunPageChrome>{surface === null ? <div /> : <Screen />}</RunPageChrome>,
    );
    await settle();
    if (surface === null) return null;
    await act(async () => {
      await promptField.submit?.("what is the weather in Berlin today?");
    });
    await settle();
    return sent.turns[0] ?? null;
  }

  it("no screen: a page with no screen draws no window to type into", async () => {
    expect(await payloadFor(null)).toBeNull();
  });

  for (const [surface, label] of SCREENS) {
    it(`${label}: the payload names the screen and narrows nothing`, async () => {
      const payload = await payloadFor(surface);
      expect(payload, "the page's window sent a turn").not.toBeNull();
      // THE SCREEN'S CONTEXT IS ADDITIVE: the run it belongs to, which reading it
      // is, and the person's words. Nothing else — and nothing that could make
      // one screen's world smaller than another's.
      expect(Object.keys(payload!).sort()).toEqual(["prompt", "runId", "surface"]);
      expect(payload!.surface).toBe(surface);
      const narrowing = Object.keys(payload!).filter((k) =>
        /allow|filter|mode|tool|capabilit|deny|restrict|only|subset/i.test(k),
      );
      expect(narrowing).toEqual([]);
    });
  }

  it("every screen sends the SAME shape — only the screen-context field differs", async () => {
    const shapes: string[][] = [];
    for (const [surface] of SCREENS) {
      const payload = await payloadFor(surface);
      shapes.push(Object.keys(payload!).sort());
    }
    for (const shape of shapes) expect(shape).toEqual(shapes[0]);
  });
});
