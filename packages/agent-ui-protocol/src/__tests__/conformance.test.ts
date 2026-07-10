import { describe, expect, it } from "vitest";

import { isAgUiEvent, isAgUiEventType, analyzeEventLog } from "../conformance";
import {
  CONFORMANCE_CORPUS,
  FIXTURE_FULL_TURN,
  FIXTURE_RUN_ERROR,
  FIXTURE_STREAMING_PARTIAL,
  FIXTURE_UNKNOWN_RENDERABLE_VIEW,
} from "../conformance-fixtures";
import { AG_UI_EVENT_TYPES } from "../events";

describe("isAgUiEventType", () => {
  it("accepts every known type and rejects the rest", () => {
    for (const t of AG_UI_EVENT_TYPES) expect(isAgUiEventType(t)).toBe(true);
    expect(isAgUiEventType("BOGUS")).toBe(false);
    expect(isAgUiEventType(undefined)).toBe(false);
  });
});

describe("isAgUiEvent (structural validation)", () => {
  it("accepts every event across the seed corpus", () => {
    for (const [name, log] of Object.entries(CONFORMANCE_CORPUS)) {
      log.forEach((event, i) => {
        expect(isAgUiEvent(event), `${name}[${i}] ${JSON.stringify(event)}`).toBe(true);
      });
    }
  });

  it("rejects non-objects and unknown types", () => {
    expect(isAgUiEvent(null)).toBe(false);
    expect(isAgUiEvent("RUN_STARTED")).toBe(false);
    expect(isAgUiEvent([])).toBe(false);
    expect(isAgUiEvent({ type: "NOPE" })).toBe(false);
  });

  it("enforces the required fields per type", () => {
    expect(isAgUiEvent({ type: "RUN_STARTED", threadId: "t", runId: "r" })).toBe(true);
    expect(isAgUiEvent({ type: "RUN_STARTED", threadId: "t" })).toBe(false); // no runId
    expect(isAgUiEvent({ type: "RUN_ERROR", threadId: "t", runId: "r", message: "x" })).toBe(true);
    expect(isAgUiEvent({ type: "RUN_ERROR", threadId: "t", runId: "r" })).toBe(false); // no message
    expect(isAgUiEvent({ type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "" })).toBe(true);
    expect(isAgUiEvent({ type: "TEXT_MESSAGE_CONTENT", messageId: "m" })).toBe(false); // no delta
    expect(isAgUiEvent({ type: "TOOL_CALL_START", toolCallId: "c", toolCallName: "n" })).toBe(true);
    expect(isAgUiEvent({ type: "TOOL_CALL_START", toolCallId: "c" })).toBe(false); // no name
    expect(
      isAgUiEvent({
        type: "INTERRUPT",
        threadId: "t",
        runId: "r",
        schema: {},
        xRenderer: "pkg:renderer",
        values: {},
        reviewTaskId: "rt",
      }),
    ).toBe(true);
    expect(isAgUiEvent({ type: "INTERRUPT", threadId: "t", runId: "r" })).toBe(false);
    // DATA_PART requires an object payload, not the presence of a viewType.
    expect(isAgUiEvent({ type: "DATA_PART", data: { anything: true } })).toBe(true);
    expect(isAgUiEvent({ type: "DATA_PART", data: "not-an-object" })).toBe(false);
    expect(isAgUiEvent({ type: "DATA_PART", data: [1, 2] })).toBe(false);
  });
});

describe("analyzeEventLog (turn shape)", () => {
  it("reports a complete turn for full_turn (RUN_STARTED … RUN_FINISHED)", () => {
    const a = analyzeEventLog(FIXTURE_FULL_TURN);
    expect(a.count).toBe(FIXTURE_FULL_TURN.length);
    expect(a.invalidIndices).toEqual([]);
    expect(a.startsWithRunStarted).toBe(true);
    expect(a.terminal).toBe("RUN_FINISHED");
    expect(a.complete).toBe(true);
  });

  it("reports the terminal RUN_ERROR for a failed run", () => {
    const a = analyzeEventLog(FIXTURE_RUN_ERROR);
    expect(a.terminal).toBe("RUN_ERROR");
    expect(a.complete).toBe(true);
  });

  it("reports a streaming/partial prefix as valid-but-incomplete", () => {
    const a = analyzeEventLog(FIXTURE_STREAMING_PARTIAL);
    expect(a.invalidIndices).toEqual([]); // every event is well-formed
    expect(a.startsWithRunStarted).toBe(true);
    expect(a.terminal).toBeNull(); // no terminal frame yet
    expect(a.complete).toBe(false);
  });

  it("treats an unknown/unregistered renderable-view DATA_PART as a valid event", () => {
    const a = analyzeEventLog(FIXTURE_UNKNOWN_RENDERABLE_VIEW);
    expect(a.invalidIndices).toEqual([]);
    expect(a.complete).toBe(true);
  });

  it("flags malformed entries and surfaces unknown event types", () => {
    const a = analyzeEventLog([
      { type: "RUN_STARTED", threadId: "t", runId: "r" },
      { type: "MYSTERY_FRAME", foo: 1 },
      { type: "RUN_FINISHED", threadId: "t", runId: "r" },
    ]);
    expect(a.invalidIndices).toEqual([1]);
    expect(a.unknownTypes).toEqual(["MYSTERY_FRAME"]);
    expect(a.complete).toBe(false);
  });
});
