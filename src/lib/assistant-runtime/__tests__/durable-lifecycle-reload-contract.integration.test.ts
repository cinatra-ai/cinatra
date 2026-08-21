/**
 * THE DURABLE STREAM → STORE → RELOAD CONTRACT (cinatra#2823, epic #2784 S9j).
 *
 * WHAT THIS PROVES, and why it needs a real database and a real DOM.
 *
 * A lifecycle card in the conversation is not drawn from the model's words. It is
 * minted by the SINK from a first-party tool result, carried on the AG-UI wire as
 * a DATA_PART, and re-drawn after a reload from whatever the server kept. The
 * failure this contract exists to make impossible is the one the plan records as
 * §2.3 row 5: *a card present live can be absent after a reload*. That is a
 * PERSISTENCE defect, not a renderer defect — so a test that stops at the wire,
 * or one that hands the renderer a transcript it wrote itself, cannot see it.
 *
 * So this drives the whole path, end to end, for every ruled carriage:
 *
 *   1. THE REAL SINK. `createAgUiSinkAdapter` — the shipped adapter — is driven
 *      with a real producing tool result: the reserved envelope built by the real
 *      `buildLifecycleViewEnvelope` for the three DATA_PART kinds, and the
 *      durable `agent_run` dispatch result for the recommendation case, which is
 *      deliberately NOT an envelope. Both the AG-UI events and `durableContent()`
 *      are captured from that one drive.
 *   2. THE REAL STORE. The user's turn lands through the shipped legacy-mirror
 *      PROJECTION — `buildAssistantThreadMirrorQueries`, run in one transaction
 *      with the org anchor and schema `upsertChatThreadInDatabase` passes it.
 *      Named precisely, because the seam matters: this tier drives the mirror
 *      the writer runs, NOT the writer wrapper. The wrapper is not importable
 *      here — `src/lib/__tests__/chat-capture-enqueue-hook.test.ts` records the
 *      same limit for the same reason ("importing database.ts pulls the full
 *      sync-pg module graph, which unit tests cannot boot"), and its lazy
 *      `require("@/lib/...")` of the builders is resolved by the BUNDLER, which
 *      no vitest alias governs. So the gap between "the mirror" and "the writer"
 *      is closed the way that suite closes its own: by the source-level tripwire
 *      `the shipped writer still runs the mirror this tier drives`, below, which
 *      reds the moment `upsertChatThreadInDatabase` stops composing this builder.
 *      What the wrapper adds on top is the artifact-ref pin sync (nothing to sync
 *      for an attachment-less transcript) and a post-commit chat-capture enqueue
 *      (a detection job) — neither on the path from a card to the screen.
 *      `/chat` persists the user message before it routes, so that save is the
 *      one that has already landed when the assistant turn begins. The assistant
 *      turn lands the way the STREAM ROUTE lands it: `appendAssistantTurn` +
 *      `updateAssistantTurn(…, { content: durableContent() })`. Nothing else
 *      writes.
 *   3. NO REDIS, NO CLIENT MEMORY. The reload is `reconstructThreadPayload` and
 *      nothing else. The AG-UI log is never read (it is Redis, and a reload does
 *      not have it); the client's own whole-transcript save is never made for the
 *      assistant turn, because that save is best-effort and silent
 *      (`packages/chat/src/conversation-services.ts`) and a contract that
 *      depended on it would be asserting the very thing that can be lost.
 *   4. THE REAL VIEW. What comes back is mounted through the shared surface
 *      harness — the same `ConversationColumn` `/chat` mounts — and the card is
 *      measured off the production DOM with the SAME per-kind carriage table the
 *      S9h anti-pattern gates use (`CHAT_THREAD_CARRIAGE_CONTRACT`).
 *
 * THE TEST NEVER CONSTRUCTS `UiMessage.parts` OR `UiMessage.dataParts`.
 * That is the whole methodological point and it is enforced below by
 * `refuseHandBuiltRenderState`, which fails the suite if any message reaching the
 * mount carries render state this file authored rather than the store returned.
 * The only message this file writes by hand is the USER's, which has neither
 * field — a hand-built assistant transcript would make the mount a fixture test
 * and would pass whether or not persistence works, which is exactly the shape
 * that let the gap survive.
 *
 * WHAT IS STUBBED, AND WHY THAT IS NOT THE THING UNDER TEST. The lifecycle card
 * re-resolves its AUTHORITATIVE state server-side from the persisted ref
 * (`/api/lifecycle-views/resolve`) — that is the S1 contract and a separate
 * seam. It is answered here by a stub that RECORDS which ref it was asked about,
 * which turns the stub into an assertion: the card must ask about exactly the ref
 * the sink minted, recovered from Postgres alone. The four modules the mounted
 * column reaches that belong to the server runtime are replaced exactly as the
 * chat package's own DOM suites replace them, for their stated reason: their
 * graphs reach server-only code, so without them the column does not mount at
 * all. Everything this contract measures stays real.
 *
 * LOCAL NOTE: this suite runs under `vitest.integration-2823.config.ts` (jsdom +
 * the chat package's alias set + a live Postgres). It is NOT in the root include.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import React from "react";
import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// ---------------------------------------------------------------------------
// The mounted column's server-runtime leaves, replaced exactly as the chat
// package's own DOM suites replace them (see `held-turn-transcript-contract`).
// The specifiers are spelled from THIS file; vitest resolves them to the same
// module ids the column imports relatively, so the replacement takes.
// ---------------------------------------------------------------------------
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

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/chat",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("../../../../packages/chat/src/pending-call-actions", () => ({
  listPendingToolConfirmations: async () => ({ rows: [] }),
  decidePendingToolCall: async () => ({ ok: true }),
}));
vi.mock("../../../../packages/chat/src/undo-actions", () => ({
  recentUndoableChangeSetForRunAction: async () => ({ changeSetId: null }),
}));
vi.mock("@/components/data-safety/undo-toast", () => ({
  undoDeepLink: (id: string) => `/objects?undo=${id}`,
}));
// The inline run card is the AG-UI run panel, whose graph reaches the server
// runtime. Replaced by a stand-in that declares the SAME `run_card` host the
// shipped panel declares and pins the runId it was mounted with, so the
// recommendation carriage's identity assertion is made against the production
// vocabulary rather than a marker invented here.
vi.mock("../../../../packages/chat/src/inline-agent-run-card", () => ({
  InlineAgentRunCard: ({ runId }: { runId: string }) =>
    React.createElement("div", {
      "data-lifecycle-card-host": "run_card",
      "data-inline-run-card": runId,
    }),
}));
vi.mock("../../../../packages/agents/src/server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
  getSkillsForAgentAction: vi.fn(async () => []),
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({})),
  confirmRunSkillSelectionAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../../../../packages/agents/src/run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: async () => ({ state: "none" }),
  confirmRunRecommendationAction: async () => ({ ok: true, dispatched: true }),
  skipRunRecommendationAction: async () => ({ ok: true, dispatched: true }),
}));

import {
  createAgUiSinkAdapter,
  extractAgentRunIdFromResult,
  type AgUiTurnDurableContent,
} from "@/lib/assistant-runtime/ag-ui-sink-adapter";
import {
  buildLifecycleViewEnvelope,
  LIFECYCLE_PRODUCER_SERVER_LABEL,
  type LifecycleViewType,
} from "@/lib/assistant-runtime/lifecycle-view-envelope";
import {
  appendAssistantTurn,
  createAssistantThread,
  getAssistantThread,
  reconstructThreadPayload,
  updateAssistantTurn,
} from "@/lib/assistant-thread-store";
import { buildAssistantThreadMirrorQueries } from "@/lib/project-inheritance";
import { postgresSchema, getPostgresConnectionString } from "@/lib/postgres-config";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import {
  CHAT_THREAD_CARRIAGE_CONTRACT,
  HELD_TURN_MOUNT_OBLIGATIONS,
  carriageRowFor,
  projectsOwnerCard,
  runIdOf,
  type ChatThreadCarriageRow,
  type ProjectedNode,
  type TurnProjection,
} from "@/lib/lifecycle/held-turn-card-contract";
import { mountSurface } from "../../../../packages/chat/src/__tests__/conversation-column-harness";
import { projectConversationMessage } from "../../../../packages/chat/src/ag-ui-chat-client";
import { reduceAgUiEvents } from "../../../../packages/chat/src/renderer/ag-ui-reducer";
import type { AgUiEvent } from "@cinatra-ai/agent-ui-protocol";
import type { UiMessage } from "../../../../packages/chat/src/types";
import { LIFECYCLE_VIEW_RESOLVE_PATH } from "../../../../packages/agents/src/lifecycle-card-runtime";

// ---------------------------------------------------------------------------
// The four carriages
// ---------------------------------------------------------------------------

/**
 * One carriage: a ruled lifecycle kind, the first-party tool whose result mints
 * it, and how that result is built.
 *
 * THE THREE ENVELOPE KINDS use the REAL producer builder, so the bytes the sink
 * recognizes are the bytes a lifecycle primitive really returns — a hand-written
 * JSON blob would let this suite pass against a recognizer that had drifted.
 *
 * THE RECOMMENDATION CASE IS DELIBERATELY NOT AN ENVELOPE. Its carriage is the
 * durable `agent_run` dispatch result (`{ runId, status }`), which the sink parses
 * with `extractAgentRunIdFromResult` and the S9h carriage contract reads back with
 * `runIdOf`. Both shipped readers are asserted against it below, so the shape is
 * pinned by the code that consumes it rather than by this file's opinion of it.
 */
type Carriage = {
  kind: ChatThreadCarriageRow["kind"];
  /** The first-party tool whose result mints this kind. */
  toolName: string;
  /** Deterministic per-kind prose, so the turn has a text part like a real one. */
  prose: string;
  /** Build the tool result; returns the serialized result and the identity in it. */
  build: () => { result: string; identity: string };
};

/** The opaque ref of a lifecycle envelope, per kind. Bounded, printable, unique. */
function refFor(viewType: LifecycleViewType): string {
  return `${viewType}:${randomUUID()}`;
}

