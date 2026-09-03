// @vitest-environment jsdom
/**
 * ONE WIDGET TURN, END TO END: THE RUN AND ITS REVIEW (cinatra#3051).
 *
 * The sibling `agentic-run-panel.widget-review-slot.test.tsx` (in the agents
 * package) pins the panel's own mount. This one is the TURN: the persisted
 * `agent_named_start` dispatch — the widget's one narrowly scoped start door —
 * replayed through the REAL widget arm of the ONE shared conversation column,
 * with the REAL inline run card inside it, and read off the rendered transcript.
 *
 * The four moments a person actually passes through, in order:
 *
 *   1. THE RUNNING PLACEHOLDER — the frame and the spinner, no review card.
 *   2. THE COMPLETED/AWAITING PLACEHOLDER — the run is done and the review has
 *      not opened yet. Before this change the widget fell through to the run's
 *      terminal reading here ("Its output could not be loaded here…"), which is
 *      the sentence #3051 was filed about.
 *   3. THE PENDING GATE — the same slot, now the 'Review requested' screen.
 *   4. THE SETTLED GATE — the decision taken through the card's own bar.
 *
 * And at every moment: EXACTLY ONE card, the transcript and its tool-call count
 * unchanged, and every request the card made carrying the surface's own broker
 * proof with cookies OMITTED. Then the RELOAD — the same persisted turn mounted
 * afresh — draws the card again on the first paint.
 *
 * AND THE CARD NAMES WHAT IS BEING DECIDED (cinatra#3051, second round). The
 * first round proved the card ARRIVES; the capture then showed it arriving with
 * a target panel that named nothing — "The preview did not load", no header, no
 * floor — because the header and the floor lived only inside the island
 * document. So the pending and the restored moments now also read the panel: the
 * §IV header off the gate's own rows and the §V floor line, present the moment
 * the card is, before the frame has loaded anything.
 *
 * WHY THE REAL RUN CARD HERE. The other widget carriage suites stand a marker in
 * for the inline run card because they are about the column's dispatch. This one
 * is about what the run card DRAWS on this host, so a stand-in would measure the
 * fixture — which is exactly how the defect survived: two rules each assuming
 * the other delivered the gate, and nothing rendering it.
 *
 *   pnpm --filter @cinatra-ai/chat exec vitest run \
 *     src/__tests__/widget-turn-review-gate.test.tsx
 */

import React from "react";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    ownKeys: () => ["Check", "ChevronDown", "Loader2", "default"],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: StubIcon }),
  });
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/embed/assistant",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

// --- the server-bound graphs the column and the panel reach -----------------
// Replaced exactly as the sibling carriage suites replace them, and for the same
// stated reason: their graphs reach the server runtime, so without these the
// column does not mount at all. Everything MEASURED here stays real — the
// transcript, the host declaration, the run panel, the review card, and every
// request they issue.

