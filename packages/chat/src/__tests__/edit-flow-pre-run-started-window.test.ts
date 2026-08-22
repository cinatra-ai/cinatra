/**
 * THE PRE-`RUN_STARTED` WINDOW, CLOSED THROUGH THE EDIT FLOW (cinatra#2823 S9j).
 *
 * `/chat` registers a turn BEFORE it dispatches (`beginStream`) and learns the
 * server's name for it only at `RUN_STARTED`. Slack mode is exactly the mode
 * that lets a reader edit while a turn streams, so an edit can be dispatched
 * INSIDE that handshake: it removes the turn's anchor prompt while the turn has
 * no run to assert, the run arrives a moment later, and no later edit's removed
 * set can ever carry that prompt again — the transcript no longer has it. The
 * turn's run-bound row stays live and folds back in above the edited prompt on
 * every reload, permanently, which is the pre-cinatra#2823 behaviour for exactly
 * those turns.
 *
 * THE CLOSE IS A DEFERRAL. The flow holds its truncation intent until every turn
 * it would name by RUN has settled that identity — `RUN_STARTED` arrived, or the
 * stream terminated without one — and only then builds and posts the save. The
 * anchor filter is untouched: a held turn is by construction anchored to a
 * prompt THIS edit removes, so it is a turn below the edit point, and a turn
 * whose prompt the edit KEPT is never waited on and never offered. Nothing is
 * condemned and no latch outlives the edit, so the over-reach the anchor exists
 * to prevent — tombstoning a visible turn that revealed after the truncation —
 * is not re-introduced.
 *
 * These arms drive the REAL `editAndResend` against the REAL registry, with the
 * window held open by construction rather than raced into: the run is reported
 * only after the flow has started and is provably still holding.
 *
 * LOCAL NOTE: this suite runs under the chat package's own vitest config.
 *
 *   pnpm --filter @cinatra-ai/chat exec vitest run \
 *     src/__tests__/edit-flow-pre-run-started-window.test.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const saved: Array<Record<string, unknown>> = [];

vi.mock("../ag-ui-chat-client", () => ({
  saveChatThreadInOrder: vi.fn(async (thread: Record<string, unknown>) => {
    saved.push(thread);
  }),
  generateId: (() => {
    let n = 0;
    return () => `gen-${++n}`;
  })(),
  deriveThreadTitle: (s: string) => s.slice(0, 20),
}));

vi.mock("../actions", () => ({
  resolveMessageRouting: vi.fn(async () => ({ shouldCallLlm: true })),
}));

vi.mock("../chat-routing", () => ({
  applyExternalMentionsToMessages: vi.fn((prev: unknown) => prev),
}));

import { editAndResend, type EditAndResendDeps } from "../message-edit-flow";
import { createTurnStreamRegistry, type TurnStreamRegistry } from "../turn-stream-registry";
import type { UiMessage as Message } from "../types";

const msg = (id: string, role: "user" | "assistant"): Message =>
  ({ id, role, content: id }) as Message;

/** u1 · a1 · u2 — the reader edits `u2` while a turn dispatched for `u2` is
 *  still inside its handshake. */
const SNAPSHOT: Message[] = [msg("u1", "user"), msg("a1", "assistant"), msg("u2", "user")];

function deps(streams: TurnStreamRegistry, over: Partial<EditAndResendDeps> = {}): EditAndResendDeps {
  return {
    messages: SNAPSHOT,
    currentMessages: () => SNAPSHOT,
    setMessages: () => {},
    isSlackMode: true,
    hasActiveStream: true,
    removableTurnIds: () => streams.removableTurnIds(),
    removableRunIds: (removed) => streams.removableRunIds(removed),
    condemnedTurnIds: (removed) => streams.condemnedTurnIds(removed),
    settleRemovableRunIds: (removed) => streams.settleRunIdsForRemoval(removed),
    activeThreadId: "th1",
    currentThreadId: () => "th1",
    loadedThreadCreatedAt: () => "2026-08-01T00:00:00.000Z",
    threads: [{ id: "th1", title: "t", createdAt: "2026-08-01T00:00:00.000Z" }] as never,
    setActiveAssistantHandle: () => {},
    taggedAssistantUserIds: [],
    pausedParticipants: [],
    assistantHandleMap: new Map(),
    streamResponse: async () => {},
    ...over,
  };
}