function envelopeCarriage(
  viewType: LifecycleViewType,
  toolName: string,
  prose: string,
): Carriage {
  return {
    kind: viewType,
    toolName,
    prose,
    build: () => {
      const ref = refFor(viewType);
      const result = buildLifecycleViewEnvelope({ viewType, ref });
      if (result === null) {
        throw new Error(
          `buildLifecycleViewEnvelope refused a ${viewType} ref of ${ref.length} chars — ` +
            "the producer would emit nothing, so this carriage could not be driven at all",
        );
      }
      return { result, identity: ref };
    },
  };
}

const CARRIAGES: readonly Carriage[] = Object.freeze([
  envelopeCarriage(
    "artifact_review_gate",
    "artifact_review_gate_render",
    "I put the draft up for review.",
  ),
  envelopeCarriage(
    "trigger_schedule_proposal",
    "schedule_proposal_render",
    "Here is the schedule I would set.",
  ),
  envelopeCarriage(
    "verification_summary",
    "verification_record_render",
    "I checked the change against what the review authorized.",
  ),
  {
    kind: "recommendation_hold",
    toolName: "agent_run",
    prose: "I started the agent and it is waiting on you.",
    build: () => {
      const runId = randomUUID();
      // The durable dispatch answer, exactly as the held-dispatch turn persists
      // it. Not an envelope, by design: the run is genuinely blocked on the
      // answer, so this carriage is an INTERRUPT and its identity is the run.
      const result = JSON.stringify({ runId, status: "pending_input" });
      return { result, identity: runId };
    },
  },
]);

// ---------------------------------------------------------------------------
// 1. The real sink
// ---------------------------------------------------------------------------

type SinkDrive = {
  runId: string;
  toolCallId: string;
  /** The identity the producer minted: the envelope's ref, or the run's id. */
  identity: string;
  /** Every AG-UI event the adapter published, in order. */
  events: Array<Record<string, unknown>>;
  /** What the route would persist to `assistant_turns.content`. */
  durable: AgUiTurnDurableContent;
};

/**
 * Drive the SHIPPED sink adapter through one lifecycle turn and capture both of
 * its outputs from the SAME drive: the AG-UI wire and the durable content.
 *
 * Capturing both from one drive is load-bearing. If the wire were driven twice —
 * once for the events and once for the durable row — the two could disagree and
 * this suite would never notice, which is the failure mode it is here to catch:
 * the card on the wire and the card in the durable row must be the same card.
 */
async function driveTheRealSink(carriage: Carriage, threadId: string): Promise<SinkDrive> {
  const runId = randomUUID();
  const toolCallId = `call-${randomUUID()}`;
  const { result, identity } = carriage.build();
  const events: Array<Record<string, unknown>> = [];

  const adapter = createAgUiSinkAdapter({
    runId,
    threadId,
    publish: async (event) => {
      events.push(event as unknown as Record<string, unknown>);
    },
  });

  adapter.start();
  adapter.send("text", { content: carriage.prose });
  adapter.send("tool_call", {
    id: toolCallId,
    name: carriage.toolName,
    serverLabel: LIFECYCLE_PRODUCER_SERVER_LABEL,
  });
  adapter.send("tool_result", {
    id: toolCallId,
    name: carriage.toolName,
    serverLabel: LIFECYCLE_PRODUCER_SERVER_LABEL,
    resultLabel: `${carriage.toolName} ok`,
    result,
  });
  adapter.send("done", {});
  await adapter.drain();

  const durable = adapter.durableContent();
  if (durable === null) {
    throw new Error(
      `the sink produced no durable content for ${carriage.kind} — the turn had text and a tool round, ` +
        "so a null here is the adapter losing the whole turn, not this carriage being empty",
    );
  }
  return { runId, toolCallId, identity, events, durable };
}

/**
 * The renderable views a reloaded turn carries, split by WHERE it carries them.
 *
 * Position is part of the contract (cinatra#2823): a card the
 * sink stamped with its producing call must come back ON that `tool_call` part —
 * the mount the live render uses — and must be ABSENT from the turn-level list,
 * because the two mounts partition the turn's views so a card is drawn once.
 * Asserting "the ref is somewhere on the message" would pass for a card that
 * kept its content and lost its position, which is the defect this closes.
 */
function viewsCarriedBy(message: UiMessage): {
  turnLevel: Array<Record<string, unknown>>;
  atSlot: (toolCallId: string) => Array<Record<string, unknown>>;
} {
  return {
    turnLevel: (message.dataParts ?? []) as Array<Record<string, unknown>>,
    atSlot: (toolCallId: string) => {
      const part = (message.parts ?? []).find(
        (p) => p.kind === "tool_call" && p.id === toolCallId,
      );
      if (!part || part.kind !== "tool_call") return [];
      return (part.views ?? []) as Array<Record<string, unknown>>;
    },
  };
}

/** The DATA_PART payloads the wire carried, in order. */
function dataPartsOnTheWire(drive: SinkDrive): Array<Record<string, unknown>> {
  return drive.events
    .filter((e) => e.type === "DATA_PART")
    .map((e) => e.data as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// 2. The real store
// ---------------------------------------------------------------------------

const ORG_ID = "org-2823";
const OWNER_ID = "user-2823";

/**
 * Persist the turn the way PRODUCTION persists it, and no other way.
 *
 * The USER's message goes through the legacy-mirror writer because that is where
 * it really goes: `/chat` fires its whole-transcript save the moment the message
 * is sent, "before routing, before LLM call". So by the time the assistant turn
 * exists, the user's message is already durable.
 *
 * The ASSISTANT's turn goes through `appendAssistantTurn` +
 * `updateAssistantTurn(content)` because that is the stream route's own
 * persistence, and it is the ONLY server-side record of the turn. The
 * second whole-transcript save — the one that would carry the assistant turn
 * back down — is deliberately NOT made here: it is best-effort and silent, so a
 * card that survives only because it landed is a card that vanishes the first
 * time it does not.
 */
function persistThroughTheRealStore(args: {
  threadId: string;
  userText: string;
  runId: string;
  durable: AgUiTurnDurableContent;
}): { userMessage: { id: string; role: "user"; content: string } } {
  const now = new Date().toISOString();
  // A user message: no `parts`, no `dataParts`, nothing this file could use to
  // smuggle render state past the reload.
  const userMessage = { id: `u-${randomUUID()}`, role: "user" as const, content: args.userText };
  // THE MIRROR PROJECTION `upsertChatThreadInDatabase` RUNS, driven directly:
  // the same builder, the same schema, the same one transaction, with the org
  // anchor the wrapper would pass. It is NOT the wrapper itself — the describe
  // "the shipped writer still runs the mirror this tier drives" is what keeps
  // that sentence true rather than merely asserted.
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    transaction: true,
    queries: buildAssistantThreadMirrorQueries({
      schemaName: postgresSchema,
      thread: {
        id: args.threadId,
        title: args.userText,
        messages: [userMessage],
        createdAt: now,
        updatedAt: now,
        ownerUserId: OWNER_ID,
      },
      explicitMirrorOrgId: ORG_ID,
    }),
  });
  if (!getAssistantThread(args.threadId)) {
    // The mirror is the thread's first writer here; if it did not land there is
    // no thread to hang a turn on and the FK would say so less clearly.
    throw new Error(`the legacy-mirror writer did not create thread ${args.threadId}`);
  }
  const turn = appendAssistantTurn({
    threadId: args.threadId,
    runId: args.runId,
    role: "assistant",
    status: "running",
  });
  updateAssistantTurn(turn.id, { status: "completed", content: args.durable });
  return { userMessage };
}

/**
 * A LATER whole-transcript save that does not carry the assistant turn — the
 * stale/divergent tab of cinatra#2823 codex round 2, F2.
 *
 * The save is best-effort, silent and LAST-WRITER-WINS, and it posts the WHOLE
 * transcript. So a tab whose transcript never received the assistant turn can
 * still save a LATER user message on top of it, and the mirror reconcile will
 * happily write a spine that is no longer a prefix of the conversation: the turn
 * that is missing from it is one from the MIDDLE, not the end.
 *
 * Written through the same shipped mirror projection as the first save, so the
 * spine's own `created_at` stamps are the ones production would have — which is
 * the whole point of running this arm against a real database rather than
 * against a hand-timestamped fixture.
 */
function saveAStaleTranscriptCarryingALaterTurn(args: {
  threadId: string;
  keptMessages: Array<{ id: string; role: "user"; content: string }>;
  laterText: string;
}): { laterMessageId: string } {
  const now = new Date().toISOString();
  const laterMessage = { id: `u-${randomUUID()}`, role: "user" as const, content: args.laterText };
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    transaction: true,
    queries: buildAssistantThreadMirrorQueries({
      schemaName: postgresSchema,
      thread: {
        id: args.threadId,
        title: args.laterText,
        messages: [...args.keptMessages, laterMessage],
        createdAt: now,
        updatedAt: now,
        ownerUserId: OWNER_ID,
      },
      explicitMirrorOrgId: ORG_ID,
    }),
  });
  return { laterMessageId: laterMessage.id };
}

/**
 * A whole-transcript save that LANDS, carrying exactly the messages given.
 *
 * The same shipped mirror projection every other save in this file runs, so the
 * spine it writes is the spine production writes — including the reconcile
 * DELETE, which is what makes this helper serve the truncation arms too.
 */
function saveWholeTranscript(args: {
  threadId: string;
  messages: Array<Record<string, unknown>>;
  /**
   * The save's EXPLICIT truncation assertion (cinatra#2823):
   * the message ids this writer is saying the user removed. Omitted by every
   * ordinary save — a whole-transcript save asserts nothing about what it does
   * not carry, because it may simply never have had it.
   */
  removedMessageIds?: string[];
  /**
   * The TRANSPORT-VERIFIED writer the route derived. Defaults to the thread's
   * OWNER, which is what the save route derives for a personal thread — the only
   * shape where an assertion is self-harm. An arm naming someone else is naming
   * a SECOND writer, which is exactly what a team / unowned thread has.
   */
  actorUserId?: string;
  /** The thread's ownership axes, when an arm needs a shape other than the
   *  personal one every other arm uses. */
  ownership?: { ownerUserId?: string; teamId?: string };
}): void {
  const now = new Date().toISOString();
  const ownerUserId = args.ownership ? args.ownership.ownerUserId : OWNER_ID;
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    transaction: true,
    queries: buildAssistantThreadMirrorQueries({
      schemaName: postgresSchema,
      thread: {
        id: args.threadId,
        title: "slack thread",
        messages: args.messages,
        createdAt: now,
        updatedAt: now,
        ...(ownerUserId ? { ownerUserId } : {}),
        ...(args.ownership?.teamId ? { teamId: args.ownership.teamId } : {}),
        ...(args.removedMessageIds ? { removedMessageIds: args.removedMessageIds } : {}),
      },
      explicitMirrorOrgId: ORG_ID,
      actorUserId: args.actorUserId ?? OWNER_ID,
    }),
  });
}

