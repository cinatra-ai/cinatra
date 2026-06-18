// Pins the thread-list ordering activity gate (issue #283): a thread's
// `updatedAt` — and therefore its position in the activity-sorted sidebar —
// must advance ONLY on real conversational activity, never on a passive
// thread open/load.
//
// The persist effect in chat-page.tsx decides "real activity vs. load echo"
// purely through `isRealActivity(loadedFingerprint, messages)`. These tests
// reproduce the scenarios that effect sees so a regression (e.g. a fingerprint
// that ignores content edits, or that wrongly treats a re-render as activity)
// fails here rather than silently reordering the sidebar on every open.

import { describe, expect, it } from "vitest";

import {
  fingerprintMessages,
  isRealActivity,
  type ActivityMessage,
} from "../thread-activity";

const user = (id: string, content: string): ActivityMessage => ({
  id,
  role: "user",
  content,
});
const assistant = (id: string, content: string, extra: Partial<ActivityMessage> = {}): ActivityMessage => ({
  id,
  role: "assistant",
  content,
  ...extra,
});

describe("fingerprintMessages", () => {
  it("is stable for an identical message array (the load-echo case)", () => {
    const loaded = [user("u1", "hello"), assistant("a1", "hi there")];
    // A re-render hands the effect the SAME logical messages.
    const reRendered = [user("u1", "hello"), assistant("a1", "hi there")];
    expect(fingerprintMessages(reRendered)).toBe(fingerprintMessages(loaded));
  });

  it("changes when a message is appended (user submit / LLM response)", () => {
    const before = [user("u1", "hello")];
    const afterUser = [user("u1", "hello"), user("u2", "second")];
    const afterAssistant = [...afterUser, assistant("a1", "answer")];
    expect(fingerprintMessages(afterUser)).not.toBe(fingerprintMessages(before));
    expect(fingerprintMessages(afterAssistant)).not.toBe(fingerprintMessages(afterUser));
  });

  it("changes on a same-id, same-LENGTH content edit (regenerate/correction)", () => {
    // The bug class codex flagged: a content-length-only fingerprint would
    // miss this. Both contents are 5 chars; only the characters differ.
    const before = [assistant("a1", "12345")];
    const edited = [assistant("a1", "abcde")];
    expect(fingerprintMessages(before)).not.toBe(fingerprintMessages(edited));
  });

  it("changes when an errored turn becomes real content (same id)", () => {
    const errored = [assistant("a1", "", { error: "rate limited" })];
    const recovered = [assistant("a1", "here is the answer")];
    expect(fingerprintMessages(errored)).not.toBe(fingerprintMessages(recovered));
  });

  it("changes when streamed parts grow even if flat content is equal", () => {
    const before = [assistant("a1", "answer", { parts: [{}] })];
    const after = [assistant("a1", "answer", { parts: [{}, {}] })];
    expect(fingerprintMessages(before)).not.toBe(fingerprintMessages(after));
  });

  it("changes when external-mention metadata is attached to an existing message", () => {
    // sendMessage saves the user message FIRST, then attaches mentions/
    // mentionState once routing resolves. That metadata-only update must read
    // as activity so the pending external mention is persisted (chat_mentions_
    // poll depends on it). A fingerprint that ignored these fields would
    // suppress that persist.
    const beforeMention: ActivityMessage[] = [
      { id: "u1", role: "user", content: "@bot please look" },
    ];
    const afterMention: ActivityMessage[] = [
      {
        id: "u1",
        role: "user",
        content: "@bot please look",
        mentions: [{ assistantUserId: "ext-bot", offset: 0 }],
        mentionState: { "ext-bot": "pending" },
      },
    ];
    expect(fingerprintMessages(beforeMention)).not.toBe(
      fingerprintMessages(afterMention),
    );
  });

  it("changes when a mentionState transitions pending -> handled", () => {
    const pending: ActivityMessage[] = [
      { id: "u1", role: "user", content: "x", mentionState: { bot: "pending" } },
    ];
    const handled: ActivityMessage[] = [
      { id: "u1", role: "user", content: "x", mentionState: { bot: "handled" } },
    ];
    expect(fingerprintMessages(pending)).not.toBe(fingerprintMessages(handled));
  });

  it("does not alias distinct field tuples across the separator", () => {
    // id 'a' + content 'b c' must not collide with id 'a b' + content 'c'.
    const left = [{ id: "a", role: "user", content: "b c" } as ActivityMessage];
    const right = [{ id: "a b", role: "user", content: "c" } as ActivityMessage];
    expect(fingerprintMessages(left)).not.toBe(fingerprintMessages(right));
  });

  it("distinguishes a reorder of the same messages", () => {
    const ab = [user("u1", "a"), user("u2", "b")];
    const ba = [user("u2", "b"), user("u1", "a")];
    expect(fingerprintMessages(ab)).not.toBe(fingerprintMessages(ba));
  });
});

