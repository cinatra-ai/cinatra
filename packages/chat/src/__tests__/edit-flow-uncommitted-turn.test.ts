/**
 * THE ZERO-SOURCE WINDOW, DRIVEN THROUGH THE EDIT FLOW (cinatra#2823 S9j).
 *
 * `turn-stream-registry.test.ts` states the registry's own contract. This states
 * the consequence the contract exists for: what `editAndResend` actually POSTS
 * when the turn it is removing is in neither of the flow's two sources.
 *
 * The setup is the window itself. `messages` is the render's snapshot, taken
 * before the Slack turn's reveal committed, so it does NOT carry the turn; and
 * the turn's stream has already ended, so the in-flight map does not carry it
 * either. What must still appear in `removedMessageIds` is that turn — otherwise
 * the save asserts nothing about it and its run-bound row folds back in above the
 * edited prompt on the next reload.
 *
 * The flow is a leaf module, so this drives the real `editAndResend` with hand-
 * built deps: no page mount, no scheduling luck, and the window is held open by
 * construction rather than raced into.
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
import { createTurnStreamRegistry } from "../turn-stream-registry";
import type { UiMessage as Message } from "../types";

const msg = (id: string, role: "user" | "assistant"): Message =>
  ({ id, role, content: id }) as Message;

/** The transcript as the OLD render holds it: the Slack turn `a-slack` has been
 *  revealed by `setMessages`, but this snapshot predates that commit. */
const STALE_SNAPSHOT: Message[] = [msg("u1", "user"), msg("a1", "assistant"), msg("u2", "user")];