/**
 * The assistant message a client's own whole-transcript save carries for a turn
 * it watched stream: the ordered trace's `tool_call` step and the turn's text,
 * and NO render state. That is the honest shape — the card the sink minted lives
 * in the run-bound durable row, and putting it on the spine by hand here would
 * make the reload arms pass without the store having kept anything.
 */
function savedAssistantMessageFor(drive: SinkDrive, carriage: Carriage): Record<string, unknown> {
  return {
    id: `a-${randomUUID()}`,
    role: "assistant" as const,
    content: drive.durable.content,
    parts: [
      {
        kind: "tool_call",
        id: drive.toolCallId,
        name: carriage.toolName,
        status: "completed",
      },
    ],
  };
}

/**
 * A SECOND run-bound turn on a thread that already exists — the stream route's
 * own persistence (`appendAssistantTurn` + `updateAssistantTurn`) and nothing
 * else. `persistThroughTheRealStore` cannot be called twice for this: its mirror
 * write carries a one-message transcript, so the second call would reconcile the
 * first turn's spine row away.
 */
function persistAnotherRunBoundTurn(args: {
  threadId: string;
  runId: string;
  durable: AgUiTurnDurableContent;
}): void {
  const turn = appendAssistantTurn({
    threadId: args.threadId,
    runId: args.runId,
    role: "assistant",
    status: "running",
  });
  updateAssistantTurn(turn.id, { status: "completed", content: args.durable });
}

/**
 * The turn the SHIPPED Slack projection builds for this drive.
 *
 * Built by folding the sink's OWN events through the shipped AG-UI reducer and
 * projecting the result with `slackMode: true` — the production path, not a
 * shape this file decided on. That is what makes the arms below a statement
 * about the two real records of one turn rather than about a fixture.
 */
function slackProjectionOf(drive: SinkDrive, assistantId: string): UiMessage {
  const state = reduceAgUiEvents(drive.events as unknown as AgUiEvent[]);
  return projectConversationMessage(state, { assistantId, slackMode: true });
}

// ---------------------------------------------------------------------------
// 3. The reload — no Redis, no client memory
// ---------------------------------------------------------------------------

/**
 * Everything a cold reload has: the structured store, read back.
 *
 * There is no second source in this function ON PURPOSE. Every other way a card
 * could reach the screen — the Redis AG-UI log, a live reducer, a client-held
 * transcript — is absent from a reload, so any of them appearing here would make
 * the assertion below untrue of the thing it claims to be about.
 */
function reloadWithNoRedisAndNoClientMemory(threadId: string): UiMessage[] {
  const payload = reconstructThreadPayload(threadId);
  if (payload === null) {
    throw new Error(
      `the reload found nothing for thread ${threadId} — the structured store reconstructed no payload at all`,
    );
  }
  const messages = payload.messages;
  if (!Array.isArray(messages)) {
    throw new Error("the reconstructed payload carries no messages array");
  }
  return messages as UiMessage[];
}

/**
 * The reloaded assistant turn, or `null` when the reload brought none back.
 *
 * IT RETURNS NULL RATHER THAN THROWING, deliberately. "The turn did not come
 * back" is the defect this contract is about, so it has to be a failing
 * ASSERTION inside the arm that asserts it — not an exception in a shared
 * helper, which would red every arm at once and leave the record unable to say
 * WHICH half broke. The wire arms below pass on a tree with no bridge at all;
 * only the reload arms turn red. That distinction is the whole red-on-main
 * record.
 */
function reloadedAssistantTurn(messages: UiMessage[]): UiMessage | null {
  const assistants = messages.filter((m) => m.role === "assistant");
  if (assistants.length !== 1) return null;
  return assistants[0];
}

/** Assert the turn came back at all, and narrow it for the arms that need it. */
function requireReloadedAssistantTurn(carried: Carried): UiMessage {
  expect(
    carried.assistant,
    `the reload brought back no assistant turn for ${carried.carriage.kind} — the durable turn the ` +
      "stream route persisted is not part of the reconstructed transcript, so its card cannot be redrawn " +
      `(roles back: ${carried.reloaded.map((m) => m.role).join(", ") || "none"})`,
  ).not.toBeNull();
  return carried.assistant as UiMessage;
}

// ---------------------------------------------------------------------------
// THE HAND-BUILT-RENDER-STATE REFUSAL
// ---------------------------------------------------------------------------

/**
 * The methodological gate, executed rather than promised.
 *
 * The issue's rule is that this test never constructs `UiMessage.parts` or
 * `UiMessage.dataParts` by hand. A rule like that is worth nothing as a promise
 * in a comment — the whole reason this gap survived is that a suite CAN hand its
 * renderer a transcript it wrote itself and still look like a passing contract.
 * So it is executed, in two directions:
 *
 *   1. THE MOUNTED TRANSCRIPT IS THE STORE'S. Read the thread back a SECOND
 *      time, from Postgres, with nothing in between, and require what is about
 *      to be mounted to equal it. A transcript this file had shaped — a part
 *      appended, a `dataParts` array supplied, a runId pinned — would not survive
 *      a fresh read, because the fresh read does not know about it.
 *   2. THIS FILE AUTHORS NO RENDER STATE AT ALL. The single message it does write
 *      is the user's, and a user message carries neither field. Asserted on every
 *      non-assistant message rather than assumed of the one.
 */
function refuseHandBuiltRenderState(mounted: UiMessage[], threadId: string): void {
  const secondRead = reloadWithNoRedisAndNoClientMemory(threadId);
  expect(
    mounted,
    "what is about to be mounted is not what a fresh read of the store returns — the transcript was shaped in this file",
  ).toEqual(secondRead);
  for (const message of mounted) {
    if (message.role === "assistant") continue;
    expect(
      message.parts === undefined && message.dataParts === undefined,
      `a ${message.role} message carries render state — this suite writes none, so it came from somewhere it should not have`,
    ).toBe(true);
  }
}

// ---------------------------------------------------------------------------
// 4. The real view
// ---------------------------------------------------------------------------

/** Refs the mounted cards asked the resolve endpoint about, in order. */
let resolveAsks: Array<{ viewType: string; ref: string }> = [];
let originalFetch: typeof globalThis.fetch;

/**
 * The authoritative-resolve seam, answered and RECORDED.
 *
 * A lifecycle card draws nothing until the server answers, so the mount needs an
 * answer; and what the card ASKED is the strongest available statement that the
 * ref survived — it is the persisted ref, read out of Postgres, travelling back
 * to the server through the real card. The stub therefore records every ask, and
 * the per-kind assertion reads it back.
 */
function installResolveStub(): void {
  originalFetch = globalThis.fetch;
  resolveAsks = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === LIFECYCLE_VIEW_RESOLVE_PATH) {
      let asked: { viewType?: unknown; ref?: unknown } = {};
      try {
        asked = JSON.parse(String(init?.body ?? "{}")) as { viewType?: unknown; ref?: unknown };
      } catch {
        /* recorded below as the empty ask it is */
      }
      resolveAsks.push({ viewType: String(asked.viewType ?? ""), ref: String(asked.ref ?? "") });
      const kind = String(asked.viewType ?? "artifact_review_gate");
      return json({
        kind,
        // `pending` for every kind: the card is open, so it draws. An `absent`
        // answer draws no DOM at all (§IV) and would make the mount assertion
        // measure the stub instead of the carriage.
        state: { state: "pending", canDecide: true, canComment: true },
        // Each kind gets the body IT is authorized to carry, because the shared
        // parse refuses anything else outright: the review kind draws from its
        // island and a body beside it is refused, while the other two fail closed
        // WITHOUT one. A stub that handed every kind the same answer would draw
        // no schedule card and the mount arm would read that as a carriage gap.
        body: RESOLVE_BODIES[kind] ?? null,
      });
    }
    // Everything else the column asks for is the harness's own business.
    return json({}, 404);
  }) as unknown as typeof fetch;
}

/**
 * The per-kind resolve BODY, in the shape each kind's own schema demands.
 *
 * `artifact_review_gate` is absent on purpose: its target arrives through the
 * review island, so the parse REFUSES a body beside it.
 */
const RESOLVE_BODIES: Record<string, unknown> = {
  // §VII — the verification kind fails closed without a reading.
  verification_summary: {
    version: 1,
    outcome: "verified",
    reviewedRevisionId: "rev-base",
    repairedRevisionId: "rev-fixed",
    scopePaths: ["content.title"],
    fieldDiff: [{ field: "content.title", before: "old", after: "new" }],
  },
  // §VI — the proposal card's pending body: the chosen option row, the duration
  // line and the Confirm floor.
  trigger_schedule_proposal: {
    phase: "proposal",
    version: 1,
    agentName: "Proof Agent",
    schedule: { kind: "scheduled", runAt: "2026-07-14T09:00", timezone: "Europe/Berlin" },
    durationCopy: "About 45s – 3.4 hr.",
    canConfirm: true,
    restrictedReason: null,
  },
};

