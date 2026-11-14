// @vitest-environment jsdom
/**
 * THE LIVE PAGE OWES THE SAME ONE WINDOW A REOPENED PAGE DRAWS (cinatra#3487).
 *
 * Picture round 6 of this pull request counted this defect on a development
 * boot: parked at its artifact review gate, the LIVE run page — polled in place
 * every ten seconds for minutes and never reloaded since the run was dispatched
 * on that same page — drew ZERO review prompt windows while the decision floor
 * was offered in the run detail, and the SAME run state on a REOPENED page drew
 * exactly one, in the page chrome.
 *
 * THE DRAWING MAKES NO SUCH DISTINCTION. `specs/app-artifact-review.html` §I.3:
 * a review that pauses the run is an entry on the rail and selecting it opens
 * the review in place, in the run detail, with the same gate header, target,
 * decision bar and prompt window the gate draws anywhere else; §VI: beneath the
 * decision bar the run detail carries a conversational prompt window. No
 * sentence makes the window's presence depend on how the reader arrived at the
 * gate, so a live transition into the gate owes the same one window.
 *
 * WHY THE LIVE PAGE DREW NONE. At a marked review gate the run panel publishes
 * a registration whose `canManipulate` is deliberately false
 * (`agentic-run-panel.tsx`, the sixth conjunct of its registration) while the
 * review card it mounts as its OWN CHILD publishes the server's yes
 * (`review-gate-card.tsx`, the window component the card renders). React runs a
 * child's passive effect before its parent's, so in one commit the card
 * published a record that lends something and the panel published nothing-to-
 * manipulate over it, and the page — which draws exactly one record — drew no
 * window. The panel re-publishes on its own poll tick, so the false record was
 * reclaimed every few seconds: exactly the round's reading.
 *
 * WHAT IS MEASURED HERE. The live transition is driven the way the live page
 * reaches the gate — the SAME mounted tree, no remount and no fresh render
 * call, the polled run state advancing from the setup gate into the marked
 * artifact review gate — and the page is read for the one window and for the
 * places the ruling forbids it.
 *
 * NO WAIVER, NO SKIP.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run --maxWorkers=2 \
 *     src/__tests__/run-page-window-follows-the-live-gate-3487.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

import type { LifecycleCardState } from "@cinatra-ai/agent-ui-protocol/renderable-views";

import {
  ARTIFACT_REVIEW_REDIRECT_RENDERER_ID,
  SCHEMA_FIELD_FALLBACK_RENDERER_ID,
} from "../agent-builder-ids";

/** The run this file drives, and the gate it is standing at right now. */
const live = vi.hoisted(() => ({
  phase: "setup" as "setup" | "review",
  canComment: true,
  status: "pending_approval" as string,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

// The window's field pulls browser-only deps jsdom cannot load. Stubbed to a
// plain element carrying the placeholder as text and a send marker, so what is
// read is real DOM rather than the stub's absence.
vi.mock("@cinatra-ai/sdk-ui", () => ({
  LoadingSpinner: () => null,
  PromptField: ({ placeholder }: { placeholder?: string }) => (
    <div data-testid="run-window-prompt">
      {placeholder}
      <span data-testid="run-window-send" />
    </div>
  ),
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
    runId: "run-3487-live",
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

// The page under test is the POLLED one: the stream is off, so the run's own
// poll owns the status and the gate exactly as a live page with no SSE does.
vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: () => ({
    status: null,
    error: null,
    presentationHint: null,
    isLive: false,
    messages: [],
    dataPartFrames: [],
    lifecycleInterrupt: null,
    interruptContext: null,
    streamedText: "",
  }),
}));

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { RunPageChrome } from "../run-page-chrome";
import { ReviewGateCard } from "../review-gate-card";
import { useRunWindowScreen } from "../run-window-screen-context";

const RUN_ID = "run-3487-live";
const TEMPLATE_ID = "tmpl-3487";
/** The server-minted card ref a marked review gate carries. */
const GATE_REF = "ref-3487-live";

/** The setup gate the run stands at before it parks on its review. */
const SETUP_GATE = {
  xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
  childRunId: null,
  reviewTaskId: `setup-${RUN_ID}`,
  inputSchema: {
    type: "object",
    properties: { subject: { type: "string" } },
    required: ["subject"],
  },
  currentValues: {},
};

/** The MARKED artifact review gate the same run parks on, in place. */
const REVIEW_GATE = {
  xRenderer: ARTIFACT_REVIEW_REDIRECT_RENDERER_ID,
  childRunId: null,
  reviewTaskId: "rt-3487-live",
  inputSchema: {},
  currentValues: { lifecycleCardRef: GATE_REF },
};

function runPollBody(): Record<string, unknown> {
  const parked = live.status === "pending_approval";
  return {
    status: live.status,
    error: null,
    startedAt: "2026-09-18T10:00:00.000Z",
    completedAt: live.status === "completed" ? "2026-09-18T10:20:00.000Z" : null,
    messages: [],
    hitlContext: parked ? (live.phase === "review" ? REVIEW_GATE : SETUP_GATE) : null,
    lifecycleMoment: null,
  };
}

function cardState(): LifecycleCardState {
  return { state: "pending", canDecide: true, canComment: live.canComment };
}

/** ONE road for both readers: the run's own poll, and the card's resolve. */
function installFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(
        typeof input === "string" ? input : (input as { url?: string })?.url ?? input,
      );
      const payload = url.includes("/api/agents/runs/")
        ? runPollBody()
        : { kind: "artifact_review_gate", state: cardState(), body: null };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  cleanup();
  document.body.innerHTML = "";
  document.body.appendChild(document.createElement("main"));
  live.phase = "setup";
  live.canComment = true;
  live.status = "pending_approval";
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  installFetch();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  // The suite installs its own `fetch`; the tier's other files get theirs back.
  globalThis.fetch = realFetch;
  try {
    window.localStorage.clear();
  } catch {
    /* jsdom without storage — nothing to clear. */
  }
});

/**
 * LET THE PAGE SETTLE THE WAY A LIVE PAGE DOES: the poll's own interval fires
 * and its answers are applied, on the tree that is already mounted.
 */
async function poll(ms = 6000): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/**
 * THE WINDOW'S OWN INVITATION, keyed by surface in `hitl-conversation-panel.tsx`
 * (:28 the run page's, :36 the review's). Reading it is how a case says WHICH
 * registration the page drew, not merely that it drew one.
 */
const REVIEW_INVITATION = "Ask Cinatra about this review";
const SETUP_INVITATION = "Ask Cinatra to fill the fields above";

const windows = (root: ParentNode) =>
  root.querySelectorAll('[data-conformance-id="review-prompt-window"]');
const chromeNode = (root: ParentNode) =>
  root.querySelector('[data-run-window-host="page-chrome"]');

/**
 * THE PLACES THE RULING FORBIDS THE WINDOW: every lifecycle card root, and
 * every step-screen root the run page draws. Named by their own markers so an
 * absence is read from the place it is absent from.
 */
const SCREEN_AND_CARD_ROOTS = [
  "[data-lifecycle-card-host]",
  "[data-run-review-slot]",
  "[data-run-progress-panel]",
  "[data-run-step-rail]",
  "[data-run-surface-rail-step]",
];

function anchorsInsideScreensOrCards(root: ParentNode): number {
  let count = 0;
  for (const selector of SCREEN_AND_CARD_ROOTS) {
    for (const host of root.querySelectorAll(selector)) {
      count += host.querySelectorAll('[data-conformance-id="review-prompt-window"]').length;
    }
  }
  return count;
}

/** The run page, composed as the page composes it: the chrome over the panel. */
async function renderLiveRunPage() {
  const { AgenticRunPanel } = await import("../agentic-run-panel");
  return render(
    <RunPageChrome>
      <AgenticRunPanel
        runId={RUN_ID}
        initialStatus="pending_approval"
        initialError={null}
        initialMessages={[]}
        agUiEnabled={false}
        templateId={TEMPLATE_ID}
        canRespondInWindow={true}
      />
    </RunPageChrome>,
  );
}

describe("(i) the live transition into the marked review gate", () => {
  it("draws exactly one window in the page chrome after the run parks on its review, with no remount", async () => {
    const { container } = await renderLiveRunPage();
    await poll();

    // The page is standing at its setup step, on its own live tree.
    expect(windows(container)).toHaveLength(1);
    const treeBefore = chromeNode(container);
    expect(treeBefore).not.toBeNull();

    // THE ADVANCE. The same mounted tree; nothing is rendered afresh and
    // nothing remounts — only the polled run state moves on, which is how the
    // live page reaches the gate.
    live.phase = "review";
    await poll();
    await poll();

    // The gate really is drawn in place: the card the panel mounts is on the page.
    expect(container.querySelector("[data-lifecycle-card-host]")).not.toBeNull();

    // AND THE ONE WINDOW THE DRAWING OWES IT.
    expect(windows(container)).toHaveLength(1);
    const chrome = chromeNode(container);
    expect(chrome).not.toBeNull();
    // NO REMOUNT: the host node the window hangs in is the very node the page
    // already had before the run parked on its gate.
    expect(chrome).toBe(treeBefore);
    expect(windows(container)[0].closest('[data-run-window-host="page-chrome"]')).toBe(chrome);
    // AND IT IS THE REVIEW'S OWN WINDOW, not a setup window left standing: the
    // invitation is keyed by the drawn record's surface, so the sentence the
    // window carries names which registration the page is drawing.
    expect(windows(container)[0].textContent).toContain(REVIEW_INVITATION);
    expect(windows(container)[0].textContent).not.toContain(SETUP_INVITATION);
    expect(anchorsInsideScreensOrCards(container)).toBe(0);
    // It is the PAGE's node, never the card's.
    expect(windows(container)[0].closest("[data-lifecycle-card-host]")).toBeNull();

    // AND IT SURVIVES THE PANEL'S NEXT POLL TICK. The panel re-publishes its own
    // nothing-to-manipulate reading every few seconds; under arrival order that
    // is where the page lost the window again, which is why the round read zero
    // for minutes rather than once.
    await poll();
    expect(windows(container)).toHaveLength(1);
    expect(chromeNode(container)).toBe(treeBefore);
    expect(windows(container)[0].textContent).toContain(REVIEW_INVITATION);
    expect(anchorsInsideScreensOrCards(container)).toBe(0);
  });
});

describe("(ii) a nested pair under one chrome", () => {
  /** A screen double for the structural reading — what a screen publishes, exactly. */
  function ScreenDouble(props: {
    surface: "run-page" | "step-by-step" | "schedule" | "armed-trigger" | "review";
    canManipulate: boolean;
    children?: React.ReactNode;
  }) {
    useRunWindowScreen({
      surface: props.surface,
      runId: RUN_ID,
      canManipulate: props.canManipulate,
      storageKey: `key_${props.surface}`,
      conversation: [],
      promptPending: false,
      onSubmit: async () => {},
    });
    return <div data-testid={`screen-${props.surface}`}>{props.children}</div>;
  }

  it("an outer screen that lends nothing leaves the page drawing the inner screen's window", async () => {
    const { container } = render(
      <RunPageChrome>
        <ScreenDouble surface="run-page" canManipulate={false}>
          <ScreenDouble surface="review" canManipulate={true} />
        </ScreenDouble>
      </RunPageChrome>,
    );
    await poll(200);

    expect(windows(container)).toHaveLength(1);
    expect(windows(container)[0].closest('[data-run-window-host="page-chrome"]')).toBe(
      chromeNode(container),
    );
  });
});

describe("(iii) the setup step on the same live page, before the advance", () => {
  it("one window in the page chrome, none inside any screen or card", async () => {
    const { container } = await renderLiveRunPage();
    await poll();

    expect(windows(container)).toHaveLength(1);
    expect(windows(container)[0].closest('[data-run-window-host="page-chrome"]')).toBe(
      chromeNode(container),
    );
    expect(anchorsInsideScreensOrCards(container)).toBe(0);
  });
});

describe("(iv) a reader who may not comment, at the same parked gate", () => {
  it("draws no window at all", async () => {
    live.canComment = false;
    const { container } = await renderLiveRunPage();
    await poll();
    live.phase = "review";
    await poll();
    await poll();

    expect(container.querySelector("[data-lifecycle-card-host]")).not.toBeNull();
    expect(windows(container)).toHaveLength(0);
    expect(anchorsInsideScreensOrCards(container)).toBe(0);
  });
});

describe("(v) a conversation host drawing the same card", () => {
  it("draws no window anywhere on the page", async () => {
    const { container } = render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <LifecycleCardSurfaceProvider host="run_card">
          <ReviewGateCard
            view={{ viewType: "artifact_review_gate", schemaVersion: 1, ref: GATE_REF }}
            runId={RUN_ID}
          />
        </LifecycleCardSurfaceProvider>
      </LifecycleCardSurfaceProvider>,
    );
    await poll(500);

    expect(container.querySelector("[data-lifecycle-card-host]")).not.toBeNull();
    expect(windows(container)).toHaveLength(0);
    expect(container.querySelectorAll('[data-testid="run-window-prompt"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-testid="run-window-send"]')).toHaveLength(0);
  });
});

