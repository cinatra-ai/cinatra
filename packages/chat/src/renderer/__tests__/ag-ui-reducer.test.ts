// AG-UI event-to-UI reducer — full test matrix (cinatra#1311).
// Happy path, event-ordering, partial/streaming, error, replay/resume.

import { describe, expect, it } from "vitest";
import type { AgUiEvent } from "@cinatra-ai/agent-ui-protocol";

import {
  agUiReduce,
  agUiReduceAll,
  createAgUiReducerState,
  type AgUiReducerState,
} from "../ag-ui-reducer";
import {
  AGENT_RUN_PIN,
  CITATIONS,
  ERROR_MIDSTREAM,
  HAPPY_PATH,
  HITL,
  MSG_ID,
  RUN_ID,
  THREAD_ID,
} from "./ag-ui-fixtures";

function textParts(s: AgUiReducerState): string[] {
  return (s.message.parts ?? [])
    .filter((p): p is { kind: "text"; content: string } => p.kind === "text")
    .map((p) => p.content);
}

describe("agUiReduce — happy path", () => {
  const s = agUiReduceAll(HAPPY_PATH);

  it("accumulates text with a paragraph break after the tool round", () => {
    // "Let me check that." then a tool round, then a NEW paragraph.
    expect(s.message.content).toBe("Let me check that.\n\nHere is the answer.");
  });

  it("builds an ordered parts trace: text, tool_call, text", () => {
    const kinds = (s.message.parts ?? []).map((p) => p.kind);
    expect(kinds).toEqual(["text", "tool_call", "text"]);
  });

  it("records the tool call in the single thought group, completed", () => {
    const tools = s.message.thoughtGroups?.[0].toolCalls ?? [];
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ id: "tc-1", status: "completed" });
  });

  it("seeds run/thread ids and finishes the run, clearing liveStatus", () => {
    expect(s.runId).toBe(RUN_ID);
    expect(s.threadId).toBe(THREAD_ID);
    expect(s.runStatus).toBe("finished");
    expect(s.message.liveStatus).toBeUndefined();
  });
});

describe("agUiReduce — tool label derivation (mapping gap)", () => {
  it("derives the completed chip label from the tool NAME, not a wire field", () => {
    // AG-UI TOOL_CALL_END carries only the id — the label must come from the name.
    const s = agUiReduceAll([
      { type: "TOOL_CALL_START", toolCallId: "t", toolCallName: "campaigns.list" },
      { type: "TOOL_CALL_END", toolCallId: "t" },
    ]);
    const tc = s.message.thoughtGroups?.[0].toolCalls[0];
    expect(tc?.status).toBe("completed");
    expect(tc?.resultLabel).toBe("Campaigns · List");
  });

  it("pins an agent_run runId ONLY from a DATA_PART, never from TOOL_CALL_END", () => {
    const s = agUiReduceAll(AGENT_RUN_PIN);
    const part = (s.message.parts ?? []).find((p) => p.kind === "tool_call");
    expect(part && part.kind === "tool_call" && part.runId).toBe("child-run-9");
  });

  it("drops a runId-pin DATA_PART with no matching tool_call (no-op)", () => {
    const base = agUiReduceAll([
      { type: "TOOL_CALL_START", toolCallId: "known", toolCallName: "x" },
    ]);
    const after = agUiReduce(base, {
      type: "DATA_PART",
      data: { toolCallId: "unknown", runId: "r" },
    });
    expect(after).toBe(base);
  });

  it("is a no-op (same reference) when the runId pin is already applied", () => {
    const pinned = agUiReduceAll(AGENT_RUN_PIN);
    const again = agUiReduce(pinned, {
      type: "DATA_PART",
      data: { toolCallId: "tc-run", runId: "child-run-9" },
    });
    expect(again).toBe(pinned);
  });
});

