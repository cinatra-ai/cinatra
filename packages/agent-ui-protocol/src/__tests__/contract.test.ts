import { describe, expect, it } from "vitest";

import {
  ASSISTANT_STREAM_CONTRACT_VERSION,
  ASSISTANT_STREAM_SURFACES,
  ASSISTANT_STREAM_TRANSPORT,
  TERMINAL_EVENT_TYPES,
  RESUME_HEADER,
  REPLAY_FROM_START_CURSOR,
  isValidStreamCursor,
  normalizeResumeCursor,
} from "../contract";

describe("assistant-stream contract constants", () => {
  it("pins a single semver-shaped contract version (no `v` prefix)", () => {
    expect(ASSISTANT_STREAM_CONTRACT_VERSION).toBe("1.0.0");
    expect(ASSISTANT_STREAM_CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("names the three surfaces that speak the one wire", () => {
    expect([...ASSISTANT_STREAM_SURFACES]).toEqual([
      "chat",
      "embedded-view",
      "cms-iframe",
    ]);
  });

  it("describes the durable/resumable SSE transport", () => {
    expect(ASSISTANT_STREAM_TRANSPORT.kind).toBe("sse");
    expect(ASSISTANT_STREAM_TRANSPORT.resumeHeader).toBe("Last-Event-ID");
    expect(RESUME_HEADER).toBe("Last-Event-ID");
    expect(ASSISTANT_STREAM_TRANSPORT.replayFromStartCursor).toBe("0-0");
    expect(REPLAY_FROM_START_CURSOR).toBe("0-0");
    expect([...ASSISTANT_STREAM_TRANSPORT.terminalEventTypes]).toEqual([
      "RUN_FINISHED",
      "RUN_ERROR",
    ]);
    expect([...TERMINAL_EVENT_TYPES]).toEqual(["RUN_FINISHED", "RUN_ERROR"]);
  });
});

describe("resume cursor parsing (Last-Event-ID)", () => {
  it("accepts Redis-Streams entry IDs `<digits>-<digits>`", () => {
    expect(isValidStreamCursor("0-0")).toBe(true);
    expect(isValidStreamCursor("1720000000000-0")).toBe(true);
    expect(isValidStreamCursor("1720000000000-42")).toBe(true);
  });

  it("rejects anything that is not `<digits>-<digits>`", () => {
    for (const bad of ["", "abc", "123", "123-", "-1", "1-2-3", "1.2-3", "x-y"]) {
      expect(isValidStreamCursor(bad)).toBe(false);
    }
    expect(isValidStreamCursor(123 as unknown)).toBe(false);
    expect(isValidStreamCursor(null)).toBe(false);
    expect(isValidStreamCursor(undefined)).toBe(false);
  });

  it("normalizes a header value: valid passes through, invalid/absent -> undefined", () => {
    expect(normalizeResumeCursor("1720000000000-3")).toBe("1720000000000-3");
    expect(normalizeResumeCursor("garbage")).toBeUndefined();
    expect(normalizeResumeCursor(null)).toBeUndefined();
    expect(normalizeResumeCursor(undefined)).toBeUndefined();
    expect(normalizeResumeCursor("")).toBeUndefined();
  });
});
