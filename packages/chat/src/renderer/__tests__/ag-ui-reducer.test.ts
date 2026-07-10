// ---------------------------------------------------------------------------
// AG-UI event-to-UI reducer — full test matrix (cinatra#1311).
// Happy path · tool rounds · mapping gaps · event-ordering edge cases ·
// partial/streaming · error · replay/resume (STATE_SNAPSHOT + idempotence).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import type { AgUiEvent } from "@cinatra-ai/agent-ui-protocol";
import {
  agUiReduce,
  initialConversationState,
  reduceAgUiEvents,
  type ConversationViewState,
} from "../ag-ui-reducer";
import {
  AGENT_RUN,
  ERROR_MIDSTREAM,
  HAPPY_TEXT,
  HITL,
  PARTIAL_EMBED,
  TOOL_THEN_TEXT,
  WITH_CITATIONS,
  agentRunDataPart,
  citationsDataPart,
  interrupt,
  resume,
  runError,
  runStarted,
  textDelta,
  textEnd,
  textStart,
  toolEnd,
  toolStart,
} from "./ag-ui-fixtures";

const toolCallParts = (s: ConversationViewState) =>
  s.message.parts.filter((p) => p.kind === "tool_call");
const textParts = (s: ConversationViewState) =>
  s.message.parts.filter((p) => p.kind === "text");
const groupToolCalls = (s: ConversationViewState) =>
  s.message.thoughtGroups[0]?.toolCalls ?? [];

describe("agUiReduce — happy path", () => {
  it("folds a plain text turn into content + a single text part", () => {
    const s = reduceAgUiEvents(HAPPY_TEXT);
    expect(s.message.content).toBe("Hello world");
    expect(textParts(s)).toHaveLength(1);
    expect(s.status).toBe("finished");
    expect(s.message.liveStatus).toBeUndefined();
    expect(s.runId).toBe("run-1");
    expect(s.threadId).toBe("thread-1");
  });

  it("sets liveStatus 'Thinking' on RUN_STARTED and clears it once visible text streams", () => {
    let s = agUiReduce(initialConversationState(), runStarted());
    expect(s.message.liveStatus).toBe("Thinking");
    s = agUiReduce(s, textStart("m1"));
    s = agUiReduce(s, textDelta("m1", "hi"));
    expect(s.message.liveStatus).toBeUndefined();
  });
});

describe("agUiReduce — tool rounds + round separator", () => {
  it("inserts a paragraph break when text resumes after a tool round", () => {
    const s = reduceAgUiEvents(TOOL_THEN_TEXT);
    expect(s.message.content).toBe("Let me check.\n\nYou have 3 messages.");
    // Two text segments split by the tool round → two text parts.
    expect(textParts(s)).toHaveLength(2);
    expect(toolCallParts(s)).toHaveLength(1);
  });

  it("derives the tool chip label from the tool NAME (TOOL_CALL_END has no resultLabel)", () => {
    const s = reduceAgUiEvents([
      runStarted(),
      toolStart("t1", "gmail.messages.list"),
      toolEnd("t1"),
    ]);
    const tc = groupToolCalls(s)[0];
    expect(tc.status).toBe("completed");
    // "gmail.messages.list" → "Messages · List" via formatToolCallLabel/formatToolName.
    expect(tc.resultLabel).toBe("Messages · List");
    const part = toolCallParts(s)[0];
    expect(part.kind === "tool_call" && part.resultLabel).toBe("Messages · List");
  });

  it("sets liveStatus to a tool-progress string while a tool runs", () => {
    const s = reduceAgUiEvents([runStarted(), toolStart("t1", "web_search")]);
    expect(s.message.liveStatus).toBe("Searching the web");
  });
});