vi.mock("../../../agents/src/run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: vi.fn(async () => ({ state: "none" })),
  confirmRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
  skipRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
}));
vi.mock("../../../agents/src/agent-hitl-screen-actions", () => ({
  getAgentHitlScreenStateAction: vi.fn(async () => ({ state: "none" })),
}));
// THE COOKIE-BOUND REVIEW ACTIONS, kept as spies rather than removed: a widget
// card that reached for one would be asking the app to answer as whoever else is
// signed in on this browser, so "never called" is an assertion below.
const approveReviewTask = vi.hoisted(() => vi.fn(async () => undefined));
const rejectReviewTask = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../../agents/src/hitl-actions", () => ({ approveReviewTask, rejectReviewTask }));
vi.mock("../../../agents/src/a2a-actions", () => ({
  getAgentBuilderTask: vi.fn(async () => null),
}));
vi.mock("../../../agents/src/server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
  getSkillsForAgentAction: vi.fn(async () => []),
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({})),
  confirmRunSkillSelectionAction: vi.fn(async () => ({ ok: true })),
  getAuditAvailabilityAction: vi.fn(async () => ({
    visible: false,
    promptCount: 0,
    skillCount: 0,
  })),
}));
vi.mock("../../../agents/src/run-actions", () => ({
  resetAgentRun: vi.fn(async () => ({ ok: true })),
  createAndTriggerRun: vi.fn(async () => ({ ok: true, runId: "run-next" })),
  triggerAgentRun: vi.fn(async () => ({ ok: true })),
  readRunOutputEvidence: vi.fn(async () => ({
    ok: true,
    outputs: [],
    hasTranscript: false,
    hasStepResults: false,
    outputsUnavailable: false,
    unlinkableOutputs: 0,
  })),
}));
// No live stream: what is measured is what the run's own STATE makes the card
// draw, and a stream would supply its own status.
vi.mock("../../../agents/src/use-ag-ui-run-stream", () => ({
  useAgUiRunStream: vi.fn(() => ({
    status: null,
    error: null,
    presentationHint: null,
    isLive: false,
    interruptContext: null,
    streamedText: "",
    dataPartFrames: [],
  })),
}));
vi.mock("../../../agents/src/agent-ui-override-registry", () => ({
  agentUIOverrideRegistry: { resolve: () => null },
}));
// THE PANEL, REAL — reached by its own module rather than through the package's
// client barrel. The barrel is the whole client surface of the agents package
// and its graph boots the app's auth module, which no DOM test can stand up; the
// component under test is the panel, so it is imported as itself. Everything the
// panel does — the slot, the host declaration, the card and its requests — is the
// shipped code.
vi.mock("@cinatra-ai/agents/client-entry", async () => {
  const panel = await vi.importActual<
    typeof import("../../../agents/src/agentic-run-panel")
  >("../../../agents/src/agentic-run-panel");
  return { AgenticRunPanel: panel.AgenticRunPanel };
});
vi.mock("../pending-call-actions", () => ({
  listPendingToolConfirmations: async () => ({ rows: [] }),
  decidePendingToolCall: async () => ({ ok: true }),
}));
vi.mock("../undo-actions", () => ({
  recentUndoableChangeSetForRunAction: async () => ({ changeSetId: null }),
}));
vi.mock("@/components/data-safety/undo-toast", () => ({
  undoDeepLink: (id: string) => `/objects?undo=${id}`,
}));

import { LIFECYCLE_VIEW_RESOLVE_PATH } from "../../../agents/src/lifecycle-card-runtime";
import { LIFECYCLE_VIEW_DECIDE_PATH } from "../../../agents/src/review-gate-card";
import { NAMED_AGENT_START_TOOL_NAME } from "../run-start-tool-names";
import type { UiMessage } from "../types";
import { installWidgetServiceStub, mountSurface } from "./conversation-column-harness";

const RUN_ID = "run-3051-widget";
const GATE_REF = "lcr-opaque-3051";
const PLACEHOLDER = '[data-conformance-id="review-gate-placeholder"]';
const REVIEW_CARD = '[data-conformance-id="review-gate-card"]';
const SLOT = "[data-run-review-slot]";
const APPROVE = '[data-action="approve-review -> resolved"]';

