// ---------------------------------------------------------------------------
// LIVE PROOF (cinatra#1217 · S1) — a run streamed over the unified contract
// with resume, against the GENUINE durable Redis-Streams AG-UI log.
//
// This is NOT a mocked unit test: it publishes the full AG-UI event vocabulary
// through `publishAgUiEvent` (which XADDs to `cinatra:a2a:events:{runId}`, the
// real durable log resolved via the live-proof `@cinatra-ai/a2a` shim) and
// consumes it back through `subscribeToAgUiEventsWithId`, then proves the
// contract's resume semantics (§4 of CONTRACT.md):
//
//   1. The whole vocabulary streams back in order; every frame validates
//      (`isAgUiEvent`); every SSE `id:` is a well-formed resume cursor; the
//      DATA_PART renderable-view payload round-trips byte-for-byte.
//   2. Reconnecting with a mid-stream `Last-Event-ID` cursor delivers EXACTLY
//      the un-replayed suffix — no loss, no duplication — and prefix+suffix
//      reconstruct the full run exactly once.
//   3. The `0-0` sentinel replays the entire durable log.
//
// Run against a throwaway Redis (default redis://127.0.0.1:6591):
//   REDIS_URL=redis://127.0.0.1:6591 vitest run \
//     --config live-proof/vitest.config.ts
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  __disconnectSharedEventLogPublisher,
  expireRunStream,
  xaddRunEvent,
} from "@cinatra-ai/a2a";

import {
  __disconnectSharedAgUiPublisher,
  publishAgUiEvent,
  subscribeToAgUiEventsWithId,
} from "../src/server";
import { isValidStreamCursor, normalizeResumeCursor } from "../src/contract";
import { isAgUiEvent } from "../src/conformance";
import { renderableViewDataPart } from "../src/renderable-views";
import type { AgUiEvent } from "../src/events";

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6591";