describe("(vi) the finished run, with the record step selected", () => {
  it("draws no window anchor inside any screen or card root", async () => {
    live.status = "completed";
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    const { container } = render(
      <RunPageChrome>
        <AgenticRunPanel
          runId={RUN_ID}
          initialStatus="completed"
          initialError={null}
          initialMessages={[]}
          agUiEnabled={false}
          templateId={TEMPLATE_ID}
          canRespondInWindow={true}
        />
      </RunPageChrome>,
    );
    await poll();

    // NOT AN EMPTY ROOM: the finished run really did draw a screen or card root
    // for the reading to be taken inside of.
    expect(container.querySelector(SCREEN_AND_CARD_ROOTS.join(","))).not.toBeNull();
    expect(anchorsInsideScreensOrCards(container)).toBe(0);
  });
});

/**
 * THE CONTRACT, STATED ONCE OVER EVERY REGISTRANT THE RUN PAGE CAN CARRY UNDER
 * ONE CHROME. The census is re-taken from the source at this head with
 *   grep -rn -a 'useRunWindowScreen' packages/agents/src/
 * (plain `grep` treats `review-gate-card.tsx` as binary and skips it, so `-a`
 * is what makes the census complete). It answers with FIVE registrants — one
 * more than the task's four: `schedule-prompt-window.tsx` publishes the armed
 * schedule step's own reading, and it is named here with the rest.
 */
