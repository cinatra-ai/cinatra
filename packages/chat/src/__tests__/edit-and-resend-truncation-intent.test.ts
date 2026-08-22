/**
 * THE TRUNCATION INTENT'S REACH (cinatra#2823 S9j).
 *
 * The intent is the one thing a save carries that lets the server tombstone a
 * removed turn's run-bound row. A turn the intent cannot NAME is a turn the save
 * removed and asserted nothing about — so the reload folds it back in above the
 * edited prompt and the removal is undone, permanently.
 *
 * The turn it could not name was a Slack turn STILL STREAMING. Slack mode is
 * precisely the mode that allows editing during a stream (concurrent streams are
 * the point — `editAndResend` only refuses on an active stream in ChatGPT mode),
 * and it is also the mode whose turns are a whole-turn ATOMIC REVEAL: the
 * assistant message is appended to the transcript when the turn COMPLETES, not
 * when it starts. So at the moment of the edit the transcript does not yet
 * contain the turn that is about to land in it, while the turn's run-bound row is
 * already durable — the row is minted when the run starts.
 */
import { describe, it, expect } from "vitest";
import { buildTruncationIntent } from "../truncation-intent";
import type { UiMessage as Message } from "../types";

function msg(id: string, role: "user" | "assistant"): Message {
  return { id, role, content: id } as Message;
}

const TRANSCRIPT: Message[] = [
  msg("u1", "user"),
  msg("a1", "assistant"),
  msg("u2", "user"),
  msg("a2", "assistant"),
];

describe("buildTruncationIntent", () => {
  it("names the edited message and every successor in the transcript", () => {
    expect(buildTruncationIntent(TRANSCRIPT, 2, [])).toEqual(["u2", "a2"]);
  });

  it("names a Slack turn that is STILL STREAMING and therefore not in the transcript yet", () => {
    // The probe. `a3` is in flight: its run-bound row exists, its message does
    // not. Unnamed, the reload folds it back in above the edited prompt.
    expect(buildTruncationIntent(TRANSCRIPT, 2, ["a3"])).toEqual(["u2", "a2", "a3"]);
  });

  it("names EVERY in-flight turn — each of them reveals below the edit point", () => {
    // Slack mode runs concurrent streams, and a revealed turn appends to the
    // tail. The tail is at or below the edit point once the edit truncates, so
    // every in-flight turn is a successor of it.
    expect(buildTruncationIntent(TRANSCRIPT, 1, ["a3", "a4"])).toEqual([
      "a1",
      "u2",
      "a2",
      "a3",
      "a4",
    ]);
  });

  it("does not double-name a turn that revealed between the read and the build", () => {
    // The reveal can land while the flow is between reading the transcript and
    // building the intent, so the same id can appear in both sources. The server
    // treats the intent as a SET; saying an id twice is noise the client owes it
    // not to send.
    const landed = [...TRANSCRIPT, msg("a3", "assistant")];
    expect(buildTruncationIntent(landed, 2, ["a3"])).toEqual(["u2", "a2", "a3"]);
  });

  it("ignores empty and non-string ids from either source", () => {
    const ragged = [...TRANSCRIPT, { id: "", role: "assistant", content: "" } as Message];
    expect(
      buildTruncationIntent(ragged, 2, ["", undefined as unknown as string, "a3"]),
    ).toEqual(["u2", "a2", "a3"]);
  });

  it("asserts nothing when the edit is at the tail and nothing is in flight", () => {
    expect(buildTruncationIntent(TRANSCRIPT, TRANSCRIPT.length, [])).toEqual([]);
  });
});