if (typeof window !== "undefined" && typeof window.localStorage?.getItem !== "function") {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

/**
 * THE PERSISTED TURN — the widget's own start door, as the server wrote it.
 *
 * `agent_named_start` rather than `agent_run`: the widget's closed allowlist
 * does not hold `agent_run`, so this is the name a widget-started run really
 * carries on the durable part, and the column mounts the card off it.
 */
function namedStartTranscript(): UiMessage[] {
  return [
    { id: "u1", role: "user", content: "Write the launch post" },
    {
      id: "a1",
      role: "assistant",
      content: "",
      parts: [
        {
          kind: "text",
          content:
            "Started `@cinatra-ai/blog-draft-writer-agent` (runId: `" + RUN_ID + "`).",
        },
        {
          kind: "tool_call",
          id: "t1",
          name: NAMED_AGENT_START_TOOL_NAME,
          runId: RUN_ID,
          status: "completed",
          resultLabel: `runId: ${RUN_ID}, status: running`,
        },
      ],
    } as UiMessage,
  ];
}

type Call = { url: string; init: RequestInit };

/** The run's seed, as `/api/agents/runs/<id>` answers it. */
function seedBody(over: Record<string, unknown> = {}) {
  return {
    status: "running",
    error: null,
    inputParams: {},
    templateId: "tmpl-3051",
    agentPackageName: "@cinatra-ai/blog-draft-writer-agent",
    agUiEnabled: false,
    taskId: null,
    traceId: null,
    messages: [],
    hitlContext: null,
    reviewGate: { ref: null, awaiting: false },
    ...over,
  };
}

const PENDING = { state: "pending", canDecide: true, canComment: true };

/** The gate's own pinned target HEADER, as the resolve answers it — the facts
 *  the card's target header and floor are drawn from, and the ones the proof
 *  round found missing at the pending instant.
 *
 *  It arrives already WORDED: the server composes it out of the same reads and
 *  the same surface-model functions the island's own header uses, so the stored
 *  instant the earlier reading printed raw ("updated 2026-08-29T03:07:18.778Z")
 *  is read as a time before it ever reaches the wire, and the card — which owns
 *  no artifact vocabulary — cannot word it differently. */
const TARGET_HEADER = {
  title: "Launch post draft",
  typeLabel: "Blog Post Artifact",
  objectType: "@cinatra-ai/blog-post-artifact:post",
  revisionId: "ea615d36-2ad7-4a11-9f0e-8c1b2d3e4f56",
  facts: ["Organization", "Organization", "text/markdown", "updated 8 minutes ago"],
};

/** What the panel must read at ANY moment the frame has not painted: the header
 *  fields the drawing names, and the one sanitized floor line under them. */
function expectTargetNamed(root: HTMLElement, when: string): void {
  const header = root.querySelector("[data-review-target-header]");
  expect(header, `${when}: the target header is drawn`).not.toBeNull();
  const text = header!.textContent ?? "";
  for (const fact of [
    "Launch post draft",
    "@cinatra-ai/blog-post-artifact:post",
    "revision ea615d36-2ad",
    "pinned",
    // THE DRAWN LINE: bare scope words in the host's own vocabulary and a
    // relative time — never a labelled enum and never a raw instant.
    "Organization · Organization · text/markdown · updated 8 minutes ago",
  ]) {
    expect(text, `${when}: ${fact}`).toContain(fact);
  }
  expect(text, `${when}: no raw instant in the header`).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  expect(text, `${when}: no labelled enum in the header`).not.toContain("Ownership:");
  const floor = root.querySelector("[data-review-target-floor]");
  expect(floor, `${when}: the never-blank floor`).not.toBeNull();
  // AMENDED (cinatra#3058, fix leg 8). The line's `package` half is DROPPED on
  // the card's own overlay: §V fixes the renderer resolution as "host-derived,
  // never a claim the client or the model can forge", and this overlay is drawn
  // on the client for a frame that reached no renderer at all. Reading the
  // artifact type's defining package off the type id in its place would name a
  // package that had no part in the failure. What #3051 needs from this line is
  // unchanged and is what is measured here: it is DRAWN, in every reading,
  // inside the widget — never a blank — with the two parts that are true of it.
  expect(floor!.getAttribute("data-review-floor-package"), when).toBe("");
  expect(floor!.getAttribute("data-review-floor-slot"), when).toBe("detail");
  expect(floor!.textContent, when).toContain('slot "detail"');
  expect(floor!.textContent, when).not.toContain("package");
  // The sentence the capture photographed is a preview state, never a reason the
  // reviewer cannot decide — and it never stands alone any more.
  expect(root.textContent, `${when}: the decision floor is live`).toContain("Approve");
}

/**
 * The widget's server. `installWidgetServiceStub` answers the conversation
 * routes; this wraps it with the two routes THIS turn adds — the run's seed and
 * the gate's decision — and records every call so the credential rail can be
 * read back. Wrapping rather than editing the shared harness keeps the other
 * carriage suites answering exactly what they answered before.
 */
function installTurnServer(state: {
  seed: () => Record<string, unknown>;
  gate: () => Record<string, unknown>;
}) {
  const calls: Call[] = [];
  const base = installWidgetServiceStub({
    threadMessages: namedStartTranscript(),
    lifecycle: () => ({
      kind: "artifact_review_gate",
      state: state.gate(),
      body: null,
      // The gate's own target header rides the answer that authorized the card
      // (cinatra#3051, #3141 item 7), which is what lets the panel name its
      // target before the island has loaded anything.
      targetHeaders: [TARGET_HEADER],
    }),
  });
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    if (url.includes("/api/agents/runs/")) return json(state.seed());
    if (url === LIFECYCLE_VIEW_DECIDE_PATH) {
      return json({ outcome: { kind: "decided", disposition: "approve", idempotent: false } });
    }
    return inner(input, init);
  }) as unknown as typeof fetch;
  return { calls, restore: base.restore };
}