const REGISTRANTS: Array<{
  name: string;
  surface: "run-page" | "step-by-step" | "schedule" | "armed-trigger" | "review";
}> = [
  { name: "agentic-run-panel.tsx (the run page's own reading)", surface: "run-page" },
  { name: "trigger-screen-client.tsx (the schedule screen)", surface: "schedule" },
  { name: "schedule-prompt-window.tsx (the armed schedule step)", surface: "armed-trigger" },
  { name: "orchestrator-stepper-panel.tsx (the step-by-step screen)", surface: "step-by-step" },
  { name: "review-gate-card.tsx (the review card's window)", surface: "review" },
];

describe("the census — a registrant that lends nothing never takes the page's window away", () => {
  function Registrant(props: {
    surface: (typeof REGISTRANTS)[number]["surface"];
    canManipulate: boolean;
    children?: React.ReactNode;
  }) {
    useRunWindowScreen({
      surface: props.surface,
      runId: RUN_ID,
      canManipulate: props.canManipulate,
      storageKey: `census_${props.surface}`,
      conversation: [],
      promptPending: false,
      onSubmit: async () => {},
    });
    return <div>{props.children}</div>;
  }

  for (const lender of REGISTRANTS) {
    for (const other of REGISTRANTS) {
      if (other.surface === lender.surface) continue;
      it(`${other.name} lending nothing leaves ${lender.name} its window`, async () => {
        const { container } = render(
          <RunPageChrome>
            <Registrant surface={other.surface} canManipulate={false}>
              <Registrant surface={lender.surface} canManipulate={true} />
            </Registrant>
          </RunPageChrome>,
        );
        await poll(200);
        expect(windows(container)).toHaveLength(1);
        expect(windows(container)[0].closest('[data-run-window-host="page-chrome"]')).toBe(
          chromeNode(container),
        );
        cleanup();
      });
    }
  }

  it("and a registrant that lends nothing on its own still draws no window", async () => {
    for (const registrant of REGISTRANTS) {
      const { container } = render(
        <RunPageChrome>
          <Registrant surface={registrant.surface} canManipulate={false} />
        </RunPageChrome>,
      );
      await poll(200);
      expect(windows(container), registrant.name).toHaveLength(0);
      // The page's own node is still there — the column does not move.
      expect(chromeNode(container), registrant.name).not.toBeNull();
      cleanup();
    }
  });
});