function deps(over: Partial<EditAndResendDeps> = {}): EditAndResendDeps {
  return {
    messages: STALE_SNAPSHOT,
    setMessages: () => {},
    isSlackMode: true,
    hasActiveStream: false,
    removableTurnIds: () => [],
    removableRunIds: () => [],
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

beforeEach(() => {
  saved.length = 0;
});

describe("editAndResend names a turn that is in NEITHER source", () => {
  it("names the ended-but-uncommitted Slack turn its snapshot cannot see", async () => {
    // THE REGRESSION ARM. The registry is driven exactly as the page drives it:
    // the turn streamed, and its drive's `finally` ended it. The reveal has not
    // committed, so nothing has released it from the ledger.
    const streams = createTurnStreamRegistry();
    streams.end(streams.begin("a-slack", new AbortController()));

    await editAndResend(
      deps({
        removableTurnIds: () => streams.removableTurnIds(),
        removableRunIds: (removed) => streams.removableRunIds(removed),
      }),
      "u2",
      "edited",
    );

    expect(saved).toHaveLength(1);
    const removed = saved[0].removedMessageIds as string[];
    // The transcript slice from the edit point down...
    expect(removed).toContain("u2");
    // ...AND the turn the snapshot never saw. Before the ledger this was absent
    // and the removal was silently never asserted.
    expect(removed).toContain("a-slack");
    // The posted transcript is still the truncation itself — the intent names
    // the turn, it does not resurrect it.
    expect((saved[0].messages as Message[]).map((m) => m.id)).toEqual(["u1", "a1", "gen-1"]);
  });

  it("names an ABORTED turn that never revealed at all", async () => {
    // The same window held open forever. The run-bound row exists — it is minted
    // when the run STARTS — so the turn has durable state to fold back in even
    // though no transcript ever carried its message.
    const streams = createTurnStreamRegistry();
    const aborted = streams.begin("a-aborted", new AbortController());
    streams.abortAll();
    streams.end(aborted);

    await editAndResend(
      deps({
        removableTurnIds: () => streams.removableTurnIds(),
        removableRunIds: (removed) => streams.removableRunIds(removed),
      }),
      "u2",
      "edited",
    );

    expect(saved[0].removedMessageIds as string[]).toContain("a-aborted");
  });

  it("does NOT name a turn the committed transcript already carries", async () => {
    // The release event, from the flow's side: once the reveal commits, the
    // transcript slice names the turn and the ledger has nothing to add. A turn
    // ABOVE the edit point must not be asserted removed at all.
    const streams = createTurnStreamRegistry();
    streams.end(streams.begin("a1", new AbortController()));
    streams.noteCommittedTranscript(STALE_SNAPSHOT);

    await editAndResend(
      deps({
        removableTurnIds: () => streams.removableTurnIds(),
        removableRunIds: (removed) => streams.removableRunIds(removed),
      }),
      "u2",
      "edited",
    );

    expect(saved[0].removedMessageIds as string[]).toEqual(["u2"]);
    // ...and nothing streaming is nameable either, so the STREAMING half of the
    // assertion is absent rather than empty. An assertion about nothing is no
    // assertion, and the server emits no tombstone for it at all.
    expect(saved[0].removedRunIds).toBeUndefined();
  });
});

describe("editAndResend carries the SERVER's name for a turn with no mirror row", () => {
  // The bubble id alone reaches nothing on the server for these turns: they have
  // no mirror row, and every message-id key is read out of one. The run id is the
  // identity both sides hold, so the flow has to post it.

  it("posts the run id of the ended-but-uncommitted turn beside its bubble id", async () => {
    const streams = createTurnStreamRegistry();
    // ANCHORED to the message this edit removes: the turn answers `u2`.
    const token = streams.begin("a-slack", new AbortController(), "u2");
    streams.noteRunId(token, "run-slack-1"); // RUN_STARTED arrived on the wire
    streams.end(token);

    await editAndResend(
      deps({
        removableTurnIds: () => streams.removableTurnIds(),
        removableRunIds: (removed) => streams.removableRunIds(removed),
      }),
      "u2",
      "edited",
    );

    expect(saved[0].removedMessageIds as string[]).toContain("a-slack");
    expect(saved[0].removedRunIds as string[]).toEqual(["run-slack-1"]);
  });

  it("posts the run of a turn that is STILL streaming", async () => {
    const streams = createTurnStreamRegistry();
    const token = streams.begin("a-live", new AbortController(), "u2");
    streams.noteRunId(token, "run-live-1");

    await editAndResend(
      deps({
        removableTurnIds: () => streams.removableTurnIds(),
        removableRunIds: (removed) => streams.removableRunIds(removed),
      }),
      "u2",
      "edited",
    );

    expect(saved[0].removedRunIds as string[]).toEqual(["run-live-1"]);
  });

  it("omits the run of a turn whose SAVE has landed — the mirror row is the key now", async () => {
    // WHAT CHANGED, AND WHY (codex round 4, finding 1). This arm used to release the
    // run on the committed transcript alone, on the rule "a run id leaves
    // exactly when its turn's id does". That rule assumed "the transcript names
    // it" and "the server has a row for it" are one thing, and they are not: the
    // save that writes the row is a separate, fallible event. So the release is
    // keyed on the SAVE here, and the arm below states the half that used to be
    // lost between the two.
    const streams = createTurnStreamRegistry();
    const token = streams.begin("a1", new AbortController(), "u1");
    streams.noteRunId(token, "run-a1");
    streams.end(token);
    streams.noteCommittedTranscript(STALE_SNAPSHOT);
    streams.noteSavedTranscript(STALE_SNAPSHOT);

    await editAndResend(
      deps({
        removableTurnIds: () => streams.removableTurnIds(),
        removableRunIds: (removed) => streams.removableRunIds(removed),
      }),
      "u1",
      "edited",
    );

    expect(saved[0].removedRunIds).toBeUndefined();
  });

  it("STILL posts the run of a revealed turn whose save never landed — the Slack sibling shape", async () => {
    // CODEX ROUND 4, FINDING 1, THE REGRESSION ARM. Slack dispatches concurrently, so
    // turn A can reveal into `messages` while sibling B is still streaming — and
    // the page skips its ordinary save for as long as anything is in flight. A
    // is therefore on screen with NO mirror row. The old release rule dropped
    // A's run on that reveal, so this edit named A's bubble id (which reaches no
    // row) and asserted no run (the only key that would have reached one): A's
    // run-bound row stayed unsuperseded and folded back in above the edited
    // prompt on the next reload, made permanent by the next whole-transcript
    // save. `assistant-turn-supersede.ts` is driven on a real database for the
    // other half of this — that an asserted run tombstones exactly that row.
    const streams = createTurnStreamRegistry();
    const revealed = streams.begin("a1", new AbortController(), "u1");
    streams.noteRunId(revealed, "run-a1");
    const sibling = streams.begin("a-sibling", new AbortController(), "u1");
    streams.noteRunId(sibling, "run-sibling");
    streams.end(revealed); // A's drive unwound...
    streams.noteCommittedTranscript(STALE_SNAPSHOT); // ...and its reveal committed
    // No save landed: `a-sibling` is still in flight, so the page's ordinary
    // save never ran. Nothing calls `noteSavedTranscript`.

    await editAndResend(
      deps({
        removableTurnIds: () => streams.removableTurnIds(),
        removableRunIds: (removed) => streams.removableRunIds(removed),
      }),
      "u1",
      "edited",
    );

    expect(saved[0].removedMessageIds as string[]).toContain("a1");
    expect(saved[0].removedRunIds as string[]).toContain("run-a1");
  });

  it("omits the run of a CONCURRENT turn whose prompt the edit KEPT", async () => {
    // The one place over-naming stops being free. Slack runs turns concurrently:
    // a turn dispatched for `u1` can still be streaming while the user edits
    // `u2`, and the ledger holds it because no committed transcript carries it.
    // Named as a run it would be tombstoned permanently — a turn whose prompt is
    // still on the screen, losing its card forever. Its ANCHOR is `u1`, which
    // this edit does not remove, so it is withheld.
    const streams = createTurnStreamRegistry();
    const kept = streams.begin("a-for-u1", new AbortController(), "u1");
    streams.noteRunId(kept, "run-for-u1");
    const removedTurn = streams.begin("a-for-u2", new AbortController(), "u2");
    streams.noteRunId(removedTurn, "run-for-u2");

    await editAndResend(
      deps({
        removableTurnIds: () => streams.removableTurnIds(),
        removableRunIds: (removed) => streams.removableRunIds(removed),
      }),
      "u2",
      "edited",
    );

    // Both are still NAMED by bubble id — that assertion cannot reach a row it
    // has no mirror for, so over-naming there stays free...
    const removedIds = saved[0].removedMessageIds as string[];
    expect(removedIds).toContain("a-for-u1");
    expect(removedIds).toContain("a-for-u2");
    // ...and exactly one RUN is asserted: the turn below the edit point.
    expect(saved[0].removedRunIds as string[]).toEqual(["run-for-u2"]);
  });

  it("omits the run of a turn with NO anchor at all", async () => {
    // Fail-closed: a turn that cannot show where it sits is not offered as a run.
    const streams = createTurnStreamRegistry();
    const token = streams.begin("a-anchorless", new AbortController(), null);
    streams.noteRunId(token, "run-anchorless");

    await editAndResend(
      deps({
        removableTurnIds: () => streams.removableTurnIds(),
        removableRunIds: (removed) => streams.removableRunIds(removed),
      }),
      "u2",
      "edited",
    );

    expect(saved[0].removedMessageIds as string[]).toContain("a-anchorless");
    expect(saved[0].removedRunIds).toBeUndefined();
  });
});
