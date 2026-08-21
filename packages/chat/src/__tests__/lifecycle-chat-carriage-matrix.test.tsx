// @vitest-environment jsdom
/**
 * THE FOUR-KIND chat_thread CARRIAGE MATRIX (cinatra#2827, epic #2784 S9i).
 *
 * Plan: PLAN: Agents Lifecycle §2 — "a card takes the assistant turn's content
 * slot", and §2.3 row 4, "a card is appended after the trace, not folded in at
 * the step that produced it — the card payload carries no slot identity".
 *
 * WHAT MAKES THIS THE REAL THING, end to end and in this order:
 *
 *   1. THE REAL PRODUCER. `buildLifecycleViewEnvelope` mints the tool result, so
 *      the bytes the sink recognizes are the bytes a lifecycle primitive really
 *      returns, from a (server, tool) tuple read out of the shipped allowlist.
 *   2. THE REAL SINK. `createAgUiSinkAdapter` turns that result into the wire.
 *      Nothing here writes a `DATA_PART` by hand, so "the sink preserves the
 *      producing call" is measured rather than assumed.
 *   3. THE REAL REDUCER. `reduceAgUiEvents` + `projectConversationMessage` fold
 *      the wire into the `UiMessage` the transcript renders. The suite never
 *      constructs `parts`, `views` or `dataParts` for an assistant turn.
 *   4. THE REAL VIEW. The column `/chat` mounts, through the shared surface
 *      harness, with the production renderable-view registry and the real owner
 *      components behind it.
 *
 * WHAT A ROW REQUIRES, and why each half is there (see
 * `evaluateChatCarriage`): the kind's OWNER root — its kind, its chat host and
 * a resolved state on ONE element — plus the kind's REAL decision controls
 * inside it, at the ordered slot of the part that PRODUCED the view, outside
 * the run card's subtree. The S1 shell satisfies none of that: it names the kind
 * and the state, declares no host and offers nothing to press. That is the point
 * — a gate that accepted the shell would certify a placeholder as §VI and §VII.
 *
 * THE RATCHET. `CHAT_OWNER_MOUNT_OBLIGATIONS` is the ruled owed set, and the
 * matrix asserts the OBSERVED unmounted set is EXACTLY it. A kind whose owner
 * lands turns this red until its row is struck, and a row struck early is red
 * the same day. `recommendation_hold` reads its entry from
 * `HELD_TURN_MOUNT_OBLIGATIONS` (S9h's switch), so S9b strikes one row and both
 * ratchets move.
 *
 * LOCAL NOTE: runs under the chat package's own vitest config, in the required
 * `package-unit-suites` job. CI (Node 24) is authoritative.
 */

import React from "react";
import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, waitFor } from "@testing-library/react";

const __dirname = dirname(fileURLToPath(import.meta.url));
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- the owner cards' server-side graph, stubbed as the sibling suites do ----

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
    ownKeys: () => ["Check", "ChevronDown", "default"],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: StubIcon }),
  });
});

const routerPush = vi.fn();
const routerReplace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: routerReplace, refresh: vi.fn() }),
  usePathname: () => "/chat",
  useSearchParams: () => new URLSearchParams(),
}));

/**
 * The recommendation hold's AUTHORITY, and the ONLY thing stubbed for that kind.
 * Its two decision controls stay the real `confirm-run-recommendation` /
 * `skip-run-recommendation` actions on the shipped chip row.
 */
type HoldState =
  | { state: "none" }
  | {
      state: "held";
      agentPackageName: string;
      promptText: string;
      recommendations: {
        skillId: string;
        skillRevisionId: string;
        recommended: boolean;
        name?: string;
      }[];
      holdRef: string;
    };
const holdStateMock = vi.fn(async (): Promise<HoldState> => ({ state: "none" }));
vi.mock("../../../agents/src/run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: () => holdStateMock(),
  confirmRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
  skipRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
}));
// A server-only graph: stubbed rather than loaded, carrying every symbol the
// lazy chat chunk reaches — a missing one fails the chunk and the transcript
// never mounts, which would read as a passing negative arm.
vi.mock("../../../agents/src/server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
  getSkillsForAgentAction: vi.fn(async () => []),
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({})),
  confirmRunSkillSelectionAction: vi.fn(async () => ({ ok: true })),
}));
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
// The inline run card is the AG-UI run panel, whose graph reaches the server
// runtime. The stand-in declares the SAME host the shipped panel declares, so
// the foreign-host arm is measured against the production vocabulary.
vi.mock("../inline-agent-run-card", () => ({
  InlineAgentRunCard: ({ runId }: { runId: string }) => (
    <div data-lifecycle-card-host="run_card" data-inline-run-card={runId} />
  ),
}));