describe("isRealActivity — the #283 gate", () => {
  it("PASSIVE OPEN: messages identical to the loaded snapshot ⇒ NOT activity (no bump)", () => {
    const loaded = [user("u1", "hello"), assistant("a1", "hi there")];
    const fp = fingerprintMessages(loaded);
    // Opening the thread re-sets the same messages; the effect must bail.
    expect(isRealActivity(fp, loaded)).toBe(false);
    expect(isRealActivity(fp, [user("u1", "hello"), assistant("a1", "hi there")])).toBe(false);
  });

  it("USER SUBMIT: a new user message after load ⇒ activity (bump)", () => {
    const loaded = [user("u1", "hello"), assistant("a1", "hi")];
    const fp = fingerprintMessages(loaded);
    const afterSubmit = [...loaded, user("u2", "follow-up question")];
    expect(isRealActivity(fp, afterSubmit)).toBe(true);
  });

  it("LLM RESPONSE: an assistant message after load ⇒ activity (bump)", () => {
    const afterUserSubmit = [user("u1", "hello"), user("u2", "again")];
    const fp = fingerprintMessages(afterUserSubmit);
    const afterResponse = [...afterUserSubmit, assistant("a1", "the answer")];
    expect(isRealActivity(fp, afterResponse)).toBe(true);
  });

  it("EDIT/REGENERATE: truncate + re-stream changes the tail ⇒ activity (bump)", () => {
    const loaded = [user("u1", "q"), assistant("a1", "old answer")];
    const fp = fingerprintMessages(loaded);
    // Edit truncates to the user turn then a fresh assistant id streams in.
    const regenerated = [user("u1", "q"), assistant("a2", "new answer")];
    expect(isRealActivity(fp, regenerated)).toBe(true);
  });

  it("EXTERNAL MESSAGE: poll-added message grows the list ⇒ activity (bump)", () => {
    const loaded = [user("u1", "hello")];
    const fp = fingerprintMessages(loaded);
    const afterPoll = [...loaded, assistant("ext1", "reply from MCP")];
    expect(isRealActivity(fp, afterPoll)).toBe(true);
  });

  it("NEW THREAD: empty loaded snapshot, first user message ⇒ activity (bump)", () => {
    // A brand-new thread starts with loadedFingerprint = "" (empty baseline).
    const empty = "";
    const firstMessage = [user("u1", "first prompt of a new thread")];
    expect(isRealActivity(empty, firstMessage)).toBe(true);
  });

  it("RE-RENDER AFTER PERSIST: adopting the new fingerprint prevents a double bump", () => {
    // After a real-activity persist, chat-page sets loadedFingerprintRef to the
    // persisted set. An unrelated re-render with the same messages must NOT
    // re-trigger a bump.
    const persisted = [user("u1", "hi"), assistant("a1", "answer")];
    const newBaseline = fingerprintMessages(persisted);
    expect(isRealActivity(newBaseline, persisted)).toBe(false);
  });
});
