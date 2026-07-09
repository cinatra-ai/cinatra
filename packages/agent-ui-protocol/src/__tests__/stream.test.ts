import { describe, expect, it } from "vitest";

import * as streamEntry from "../stream";

// ---------------------------------------------------------------------------
// The `@cinatra-ai/agent-ui-protocol/stream` entry is the public surface later
// stages (S2/S4/S5/S6) import the unified contract from. It is deliberately a
// SEPARATE entry from the package barrel so it does not inflate the latency-
// budgeted routes that reach the barrel transitively (see stream.ts). This test
// pins that entry's shape: every part of the contract is reachable from it, and
// it is a real entry point (so the tree-shaking/route-graph split holds and the
// module is not dead code).
// ---------------------------------------------------------------------------

describe("@cinatra-ai/agent-ui-protocol/stream entry", () => {
  it("re-exports the versioned contract + durable-resume surface", () => {
    expect(streamEntry.ASSISTANT_STREAM_CONTRACT_VERSION).toBeTypeOf("string");
    expect(Array.isArray(streamEntry.ASSISTANT_STREAM_SURFACES)).toBe(true);
    expect(streamEntry.ASSISTANT_STREAM_TRANSPORT.kind).toBe("sse");
    expect(streamEntry.RESUME_HEADER).toBe("Last-Event-ID");
    expect(streamEntry.REPLAY_FROM_START_CURSOR).toBe("0-0");
    expect(streamEntry.isValidStreamCursor("123-0")).toBe(true);
    expect(streamEntry.normalizeResumeCursor("nope")).toBeUndefined();
    expect([...streamEntry.TERMINAL_EVENT_TYPES]).toEqual([
      "RUN_FINISHED",
      "RUN_ERROR",
    ]);
  });

  it("re-exports the capability handshake", () => {
    expect(streamEntry.buildAssistantStreamCapabilities).toBeTypeOf("function");
    expect(streamEntry.negotiateContract).toBeTypeOf("function");
    expect(streamEntry.negotiateStreamContract).toBeTypeOf("function");
    expect(streamEntry.compareContractVersions).toBeTypeOf("function");
    expect([...streamEntry.ASSISTANT_STREAM_AUTH_MODES]).toContain("session");
  });

  it("re-exports the renderable-view seam", () => {
    expect(streamEntry.renderableViewType).toBeTypeOf("function");
    expect(streamEntry.isRenderableViewDataPart).toBeTypeOf("function");
    expect(streamEntry.isRenderableViewOfType).toBeTypeOf("function");
    expect(streamEntry.renderableViewDataPart).toBeTypeOf("function");
  });

  it("re-exports the conformance surface + seed corpus", () => {
    expect(streamEntry.isAgUiEvent).toBeTypeOf("function");
    expect(streamEntry.isAgUiEventType).toBeTypeOf("function");
    expect(streamEntry.analyzeEventLog).toBeTypeOf("function");
    // The seed corpus is present so S6 conformance can begin against the entry.
    expect(Object.keys(streamEntry.CONFORMANCE_CORPUS).length).toBeGreaterThan(0);
    expect(streamEntry.FIXTURE_FULL_TURN.length).toBeGreaterThan(0);
  });
});