// Some Node builds expose a global `localStorage` that SHADOWS jsdom's and
// throws on use, which the composer's prompt field reads on mount. Repaired only
// when actually broken, so the suite behaves identically on CI's runtime.
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

import {
  LIFECYCLE_CARD_KINDS,
  type LifecycleCardKind,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";
import {
  CHAT_OWNER_MOUNT_OBLIGATIONS,
  CHAT_THREAD_CARRIAGE_CONTRACT,
  SHELL_OWNED_CHAT_KINDS,
  carriageRowFor,
  carriesChatOwner,
  chatCarriageRootAnchorsFor,
  evaluateChatCarriage,
  type ChatCarriageObservation,
  type ChatThreadCarriageRow,
} from "@/lib/lifecycle/held-turn-card-contract";
import {
  LIFECYCLE_PRODUCER_SERVER_LABEL,
  LIFECYCLE_PRODUCER_TOOLS,
  buildLifecycleViewEnvelope,
  type LifecycleViewType,
} from "@/lib/assistant-runtime/lifecycle-view-envelope";
import { createAgUiSinkAdapter } from "@/lib/assistant-runtime/ag-ui-sink-adapter";
import type { AgUiEvent } from "@cinatra-ai/agent-ui-protocol";

import { projectConversationMessage } from "../ag-ui-chat-client";
import { reduceAgUiEvents } from "../renderer/ag-ui-reducer";
import { mountSurface } from "./conversation-column-harness";
import type { UiMessage } from "../types";

// ---------------------------------------------------------------------------
// The turn, produced by the real sink from a real envelope
// ---------------------------------------------------------------------------

const RUN_ID = "run-2827";
const THREAD_ID = "thread-2827";
const CALL_ID = "call-2827";
/** Prose that names no other surface — the S9h anti-pattern rules still apply. */
const PROSE = "Here is what I found.";

const REF_BY_KIND: Record<LifecycleCardKind, string> = {
  artifact_review_gate: "gate-ref-2827",
  verification_summary: "verification-ref-2827",
  trigger_schedule_proposal: "proposal-ref-2827",
  recommendation_hold: "hold-ref-2827",
};

/** The self-MCP tool the shipped allowlist authorizes to mint this kind. */
function producerToolFor(kind: LifecycleViewType): string {
  const tools = LIFECYCLE_PRODUCER_TOOLS[kind];
  expect(tools.length, `no producer tool is allowlisted for ${kind}`).toBeGreaterThan(0);
  return tools[0];
}

/**
 * Drive the REAL sink over one assistant turn and return what it published.
 *
 * The DATA_PART kinds run their producer primitive: a tool call, then a tool
 * result carrying the reserved envelope. `recommendation_hold` runs the shape it
 * actually has — an `agent_run` dispatch that parks — because its carriage is an
 * INTERRUPT and its slot is the dispatch's own tool call (the epic's 2026-08-16
 * ruling, and S9b's mount).
 */
async function driveSink(kind: LifecycleCardKind): Promise<AgUiEvent[]> {
  const published: AgUiEvent[] = [];
  const adapter = createAgUiSinkAdapter({
    runId: RUN_ID,
    threadId: THREAD_ID,
    publish: async (event) => {
      published.push(event);
    },
  });
  adapter.start();
  adapter.send("text", { content: PROSE });
  if (kind === "recommendation_hold") {
    adapter.send("tool_call", { id: CALL_ID, name: "agent_run" });
    adapter.send("tool_result", {
      id: CALL_ID,
      name: "agent_run",
      result: JSON.stringify({ runId: RUN_ID, status: "pending_input" }),
    });
  } else {
    const toolName = producerToolFor(kind);
    const envelope = buildLifecycleViewEnvelope({
      viewType: kind,
      ref: REF_BY_KIND[kind],
    });
    expect(envelope, `the producer refused to mint an envelope for ${kind}`).not.toBeNull();
    adapter.send("tool_call", {
      id: CALL_ID,
      name: toolName,
      serverLabel: LIFECYCLE_PRODUCER_SERVER_LABEL,
    });
    adapter.send("tool_result", {
      id: CALL_ID,
      name: toolName,
      serverLabel: LIFECYCLE_PRODUCER_SERVER_LABEL,
      result: envelope,
    });
  }
  adapter.send("done", {});
  await adapter.drain();
  return published;
}

type ReducedTurn = {
  messages: UiMessage[];
  /** The ordered index of the producing tool call in the reduced trace. */
  producingSlot: number;
};

/** The transcript the column renders, folded by the REAL reducer. */
async function reducedTurn(kind: LifecycleCardKind): Promise<ReducedTurn> {
  const events = await driveSink(kind);
  const state = reduceAgUiEvents(events);
  const assistant = projectConversationMessage(state, { assistantId: "a1" });
  const producingSlot = (assistant.parts ?? []).findIndex(
    (p) => p.kind === "tool_call" && p.id === CALL_ID,
  );
  expect(producingSlot, "the reduced trace lost the producing tool call").toBeGreaterThanOrEqual(0);
  return {
    messages: [{ id: "u1", role: "user", content: "Do the thing" }, assistant],
    producingSlot,
  };
}

// ---------------------------------------------------------------------------
// The authoritative resolve, answered per kind and RECORDED
// ---------------------------------------------------------------------------
//
// The resolve route is a separate contract (S9c owns it), so it is stubbed —
// but the stub RECORDS what each card asked about, which turns it into an
// assertion: the card re-asks the server about exactly the ref the producer
// minted and the sink carried. Each kind gets the body it is AUTHORIZED to
// carry, because the shared parse refuses anything else — a uniform answer
// would have drawn no schedule card at all and the mount arm would have read
// that as a carriage gap.

const RESOLVE_PATH = "/api/lifecycle-views/resolve";

const RESOLVE_ANSWERS: Record<string, unknown> = {
  artifact_review_gate: {
    kind: "artifact_review_gate",
    state: { state: "pending", canDecide: true, canComment: true },
    body: null,
  },
  trigger_schedule_proposal: {
    kind: "trigger_schedule_proposal",
    state: { state: "pending", canDecide: true, canComment: false },
    body: {
      phase: "proposal",
      version: 1,
      agentName: "Proof agent",
      schedule: {
        kind: "recurring",
        timezone: "Europe/Berlin",
        selection: {
          frequency: "weekly",
          interval: 1,
          weekdays: [1, 2, 3, 4, 5],
          dayOfMonth: 1,
          monthlyMode: "date",
          nthWeek: 1,
          monthlyWeekday: 1,
          quarterAnchor: "start",
          yearlyMonth: 1,
          hour: 8,
          minute: 0,
        },
      },
      durationCopy: "About 45s – 3.4 hr.",
      canConfirm: true,
      restrictedReason: null,
    },
  },
  verification_summary: {
    kind: "verification_summary",
    state: { state: "advisory" },
    body: {
      version: 1,
      outcome: "verified",
      reviewedRevisionId: "rev-base",
      repairedRevisionId: "rev-repaired",
      scopePaths: ["/title"],
      fieldDiff: [{ field: "/title", before: "Old", after: "New" }],
    },
  },
};

type ResolveAsk = { viewType: string; ref: string };

function installResolveStub() {
  const asks: ResolveAsk[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(RESOLVE_PATH)) {
      let ask: ResolveAsk = { viewType: "", ref: "" };
      try {
        ask = JSON.parse(String(init?.body ?? "{}")) as ResolveAsk;
      } catch {
        /* an unparseable body is itself the finding — recorded as empty */
      }
      asks.push(ask);
      const answer = RESOLVE_ANSWERS[ask.viewType];
      if (answer === undefined) {
        return new Response(JSON.stringify({ error: "unknown kind" }), { status: 400 });
      }
      return new Response(JSON.stringify(answer), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return {
    asks,
    restore() {
      globalThis.fetch = original;
    },
  };
}

// ---------------------------------------------------------------------------
// The observation — production DOM to the contract's model
// ---------------------------------------------------------------------------

/** The ordered-parts list, resolved through the text part's stable hook. */
function orderedPartsList(root: HTMLElement): HTMLElement {
  const text = root.querySelector("[data-embed-content]");
  if (!text?.parentElement) throw new Error("no ordered-parts list in the rendered transcript");
  return text.parentElement;
}

/**
 * The ordered slot an element renders at, read off the transcript's own slot
 * marker rather than off a child index.
 *
 * Counting children would only be right while every part happens to render one
 * container — a tool part that renders nothing shifts every index after it, and
 * the position claim this slice exists to make would then be true by luck. The
 * marker carries the part's index in the trace, so it can be compared with the
 * index the REDUCER gave the producing call.
 */
function slotOf(el: Element): number | null {
  const container = el.closest("[data-transcript-slot]");
  if (!container) return null;
  const raw = container.getAttribute("data-transcript-slot");
  const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function observeChatCarriage(
  root: HTMLElement,
  row: ChatThreadCarriageRow,
  producingSlot: number,
): ChatCarriageObservation {
  const list = orderedPartsList(root);
  const required = chatCarriageRootAnchorsFor(row);
  const byElement = new Map<Element, string[]>();
  for (const selector of required) {
    for (const el of Array.from(list.querySelectorAll(selector))) {
      // A node inside another host's subtree is that host's mount, not this one.
      if (row.foreignHostSubtrees.some((s) => el.closest(s) !== null)) continue;
      byElement.set(el, [...(byElement.get(el) ?? []), selector]);
    }
  }
  const rootCandidates = [...byElement.entries()].map(([el, anchors]) => ({
    anchors,
    slot: slotOf(el),
    controls: row.decisionControls.filter((c) => el.querySelector(c) !== null),
  }));
  return { rootCandidates, producingSlot };
}

/**
 * Let the cards' own resolves settle.
 *
 * Every lifecycle card reads its authority in an effect on mount, so an
 * observation taken in the same tick would report "no card" on a tree that does
 * mount one. Flushing here is what makes an absence MEASURED rather than
 * assumed.
 */
async function settleResolves() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    await Promise.resolve();
  });
}

/** Mount the production `/chat` column on one kind's reduced transcript. */
async function mountKind(kind: LifecycleCardKind) {
  const { messages, producingSlot } = await reducedTurn(kind);
  const mounted = await mountSurface("chat", { messages });
  const root = mounted.container.querySelector<HTMLElement>('[data-parity-surface="chat"]');
  if (!root) throw new Error("the chat surface did not mount");
  await settleResolves();
  return { mounted, root, producingSlot };
}

let resolveStub: ReturnType<typeof installResolveStub>;

beforeEach(() => {
  holdStateMock.mockImplementation(async () => ({
    state: "held",
    agentPackageName: "@cinatra-ai/proof-agent",
    promptText: "{}",
    recommendations: [
      { skillId: "skill-a", skillRevisionId: "rev-a", recommended: true, name: "Skill A" },
    ],
    holdRef: REF_BY_KIND.recommendation_hold,
  }));
  routerPush.mockReset();
  routerReplace.mockReset();
  resolveStub = installResolveStub();
});

afterEach(() => {
  resolveStub.restore();
  cleanup();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. The wire carries the slot
// ---------------------------------------------------------------------------

describe("the DATA_PART slot identity, measured on the real sink's own output", () => {
  it.each(
    LIFECYCLE_CARD_KINDS.filter((k) => carriageRowFor(k).carriage === "data_part"),
  )("the %s DATA_PART names the tool call that produced it", async (kind) => {
    const events = await driveSink(kind);
    const views = events.filter(
      (e) => e.type === "DATA_PART" && (e.data as { viewType?: unknown }).viewType === kind,
    );
    expect(views, `the sink minted no ${kind} DATA_PART`).toHaveLength(1);
    const view = views[0] as Extract<AgUiEvent, { type: "DATA_PART" }>;
    expect(view.toolCallId).toBe(CALL_ID);
    // AND THE PAYLOAD IS UNTOUCHED. The slot rides the event precisely so the
    // strict `{ viewType, schemaVersion, ref }` payload stays what a strict
    // parser already accepts — a producer may not add a field to it.
    expect(Object.keys(view.data).sort()).toEqual(["ref", "schemaVersion", "viewType"]);
    expect(view.data.ref).toBe(REF_BY_KIND[kind]);
  });

  it("carries the slot in ORDER — the call opens before its view is minted", async () => {
    const events = await driveSink("artifact_review_gate");
    const types = events.map((e) => e.type);
    const start = types.indexOf("TOOL_CALL_START");
    const end = types.indexOf("TOOL_CALL_END");
    const view = events.findIndex(
      (e) =>
        e.type === "DATA_PART" &&
        (e.data as { viewType?: unknown }).viewType === "artifact_review_gate",
    );
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(view).toBeGreaterThan(end);
  });

  it("folds the view onto the producing part rather than after the turn", async () => {
    const { messages, producingSlot } = await reducedTurn("artifact_review_gate");
    const assistant = messages[1];
    const part = (assistant.parts ?? [])[producingSlot];
    expect(part.kind).toBe("tool_call");
    expect(part.kind === "tool_call" && part.views).toEqual([
      {
        viewType: "artifact_review_gate",
        schemaVersion: 1,
        ref: REF_BY_KIND.artifact_review_gate,
      },
    ]);
    // The turn-level adjunct list is where the card USED to land, and a view
    // drawn from both would be drawn twice.
    expect(assistant.dataParts).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. The matrix
// ---------------------------------------------------------------------------

describe("the four-kind chat_thread carriage matrix, in the REAL view", () => {
  it("covers the protocol's closed kind set, once each, with no kind added or dropped", () => {
    expect([...CHAT_THREAD_CARRIAGE_CONTRACT.map((r) => r.kind)].sort()).toEqual(
      [...LIFECYCLE_CARD_KINDS].sort(),
    );
  });

  it.each([...LIFECYCLE_CARD_KINDS])(
    "%s: the kind's real owner draws at its producing slot, or its ratchet stands",
    async (kind) => {
      const row = carriageRowFor(kind);
      const { root, producingSlot } = await mountKind(kind);
      const observation = observeChatCarriage(root, row, producingSlot);
      const violations = evaluateChatCarriage(observation, row);
      if (CHAT_OWNER_MOUNT_OBLIGATIONS.includes(kind)) {
        // OWED — and the obligation is measured, not waived: something must be
        // missing, and a landed owner turns this red until the row is struck.
        expect(
          violations,
          `${kind} now carries its real owner in the chat transcript — strike its ` +
            "row from CHAT_OWNER_MOUNT_OBLIGATIONS (or, for recommendation_hold, " +
            "from HELD_TURN_MOUNT_OBLIGATIONS)",
        ).not.toEqual([]);
        return;
      }
      expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
      expect(carriesChatOwner(observation, row)).toBe(true);
    },
  );

  it("the OBSERVED unmounted set is exactly the ruled obligation list", async () => {
    const observed: LifecycleCardKind[] = [];
    for (const kind of LIFECYCLE_CARD_KINDS) {
      const row = carriageRowFor(kind);
      const { mounted, root, producingSlot } = await mountKind(kind);
      if (!carriesChatOwner(observeChatCarriage(root, row, producingSlot), row)) {
        observed.push(kind);
      }
      mounted.unmount();
    }
    expect(
      [...observed].sort(),
      "the PRODUCTION view's unmounted set drifted from CHAT_OWNER_MOUNT_OBLIGATIONS — " +
        "strike a row when its owner lands, and never before",
    ).toEqual([...CHAT_OWNER_MOUNT_OBLIGATIONS].sort());
  });
});

// ---------------------------------------------------------------------------
// 3. The implemented row, stated in full
// ---------------------------------------------------------------------------

describe("the review row — the one kind whose owner is drawn today", () => {
  const ROW = carriageRowFor("artifact_review_gate");

  it("renders ReviewGateCard's own root, declaring the kind, the chat host and its state", async () => {
    const { root } = await mountKind("artifact_review_gate");
    const card = root.querySelector<HTMLElement>('[data-conformance-id="review-gate-card"]');
    expect(card, "the real ReviewGateCard did not render in the chat transcript").not.toBeNull();
    expect(card!.getAttribute("data-lifecycle-card")).toBe("artifact_review_gate");
    expect(card!.getAttribute("data-lifecycle-card-host")).toBe("chat_thread");
    expect(card!.getAttribute("data-lifecycle-card-state")).toBe("pending");
  });

  it("draws the REAL decision controls inside that root", async () => {
    const { root } = await mountKind("artifact_review_gate");
    const card = root.querySelector<HTMLElement>('[data-conformance-id="review-gate-card"]')!;
    for (const control of ROW.decisionControls) {
      expect(card.querySelector(control), `${control} is not inside the card`).not.toBeNull();
    }
  });

  it("sits in the PRODUCING step's own container, not after the trace", async () => {
    const { root, producingSlot } = await mountKind("artifact_review_gate");
    const card = root.querySelector<HTMLElement>('[data-conformance-id="review-gate-card"]')!;
    expect(slotOf(card)).toBe(producingSlot);
    // And the container is a child of the ordered-parts list, so "at its slot"
    // means inside the trace rather than beside it.
    const list = orderedPartsList(root);
    const container = card.closest("[data-transcript-slot]")!;
    expect(container.parentElement).toBe(list);
  });

  it("sits OUTSIDE the inline run card's subtree", async () => {
    const { root } = await mountKind("artifact_review_gate");
    const card = root.querySelector<HTMLElement>('[data-conformance-id="review-gate-card"]')!;
    for (const foreign of ROW.foreignHostSubtrees) {
      expect(card.closest(foreign), `the card renders inside ${foreign}`).toBeNull();
    }
  });

  it("re-asks the server about exactly the ref the producer minted", async () => {
    await mountKind("artifact_review_gate");
    expect(resolveStub.asks.length).toBeGreaterThan(0);
    for (const ask of resolveStub.asks) {
      expect(ask).toEqual({
        viewType: "artifact_review_gate",
        ref: REF_BY_KIND.artifact_review_gate,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// 4. What may NOT pass a row
// ---------------------------------------------------------------------------

describe("what cannot satisfy a row", () => {
  it("a SOURCE DECLARATION does not: the registry maps both owed kinds and the rows still fail", async () => {
    // The registry really does declare an owner for every kind — that is the
    // claim a source-reading gate would accept, and it is why this suite reads
    // DOM instead. Both halves are asserted together so the point is executed
    // rather than described: the declaration is there, and it buys nothing.
    const registry = readFileSync(
      resolvePath(__dirname, "../renderable-views/registry.tsx"),
      "utf8",
    );
    for (const kind of SHELL_OWNED_CHAT_KINDS) {
      expect(registry, `${kind} is not declared in the registry at all`).toContain(`${kind}:`);
      const row = carriageRowFor(kind);
      const { mounted, root, producingSlot } = await mountKind(kind);
      expect(carriesChatOwner(observeChatCarriage(root, row, producingSlot), row)).toBe(false);
      mounted.unmount();
    }
  });

  it("a REGISTRY ROW alone does not: the shell draws for both owed kinds and still fails", async () => {
    for (const kind of SHELL_OWNED_CHAT_KINDS) {
      const row = carriageRowFor(kind);
      const { mounted, root, producingSlot } = await mountKind(kind);
      // The registry DID dispatch and the shell DID draw — the kind and a
      // resolved state are on screen. That is exactly the state of main, and it
      // is not this kind's owner.
      const shell = root.querySelector<HTMLElement>(`[data-lifecycle-card="${kind}"]`);
      expect(shell, `${kind} did not dispatch at all — this arm proves nothing`).not.toBeNull();
      expect(shell!.getAttribute("data-lifecycle-card-state")).not.toBeNull();
      expect(shell!.getAttribute("data-lifecycle-card-host")).toBeNull();
      expect(evaluateChatCarriage(observeChatCarriage(root, row, producingSlot), row).map(
        (v) => v.code,
      )).toContain("root_declaration_incomplete");
      mounted.unmount();
    }
  });

  it("a component that RETURNS NULL does not: an absent resolve draws no root", async () => {
    // §IV's `absent` is "no card DOM at all", and the review card honours it.
    // A row that could pass on it would be a row satisfied by nothing.
    resolveStub.restore();
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(RESOLVE_PATH)) {
        return new Response(
          JSON.stringify({ kind: "artifact_review_gate", state: { state: "absent" }, body: null }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const row = carriageRowFor("artifact_review_gate");
      const { root, producingSlot } = await mountKind("artifact_review_gate");
      expect(root.querySelector('[data-conformance-id="review-gate-card"]')).toBeNull();
      expect(
        evaluateChatCarriage(observeChatCarriage(root, row, producingSlot), row).map((v) => v.code),
      ).toContain("owner_root_absent");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("a card in the RUN CARD's subtree does not: it is another host's mount", async () => {
    const row = carriageRowFor("recommendation_hold");
    const { root, producingSlot } = await mountKind("recommendation_hold");
    const runCard = root.querySelector<HTMLElement>("[data-inline-run-card]");
    expect(runCard, "the inline run card did not mount at the agent_run slot").not.toBeNull();
    // Plant the row's own anchors INSIDE the run card, as a mislabeled-evidence
    // mount would. The observation must not see them.
    const planted = document.createElement("div");
    planted.setAttribute("data-lifecycle-card", "recommendation_hold");
    planted.setAttribute("data-lifecycle-card-host", "chat_thread");
    planted.setAttribute("data-lifecycle-card-state", "pending");
    planted.innerHTML =
      '<button data-action="confirm-run-recommendation"></button>' +
      '<button data-action="skip-run-recommendation"></button>';
    runCard!.appendChild(planted);
    const observation = observeChatCarriage(root, row, producingSlot);
    expect(observation.rootCandidates).toEqual([]);
    expect(evaluateChatCarriage(observation, row).map((v) => v.code)).toContain(
      "owner_root_absent",
    );
  });

  it("a card at ANOTHER slot does not: the position is part of the answer", async () => {
    const row = carriageRowFor("artifact_review_gate");
    const { root, producingSlot } = await mountKind("artifact_review_gate");
    const observation = observeChatCarriage(root, row, producingSlot);
    expect(evaluateChatCarriage(observation, row)).toEqual([]);
    // The SAME observation, judged against a different producing slot: the card
    // is unmoved and the verdict flips, so the slot check is live.
    const moved = evaluateChatCarriage(
      { ...observation, producingSlot: producingSlot + 1 },
      row,
    );
    expect(moved.map((v) => v.code)).toEqual(["root_off_producing_slot"]);
  });

  it("a declaration SPLIT over two elements does not", async () => {
    const row = carriageRowFor("artifact_review_gate");
    const { root, producingSlot } = await mountKind("artifact_review_gate");
    const card = root.querySelector<HTMLElement>('[data-conformance-id="review-gate-card"]')!;
    // Move the host declaration off the card's own root onto a child, leaving
    // two elements that agree by coincidence rather than one card saying what
    // it is. Nothing else changes.
    card.removeAttribute("data-lifecycle-card-host");
    const child = document.createElement("div");
    child.setAttribute("data-lifecycle-card-host", "chat_thread");
    card.appendChild(child);
    expect(
      evaluateChatCarriage(observeChatCarriage(root, row, producingSlot), row).map((v) => v.code),
    ).toEqual(["root_declaration_incomplete"]);
  });

  it("a card with the root but NO operable floor does not", async () => {
    const row = carriageRowFor("artifact_review_gate");
    const { root, producingSlot } = await mountKind("artifact_review_gate");
    const card = root.querySelector<HTMLElement>('[data-conformance-id="review-gate-card"]')!;
    for (const control of row.decisionControls) {
      for (const el of Array.from(card.querySelectorAll(control))) el.remove();
    }
    expect(
      evaluateChatCarriage(observeChatCarriage(root, row, producingSlot), row).map((v) => v.code),
    ).toEqual(["controls_absent"]);
  });
});

// ---------------------------------------------------------------------------
// 5. The turn-level list keeps what has no slot
// ---------------------------------------------------------------------------

describe("a view with no producing step", () => {
  it("stays a turn-level adjunct and still renders", async () => {
    // An A2A bridge part carries no `toolCallId`; the fold must not swallow it.
    const events = await driveSink("artifact_review_gate");
    const stripped: AgUiEvent[] = events.map((e) =>
      e.type === "DATA_PART" ? ({ ...e, toolCallId: undefined } as AgUiEvent) : e,
    );
    const assistant = projectConversationMessage(reduceAgUiEvents(stripped), {
      assistantId: "a1",
    });
    expect(assistant.dataParts).toEqual([
      {
        viewType: "artifact_review_gate",
        schemaVersion: 1,
        ref: REF_BY_KIND.artifact_review_gate,
      },
    ]);
    const parts = assistant.parts ?? [];
    expect(parts.some((p) => p.kind === "tool_call" && p.views !== undefined)).toBe(false);

    const mounted = await mountSurface("chat", {
      messages: [{ id: "u1", role: "user", content: "Do the thing" }, assistant],
    });
    const root = mounted.container.querySelector<HTMLElement>('[data-parity-surface="chat"]')!;
    await settleResolves();
    await waitFor(() =>
      expect(root.querySelector('[data-conformance-id="review-gate-card"]')).not.toBeNull(),
    );
    // Drawn ONCE, and not inside the trace's slotted containers.
    expect(root.querySelectorAll('[data-conformance-id="review-gate-card"]')).toHaveLength(1);
    expect(
      slotOf(root.querySelector('[data-conformance-id="review-gate-card"]')!),
    ).toBeNull();
  });
});