/** The posted transcript as an ORDER, with the edited prompt named by its
 *  content: `generateId` is mocked with a counter that runs across the whole
 *  file, so the replacement's id is not stable per arm and only its POSITION is
 *  the claim. */
const shape = (messages: Message[], edited = "actually, ask something else") =>
  messages.map((m) => (m.content === edited ? "<edit>" : m.id));

/** Let every already-queued microtask run, without letting a timer fire. */
const drainMicrotasks = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

beforeEach(() => {
  saved.length = 0;
});

describe("an edit made inside the pre-RUN_STARTED window", () => {
  it("HOLDS the intent, then asserts the run the handshake delivered", async () => {
    // THE REGRESSION ARM. Before the deferral this posted `removedMessageIds`
    // with no `removedRunIds` at all: the turn had no run at intent-build time,
    // and by the time `RUN_STARTED` landed its anchor was gone from every
    // transcript, so the run could never be asserted by anything.
    const streams = createTurnStreamRegistry();
    const token = streams.begin("a-slow-start", new AbortController(), "u2");

    const flow = editAndResend(deps(streams), "u2", "actually, ask something else");

    // The flow is holding: nothing has been POSTed while the run is unknown.
    await drainMicrotasks();
    expect(saved, "the intent went out before the run was known").toHaveLength(0);

    // `RUN_STARTED` lands, exactly as `driveAssistantChatTurn` reports it.
    expect(streams.noteRunId(token, "run-slow")).toBe(true);
    await flow;

    expect(saved).toHaveLength(1);
    const intent = saved[0] as { removedMessageIds?: string[]; removedRunIds?: string[] };
    // The turn is named by its bubble id, as it always was...
    expect(intent.removedMessageIds).toContain("a-slow-start");
    expect(intent.removedMessageIds).toContain("u2");
    // ...and by the one identity the server can actually act on for a turn no
    // saved transcript ever carried. This is the close.
    expect(
      intent.removedRunIds,
      "the pre-RUN_STARTED window is open again — the run-bound row folds back in on reload",
    ).toEqual(["run-slow"]);
  });

  it("releases the hold when the stream is CUT before its run ever arrives", async () => {
    // The other settling event, and the residual it leaves stated rather than
    // discovered: a turn that never learned a run contributes none, and is
    // still named by its bubble id.
    const streams = createTurnStreamRegistry();
    const token = streams.begin("a-cut", new AbortController(), "u2");

    const flow = editAndResend(deps(streams), "u2", "never mind");
    await drainMicrotasks();
    expect(saved).toHaveLength(0);

    expect(streams.end(token)).toBe(true); // the drive's `finally`
    await flow;

    expect(saved).toHaveLength(1);
    const intent = saved[0] as { removedMessageIds?: string[]; removedRunIds?: string[] };
    expect(intent.removedMessageIds).toContain("a-cut");
    expect(intent).not.toHaveProperty("removedRunIds");
  });

  it("a THREAD SWITCH during the hold releases it, and the truncation is still recorded", async () => {
    // THE RESIDUAL, PINNED (codex round 5, finding 1). Leaving the thread aborts
    // every drive and drops the ledger, so the held edit resumes with its turn
    // still runless — and it posts anyway, for the thread it was made in,
    // because a truncation that is not recorded is the silent degradation this
    // leg exists to remove. The turn keeps its run-bound row.
    //
    // That is the SAME residual as any stream cut before `RUN_STARTED`, arriving
    // through a different door: the identity never reached this client, so there
    // is nothing here to assert. It is not a new hole — it is the
    // pre-cinatra#2823 behaviour, narrowed from EVERY edit inside the window to
    // an edit inside the window whose reader also left the thread.
    const streams = createTurnStreamRegistry();
    expect(streams.resetForThread("th1")).toBe(false);
    streams.begin("a-slow-start", new AbortController(), "u2");

    let liveThread = "th1";
    const flow = editAndResend(
      deps(streams, { currentThreadId: () => liveThread }),
      "u2",
      "ask something else",
    );
    await drainMicrotasks();
    expect(saved).toHaveLength(0);

    // The reader opens another thread. Every drive is aborted and the ledger,
    // whose ids belong to the thread being left, goes with it.
    liveThread = "th2";
    expect(streams.resetForThread("th2")).toBe(true);
    await flow;

    // The truncation IS durably recorded for the thread the edit was made in...
    expect(saved).toHaveLength(1);
    const intent = saved[0] as { id?: string; removedMessageIds?: string[]; removedRunIds?: string[] };
    expect(intent.id).toBe("th1");
    expect(intent.removedMessageIds).toContain("u2");
    // ...and the run is not asserted, because it never arrived here to assert.
    expect(intent).not.toHaveProperty("removedRunIds");
  });

  it("KEEPS a reply that reveals for a kept prompt while the edit is holding", async () => {
    // THE OTHER SIDE OF THE HOLD, and the defect it opened. The wait is an
    // await, and a Slack turn anchored ABOVE the edit point keeps streaming
    // through it — correctly unwaited-on and correctly unnamed by run. When it
    // REVEALS mid-hold, the transcript the save posts must carry it: a save
    // posts the WHOLE thread, so a reply missing from the payload is a reply
    // deleted from the server by an edit that never touched its prompt.
    const streams = createTurnStreamRegistry();
    // The turn this edit caught mid-handshake — the reason it holds at all.
    const held = streams.begin("a-held", new AbortController(), "u2");
    // The concurrent turn for the prompt ABOVE the edit point.
    streams.begin("a-kept", new AbortController(), "u1");

    const live: Message[] = [...SNAPSHOT];
    const flow = editAndResend(
      deps(streams, { currentMessages: () => live }),
      "u2",
      "actually, ask something else",
    );
    await drainMicrotasks();
    expect(saved, "the edit posted before the run was known").toHaveLength(0);

    // THE REVEAL, mid-hold: `driveAssistantChatTurn` appends the finished turn.
    live.push(msg("a-kept", "assistant"));

    expect(streams.noteRunId(held, "run-held")).toBe(true);
    await flow;

    expect(saved).toHaveLength(1);
    const intent = saved[0] as {
      messages: Message[];
      removedMessageIds?: string[];
      removedRunIds?: string[];
    };
    expect(
      intent.messages.map((m) => m.id),
      "the kept prompt's reply was overwritten out of the thread by an edit below it",
    ).toContain("a-kept");
    // THE WHOLE ORDER, not just the membership. The kept region comes back as it
    // was, the edited prompt holds the EDIT POINT, and what arrived during the
    // hold follows it — it arrived after the reader submitted this edit.
    expect(shape(intent.messages)).toEqual(["u1", "a1", "<edit>", "a-kept"]);
    // ...and the edit's own removal still happened.
    expect(intent.removedMessageIds).toContain("u2");
    expect(intent.removedRunIds).toEqual(["run-held"]);
  });

  it("KEEPS a message the reader POSTS during the hold, after the edited prompt", async () => {
    // Slack mode allows re-entry while a turn streams, so the reader can send a
    // new message while their own edit is still holding. It arrived AFTER the
    // edit, so it belongs after it — and it must not be overwritten away by a
    // save whose payload predates it.
    const streams = createTurnStreamRegistry();
    const held = streams.begin("a-held", new AbortController(), "u2");

    const live: Message[] = [...SNAPSHOT];
    const flow = editAndResend(
      deps(streams, { currentMessages: () => live }),
      "u2",
      "actually, ask something else",
    );
    await drainMicrotasks();

    live.push(msg("u3", "user"));

    expect(streams.noteRunId(held, "run-held")).toBe(true);
    await flow;

    const intent = saved[0] as { messages: Message[] };
    expect(
      shape(intent.messages),
      "a message posted during the hold was lost, or ordered ahead of the edit that preceded it",
    ).toEqual(["u1", "a1", "<edit>", "u3"]);
  });

  it("ANCHORS its regeneration to the EDITED PROMPT, not to what arrived during the hold", async () => {
    // THE DISPATCH SIDE OF THE REBUILT TRANSCRIPT. The page anchors a turn to
    // the last message of the context it is handed unless the caller names one.
    // This flow names it, so the claim holds however that context is composed —
    // left derived off a transcript that ends in what ARRIVED during the hold,
    // the regeneration would register under a message the edit KEPT, and a
    // later edit of THAT message would condemn its bubble and offer its run: a
    // reply to a prompt nobody removed, tombstoned.
    const streams = createTurnStreamRegistry();
    const held = streams.begin("a-held", new AbortController(), "u2");

    const live: Message[] = [...SNAPSHOT];
    const dispatched: Array<{ tail?: string; anchor?: string | null }> = [];
    const flow = editAndResend(
      deps(streams, {
        currentMessages: () => live,
        streamResponse: async (contextMessages, _handle, _endpoint, _authorUserId, _assistant, anchorMessageId) => {
          dispatched.push({ tail: contextMessages[contextMessages.length - 1]?.id, anchor: anchorMessageId });
        },
      }),
      "u2",
      "actually, ask something else",
    );
    await drainMicrotasks();

    // The reader posts while their own edit is still holding (Slack re-entry).
    live.push(msg("u3", "user"));

    expect(streams.noteRunId(held, "run-held")).toBe(true);
    await flow;

    const posted = (saved[0] as { messages: Message[] }).messages;
    expect(shape(posted)).toEqual(["u1", "a1", "<edit>", "u3"]);
    const editedId = posted.find((m) => m.content === "actually, ask something else")?.id;
    expect(editedId, "the edited prompt is in the posted transcript").toBeTruthy();

    expect(dispatched).toHaveLength(1);
    // The dispatch context ends at the edited prompt — what arrived during the
    // hold is in the posted transcript above, not in what the model is asked to
    // answer (the dispatch-context arm below is where that is the claim).
    expect(dispatched[0]?.tail).toBe(editedId);
    // The anchor is NAMED rather than left to be derived from that tail, and it
    // is the prompt this regeneration was dispatched to answer.
    expect(
      dispatched[0]?.anchor,
      "the regeneration is anchored to a message that merely arrived during the hold",
    ).toBe(editedId);

    // AND THAT IS THE INVARIANT IT BUYS, asked of the registry that enforces it:
    // a later edit of the arrived message must not reach this turn.
    const regen = streams.begin("a-regen", new AbortController(), dispatched[0]?.anchor ?? null);
    expect(streams.noteRunId(regen, "run-regen")).toBe(true);
    expect(
      streams.condemnedTurnIds(["u3"]),
      "editing the arrived message condemned the regeneration's bubble",
    ).not.toContain("a-regen");
    expect(
      streams.removableRunIds(["u3"]),
      "editing the arrived message offered the regeneration's run for the tombstone",
    ).not.toContain("run-regen");
    // ...while an edit of the prompt it actually answers still reaches it.
    expect(streams.condemnedTurnIds([editedId as string])).toContain("a-regen");
  });

  it("DISPATCHES a context ending at the edited prompt while the SAVE still posts what arrived", async () => {
    // THE MODEL CONTEXT IS A DIFFERENT QUESTION FROM THE PAYLOAD, and this arm
    // is the one that separates them. `streamAgUiResponse` maps the context it
    // is handed straight into the request, so dispatching the rebuilt
    // transcript would ask the model to answer a conversation whose last turn
    // is a message that merely ARRIVED while this edit was holding. The
    // regeneration answers the EDITED PROMPT, so that is where its context
    // ends — while the save keeps posting the whole thread, arrivals and all,
    // because a message missing from the payload is a message deleted.
    const streams = createTurnStreamRegistry();
    const held = streams.begin("a-held", new AbortController(), "u2");
    // A concurrent turn ABOVE the edit point, so BOTH kinds of arrival are in
    // play: a reply that reveals mid-hold, and a message the reader posts.
    streams.begin("a-kept", new AbortController(), "u1");

    const live: Message[] = [...SNAPSHOT];
    const contexts: Message[][] = [];
    const flow = editAndResend(
      deps(streams, {
        currentMessages: () => live,
        streamResponse: async (contextMessages) => {
          contexts.push(contextMessages);
        },
      }),
      "u2",
      "actually, ask something else",
    );
    await drainMicrotasks();

    live.push(msg("a-kept", "assistant"));
    live.push(msg("u3", "user"));

    expect(streams.noteRunId(held, "run-held")).toBe(true);
    await flow;

    // THE SAVE carries both arrivals, in the order they happened relative to
    // the edit point.
    const posted = (saved[0] as { messages: Message[] }).messages;
    expect(shape(posted)).toEqual(["u1", "a1", "<edit>", "a-kept", "u3"]);
    const editedId = posted.find((m) => m.content === "actually, ask something else")?.id;
    expect(editedId, "the edited prompt is in the posted transcript").toBeTruthy();

    // THE DISPATCH carries neither, and ends at the prompt it answers.
    expect(contexts).toHaveLength(1);
    const dispatched = contexts[0] ?? [];
    expect(
      shape(dispatched),
      "the model was handed the persistence payload instead of the edit's own context",
    ).toEqual(["u1", "a1", "<edit>"]);
    expect(
      dispatched[dispatched.length - 1]?.id,
      "the model was asked to answer a message that merely arrived during the hold",
    ).toBe(editedId);
    expect(dispatched.map((m) => m.id)).not.toContain("a-kept");
    expect(dispatched.map((m) => m.id)).not.toContain("u3");
  });

  it("posts exactly the pre-await slice when NOTHING arrives during the hold", async () => {
    // The overwhelmingly common edit: no concurrent turn, nothing revealed,
    // nothing posted. The live read must produce what `[...prior, edited]` did.
    const streams = createTurnStreamRegistry();
    await editAndResend(deps(streams), "u2", "just fix the typo");

    const intent = saved[0] as { messages: Message[] };
    expect(shape(intent.messages, "just fix the typo")).toEqual(["u1", "a1", "<edit>"]);
    // ...and the kept region is carried through, not rebuilt: the SAME message
    // objects the render held, in the same order.
    expect(intent.messages[0]).toBe(SNAPSHOT[0]);
    expect(intent.messages[1]).toBe(SNAPSHOT[1]);
    expect(intent.messages[2]?.content).toBe("just fix the typo");
  });

  it("DROPS a reply that reveals for a prompt this edit removed", async () => {
    // The same live read, in the direction that must not leak: a turn anchored
    // to a prompt the edit REMOVED is below the edit point wherever its reveal
    // happens to land, so re-reading the transcript must not carry it back in.
    // Over-naming is safe for the INTENT and is the bug for the PAYLOAD, which
    // is why the rebuild asks for the ANCHORED set rather than the union.
    const streams = createTurnStreamRegistry();
    const held = streams.begin("a-held", new AbortController(), "u2");
    const early = streams.begin("a-below", new AbortController(), "u2");
    expect(streams.noteRunId(early, "run-below")).toBe(true);

    const live: Message[] = [...SNAPSHOT];
    const flow = editAndResend(
      deps(streams, { currentMessages: () => live }),
      "u2",
      "actually, ask something else",
    );
    await drainMicrotasks();

    // The sibling turn for the SAME removed prompt finishes while the edit is
    // still holding for the one that has no run yet.
    live.push(msg("a-below", "assistant"));

    expect(streams.noteRunId(held, "run-held")).toBe(true);
    await flow;

    const intent = saved[0] as { messages: Message[]; removedRunIds?: string[] };
    expect(
      intent.messages.map((m) => m.id),
      "a turn answering the edited-away prompt survived the truncation",
    ).not.toContain("a-below");
    expect(shape(intent.messages)).toEqual(["u1", "a1", "<edit>"]);
    expect(intent.removedRunIds).toEqual(expect.arrayContaining(["run-below", "run-held"]));
  });

  it("does NOT hold for a concurrent turn whose prompt this edit KEPT", async () => {
    // The latency the close costs is paid only by the turns the edit is about.
    // A Slack turn answering a prompt ABOVE the edit point is none of its
    // business, and its run is withheld for the same reason it always was.
    const streams = createTurnStreamRegistry();
    streams.begin("a-above", new AbortController(), "u1");

    await editAndResend(deps(streams), "u2", "edit the later prompt");

    expect(saved).toHaveLength(1);
    const intent = saved[0] as { removedRunIds?: string[] };
    expect(intent).not.toHaveProperty("removedRunIds");
  });
});