/** Lower-cased header map of a recorded call. */
function headersOf(init: RequestInit): Record<string, string> {
  const raw = (init.headers ?? {}) as Record<string, string>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) out[k.toLowerCase()] = v;
  return out;
}

function callsTo(calls: Call[], path: string): Call[] {
  return calls.filter((c) => c.url === path);
}

/** The run's seed address — the read the card re-asks the slot with. */
function seedUrl(runId: string): string {
  return `/api/agents/runs/${encodeURIComponent(runId)}`;
}

function expectBrokered(call: Call | undefined, what: string) {
  expect(call, `${what} was never issued`).toBeDefined();
  const headers = headersOf(call!.init);
  expect(headers["authorization"], what).toBe("Bearer cit_site");
  expect(headers["x-cinatra-widget-user-token"], what).toBe("cwu_user");
  expect(call!.init.credentials, what).toBe("omit");
}

/** What the transcript itself is made of, independent of the review slot. */
function transcriptShape(root: HTMLElement) {
  return {
    slots: root.querySelectorAll("[data-transcript-slot]").length,
    runStartSlots: root.querySelectorAll("[data-agent-run-slot]").length,
    assistantContent: root.querySelectorAll("[data-embed-content]").length,
  };
}

/** The one-card reading, at any moment. */
function cardCounts(root: HTMLElement) {
  return {
    reviewCards: root.querySelectorAll('[data-lifecycle-card="artifact_review_gate"]').length,
    slots: root.querySelectorAll(SLOT).length,
    placeholders: root.querySelectorAll(PLACEHOLDER).length,
  };
}

let server: ReturnType<typeof installTurnServer> | null = null;

beforeEach(() => {
  approveReviewTask.mockClear();
  rejectReviewTask.mockClear();
  cleanup();
});

afterEach(() => {
  cleanup();
  server?.restore();
  server = null;
  vi.clearAllMocks();
});

