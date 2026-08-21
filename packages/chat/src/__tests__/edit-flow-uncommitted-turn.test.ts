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
    streams.begin("a-slack", new AbortController());
    streams.end("a-slack");

    await editAndResend(
      deps({ removableTurnIds: () => streams.removableTurnIds() }),
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
    streams.begin("a-aborted", new AbortController());
    streams.abortAll();
    streams.end("a-aborted");

    await editAndResend(
      deps({ removableTurnIds: () => streams.removableTurnIds() }),
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
    streams.begin("a1", new AbortController());
    streams.end("a1");
    streams.noteCommittedTranscript(STALE_SNAPSHOT);

    await editAndResend(
      deps({ removableTurnIds: () => streams.removableTurnIds() }),
      "u2",
      "edited",
    );

    expect(saved[0].removedMessageIds as string[]).toEqual(["u2"]);
  });
});