describe("agUiReduce — mapping gap: agent_run runId from DATA_PART only", () => {
  it("pins the inline-run-card runId from a DATA_PART, never from TOOL_CALL_END", () => {
    // Before the DATA_PART, the tool_call part has NO runId even though it ended.
    let s = reduceAgUiEvents([runStarted(), toolStart("t1", "agent_run"), toolEnd("t1")]);
    let part = toolCallParts(s)[0];
    expect(part.kind === "tool_call" && part.runId).toBeUndefined();
    // The DATA_PART pins it.
    s = agUiReduce(s, agentRunDataPart("t1", "agent-run-99", 0));
    part = toolCallParts(s)[0];
    expect(part.kind === "tool_call" && part.runId).toBe("agent-run-99");
  });

  it("full AGENT_RUN stream pins the runId on the matching part", () => {
    const s = reduceAgUiEvents(AGENT_RUN);
    const part = toolCallParts(s).find((p) => p.kind === "tool_call" && p.name === "agent_run");
    expect(part && part.kind === "tool_call" && part.runId).toBe("agent-run-99");
  });

  it("ignores an agent_run DATA_PART for an unknown toolCallId (no crash, no pin)", () => {
    const s = reduceAgUiEvents([
      runStarted(),
      toolStart("t1", "agent_run"),
      agentRunDataPart("tX", "agent-run-99", 0),
    ]);
    const part = toolCallParts(s)[0];
    expect(part.kind === "tool_call" && part.runId).toBeUndefined();
  });
});

describe("agUiReduce — citations via DATA_PART", () => {
  it("merges normalized citations from a citations DATA_PART", () => {
    const s = reduceAgUiEvents(WITH_CITATIONS);
    expect(s.message.citations.map((c) => c.url)).toEqual([
      "https://a.example/x",
      "https://b.example/y",
    ]);
  });

  it("dedupes citations by url across DATA_PARTs", () => {
    const s = reduceAgUiEvents([
      runStarted(),
      citationsDataPart([{ url: "https://a.example/x", title: "A" }], 0),
      citationsDataPart([{ url: "https://a.example/x", title: "A2" }, { url: "https://c.example/z" }], 1),
    ]);
    expect(s.message.citations.map((c) => c.url)).toEqual([
      "https://a.example/x",
      "https://c.example/z",
    ]);
  });

  it("carries an unrecognized DATA_PART through to dataParts (S4 renderable view seam)", () => {
    const s = reduceAgUiEvents([
      runStarted(),
      { type: "DATA_PART", data: { kind: "content_change_proposal", id: "v1" }, partIndex: 0 } as AgUiEvent,
    ]);
    expect(s.dataParts).toEqual([{ kind: "content_change_proposal", id: "v1" }]);
  });
});

describe("agUiReduce — HITL interrupt/resume", () => {
  it("opens an interrupt slice on INTERRUPT and clears it on RESUME", () => {
    let s = agUiReduce(initialConversationState(), runStarted());
    s = agUiReduce(s, interrupt({ fieldName: "confirm" }));
    expect(s.interrupt).toMatchObject({
      reviewTaskId: "rt-1",
      xRenderer: "@cinatra-ai/email-agent:send-confirmation",
      fieldName: "confirm",
      runId: "run-1",
    });
    expect(s.message.liveStatus).toBe("Waiting for your input");
    s = agUiReduce(s, resume());
    expect(s.interrupt).toBeNull();
  });

  it("full HITL stream ends with no open interrupt and the final answer", () => {
    const s = reduceAgUiEvents(HITL);
    expect(s.interrupt).toBeNull();
    expect(s.message.content).toBe("Done.");
  });

  it("RESUME with no open interrupt is a no-op (same reference)", () => {
    const s = agUiReduce(initialConversationState(), runStarted());
    expect(agUiReduce(s, resume())).toBe(s);
  });
});

describe("agUiReduce — error", () => {
  it("sets a friendly error + errorRaw and clears liveStatus on RUN_ERROR", () => {
    const s = reduceAgUiEvents(ERROR_MIDSTREAM);
    expect(s.status).toBe("error");
    expect(s.message.errorRaw).toBe("The model call failed.");
    expect(s.message.error).toBe("The model call failed.");
    expect(s.message.liveStatus).toBeUndefined();
    // The partial text folded before the error is preserved.
    expect(s.message.content).toBe("Partial answer");
  });
});