describe("agUiReduce — event ordering", () => {
  it("dedupes a duplicate TOOL_CALL_START to a single chip + part", () => {
    const s = agUiReduceAll([
      { type: "TOOL_CALL_START", toolCallId: "dup", toolCallName: "n" },
      { type: "TOOL_CALL_START", toolCallId: "dup", toolCallName: "n" },
    ]);
    expect(s.message.thoughtGroups?.[0].toolCalls).toHaveLength(1);
    expect((s.message.parts ?? []).filter((p) => p.kind === "tool_call")).toHaveLength(1);
  });

  it("no-ops an orphan TOOL_CALL_END (no prior start) — same reference", () => {
    const base = createAgUiReducerState();
    const after = agUiReduce(base, { type: "TOOL_CALL_END", toolCallId: "ghost" });
    expect(after).toBe(base);
  });

  it("no-ops TEXT_MESSAGE_END — same reference", () => {
    const base = agUiReduceAll(HAPPY_PATH);
    const after = agUiReduce(base, { type: "TEXT_MESSAGE_END", messageId: MSG_ID });
    expect(after).toBe(base);
  });

  it("accepts TEXT_MESSAGE_CONTENT that arrives before RUN_STARTED", () => {
    const s = agUiReduceAll([
      { type: "TEXT_MESSAGE_CONTENT", messageId: MSG_ID, delta: "early" },
      { type: "RUN_STARTED", threadId: THREAD_ID, runId: RUN_ID },
    ]);
    expect(s.message.content).toBe("early");
    // RUN_STARTED still adopts its runId as the message id (was empty).
    expect(s.message.id).toBe(RUN_ID);
  });
});

describe("agUiReduce — partial / streaming", () => {
  it("keeps liveStatus set while only an incomplete embed has streamed", () => {
    // After a tool round liveStatus = "Reviewing tool results"; a partial
    // chart embed is not yet visible text, so liveStatus must NOT clear.
    const s = agUiReduceAll([
      { type: "TOOL_CALL_START", toolCallId: "t", toolCallName: "n" },
      { type: "TOOL_CALL_END", toolCallId: "t" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: MSG_ID, delta: '[chart:{"type":' },
    ]);
    expect(s.message.liveStatus).toBe("Reviewing tool results");
  });

  it("clears liveStatus once visible text streams", () => {
    const s = agUiReduceAll([
      { type: "TOOL_CALL_START", toolCallId: "t", toolCallName: "n" },
      { type: "TOOL_CALL_END", toolCallId: "t" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: MSG_ID, delta: "Real answer." },
    ]);
    expect(s.message.liveStatus).toBeUndefined();
  });

  it("skips empty text deltas without changing state", () => {
    const base = agUiReduceAll([
      { type: "TEXT_MESSAGE_CONTENT", messageId: MSG_ID, delta: "hi" },
    ]);
    const after = agUiReduce(base, {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: MSG_ID,
      delta: "",
    });
    expect(after).toBe(base);
  });
});

describe("agUiReduce — citations", () => {
  it("merges + dedupes citations by url across DATA_PARTs", () => {
    const s = agUiReduceAll(CITATIONS);
    const urls = (s.message.citations ?? []).map((c) => c.url);
    expect(urls).toEqual([
      "https://a.example",
      "https://b.example",
      "https://c.example",
    ]);
  });
});

describe("agUiReduce — error", () => {
  it("stores a normalized error message + raw, sets error status", () => {
    const s = agUiReduceAll(ERROR_MIDSTREAM);
    expect(s.runStatus).toBe("error");
    expect(s.message.error).toBe("upstream exploded");
    expect(s.message.errorRaw).toContain("upstream exploded");
  });

  it("clears an open interrupt on RUN_ERROR", () => {
    const withInterrupt = agUiReduceAll(HITL);
    expect(withInterrupt.interrupt).not.toBeNull();
    const errored = agUiReduce(withInterrupt, {
      type: "RUN_ERROR",
      threadId: THREAD_ID,
      runId: RUN_ID,
      message: "boom",
    });
    expect(errored.interrupt).toBeNull();
  });
});