/** Let the cards' own resolve effects settle before anything is measured. */
async function settleResolvers(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** Mount the production `/chat` column on the RELOADED transcript. */
async function mountReloadedChat(messages: UiMessage[]) {
  const mounted = await mountSurface("chat", { messages });
  const root = mounted.container.querySelector<HTMLElement>('[data-parity-surface="chat"]');
  if (!root) throw new Error("the chat surface did not mount");
  await settleResolvers();
  return root;
}

/**
 * The production DOM, read into the contract's own projection model.
 *
 * The conversation list renders one block per message; the assistant turn's block
 * is its SLOT. A node carrying an owner anchor is attributed to the slot whose
 * block contains it, so "the owner root under its slot" is measured rather than
 * assumed, and an anchor that turned up under the user's block — or nowhere —
 * reads as the absence it is.
 */
function projectionFromReloadedDom(
  root: HTMLElement,
  row: ChatThreadCarriageRow,
  messages: UiMessage[],
  drive: SinkDrive,
  carriage: Carriage,
): TurnProjection {
  const list = root.querySelector("[data-conversation-list]");
  if (!list) throw new Error("the reloaded transcript rendered no conversation list");
  const blocks = Array.from(list.children) as HTMLElement[];
  expect(
    blocks.length,
    "the reloaded transcript renders one block per reconstructed message",
  ).toBe(messages.length);

  const assistantSlot = messages.findIndex((m) => m.role === "assistant");
  expect(assistantSlot, "the reloaded transcript has an assistant block").toBeGreaterThanOrEqual(0);

  // The ordered parts of the turn, as the CONTRACT models them: the prose and
  // the durable tool result that triggered the card. Both are read off what came
  // back from the store, never off this file's inputs.
  const parts: TurnProjection["parts"] = [
    { kind: "text", slot: assistantSlot, text: carriage.prose },
    {
      kind: "tool_result",
      slot: assistantSlot,
      name: carriage.toolName,
      result: durableToolResultOf(drive.durable, drive.toolCallId),
    },
  ];

  const anchorsByEl = new Map<Element, string[]>();
  for (const selector of [...row.ownerAnchors, ...row.ruledRootAnchors]) {
    for (const el of Array.from(list.querySelectorAll(selector))) {
      anchorsByEl.set(el, [...(anchorsByEl.get(el) ?? []), selector]);
    }
  }
  const nodes: ProjectedNode[] = [];
  for (const [el, anchors] of anchorsByEl) {
    const slot = blocks.findIndex((b) => b === el || b.contains(el));
    nodes.push({
      anchors,
      slot: slot === -1 ? null : slot,
      insideSubtrees: row.foreignHostSubtrees.filter((s) => el.closest(s) !== null),
    });
  }
  return { parts, nodes };
}

/** The durable tool_result payload the sink kept for this call, if any. */
function durableToolResultOf(durable: AgUiTurnDurableContent, toolCallId: string): string | null {
  for (const part of durable.parts) {
    if (part.type === "tool_result" && part.id === toolCallId) {
      return typeof part.result === "string" ? part.result : null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** One carriage driven all the way through, cached so the arms share one drive. */
type Carried = {
  carriage: Carriage;
  threadId: string;
  drive: SinkDrive;
  reloaded: UiMessage[];
  /** `null` when the reload brought no assistant turn back — see below. */
  assistant: UiMessage | null;
};

const carried = new Map<string, Carried>();

async function carry(carriage: Carriage): Promise<Carried> {
  const cached = carried.get(carriage.kind);
  if (cached) return cached;
  const threadId = `thr-2823-${randomUUID()}`;
  const drive = await driveTheRealSink(carriage, threadId);
  persistThroughTheRealStore({
    threadId,
    userText: `Please handle the ${carriage.kind} case.`,
    runId: drive.runId,
    durable: drive.durable,
  });
  const reloaded = reloadWithNoRedisAndNoClientMemory(threadId);
  const value: Carried = {
    carriage,
    threadId,
    drive,
    reloaded,
    assistant: reloadedAssistantTurn(reloaded),
  };
  carried.set(carriage.kind, value);
  return value;
}

beforeAll(() => {
  // The store bootstraps its own DDL on first use; do it once, loudly, so a
  // provisioning failure is not mistaken for a persistence failure.
  const probe = `thr-2823-probe-${randomUUID()}`;
  createAssistantThread({ id: probe, ownerUserId: OWNER_ID, orgId: ORG_ID });
  expect(getAssistantThread(probe), "the store did not provision").not.toBeNull();
});

beforeEach(() => {
  installResolveStub();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  carried.clear();
});

describe("a stale save cannot push a turn out of its place in time", () => {
  // cinatra#2823 codex round 2, F2. The fold-in used to APPEND, on the claim
  // that the spine is always a PREFIX of the conversation. Nothing enforces that
  // claim: the whole-transcript save is last-writer-wins, so this arm builds the
  // spine production would actually have after a divergent tab saves — one that
  // carries a LATER user message but not the assistant turn between — and
  // requires the reload to put the turn back where the SERVER's clock says it
  // happened, not at the end.
  //
  // It runs on the real database ON PURPOSE: the placement is made against the
  // spine's own `assistant_turns.created_at`, which is written by the mirror
  // reconcile's SQL and deliberately preserved by its `ON CONFLICT DO UPDATE`.
  // A fixture with hand-written timestamps would prove the comparison and not
  // the thing being compared.
  it("folds the turn back into the MIDDLE of a spine that is no longer a prefix", async () => {
    const carriage = CARRIAGES[0];
    const threadId = `thr-2823-stale-${randomUUID()}`;
    const drive = await driveTheRealSink(carriage, threadId);
    const { userMessage } = persistThroughTheRealStore({
      threadId,
      userText: `Please handle the ${carriage.kind} case.`,
      runId: drive.runId,
      durable: drive.durable,
    });
    const { laterMessageId } = saveAStaleTranscriptCarryingALaterTurn({
      threadId,
      keptMessages: [userMessage],
      laterText: "and now something else entirely",
    });

    const reloaded = reloadWithNoRedisAndNoClientMemory(threadId);
    refuseHandBuiltRenderState(reloaded, threadId);
    const assistant = reloadedAssistantTurn(reloaded);
    expect(assistant, "the reload brought back no assistant turn at all").not.toBeNull();
    expect(reloaded.map((m) => m.id)).toEqual([userMessage.id, assistant!.id, laterMessageId]);
    // ...and the card it came back in the middle WITH is still the sink's own,
    // still at the step that produced it.
    expect(viewsCarriedBy(assistant!).atSlot(drive.toolCallId)).toEqual([
      { viewType: carriage.kind, schemaVersion: 1, ref: drive.identity },
    ]);
  });
});

describe("edit-and-resend does not resurrect the turns the user removed", () => {
  // cinatra#2823, reproduced for BOTH kinds of removal.
  //
  // The truncating save deletes MIRROR rows only — the reconcile DELETE is
  // scoped `id LIKE 'legacy:%'` so a legacy write can never delete a
  // runtime-minted row. The run-bound row therefore survives a truncation, and
  // the fold-in puts it back: ABOVE the edited prompt, because the run-bound
  // stamp is taken at run START while the edited message gets a fresh one. The
  // next whole-transcript save then writes it back down as a mirror row and the
  // resurrection is permanent.
  //
  // Every message here is written through the shipped mirror projection, so the
  // truncation is the real one: the same DELETE, the same predicate, the same
  // transaction production runs.
  it.each([
    ["the lifecycle-view carriage", 0],
    ["the agent_run pin carriage", 3],
  ])("the removed turn stays removed — %s", async (_label, index) => {
    const carriage = CARRIAGES[index];
    const threadId = `thr-2823-edit-${randomUUID()}`;
    const drive = await driveTheRealSink(carriage, threadId);
    const { userMessage } = persistThroughTheRealStore({
      threadId,
      userText: `Please handle the ${carriage.kind} case.`,
      runId: drive.runId,
      durable: drive.durable,
    });
    // The client's save LANDS, carrying the assistant turn — so the turn really
    // is in the transcript the user is about to edit.
    const assistantMessage = {
      id: `a-${randomUUID()}`,
      role: "assistant" as const,
      content: drive.durable.content,
      parts: [
        {
          kind: "tool_call",
          id: drive.toolCallId,
          name: carriage.toolName,
          status: "completed",
        },
      ],
    };
    saveWholeTranscript({ threadId, messages: [userMessage, assistantMessage] });
    expect(reloadWithNoRedisAndNoClientMemory(threadId).map((m) => m.role)).toEqual([
      "user",
      "assistant",
    ]);

    // EDIT AND RESEND: the user rewrites their prompt. The transcript from the
    // edit point down is gone, and the edited prompt is a NEW message with a
    // fresh stamp — later than the run-bound turn's, which is why the survivor
    // used to reappear ABOVE it.
    const editedPrompt = { id: `u-${randomUUID()}`, role: "user" as const, content: "actually, never mind" };
    // ...and it says so: the edit-and-resend path carries the ids it dropped
    // (round 4, F1), which is what distinguishes this from a stale tab's save.
    saveWholeTranscript({
      threadId,
      messages: [editedPrompt],
      removedMessageIds: [userMessage.id, assistantMessage.id],
    });

    const reloaded = reloadWithNoRedisAndNoClientMemory(threadId);
    expect(
      reloaded.map((m) => m.id),
      "a turn the user deleted by editing and resending came back — the truncating save removed the mirror row and left the run-bound row to fold in again",
    ).toEqual([editedPrompt.id]);
  });

  it("a LOST save still repairs — nothing was deleted, so nothing was superseded", () => {
    // The other side of the separation, and the reason it cannot be "the row is
    // absent from the payload". A save that never carried the assistant turn is
    // SILENT about it: it deletes nothing, so it asserts nothing, and the repair
    // this whole leg exists for still happens.
    const carriage = CARRIAGES[0];
    const threadId = `thr-2823-lost-${randomUUID()}`;
    return driveTheRealSink(carriage, threadId).then((drive) => {
      const { userMessage } = persistThroughTheRealStore({
        threadId,
        userText: `Please handle the ${carriage.kind} case.`,
        runId: drive.runId,
        durable: drive.durable,
      });
      // A LATER save that carries a new user message and STILL does not carry the
      // assistant turn — it never had it. It deletes nothing that was showing the
      // turn, so it supersedes nothing.
      const later = { id: `u-${randomUUID()}`, role: "user" as const, content: "and another thing" };
      saveWholeTranscript({ threadId, messages: [userMessage, later] });

      const reloaded = reloadWithNoRedisAndNoClientMemory(threadId);
      expect(reloaded.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
      expect(viewsCarriedBy(reloaded[1]).atSlot(drive.toolCallId)).toEqual([
        { viewType: carriage.kind, schemaVersion: 1, ref: drive.identity },
      ]);
    });
  });

  it("truncating a DIFFERENT message does not supersede an untouched turn", () => {
    // The tombstone is keyed on the identity the REMOVED rows carried, not on
    // "a truncation happened". A save that drops an unrelated message must leave
    // every other turn's repair exactly where it was.
    const carriage = CARRIAGES[0];
    const threadId = `thr-2823-othertrunc-${randomUUID()}`;
    return driveTheRealSink(carriage, threadId).then((drive) => {
      const { userMessage } = persistThroughTheRealStore({
        threadId,
        userText: `Please handle the ${carriage.kind} case.`,
        runId: drive.runId,
        durable: drive.durable,
      });
      const chatter = { id: `u-${randomUUID()}`, role: "user" as const, content: "ignore this one" };
      saveWholeTranscript({ threadId, messages: [userMessage, chatter] });
      // ...and now the user removes `chatter` alone. A real DELETE runs, and it
      // removes a row that never carried the assistant turn's identity.
      saveWholeTranscript({ threadId, messages: [userMessage] });

      const reloaded = reloadWithNoRedisAndNoClientMemory(threadId);
      expect(reloaded.map((m) => m.role)).toEqual(["user", "assistant"]);
      expect(viewsCarriedBy(reloaded[1]).atSlot(drive.toolCallId)).toEqual([
        { viewType: carriage.kind, schemaVersion: 1, ref: drive.identity },
      ]);
    });
  });
});

describe("a save can only tombstone a turn it ASSERTS the removal of", () => {
  // cinatra#2823 — the two holes in a payload-keyed tombstone.
  //
  // Reading "the mirror row is in the database and absent from THIS payload"
  // as the writer asserting a removal is wrong when the writer NEVER HAD
  // the row, and it reaches turns the writer never touched when the identities of
  // every removed row are pooled thread-wide. Both arms below are the shipped
  // mirror write, on a real database, through the same reconcile production runs.

  it("a STALE TAB's save cannot tombstone a turn it never observed", async () => {
    // F1. Tab B loaded before the turn existed; Tab A saved it. Tab B then saves
    // its own later message on a transcript that never had the turn in it. The
    // reconcile DELETE drops the mirror row all the same — that DELETE is keyed
    // on the payload, not on what this writer once knew — and round 3 read the
    // deletion as an assertion of removal. It is silence, and silence is exactly
    // the dropped save the fold-in exists to repair.
    const carriage = CARRIAGES[0];
    const threadId = `thr-2823-staletab-${randomUUID()}`;
    const drive = await driveTheRealSink(carriage, threadId);
    const { userMessage } = persistThroughTheRealStore({
      threadId,
      userText: `Please handle the ${carriage.kind} case.`,
      runId: drive.runId,
      durable: drive.durable,
    });
    // TAB A's save LANDS, carrying the turn: the mirror row for it now exists.
    saveWholeTranscript({
      threadId,
      messages: [userMessage, savedAssistantMessageFor(drive, carriage)],
    });
    expect(reloadWithNoRedisAndNoClientMemory(threadId).map((m) => m.role)).toEqual([
      "user",
      "assistant",
    ]);

    // TAB B — stale, and ASSERTING NOTHING. No edit happened; this is an ordinary
    // whole-transcript save from a realm whose transcript predates the turn.
    const fromTheStaleTab = {
      id: `u-${randomUUID()}`,
      role: "user" as const,
      content: "meanwhile, in the other tab",
    };
    saveWholeTranscript({ threadId, messages: [userMessage, fromTheStaleTab] });

    const reloaded = reloadWithNoRedisAndNoClientMemory(threadId);
    expect(
      reloaded.map((m) => m.role),
      "a stale tab permanently tombstoned a turn it never observed — the repair this whole leg exists for is now blocked, and the block is forever",
    ).toEqual(["user", "assistant", "user"]);
    expect(viewsCarriedBy(reloaded[1]).atSlot(drive.toolCallId)).toEqual([
      { viewType: carriage.kind, schemaVersion: 1, ref: drive.identity },
    ]);
  });

  it("a truncation does not tombstone a KEPT turn that re-renders the same lifecycle entity", async () => {
    // F2. A lifecycle `ref` names an ENTITY, not a turn, so a later turn can
    // legitimately re-render the same card. Round 3 pooled every removed row's
    // view refs thread-wide and accepted a ref match on the durable side
    // unconditionally — so removing the turn that drew the card LAST tombstoned
    // the untouched turn that drew it FIRST.
    const viewType = CARRIAGES[0].kind as LifecycleViewType;
    const sharedRef = refFor(viewType);
    const sharedEntity: Carriage = {
      ...CARRIAGES[0],
      build: () => {
        const result = buildLifecycleViewEnvelope({ viewType, ref: sharedRef });
        if (result === null) {
          throw new Error(`the producer refused the shared ${viewType} ref — this arm cannot be driven`);
        }
        return { result, identity: sharedRef };
      },
    };
    const threadId = `thr-2823-sharedref-${randomUUID()}`;

    // Y — the EARLIER turn, and the one the user KEEPS.
    const driveY = await driveTheRealSink(sharedEntity, threadId);
    const { userMessage: userY } = persistThroughTheRealStore({
      threadId,
      userText: "Put the first draft up for review.",
      runId: driveY.runId,
      durable: driveY.durable,
    });
    const assistantY = savedAssistantMessageFor(driveY, sharedEntity);
    saveWholeTranscript({ threadId, messages: [userY, assistantY] });

    // X — a LATER turn re-rendering the SAME entity through its OWN tool call.
    const userX = {
      id: `u-${randomUUID()}`,
      role: "user" as const,
      content: "show me that review gate again",
    };
    saveWholeTranscript({ threadId, messages: [userY, assistantY, userX] });
    const driveX = await driveTheRealSink(sharedEntity, threadId);
    persistAnotherRunBoundTurn({ threadId, runId: driveX.runId, durable: driveX.durable });
    // X's own save lands carrying the card it drew. THIS is the row whose view ref
    // the thread-wide pool used to reach Y with.
    const assistantXId = `a-${randomUUID()}`;
    const assistantX: Record<string, unknown> = {
      ...savedAssistantMessageFor(driveX, sharedEntity),
      id: assistantXId,
      dataParts: [{ viewType, schemaVersion: 1, ref: sharedRef }],
    };
    saveWholeTranscript({ threadId, messages: [userY, assistantY, userX, assistantX] });

    // THE TRUNCATION: the user edits `userX`, so X and its turn go. Y is untouched
    // and is not even adjacent to the edit point.
    const editedPrompt = {
      id: `u-${randomUUID()}`,
      role: "user" as const,
      content: "actually, never mind",
    };
    saveWholeTranscript({
      threadId,
      messages: [userY, assistantY, editedPrompt],
      removedMessageIds: [userX.id, assistantXId],
    });

    const reloaded = reloadWithNoRedisAndNoClientMemory(threadId);
    expect(
      reloaded.map((m) => m.id),
      "the removed turn came back, or the kept one did not — the truncation did not land as asserted",
    ).toEqual([userY.id, assistantY.id, editedPrompt.id]);
    expect(
      viewsCarriedBy(reloaded[1]).atSlot(driveY.toolCallId),
      "truncating a LATER turn tombstoned an UNTOUCHED earlier one, on a shared lifecycle ref alone",
    ).toEqual([{ viewType, schemaVersion: 1, ref: sharedRef }]);
  });
});

describe("a view ref names an ENTITY, so the tombstone keys on the CALL that drew it", () => {
  // The other half of the same key correction the reload matcher makes. Two turns
  // may legitimately draw the SAME lifecycle entity, so `viewType|ref` alone says
  // nothing about WHICH turn is speaking. The tombstone therefore keys on the
  // card's PRODUCING TOOL CALL — the slot stamp, which the removed mirror row
  // carries on the `tool_call` part it folded the card onto and the durable row
  // carries in `dataPartSlots`.
  //
  // The arm below isolates that: the removed row's card is SLOTTED on its own
  // call, and the kept turn draws the SAME entity from a DIFFERENT call. Nothing
  // links them but the entity, and the entity is not a link.

  it("truncating a turn whose SLOTTED card names an entity leaves another turn that drew the SAME entity", async () => {
    const viewType = CARRIAGES[0].kind as LifecycleViewType;
    const sharedRef = refFor(viewType);
    const sharedEntity: Carriage = {
      ...CARRIAGES[0],
      build: () => {
        const result = buildLifecycleViewEnvelope({ viewType, ref: sharedRef });
        if (result === null) {
          throw new Error(`the producer refused the shared ${viewType} ref — this arm cannot be driven`);
        }
        return { result, identity: sharedRef };
      },
    };
    const threadId = `thr-2823-slotkey-${randomUUID()}`;

    // Y — the earlier turn, KEPT. Its card is stamped with Y's OWN call.
    const driveY = await driveTheRealSink(sharedEntity, threadId);
    const { userMessage: userY } = persistThroughTheRealStore({
      threadId,
      userText: "Put the first draft up for review.",
      runId: driveY.runId,
      durable: driveY.durable,
    });
    const assistantY = savedAssistantMessageFor(driveY, sharedEntity);
    saveWholeTranscript({ threadId, messages: [userY, assistantY] });

    // X — a LATER turn re-rendering the SAME entity through its own call, and the
    // one the user removes. Its mirror row folds the card onto X's `tool_call`
    // part, which is the shape the slot-bound key reads.
    const userX = { id: `u-${randomUUID()}`, role: "user" as const, content: "show me that again" };
    saveWholeTranscript({ threadId, messages: [userY, assistantY, userX] });
    const driveX = await driveTheRealSink(sharedEntity, threadId);
    persistAnotherRunBoundTurn({ threadId, runId: driveX.runId, durable: driveX.durable });
    const baseX = savedAssistantMessageFor(driveX, sharedEntity);
    const assistantX: Record<string, unknown> = {
      ...baseX,
      parts: [{ ...(baseX.parts as Record<string, unknown>[])[0], views: [{ viewType, schemaVersion: 1, ref: sharedRef }] }],
    };
    // The two turns really do share the entity and NOT the call — otherwise this
    // arm would be testing the tool-call key it exists to look past.
    expect(driveX.toolCallId).not.toBe(driveY.toolCallId);
    saveWholeTranscript({ threadId, messages: [userY, assistantY, userX, assistantX] });

    const editedPrompt = { id: `u-${randomUUID()}`, role: "user" as const, content: "actually, never mind" };
    saveWholeTranscript({
      threadId,
      messages: [userY, assistantY, editedPrompt],
      removedMessageIds: [userX.id, assistantX.id as string],
    });

    const reloaded = reloadWithNoRedisAndNoClientMemory(threadId);
    expect(
      reloaded.map((m) => m.id),
      "the removed turn came back, or the kept one did not",
    ).toEqual([userY.id, assistantY.id, editedPrompt.id]);
    expect(
      viewsCarriedBy(reloaded[1]).atSlot(driveY.toolCallId),
      "a SLOTTED card's entity ref reached a turn that drew the same entity from a different call",
    ).toEqual([{ viewType, schemaVersion: 1, ref: sharedRef }]);
  });
});

describe("a tombstone is SELF-HARM ONLY — one writer cannot erase another's turns", () => {
  // The tombstone's whole licence is a claim about REACH: a false assertion costs
  // the writer the repair of its OWN turn and nothing else. That holds where a
  // thread has ONE writer. Two shapes do not:
  //
  //   * a TEAM-owned thread (`owner_user_id` null, `team_id` set) is writable by
  //     every member of the team's org;
  //   * a legacy UNOWNED thread (both null) is writable by anyone who reaches it.
  //
  // On either, one member's edit-and-resend would permanently supersede run-bound
  // rows belonging to turns another member is still reading — rows that are the
  // server's only copy of those turns. So the statement authorizes itself against
  // the thread row, in the write's own transaction, and refuses anywhere the
  // acting writer is not the thread's personal owner.
  //
  // Driven end-to-end: a real drive, a real run-bound row, the real mirror
  // builder, and the real reload. The assertion is on what came BACK.

  /** Drive one real turn into `threadId` and return the ids a truncation would
   *  have to name to remove it. */
  async function aRealTurnOn(threadId: string, ownership?: { ownerUserId?: string; teamId?: string }) {
    const carriage = CARRIAGES[0];
    const drive = await driveTheRealSink(carriage, threadId);
    const userMessage = {
      id: `u-${randomUUID()}`,
      role: "user" as const,
      content: `Please handle the ${carriage.kind} case.`,
    };
    const assistantMessage = {
      ...savedAssistantMessageFor(drive, carriage),
      id: `a-${randomUUID()}`,
    };
    // The whole-transcript save writes the thread row (with the ownership axes
    // this arm wants) and the mirror rows the truncation will read identity from.
    saveWholeTranscript({
      threadId,
      messages: [userMessage, assistantMessage],
      ownership,
      actorUserId: ownership ? "user-other" : undefined,
    });
    persistAnotherRunBoundTurn({ threadId, runId: drive.runId, durable: drive.durable });
    return { drive, carriage, userMessage, assistantMessage };
  }

  it("REFUSES a second writer's tombstone on a TEAM-owned thread — the reader's turn survives", async () => {
    const threadId = `thr-2823-team-${randomUUID()}`;
    const { drive, carriage, userMessage, assistantMessage } = await aRealTurnOn(threadId, {
      teamId: "team-2823",
    });

    // ANOTHER member of the team edits the user's message. Their save is
    // legitimate — a team thread is theirs to write — and it truncates the
    // transcript. What it may NOT do is permanently supersede the run-bound row
    // of a turn that is not theirs.
    const editedPrompt = { id: `u-${randomUUID()}`, role: "user" as const, content: "never mind" };
    saveWholeTranscript({
      threadId,
      messages: [editedPrompt],
      ownership: { teamId: "team-2823" },
      actorUserId: "user-a-different-member",
      removedMessageIds: [userMessage.id, assistantMessage.id],
    });

    const reloaded = reloadWithNoRedisAndNoClientMemory(threadId);
    // The mirror rows are gone — that writer's own transcript is theirs to
    // truncate — but the run-bound row was NOT tombstoned, so the server's copy
    // of the turn folds back in, card and all.
    const assistants = reloaded.filter((m) => m.role === "assistant");
    expect(
      assistants,
      "a team-mate's tombstone erased another writer's turn permanently",
    ).toHaveLength(1);
    expect(viewsCarriedBy(assistants[0]).atSlot(drive.toolCallId)).toEqual([
      { viewType: carriage.kind, schemaVersion: 1, ref: drive.identity },
    ]);
  });

  it("REFUSES a tombstone on a legacy UNOWNED thread — nobody there is harming only themselves", async () => {
    const threadId = `thr-2823-unowned-${randomUUID()}`;
    const { drive, carriage, userMessage, assistantMessage } = await aRealTurnOn(threadId, {});

    const editedPrompt = { id: `u-${randomUUID()}`, role: "user" as const, content: "never mind" };
    saveWholeTranscript({
      threadId,
      messages: [editedPrompt],
      ownership: {},
      actorUserId: "user-any-reader",
      removedMessageIds: [userMessage.id, assistantMessage.id],
    });

    const reloaded = reloadWithNoRedisAndNoClientMemory(threadId);
    const assistants = reloaded.filter((m) => m.role === "assistant");
    expect(
      assistants,
      "an unowned thread let one reader tombstone another's turn",
    ).toHaveLength(1);
    expect(viewsCarriedBy(assistants[0]).atSlot(drive.toolCallId)).toEqual([
      { viewType: carriage.kind, schemaVersion: 1, ref: drive.identity },
    ]);
  });

  it("REFUSES a non-owner's tombstone on a PERSONAL thread", async () => {
    // The same boundary from the other side: the thread has one owner, and a
    // writer who is not that owner cannot reach its rows either.
    const threadId = `thr-2823-personal-${randomUUID()}`;
    const { drive, carriage, userMessage, assistantMessage } = await aRealTurnOn(threadId);

    const editedPrompt = { id: `u-${randomUUID()}`, role: "user" as const, content: "never mind" };
    saveWholeTranscript({
      threadId,
      messages: [editedPrompt],
      actorUserId: "user-not-the-owner",
      removedMessageIds: [userMessage.id, assistantMessage.id],
    });

    const reloaded = reloadWithNoRedisAndNoClientMemory(threadId);
    expect(reloaded.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(viewsCarriedBy(reloaded.filter((m) => m.role === "assistant")[0]).atSlot(drive.toolCallId))
      .toEqual([{ viewType: carriage.kind, schemaVersion: 1, ref: drive.identity }]);
  });

  it("still lets the thread's OWNER tombstone their own turn — the positive control", async () => {
    // Without this the arms above would pass on a tombstone that never works at
    // all. The owner's own truncation must still land.
    const threadId = `thr-2823-selfharm-${randomUUID()}`;
    const { userMessage, assistantMessage } = await aRealTurnOn(threadId);

    const editedPrompt = { id: `u-${randomUUID()}`, role: "user" as const, content: "never mind" };
    saveWholeTranscript({
      threadId,
      messages: [editedPrompt],
      actorUserId: OWNER_ID,
      removedMessageIds: [userMessage.id, assistantMessage.id],
    });

    const reloaded = reloadWithNoRedisAndNoClientMemory(threadId);
    expect(
      reloaded.map((m) => m.id),
      "the owner's own removal did not stick",
    ).toEqual([editedPrompt.id]);
  });
});

describe("the truncation intent has to WIN the race, not merely run in it", () => {
  // cinatra#2823. The intent is carried by ONE save, and it used
  // to be posted fire-and-forget: `editAndResend` did not await it, and the rest
  // of the edit flow — the persistence effect on the truncated transcript, then
  // the save after the regenerated turn completes — kept going underneath it. So
  // the flow's OWN ordinary saves could reach the server FIRST.
  //
  // An ordinary save asserts nothing, but it is a whole-transcript save, so the
  // reconcile DELETE removes the truncated-away MIRROR rows all the same. And the
  // supersede reads the removed rows' identity OUT OF THOSE ROWS. Whichever save
  // commits first decides whether the removal is recorded at all.
  //
  // The orders below are DRIVEN, not raced: each save is a real, completed mirror
  // write issued in the order under test. No sleeps, no scheduling luck.

  it("the intent lands FIRST, and the flow's later ordinary saves cannot bring the turn back", async () => {
    // The order `editAndResend` now GUARANTEES (round 5): the intent save is
    // issued before the truncation reaches the screen and awaited before anything
    // else in the flow runs, and every same-tab save to a thread is chained
    // behind it (`saveChatThreadInOrder`). This arm is the server-side half of
    // that promise — once the tombstone is in, the flow's remaining saves are
    // ordinary whole-transcript writes and none of them undoes it.
    const carriage = CARRIAGES[0];
    const threadId = `thr-2823-intentfirst-${randomUUID()}`;
    const drive = await driveTheRealSink(carriage, threadId);
    const { userMessage } = persistThroughTheRealStore({
      threadId,
      userText: `Please handle the ${carriage.kind} case.`,
      runId: drive.runId,
      durable: drive.durable,
    });
    const assistantMessage = savedAssistantMessageFor(drive, carriage);
    saveWholeTranscript({ threadId, messages: [userMessage, assistantMessage] });
    expect(reloadWithNoRedisAndNoClientMemory(threadId).map((m) => m.role)).toEqual([
      "user",
      "assistant",
    ]);

    // THE EDIT — the intent first, and it is the save that truncates.
    const editedPrompt = { id: `u-${randomUUID()}`, role: "user" as const, content: "actually, never mind" };
    saveWholeTranscript({
      threadId,
      messages: [editedPrompt],
      removedMessageIds: [userMessage.id, String(assistantMessage.id)],
    });

    // ...then the flow's ordinary saves, which is what actually happens next:
    // the persistence effect on the truncated transcript, and the save after the
    // regenerated turn completes. Both assert nothing.
    saveWholeTranscript({ threadId, messages: [editedPrompt] });
    const regenerated = { id: `a-${randomUUID()}`, role: "assistant" as const, content: "sure, dropping it" };
    saveWholeTranscript({ threadId, messages: [editedPrompt, regenerated] });

    const reloaded = reloadWithNoRedisAndNoClientMemory(threadId);
    expect(
      reloaded.map((m) => m.id),
      "a later ordinary save from the edit flow resurrected the turn the intent had already tombstoned",
    ).toEqual([editedPrompt.id, regenerated.id]);
  });

  it("RESIDUAL: an ordinary save that lands FIRST destroys the evidence, and the server cannot recover", async () => {
    // WHY THIS ARM ASSERTS THE BAD OUTCOME. It is the reason the ordering above
    // is a FENCE and not a preference, and it is pinned so the fence cannot be
    // removed on the belief that the server would cope.
    //
    // The server cannot. A run-bound row and a truncated-away mirror row SHARE NO
    // KEY: the mirror row's id is `buildLegacyMirrorTurnId(threadId, messageId)`
    // and the run-bound row's is a `randomUUID()` the store mints — indeed
    // `appendAssistantTurn` REFUSES the `legacy:` namespace outright, so a legacy
    // id can never name a runtime row. The only link is the server-minted
    // identity both copies carry (tool-call ids, lifecycle `viewType|ref`), and
    // that lives in the mirror row's `content`. Once an assertion-free save has
    // DELETEd it there is nothing left in the schema to match on, and every way
    // to act anyway — matching on `run_id`, or on created_at order, or on tokens
    // the client asserts about rows the server can no longer corroborate — widens
    // the tombstone past the asserted-AND-absent intersection round 4 fixed it
    // down to. So the fix is that this order does not happen (round 5, direction
    // 1), not that it is survivable.
    //
    // IF THIS ARM EVER GOES GREEN the schema grew a link it does not have today,
    // and the client-side fence can be reconsidered on purpose rather than by
    // accident.
    const carriage = CARRIAGES[0];
    const threadId = `thr-2823-lateintent-${randomUUID()}`;
    const drive = await driveTheRealSink(carriage, threadId);
    const { userMessage } = persistThroughTheRealStore({
      threadId,
      userText: `Please handle the ${carriage.kind} case.`,
      runId: drive.runId,
      durable: drive.durable,
    });
    const assistantMessage = savedAssistantMessageFor(drive, carriage);
    saveWholeTranscript({ threadId, messages: [userMessage, assistantMessage] });

    const editedPrompt = { id: `u-${randomUUID()}`, role: "user" as const, content: "actually, never mind" };
    // The assertion-free save gets there first and takes the mirror rows with it.
    saveWholeTranscript({ threadId, messages: [editedPrompt] });
    // The intent arrives to rows that are already gone.
    saveWholeTranscript({
      threadId,
      messages: [editedPrompt],
      removedMessageIds: [userMessage.id, String(assistantMessage.id)],
    });

    const reloaded = reloadWithNoRedisAndNoClientMemory(threadId);
    // The edited-away turn is back, and ABOVE the edited prompt — the run-bound
    // stamp is taken at run START, the edited message gets a fresh one.
    expect(
      reloaded.map((m) => m.role),
      "the server RECOVERED a truncation whose evidence a prior save destroyed — the schema grew a link it did not have; re-read the client-side ordering fence in editAndResend, it may no longer be the only thing holding this",
    ).toEqual(["assistant", "user"]);
    expect(reloaded[1].id).toBe(editedPrompt.id);
    expect(viewsCarriedBy(reloaded[0]).atSlot(drive.toolCallId)).toEqual([
      { viewType: carriage.kind, schemaVersion: 1, ref: drive.identity },
    ]);
  });
});

describe("a reloaded card lands at its slot, and a pre-slot row still lands at turn level", () => {
  // The sequencing directive (cinatra#2823; #2879's named follow-up). The merge-forward gave the SLOT an event-level argument so the
  // live render draws a card inside its producing step. The durable row now
  // records that same stamp OUT OF BAND — `dataPartSlots`, a sibling array,
  // never inside the strict payload, which a reload would re-emit as payload and
  // the parser would reject — and the reload projection re-attaches the card to
  // its producing part. Live and reload stop diverging.
  it("carries the slot from the sink's own drive through Postgres to the part", async () => {
    const carriage = CARRIAGES[0];
    const threadId = `thr-2823-slot-${randomUUID()}`;
    const drive = await driveTheRealSink(carriage, threadId);
    // The stamp the SINK recorded, out of band, on the row the route persists.
    expect(drive.durable.dataPartSlots).toEqual([drive.toolCallId]);
    // ...and the payload it sits beside is untouched — still the strict object.
    expect(drive.durable.dataParts).toEqual([
      { viewType: carriage.kind, schemaVersion: 1, ref: drive.identity },
    ]);

    persistThroughTheRealStore({
      threadId,
      userText: `Please handle the ${carriage.kind} case.`,
      runId: drive.runId,
      durable: drive.durable,
    });
    const reloaded = reloadWithNoRedisAndNoClientMemory(threadId);
    const assistant = reloadedAssistantTurn(reloaded)!;
    const views = viewsCarriedBy(assistant);
    expect(views.atSlot(drive.toolCallId)).toEqual([
      { viewType: carriage.kind, schemaVersion: 1, ref: drive.identity },
    ]);
    expect(views.turnLevel).toEqual([]);
  });

  it("a PRE-SLOT durable row still folds in at TURN LEVEL, exactly as today", async () => {
    // Every row already in the table, written before this field existed. The new
    // placement is opt-in on the WRITER, never a re-interpretation of what is
    // already persisted — so the row is written here with the slot array struck,
    // which is byte-for-byte what the previous sink produced.
    const carriage = CARRIAGES[0];
    const threadId = `thr-2823-preslot-${randomUUID()}`;
    const drive = await driveTheRealSink(carriage, threadId);
    const preSlot = { ...drive.durable };
    delete preSlot.dataPartSlots;

    persistThroughTheRealStore({
      threadId,
      userText: `Please handle the ${carriage.kind} case.`,
      runId: drive.runId,
      durable: preSlot,
    });
    const reloaded = reloadWithNoRedisAndNoClientMemory(threadId);
    const assistant = reloadedAssistantTurn(reloaded)!;
    const views = viewsCarriedBy(assistant);
    expect(views.turnLevel).toEqual([
      { viewType: carriage.kind, schemaVersion: 1, ref: drive.identity },
    ]);
    expect(views.atSlot(drive.toolCallId)).toEqual([]);
    // ...and it still mounts: the pre-slot placement is a position change, never
    // a card lost.
    const root = await mountReloadedChat(reloaded);
    expect(
      projectsOwnerCard(
        projectionFromReloadedDom(root, carriageRowFor(carriage.kind), reloaded, drive, carriage),
        carriageRowFor(carriage.kind),
      ),
    ).toBe(true);
  });
});

describe("a SLACK-MODE turn whose save SUCCEEDED is not folded in twice", () => {
  // cinatra#2823 — RE-VERIFIED at the merge-forward, where the shape has moved
  // and the defect has not.
  //
  // The reviewer's reading (at `b1aaa66e`) was that the Slack projection "omits
  // `parts` and keeps `dataParts`", so a Slack turn carried the card's own
  // `viewType|ref` but no tool-call id to match on. Since S9i (#2879) it carries
  // NEITHER: a stamped view is folded onto its producing `tool_call` PART, and
  // the Slack branch is a whole-turn atomic reveal that omits `parts` outright.
  // So the only server-minted identity a Slack turn still records is the
  // tool-call id inside `thoughtGroups` — which is what the match now reads.
  //
  // The duplicate the reviewer reproduced is unchanged either way: unmatchable
  // means the save reads as one that never happened, and the server's own copy
  // folds in beside a turn that is already on screen.
  //
  // NOTHING HERE IS HAND-BUILT: the spine turn is produced by the SHIPPED Slack
  // projection over the SHIPPED reducer, fed the sink's own events from the same
  // drive that produced the durable row — the two real records of one turn.
  it.each([
    ["the lifecycle-view carriage", 0],
    ["the agent_run pin carriage", 3],
  ])("reloads the reviewer's three-message thread as TWO messages — %s", async (_label, index) => {
    const carriage = CARRIAGES[index];
    const threadId = `thr-2823-slack-${randomUUID()}`;
    const drive = await driveTheRealSink(carriage, threadId);
    const slackTurn = slackProjectionOf(drive, `a-slack-${randomUUID()}`);
    // The Slack layout really is partless — if that ever stops being true this
    // arm stops testing what it says it tests.
    expect(
      slackTurn.parts,
      "the Slack projection grew a `parts` key — this arm is about the layout that has none",
    ).toBeUndefined();

    const { userMessage } = persistThroughTheRealStore({
      threadId,
      userText: `Please handle the ${carriage.kind} case.`,
      runId: drive.runId,
      durable: drive.durable,
    });
    // The client's whole-transcript save LANDS, carrying the Slack turn.
    saveWholeTranscript({ threadId, messages: [userMessage, slackTurn] });

    const reloaded = reloadWithNoRedisAndNoClientMemory(threadId);
    expect(
      reloaded.map((m) => m.id),
      "the reload duplicated a turn whose save SUCCEEDED — the Slack-projected turn could not be matched to its own durable row",
    ).toEqual([userMessage.id, slackTurn.id]);
    // ...and the card is drawn ONCE. There is one assistant turn to draw it on.
    expect(reloaded.filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  it("still repairs a Slack-mode turn whose save never landed", () => {
    // The other half of the same discipline, and the reason the match is widened
    // rather than the fold-in narrowed: a save that never carried the assistant
    // turn is SILENT about it, and silence is exactly what this leg repairs. The
    // spine here holds the user's message alone.
    const carriage = CARRIAGES[0];
    const threadId = `thr-2823-slackdrop-${randomUUID()}`;
    return driveTheRealSink(carriage, threadId).then((drive) => {
      const { userMessage } = persistThroughTheRealStore({
        threadId,
        userText: `Please handle the ${carriage.kind} case.`,
        runId: drive.runId,
        durable: drive.durable,
      });
      const reloaded = reloadWithNoRedisAndNoClientMemory(threadId);
      expect(reloaded.map((m) => m.role)).toEqual(["user", "assistant"]);
      expect(reloaded[0].id).toBe(userMessage.id);
      expect(viewsCarriedBy(reloaded[1]).atSlot(drive.toolCallId)).toEqual([
        { viewType: carriage.kind, schemaVersion: 1, ref: drive.identity },
      ]);
    });
  });
});

describe("the shipped writer still runs the mirror this tier drives", () => {
  // The one claim in this file that its own drive cannot make (see §2 of the
  // header): the tier persists the user's turn through
  // `buildAssistantThreadMirrorQueries`, and the sentence "that is what
  // production writes" is only true while `upsertChatThreadInDatabase` composes
  // that same builder. SOURCE-LEVEL, exactly as
  // `src/lib/__tests__/chat-capture-enqueue-hook.test.ts` pins its own
  // chokepoint property and for the identical stated reason — importing
  // database.ts pulls the full sync-pg graph, and its builder reach is a lazy
  // `require()` the bundler resolves and no vitest alias does. The point is not
  // to re-test the builder; it is that this file can no longer describe a seam
  // it has quietly stopped sharing with production.
  it("upsertChatThreadInDatabase still composes buildAssistantThreadMirrorQueries", () => {
    const source = readFileSync(path.join(process.cwd(), "src/lib/database.ts"), "utf8");
    const fnStart = source.indexOf("export function upsertChatThreadInDatabase(");
    expect(fnStart).toBeGreaterThan(-1);
    // Bounded to this function, so an unrelated call site cannot satisfy it.
    const nextExport = source.indexOf("\nexport function", fnStart + 1);
    const body = source.slice(fnStart, nextExport === -1 ? undefined : nextExport);
    expect(body).toContain("buildAssistantThreadMirrorQueries({");
    // ...and still runs it in ONE transaction, which is the other half of what
    // `persistThroughTheRealStore` reproduces.
    expect(body).toContain("transaction: true");
  });

  it("edit-and-resend is the ONLY /chat save that asserts a truncation", () => {
    // The other half of the same seam, and the same kind of claim: the server
    // tombstones ONLY under an explicit `removedMessageIds`, so the deliberate
    // edit keeps working only while the edit path keeps carrying it — and a stale
    // tab stays harmless only while no OTHER save carries it. Source-level for
    // the reason the arm above is: driving the handler here would pull a graph
    // this tier has no business booting. The flow now lives in its own module
    // (`packages/chat/src/message-edit-flow.ts`), so both halves are read there —
    // and the "no other save" half is checked across the WHOLE /chat surface,
    // which is a stronger statement than the single-file one it replaces.
    const flow = readFileSync(
      path.join(process.cwd(), "packages/chat/src/message-edit-flow.ts"),
      "utf8",
    );
    expect(flow).toContain("export async function editAndResend(");
    // It derives the assertion from the truncation it just performed — the edited
    // message and every successor, plus any turn still streaming — rather than
    // restating a list by hand.
    expect(flow).toContain(
      "const removedMessageIds = buildTruncationIntent(messages, idx, deps.streamingAssistantIds());",
    );
    // ...and posts it with the truncated transcript, in the same save.
    expect(flow).toContain("messages: truncated");
    expect(flow).toContain("removedMessageIds }");
    // NO OTHER /chat SAVE MENTIONS IT. If an ordinary whole-transcript save ever
    // carried this field, every stale tab would be asserting removals again and
    // the defect would be back with a different first line. Comments are stripped
    // first: the save chain DOCUMENTS the intent it exists to order, and prose
    // about a field is not a writer of it.
    const stripComments = (text: string) =>
      text
        .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
        .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
    const surface = ["chat-page.tsx", "ag-ui-chat-client.ts", "chat-routing.ts", "actions.ts"];
    for (const file of surface) {
      const src = stripComments(readFileSync(path.join(process.cwd(), "packages/chat/src", file), "utf8"));
      expect(src, `${file} carries a truncation assertion`).not.toContain("removedMessageIds");
    }
  });

  it("edit-and-resend WAITS for its truncation intent before it changes anything", () => {
    // The other half of the same claim: carrying the intent is not enough if the
    // flow's own ordinary saves can overtake it. The RESIDUAL arm above shows
    // what the server does when they do — nothing, because it cannot — so this
    // ordering IS the fix, and it is pinned where the ordering lives. The flow is
    // its own module now; the page it was lifted out of is still checked for the
    // unordered-save escape hatch. The behaviour of the chain itself is driven
    // for real in `packages/chat/src/__tests__/chat-persistence.test.ts`.
    const body = readFileSync(
      path.join(process.cwd(), "packages/chat/src/message-edit-flow.ts"),
      "utf8",
    );
    const page = readFileSync(
      path.join(process.cwd(), "packages/chat/src/chat-page.tsx"),
      "utf8",
    );

    // EVERY /chat save goes through the per-thread chain. An unordered save could
    // be POSTed alongside the intent and commit first — which is the whole defect.
    expect(body).not.toContain("saveChatThreadViaFetch(");
    expect(page).not.toContain("saveChatThreadViaFetch(");

    // The intent save is AWAITED, and retried once INSIDE its chain slot (a
    // re-enqueued retry could land behind a save issued after it).
    const intentSaveAt = body.indexOf("await saveChatThreadInOrder(");
    expect(intentSaveAt).toBeGreaterThan(-1);
    expect(body.slice(intentSaveAt)).toContain("{ attempts: 2 }");

    // NOTHING IRREVERSIBLE HAPPENS BEFORE IT LANDS: the truncation does not reach
    // the screen, and the regeneration does not start.
    const truncationOnScreenAt = body.indexOf("setMessages(truncated)");
    expect(truncationOnScreenAt).toBeGreaterThan(intentSaveAt);
    for (const regenerate of ["await streamResponse(truncated)", "void streamResponse(truncated,"]) {
      expect(body.indexOf(regenerate)).toBeGreaterThan(intentSaveAt);
    }

    // ...and a failed intent does not degrade silently: it stops the flow and
    // says so on a never-blank bubble, the fail-closed affordance this file
    // already uses for a turn it refuses to dispatch.
    const failurePath = body.slice(body.indexOf("} catch (err) {", intentSaveAt), truncationOnScreenAt);
    expect(failurePath).toContain("error:");
    expect(failurePath).toContain("return;");
  });
});

describe("the ruled carriage table is the one this contract drives", () => {
  it("covers every chat_thread carriage, with no kind added or dropped", () => {
    expect(CARRIAGES.map((c) => c.kind).sort()).toEqual(
      CHAT_THREAD_CARRIAGE_CONTRACT.map((r) => r.kind).sort(),
    );
  });
});

describe.each(CARRIAGES.map((c) => [c.kind, c] as const))(
  "the %s carriage survives stream → store → reload",
  (_kind, carriage) => {
    it("the sink mints the card on the wire from the producing tool result", async () => {
      const { drive } = await carry(carriage);
      const wire = dataPartsOnTheWire(drive);
      if (carriage.kind === "recommendation_hold") {
        // Not an envelope: the sink parses the dispatch answer and pins the run.
        expect(wire).toEqual([
          { kind: "agent_run", toolCallId: drive.toolCallId, runId: drive.identity },
        ]);
        expect(extractAgentRunIdFromResult(
          durableToolResultOf(drive.durable, drive.toolCallId),
        )).toBe(drive.identity);
        return;
      }
      expect(wire).toEqual([
        { viewType: carriage.kind, schemaVersion: 1, ref: drive.identity },
      ]);
    });

    it("the reloaded transcript carries the identical runId/ref, from Postgres alone", async () => {
      const carried = await carry(carriage);
      const { drive } = carried;
      const assistant = requireReloadedAssistantTurn(carried);
      if (carriage.kind === "recommendation_hold") {
        // The run's identity comes back on the durable `agent_run` part, which is
        // what the transcript renders the run card from — and `runIdOf`, the
        // shipped contract reader, agrees with what the sink pinned on the wire.
        const toolPart = (assistant.parts ?? []).find(
          (p) => p.kind === "tool_call" && p.name === "agent_run",
        );
        expect(toolPart, "the reloaded turn carries its durable agent_run part").toBeDefined();
        expect(toolPart && toolPart.kind === "tool_call" ? toolPart.runId : null).toBe(
          drive.identity,
        );
        expect(runIdOf(durableToolResultOf(drive.durable, drive.toolCallId))).toBe(drive.identity);
        return;
      }
      // AT ITS PRODUCING SLOT, and only there. The sink stamped the card with the
      // call that minted it; the durable row records that stamp out of band
      // (`dataPartSlots`) and the reload projection puts the card back on that
      // part — the same mount the live render uses. A reloaded card that landed
      // in the turn-level list instead would keep its content and lose its
      // position, which is what #2879's follow-up named.
      const views = viewsCarriedBy(assistant);
      expect(
        views.atSlot(drive.toolCallId),
        `the reloaded ${carriage.kind} turn draws no card at the call that produced it — the card lost its position`,
      ).toEqual([{ viewType: carriage.kind, schemaVersion: 1, ref: drive.identity }]);
      expect(
        views.turnLevel,
        "the card is ALSO in the turn-level list — the two mounts must partition, or it draws twice",
      ).toEqual([]);
    });

    it("the real chat view projects the owner root under the turn's own slot", async () => {
      const carried = await carry(carriage);
      const { drive, reloaded } = carried;
      requireReloadedAssistantTurn(carried);
      refuseHandBuiltRenderState(reloaded, carried.threadId);
      const row = carriageRowFor(carriage.kind);
      const root = await mountReloadedChat(reloaded);
      const projection = projectionFromReloadedDom(root, row, reloaded, drive, carriage);

      // The recommendation hold's chat_thread MOUNT has not landed (S9k/S9l own
      // it), so its expectation is read from the SAME ratchet the S9h gates use
      // rather than asserted flat. The day that mount lands and the row is
      // struck, this arm starts asserting the card without an edit here — and a
      // row struck without the mount reds immediately.
      const mountIsOwed = HELD_TURN_MOUNT_OBLIGATIONS.includes(carriage.kind);
      expect(
        projectsOwnerCard(projection, row),
        mountIsOwed
          ? `${row.owner}'s chat mount is still on HELD_TURN_MOUNT_OBLIGATIONS — if it now mounts, strike the row`
          : `the reloaded transcript did not project ${row.owner} at the assistant turn's own slot`,
      ).toBe(!mountIsOwed);

      if (carriage.kind === "recommendation_hold") {
        // What S9j DOES owe this carriage: the durable run identity reaches the
        // ruled run_card mount in the reloaded turn. The hold card's own mount is
        // the next slice's; the persistence beneath it is this one's.
        const pinned = root.querySelector(`[data-inline-run-card="${drive.identity}"]`);
        expect(
          pinned,
          "the reloaded turn did not mount the run card on the persisted runId",
        ).not.toBeNull();
      }
    });

    it("the card re-asks the server about exactly the persisted ref", async () => {
      if (carriage.kind === "recommendation_hold") {
        // No authoritative-resolve seam: this carriage is an interrupt, and its
        // identity assertion is the run-card mount above.
        return;
      }
      const carried = await carry(carriage);
      const { drive, reloaded } = carried;
      requireReloadedAssistantTurn(carried);
      await mountReloadedChat(reloaded);
      expect(resolveAsks).toContainEqual({
        viewType: carriage.kind,
        ref: drive.identity,
      });
    });
  },
);