describe("a run started from the widget's own composer", () => {
  it("walks the four moments in one slot, and shows its review inside the widget", async () => {
    let seed = seedBody();
    let gate: Record<string, unknown> = PENDING;
    server = installTurnServer({ seed: () => seed, gate: () => gate });

    const { container } = await mountSurface("widget", { messages: namedStartTranscript() });
    const root = container as HTMLElement;

    // The transcript the turn arrived as. Everything below must leave it alone.
    const shapeAtStart = transcriptShape(root);
    expect(shapeAtStart.runStartSlots).toBe(1);

    // ---- MOMENT 1: the run is working -------------------------------------
    await waitFor(() => expect(root.querySelector(PLACEHOLDER)).not.toBeNull(), {
      timeout: 15_000,
    });
    expect(root.querySelector(SLOT)?.getAttribute("data-run-review-slot")).toBe("working");
    expect(cardCounts(root)).toEqual({ reviewCards: 0, slots: 1, placeholders: 1 });
    expect(transcriptShape(root)).toEqual(shapeAtStart);

    // ---- MOMENT 2: done, and the review has not opened yet ------------------
    //
    // Waited on the SURFACE'S OWN READ rather than on a clock: the assertion is
    // that nothing changed, and a fixed sleep would either race the read or pass
    // for having outrun it. Two further reads of the run means the card has seen
    // the completed status and the still-closed review, and only then is "the
    // placeholder is still up" a statement about the component.
    const readsBefore = callsTo(server.calls, seedUrl(RUN_ID)).length;
    seed = seedBody({ status: "completed", reviewGate: { ref: null, awaiting: true } });
    await waitFor(
      () =>
        expect(callsTo(server!.calls, seedUrl(RUN_ID)).length).toBeGreaterThan(
          readsBefore + 1,
        ),
      { timeout: 20_000 },
    );
    expect(root.querySelector(PLACEHOLDER)).not.toBeNull();
    // The sentence #3051 was filed about is NOT what this surface shows.
    expect(root.querySelector("[data-run-completion]")).toBeNull();
    expect(root.textContent).not.toMatch(/could not be loaded here/i);
    expect(cardCounts(root)).toEqual({ reviewCards: 0, slots: 1, placeholders: 1 });

    // ---- MOMENT 3: the review opens ----------------------------------------
    seed = seedBody({ status: "completed", reviewGate: { ref: GATE_REF, awaiting: false } });
    const card = await waitFor(
      () => {
        const el = root.querySelector(REVIEW_CARD);
        if (!el) throw new Error("the review screen never arrived in the widget");
        return el;
      },
      { timeout: 20_000 },
    );
    expect(root.querySelector(SLOT)?.getAttribute("data-run-review-slot")).toBe("review");
    expect(root.querySelector(SLOT)?.contains(card)).toBe(true);
    expect(cardCounts(root)).toEqual({ reviewCards: 1, slots: 1, placeholders: 0 });
    // It is the WIDGET's card, drawn on the widget's own host…
    expect(card.getAttribute("data-lifecycle-card-host")).toBe("site_widget");
    expect(card.getAttribute("data-lifecycle-card-state")).toBe("pending");
    // …and at that instant it NAMES what is under review. This is the reading
    // the capture found empty: the island frame has not painted, and the header
    // and the floor are on screen anyway, from the gate's own rows.
    expect(
      root
        .querySelector('[data-conformance-id="review-target-island"]')
        ?.getAttribute("data-island-load-state"),
      "the frame has not painted at the pending instant",
    ).toBe("loading");
    expectTargetNamed(root, "the pending instant");
    // …and it asked with the reader's own proof.
    const resolves = callsTo(server.calls, LIFECYCLE_VIEW_RESOLVE_PATH);
    expectBrokered(resolves[0], "the resolve");
    for (const call of resolves) expect(call.init.credentials).toBe("omit");
    // The transcript is exactly what it was — no new turn, no new tool call.
    expect(transcriptShape(root)).toEqual(shapeAtStart);

    // ---- MOMENT 4: the decision, through the card's own bar -----------------
    const approve = root.querySelector<HTMLButtonElement>(APPROVE);
    expect(approve, "the decision bar is not in the widget").not.toBeNull();
    gate = { state: "settled", outcome: "approved" };
    fireEvent.click(approve!);

    await waitFor(() =>
      expect(callsTo(server!.calls, LIFECYCLE_VIEW_DECIDE_PATH).length).toBeGreaterThan(0),
    );
    expectBrokered(callsTo(server.calls, LIFECYCLE_VIEW_DECIDE_PATH)[0], "the decide");
    expect(approveReviewTask).not.toHaveBeenCalled();
    expect(rejectReviewTask).not.toHaveBeenCalled();

    await waitFor(() =>
      expect(
        root.querySelector(REVIEW_CARD)?.getAttribute("data-lifecycle-card-state"),
      ).toBe("settled"),
    );
    expect(cardCounts(root)).toEqual({ reviewCards: 1, slots: 1, placeholders: 0 });
    expect(transcriptShape(root)).toEqual(shapeAtStart);
  }, 90_000);

  it("is still there after the third-party page is reloaded", async () => {
    // A reload replays the SAME persisted turn and re-reads the run. Nothing
    // about the card is client state, so it must draw again from what the server
    // holds — which is the half of §6 that a transient render would fail.
    const seed = seedBody({
      status: "completed",
      reviewGate: { ref: GATE_REF, awaiting: false },
    });
    server = installTurnServer({ seed: () => seed, gate: () => PENDING });

    const { container } = await mountSurface("widget", { messages: namedStartTranscript() });
    const root = container as HTMLElement;

    const card = await waitFor(
      () => {
        const el = root.querySelector(REVIEW_CARD);
        if (!el) throw new Error("the restored turn drew no review card");
        return el;
      },
      { timeout: 20_000 },
    );
    expect(card.getAttribute("data-lifecycle-card-host")).toBe("site_widget");
    expect(cardCounts(root)).toEqual({ reviewCards: 1, slots: 1, placeholders: 0 });
    expectTargetNamed(root, "the reloaded page's first paint");
    expectBrokered(callsTo(server.calls, LIFECYCLE_VIEW_RESOLVE_PATH)[0], "the resolve");
  }, 60_000);
});