const THREAD = "thr_s1proof";
const runId = `s1proof_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

// The full AG-UI vocabulary in one run: lifecycle, streamed text, a tool call,
// a HITL interrupt/resume, and a DATA_PART renderable view (the change-diff).
const SEQUENCE: readonly AgUiEvent[] = [
  { type: "RUN_STARTED", threadId: THREAD, runId },
  { type: "TEXT_MESSAGE_START", messageId: "m1" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "Updating " },
  { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "the title." },
  { type: "TEXT_MESSAGE_END", messageId: "m1" },
  { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "edit_post" },
  { type: "TOOL_CALL_END", toolCallId: "t1" },
  {
    type: "INTERRUPT",
    threadId: THREAD,
    runId,
    schema: { type: "object", properties: { confirm: { type: "boolean" } } },
    xRenderer: "@example/agent:confirm",
    values: { confirm: false },
    reviewTaskId: "rev1",
  },
  { type: "RESUME", threadId: THREAD, runId, reviewTaskId: "rev1" },
  renderableViewDataPart({
    viewType: "content_change_proposal",
    fields: [{ field: "title", before: "Old title", after: "New title" }],
    postId: "42",
    rich: false,
  }),
  { type: "RUN_FINISHED", threadId: THREAD, runId, status: "completed" },
];

/** Drain the durable log for `streamRunId` from `fromId` (exclusive; undefined =
 *  from the start) until the terminal frame or a short inactivity guard. */
async function drain(
  streamRunId: string,
  fromId?: string,
): Promise<Array<{ id: string; event: AgUiEvent }>> {
  const out: Array<{ id: string; event: AgUiEvent }> = [];
  for await (const item of subscribeToAgUiEventsWithId(streamRunId, {
    fromId,
    inactivityTimeoutMs: 3000,
  })) {
    out.push(item);
  }
  return out;
}

beforeAll(async () => {
  process.env.REDIS_URL = REDIS_URL;
  // Publish the whole run FIRST, so every consumer below is a durable-log
  // replay (the resume path), independent of live-tail timing.
  for (const event of SEQUENCE) {
    await publishAgUiEvent(runId, event);
  }
});

afterAll(async () => {
  await expireRunStream(runId, 1).catch(() => {});
  await __disconnectSharedAgUiPublisher().catch(() => {});
  await __disconnectSharedEventLogPublisher().catch(() => {});
});

describe("S1 durable-resume live proof", () => {
  it("streams the full AG-UI vocabulary in order; every frame is valid and the DATA_PART round-trips", async () => {
    const all = await drain(runId);

    expect(all.length).toBe(SEQUENCE.length);
    expect(all.map((x) => x.event.type)).toEqual(SEQUENCE.map((e) => e.type));

    // Every replayed frame passes the contract's structural validator.
    for (const { event } of all) expect(isAgUiEvent(event)).toBe(true);

    // Every SSE id: is a well-formed resume cursor (<digits>-<digits>).
    for (const { id } of all) expect(isValidStreamCursor(id)).toBe(true);

    // Terminal frame closes the stream.
    expect(all[all.length - 1]?.event.type).toBe("RUN_FINISHED");

    // The renderable-view DATA_PART payload round-trips byte-for-byte.
    const dataPart = all.find((x) => x.event.type === "DATA_PART");
    expect(dataPart?.event).toMatchObject({
      type: "DATA_PART",
      data: {
        viewType: "content_change_proposal",
        fields: [{ field: "title", before: "Old title", after: "New title" }],
        postId: "42",
        rich: false,
      },
    });
  });

  it("resumes from a mid-stream Last-Event-ID and delivers EXACTLY the un-replayed suffix — no loss, no dup", async () => {
    const all = await drain(runId);
    const dropAfterIndex = 5; // client saw indices 0..5, then the connection dropped
    const cursor = all[dropAfterIndex].id;

    // The contract's cursor parser accepts a real Redis-Streams id verbatim.
    expect(normalizeResumeCursor(cursor)).toBe(cursor);

    const resumed = await drain(runId, cursor);

    // Exclusive resume: exactly indices dropAfterIndex+1 .. end, in order.
    expect(resumed.map((x) => x.event.type)).toEqual(
      SEQUENCE.slice(dropAfterIndex + 1).map((e) => e.type),
    );

    // No duplication: nothing already delivered in the prefix reappears.
    const prefixIds = new Set(all.slice(0, dropAfterIndex + 1).map((x) => x.id));
    for (const r of resumed) expect(prefixIds.has(r.id)).toBe(false);

    // No loss: prefix + resumed suffix reconstruct the full run exactly once.
    const reconstructed = [
      ...all.slice(0, dropAfterIndex + 1).map((x) => x.event.type),
      ...resumed.map((x) => x.event.type),
    ];
    expect(reconstructed).toEqual(SEQUENCE.map((e) => e.type));
  });

  it("replays the entire durable log from the 0-0 sentinel", async () => {
    const replay = await drain(runId, "0-0");
    expect(replay.map((x) => x.event.type)).toEqual(SEQUENCE.map((e) => e.type));
  });

  it("filters a mixed AG-UI / A2A-channel log and resumes past the filtered entry", async () => {
    // The unified log carries BOTH channels for one run. Interleave a raw
    // A2A-channel entry (which the AG-UI subscriber must skip) between AG-UI
    // frames, and prove resume advances its cursor past the filtered entry.
    const mixedRunId = `s1proof_mixed_${Date.now()}`;
    await publishAgUiEvent(mixedRunId, {
      type: "RUN_STARTED",
      threadId: THREAD,
      runId: mixedRunId,
    });
    // A non-AG-UI entry on the SAME run stream (channel !== "ag-ui").
    await xaddRunEvent(mixedRunId, {
      channel: "a2a",
      kind: "status-update",
      state: "working",
    });
    await publishAgUiEvent(mixedRunId, {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "m1",
      delta: "after the a2a frame",
    });
    await publishAgUiEvent(mixedRunId, {
      type: "RUN_FINISHED",
      threadId: THREAD,
      runId: mixedRunId,
      status: "completed",
    });

    // The AG-UI consumer sees ONLY the three ag-ui frames — the a2a entry is
    // filtered out, never surfaced as a malformed AG-UI event.
    const seen = await drain(mixedRunId);
    expect(seen.map((x) => x.event.type)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_CONTENT",
      "RUN_FINISHED",
    ]);
    for (const { event } of seen) expect(isAgUiEvent(event)).toBe(true);

    // Resume from the RUN_STARTED cursor: the reader must advance PAST the
    // interleaved (filtered) a2a entry and still deliver the exact ag-ui suffix.
    const resumed = await drain(mixedRunId, seen[0].id);
    expect(resumed.map((x) => x.event.type)).toEqual([
      "TEXT_MESSAGE_CONTENT",
      "RUN_FINISHED",
    ]);

    await expireRunStream(mixedRunId, 1).catch(() => {});
  });
});