describe("agUiReduce — event-ordering edge cases", () => {
  it("orphan TOOL_CALL_END (no prior START) is a no-op (same reference)", () => {
    const s = agUiReduce(initialConversationState(), runStarted());
    expect(agUiReduce(s, toolEnd("ghost"))).toBe(s);
  });

  it("duplicate TOOL_CALL_START is deduped by id (same reference, one chip)", () => {
    let s = reduceAgUiEvents([runStarted(), toolStart("t1", "web_search")]);
    const before = s;
    s = agUiReduce(s, toolStart("t1", "web_search"));
    expect(s).toBe(before);
    expect(groupToolCalls(s)).toHaveLength(1);
    expect(toolCallParts(s)).toHaveLength(1);
  });

  it("duplicate TOOL_CALL_END on an already-completed call is a no-op", () => {
    let s = reduceAgUiEvents([runStarted(), toolStart("t1", "web_search"), toolEnd("t1")]);
    const before = s;
    s = agUiReduce(s, toolEnd("t1"));
    expect(s).toBe(before);
  });

  it("orphan / stale TEXT_MESSAGE_CONTENT (no matching open message) is a no-op", () => {
    const s = agUiReduce(initialConversationState(), runStarted());
    expect(agUiReduce(s, textDelta("never-started", "x"))).toBe(s);
  });

  it("content for a SEALED message (after its END) is ignored", () => {
    let s = reduceAgUiEvents([runStarted(), textStart("m1"), textDelta("m1", "hi"), textEnd("m1")]);
    const before = s.message.content;
    s = agUiReduce(s, textStart("m1")); // sealed → no-op
    s = agUiReduce(s, textDelta("m1", " AGAIN")); // not open → no-op
    expect(s.message.content).toBe(before);
  });
});

describe("agUiReduce — determinism / idempotence", () => {
  const streams: Array<[string, AgUiEvent[]]> = [
    ["HAPPY_TEXT", HAPPY_TEXT],
    ["TOOL_THEN_TEXT", TOOL_THEN_TEXT],
    ["AGENT_RUN", AGENT_RUN],
    ["WITH_CITATIONS", WITH_CITATIONS],
    ["HITL", HITL],
  ];

  it.each(streams)("re-folding the completed %s prefix does not duplicate", (_name, events) => {
    const once = reduceAgUiEvents(events);
    const twice = events.reduce(agUiReduce, once);
    expect(twice.message.content).toBe(once.message.content);
    expect(twice.message.parts).toEqual(once.message.parts);
    expect(twice.message.thoughtGroups).toEqual(once.message.thoughtGroups);
    expect(twice.message.citations).toEqual(once.message.citations);
    expect(twice.interrupt).toEqual(once.interrupt);
  });

  it("is deterministic: two independent folds are deep-equal", () => {
    expect(reduceAgUiEvents(TOOL_THEN_TEXT)).toEqual(reduceAgUiEvents(TOOL_THEN_TEXT));
  });
});

describe("agUiReduce — STATE_SNAPSHOT rehydrate-then-resume", () => {
  it("replaces state wholesale from a snapshot payload", () => {
    const reduced = reduceAgUiEvents(TOOL_THEN_TEXT);
    const rehydrated = agUiReduce(initialConversationState(), {
      type: "STATE_SNAPSHOT",
      snapshot: reduced,
    });
    expect(rehydrated.message.content).toBe(reduced.message.content);
    expect(rehydrated.message.parts).toEqual(reduced.message.parts);
    expect(rehydrated.message.thoughtGroups).toEqual(reduced.message.thoughtGroups);
  });

  it("a completed prefix replayed AFTER a snapshot does not double-apply", () => {
    const reduced = reduceAgUiEvents(TOOL_THEN_TEXT);
    let s = agUiReduce(initialConversationState(), {
      type: "STATE_SNAPSHOT",
      snapshot: reduced,
    });
    // Replay the full (completed) prefix on top of the snapshot.
    s = TOOL_THEN_TEXT.reduce(agUiReduce, s);
    expect(s.message.content).toBe(reduced.message.content);
    expect(s.message.parts).toEqual(reduced.message.parts);
    expect(groupToolCalls(s)).toHaveLength(1);
  });

  it("folds NEW events on top of a snapshot as normal", () => {
    const reduced = reduceAgUiEvents([runStarted(), textStart("m1"), textDelta("m1", "hi"), textEnd("m1")]);
    let s = agUiReduce(initialConversationState(), { type: "STATE_SNAPSHOT", snapshot: reduced });
    s = agUiReduce(s, textStart("m2"));
    s = agUiReduce(s, textDelta("m2", " more"));
    // New segment appends (round separator not active — no tool round).
    expect(s.message.content).toBe("hi more");
  });

  it("an unrecognized snapshot shape is a no-op (defensive)", () => {
    const s = agUiReduce(initialConversationState(), { type: "STATE_SNAPSHOT", snapshot: 42 });
    expect(s.message.content).toBe("");
    const s2 = agUiReduce(initialConversationState(), { type: "STATE_SNAPSHOT", snapshot: { nope: true } });
    expect(s2.message.content).toBe("");
  });
});