describe("agUiReduce — HITL interrupt / resume", () => {
  it("opens an interrupt slice and sets a waiting liveStatus", () => {
    const s = agUiReduceAll(HITL);
    expect(s.interrupt).toMatchObject({ reviewTaskId: "rt-1", runId: RUN_ID });
    expect(s.message.liveStatus).toBe("Waiting for approval");
  });

  it("clears the interrupt on a matching RESUME", () => {
    const s = agUiReduce(agUiReduceAll(HITL), {
      type: "RESUME",
      threadId: THREAD_ID,
      runId: RUN_ID,
      reviewTaskId: "rt-1",
    });
    expect(s.interrupt).toBeNull();
  });

  it("no-ops a RESUME whose reviewTaskId does not match the open interrupt", () => {
    const base = agUiReduceAll(HITL);
    const after = agUiReduce(base, {
      type: "RESUME",
      threadId: THREAD_ID,
      runId: RUN_ID,
      reviewTaskId: "other",
    });
    expect(after).toBe(base);
  });
});

describe("agUiReduce — STATE_SNAPSHOT rehydrate", () => {
  it("replaces state wholesale from a snapshot", () => {
    const target = agUiReduceAll(HAPPY_PATH);
    const fresh = createAgUiReducerState();
    const rehydrated = agUiReduce(fresh, {
      type: "STATE_SNAPSHOT",
      snapshot: target,
    });
    expect(rehydrated.message.content).toBe(target.message.content);
    expect(rehydrated.runStatus).toBe(target.runStatus);
  });

  it("replaces state WHOLESALE — a snapshot without runId clears the prior runId", () => {
    // Rehydrate-then-resume must not leak prior run/thread ids through.
    const prior = agUiReduceAll(HAPPY_PATH); // has runId + threadId + finished
    const snapshot = { ...createAgUiReducerState("m"), runStatus: "running" as const };
    const rehydrated = agUiReduce(prior, { type: "STATE_SNAPSHOT", snapshot });
    expect(rehydrated.runId).toBeUndefined();
    expect(rehydrated.threadId).toBeUndefined();
    expect(rehydrated.runStatus).toBe("running");
    expect(rehydrated.message.content).toBe("");
  });

  it("ignores a malformed snapshot (same reference)", () => {
    const base = agUiReduceAll(HAPPY_PATH);
    for (const bad of [null, 42, "x", [], { message: 5 }, { message: { id: 1 } }]) {
      const after = agUiReduce(base, {
        type: "STATE_SNAPSHOT",
        snapshot: bad as unknown,
      });
      expect(after).toBe(base);
    }
  });
});

describe("agUiReduce — determinism + resume idempotence", () => {
  it("is deterministic: re-folding the same log yields deep-equal state", () => {
    expect(agUiReduceAll(HAPPY_PATH)).toEqual(agUiReduceAll(HAPPY_PATH));
  });

  it("resume via snapshot+suffix equals folding the whole log (no double-apply)", () => {
    const full: AgUiEvent[] = HAPPY_PATH;
    for (let k = 1; k < full.length; k++) {
      const prefix = full.slice(0, k);
      const suffix = full.slice(k);
      const snapshotState = agUiReduceAll(prefix);
      // Reconnect: a DIVERGENT fresh client adopts the snapshot, then folds
      // only the suffix. Must equal folding the whole log from scratch.
      const resumed = suffix.reduce(
        agUiReduce,
        agUiReduce(createAgUiReducerState("divergent"), {
          type: "STATE_SNAPSHOT",
          snapshot: snapshotState,
        }),
      );
      expect(resumed).toEqual(agUiReduceAll(full));
    }
  });
});

describe("agUiReduce — lifecycle events are explicit", () => {
  it("RUN_FINISHED with status=stopped records the stopped status", () => {
    const s = agUiReduce(createAgUiReducerState(), {
      type: "RUN_FINISHED",
      threadId: THREAD_ID,
      runId: RUN_ID,
      status: "stopped",
    });
    expect(s.runStatus).toBe("stopped");
  });

  it("replaying RUN_STARTED does not wipe accumulated content", () => {
    const s = agUiReduceAll([
      { type: "RUN_STARTED", threadId: THREAD_ID, runId: RUN_ID },
      { type: "TEXT_MESSAGE_CONTENT", messageId: MSG_ID, delta: "kept" },
      { type: "RUN_STARTED", threadId: THREAD_ID, runId: RUN_ID },
    ]);
    expect(s.message.content).toBe("kept");
    expect(s.message.id).toBe(RUN_ID);
  });
});