describe("agUiReduce — partial/streaming state", () => {
  it("keeps the raw incomplete-embed tail in content (trimming is the render layer's job)", () => {
    const s = reduceAgUiEvents(PARTIAL_EMBED);
    expect(s.message.content).toBe('Chart: [chart:{"type":"bar"');
    // Still streaming — not finished, message not sealed.
    expect(s.status).toBe("running");
    expect(s.openTextMessageId).toBe("m1");
  });
});

describe("agUiReduce — exhaustiveness / lifecycle", () => {
  it("handles every event type in the S1 union without throwing", () => {
    const all: AgUiEvent[] = [
      runStarted(),
      textStart("m1"),
      textDelta("m1", "a"),
      textEnd("m1"),
      toolStart("t1", "web_search"),
      toolEnd("t1"),
      { type: "STATE_SNAPSHOT", snapshot: null },
      interrupt(),
      resume(),
      agentRunDataPart("t1", "r1", 0),
      runError("boom"),
      runStarted(),
      { type: "RUN_FINISHED", threadId: "thread-1", runId: "run-1", status: "completed" },
    ];
    expect(() => all.reduce(agUiReduce, initialConversationState())).not.toThrow();
  });

  it("RUN_STARTED for the same run does not reset an in-flight turn", () => {
    let s = reduceAgUiEvents([runStarted(), textStart("m1"), textDelta("m1", "hi")]);
    const before = s;
    s = agUiReduce(s, runStarted());
    expect(s).toBe(before);
    expect(s.message.content).toBe("hi");
  });

  it("a replayed DATA_PART is a no-op via natural idempotence (not partIndex dedupe)", () => {
    let s = reduceAgUiEvents([runStarted(), citationsDataPart([{ url: "https://a.example/x" }], 0)]);
    const before = s;
    s = agUiReduce(s, citationsDataPart([{ url: "https://a.example/x" }], 0));
    expect(s).toBe(before);
    expect(s.message.citations).toHaveLength(1);
  });

  it("keeps DISTINCT data parts that share a partIndex (partIndex is per-artifact, not a dedupe key)", () => {
    const s = reduceAgUiEvents([
      runStarted(),
      { type: "DATA_PART", data: { kind: "view_a", id: "1" }, partIndex: 0 } as AgUiEvent,
      { type: "DATA_PART", data: { kind: "view_b", id: "2" }, partIndex: 0 } as AgUiEvent,
    ]);
    expect(s.dataParts).toEqual([
      { kind: "view_a", id: "1" },
      { kind: "view_b", id: "2" },
    ]);
  });

  it("a replayed unrecognized DATA_PART is deduped by structural equality", () => {
    let s = reduceAgUiEvents([
      runStarted(),
      { type: "DATA_PART", data: { kind: "view_a", id: "1" }, partIndex: 0 } as AgUiEvent,
    ]);
    const before = s;
    s = agUiReduce(s, { type: "DATA_PART", data: { kind: "view_a", id: "1" }, partIndex: 7 } as AgUiEvent);
    expect(s).toBe(before);
    expect(s.dataParts).toHaveLength(1);
  });
});

describe("agUiReduce — terminal events clear an open interrupt", () => {
  it("RUN_ERROR clears the HITL slice", () => {
    let s = reduceAgUiEvents([runStarted(), interrupt()]);
    expect(s.interrupt).not.toBeNull();
    s = agUiReduce(s, runError("boom"));
    expect(s.interrupt).toBeNull();
    expect(s.status).toBe("error");
  });

  it("RUN_FINISHED clears the HITL slice", () => {
    let s = reduceAgUiEvents([runStarted(), interrupt()]);
    expect(s.interrupt).not.toBeNull();
    s = agUiReduce(s, { type: "RUN_FINISHED", threadId: "thread-1", runId: "run-1", status: "completed" });
    expect(s.interrupt).toBeNull();
    expect(s.status).toBe("finished");
  });
});
