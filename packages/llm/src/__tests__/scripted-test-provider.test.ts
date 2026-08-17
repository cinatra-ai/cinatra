import { describe, expect, it } from "vitest";

import type { OrchestrateStreamInput } from "../types";
import {
  UAT_SENTINEL,
  assertScriptedProviderNotProduction,
  buildScriptedContentEditorReplyText,
  isScriptedTestProviderEnabled,
  runScriptedChatAssistantTurn,
  runScriptedStream,
  runScriptedWidgetAssistantTurn,
  scriptedTurnAsksForScheduleProposal,
  scriptedTurnNamesAgentRun,
  scriptedTurnNamesLifecycleRef,
} from "../scripted-test-provider";

type Captured = {
  text: string;
  toolResults: Array<{ name: string; result: string }>;
  steps: { start: number[]; end: number[] };
  errors: Error[];
};

function makeInput(
  system: string,
  userText: string,
): { input: OrchestrateStreamInput; captured: Captured } {
  const captured: Captured = { text: "", toolResults: [], steps: { start: [], end: [] }, errors: [] };
  const input = {
    system,
    messages: [{ role: "user", content: userText }],
    onTextDelta: (d: string) => { captured.text += d; },
    onToolCall: () => {},
    onToolResult: (r: { name: string; result: string }) => { captured.toolResults.push(r); },
    onStepStart: (s: number) => { captured.steps.start.push(s); },
    onStepEnd: (s: number) => { captured.steps.end.push(s); },
    onError: (e: Error) => { captured.errors.push(e); },
  } as unknown as OrchestrateStreamInput;
  return { input, captured };
}

describe("scripted-test-provider", () => {
  it("isScriptedTestProviderEnabled reflects the env flag", () => {
    expect(isScriptedTestProviderEnabled({ CINATRA_TEST_LLM_PROVIDER: "scripted" })).toBe(true);
    expect(isScriptedTestProviderEnabled({})).toBe(false);
    expect(isScriptedTestProviderEnabled({ CINATRA_TEST_LLM_PROVIDER: "openai" })).toBe(false);
  });

  it("assertScriptedProviderNotProduction allows ONLY an explicit development runtime when enabled", () => {
    const msg = /must NEVER run outside development/;
    // enabled + explicit development → the only allowed case
    expect(() =>
      assertScriptedProviderNotProduction({ CINATRA_TEST_LLM_PROVIDER: "scripted", CINATRA_RUNTIME_MODE: "development" }),
    ).not.toThrow();
    // enabled + production runtime → throw
    expect(() =>
      assertScriptedProviderNotProduction({ CINATRA_TEST_LLM_PROVIDER: "scripted", CINATRA_RUNTIME_MODE: "production" }),
    ).toThrow(msg);
    // enabled + UNSET runtime mode → throw (allow-list, not deny-list)
    expect(() =>
      assertScriptedProviderNotProduction({ CINATRA_TEST_LLM_PROVIDER: "scripted" }),
    ).toThrow(msg);
    // enabled + development runtime BUT NODE_ENV=production → throw
    expect(() =>
      assertScriptedProviderNotProduction({ CINATRA_TEST_LLM_PROVIDER: "scripted", CINATRA_RUNTIME_MODE: "development", NODE_ENV: "production" }),
    ).toThrow(msg);
    // not enabled → no-op regardless of runtime
    expect(() =>
      assertScriptedProviderNotProduction({ CINATRA_RUNTIME_MODE: "production" }),
    ).not.toThrow();
  });

  it("streams a sentinel-bearing reply for a plain WordPress prompt (no tool result)", async () => {
    const { input, captured } = makeInput(
      "Current WordPress context:\n- instanceId: wp-prod\n- postId: 42\n",
      "Hello, what can you do?",
    );
    await runScriptedStream(input);
    expect(captured.text).toContain(UAT_SENTINEL);
    expect(captured.text).toContain("WordPress");
    expect(captured.toolResults).toHaveLength(0);
    expect(captured.steps.start).toEqual([1]);
    expect(captured.steps.end).toEqual([1]);
    expect(captured.errors).toHaveLength(0);
  });

  it("emits a wordpress_content_editor_run tool result with postId on an edit-intent prompt", async () => {
    const { input, captured } = makeInput(
      "Current WordPress context:\n- instanceId: wp-prod\n- postId: 42\n",
      "Please rewrite the title to be punchier.",
    );
    await runScriptedStream(input);
    expect(captured.toolResults).toHaveLength(1);
    expect(captured.toolResults[0].name).toBe("wordpress_content_editor_run");
    const parsed = JSON.parse(captured.toolResults[0].result);
    expect(parsed.postId).toBe("42");
    expect(Array.isArray(parsed.changes)).toBe(true);
    expect(parsed.changes[0]).toMatchObject({ field: "title" });
  });

  it("emits a drupal_content_editor_run tool result with nodeId for Drupal context", async () => {
    const { input, captured } = makeInput(
      "Current Drupal context:\n- instanceId: drupal-prod\n- nodeId: 7\n",
      "Add a short summary.",
    );
    await runScriptedStream(input);
    expect(captured.toolResults).toHaveLength(1);
    expect(captured.toolResults[0].name).toBe("drupal_content_editor_run");
    const parsed = JSON.parse(captured.toolResults[0].result);
    expect(parsed.nodeId).toBe("7");
  });
});

describe("runScriptedWidgetAssistantTurn (unified /api/assistants/chat widget seam)", () => {
  type WCaptured = {
    text: string;
    toolCalls: Array<{ id: string; name: string }>;
    toolResults: Array<{ id: string; name: string; result: string }>;
    order: string[];
  };
  function makeSink(): { sink: Parameters<typeof runScriptedWidgetAssistantTurn>[0]; captured: WCaptured } {
    const captured: WCaptured = { text: "", toolCalls: [], toolResults: [], order: [] };
    const sink = {
      instructions: "",
      assistantHandle: "wordpress",
      onText: (c: string) => { captured.text += c; captured.order.push("text"); },
      onToolCall: (call: { id: string; name: string }) => { captured.toolCalls.push(call); captured.order.push("tool_call"); },
      onToolResult: (r: { id: string; name: string; result: string }) => { captured.toolResults.push(r); captured.order.push("tool_result"); },
    };
    return { sink, captured };
  }

  it("streams a sentinel-bearing WordPress reply with NO tool call on a plain prompt", async () => {
    const { sink, captured } = makeSink();
    await runScriptedWidgetAssistantTurn({ ...sink, instructions: "Hello, what can you do here?" });
    expect(captured.text).toContain(UAT_SENTINEL);
    expect(captured.text).toContain("WordPress");
    expect(captured.toolCalls).toHaveLength(0);
    expect(captured.toolResults).toHaveLength(0);
  });

  it("emits a wordpress_content_editor_run tool_call BEFORE its tool_result on an edit intent (widget content-edit key)", async () => {
    const { sink, captured } = makeSink();
    await runScriptedWidgetAssistantTurn({ ...sink, instructions: "Please rewrite the title to be punchier." });
    expect(captured.text).toContain(UAT_SENTINEL);
    expect(captured.toolCalls).toHaveLength(1);
    expect(captured.toolCalls[0].name).toBe("wordpress_content_editor_run");
    expect(captured.toolCalls[0].name).toMatch(/_content_editor_run$/);
    expect(captured.toolResults).toHaveLength(1);
    // The tool_call and tool_result share one id, and the call precedes the result.
    expect(captured.toolResults[0].id).toBe(captured.toolCalls[0].id);
    expect(captured.order.indexOf("tool_call")).toBeLessThan(captured.order.indexOf("tool_result"));
    // Text streams before the tool call (so the widget renders the reply, then keys the edit).
    expect(captured.order.indexOf("text")).toBeLessThan(captured.order.indexOf("tool_call"));
    const parsed = JSON.parse(captured.toolResults[0].result);
    expect(Array.isArray(parsed.changes)).toBe(true);
    expect(parsed.changes[0]).toMatchObject({ field: "title" });
    expect("postId" in parsed).toBe(true);
  });

  it("selects the Drupal tool + nodeId key from the bound assistant handle", async () => {
    const { sink, captured } = makeSink();
    await runScriptedWidgetAssistantTurn({ ...sink, assistantHandle: "Drupal", instructions: "Add a short summary." });
    expect(captured.text).toContain("Drupal");
    expect(captured.toolCalls[0].name).toBe("drupal_content_editor_run");
    const parsed = JSON.parse(captured.toolResults[0].result);
    expect("nodeId" in parsed).toBe(true);
  });
});

describe("a turn that NAMES a lifecycle card ref (cinatra#2683, S8f)", () => {
  // WHY THIS ARM EXISTS. `artifact_review_gates_list` answers with the OLDEST few
  // gates a caller may read, and a VERIFICATION reading exists only for a target
  // that has actually been repaired — so on any real backlog the head of that
  // list is almost never the item with a reading, and a provider that can only
  // render `refs[0]` can never show one. Naming the item is what a model asked
  // about a specific item does, and it is the same stand-in the run card already
  // makes. It grants nothing: the ref is opaque, and the REAL primitive decodes
  // it and re-runs the whole access ladder.
  const REF = "Zm9vYmFyLXNlYWxlZC1yZWYtdGhhdC1pcy1sb25nLWVub3VnaC10by1tYXRjaA";

  type WCaptured = {
    toolCalls: Array<{ id: string; name: string }>;
    toolResults: Array<{ id: string; name: string; result: string }>;
  };
  function makeSink(): {
    sink: Omit<Parameters<typeof runScriptedWidgetAssistantTurn>[0], "instructions">;
    captured: WCaptured;
    dispatched: Array<{ name: string; args: Record<string, unknown> }>;
  } {
    const captured: WCaptured = { toolCalls: [], toolResults: [] };
    const dispatched: Array<{ name: string; args: Record<string, unknown> }> = [];
    return {
      captured,
      dispatched,
      sink: {
        assistantHandle: "wordpress",
        onText: () => {},
        onToolCall: (call) => captured.toolCalls.push(call),
        onToolResult: (r) => captured.toolResults.push(r),
        callSelfMcpTool: async (call) => {
          dispatched.push(call as { name: string; args: Record<string, unknown> });
          return JSON.stringify({ ok: true });
        },
      },
    };
  }

  it("recognises a sealed ref and NOT a run id, a word, or a sentence", () => {
    expect(scriptedTurnNamesLifecycleRef(`Show me the verification for ${REF}`)).toBe(REF);
    // A run id is 40 characters at most — below the ref floor — so the two
    // readings can never collide.
    expect(
      scriptedTurnNamesLifecycleRef("Show me the agent run run-ff2087fd-0872-4745-ae8b-f576d41f35aa"),
    ).toBeNull();
    expect(scriptedTurnNamesLifecycleRef("Which reviews are waiting for me?")).toBeNull();
    expect(scriptedTurnNamesLifecycleRef("verification")).toBeNull();
  });

  it("leaves the run-card reading untouched — a named run is still a named run", () => {
    const runPrompt = "Show me the agent run run-ff2087fd-0872-4745-ae8b-f576d41f35aa";
    expect(scriptedTurnNamesAgentRun(runPrompt)).toBe(
      "run-ff2087fd-0872-4745-ae8b-f576d41f35aa",
    );
    expect(scriptedTurnNamesLifecycleRef(runPrompt)).toBeNull();
  });

  it("renders the NAMED ref with verification_record_render, ONCE, and does not list", async () => {
    const { sink, captured, dispatched } = makeSink();
    await runScriptedWidgetAssistantTurn({
      ...sink,
      instructions: `Show me the verification reading for ${REF}`,
    });
    expect(dispatched).toEqual([
      { name: "verification_record_render", args: { ref: REF } },
    ]);
    expect(captured.toolCalls.map((c) => c.name)).toEqual(["verification_record_render"]);
    expect(captured.toolResults[0].id).toBe(captured.toolCalls[0].id);
    expect(captured.toolResults[0].result).toBe(JSON.stringify({ ok: true }));
  });

  it("renders a named ref with the GATE tool when the turn is not a verification question", async () => {
    const { sink, dispatched } = makeSink();
    await runScriptedWidgetAssistantTurn({
      ...sink,
      instructions: `Show me the review gate ${REF}`,
    });
    expect(dispatched).toEqual([{ name: "artifact_review_gate_render", args: { ref: REF } }]);
  });

  it("still LISTS when no ref is named — the discovery path is unchanged", async () => {
    const { sink, dispatched } = makeSink();
    sink.callSelfMcpTool = async (call) => {
      dispatched.push(call as { name: string; args: Record<string, unknown> });
      return call.name === "artifact_review_gates_list"
        ? JSON.stringify({ refs: ["ref-from-the-list"] })
        : JSON.stringify({ ok: true });
    };
    await runScriptedWidgetAssistantTurn({
      ...sink,
      instructions: "Which reviews are waiting for me?",
    });
    expect(dispatched.map((d) => d.name)).toEqual([
      "artifact_review_gates_list",
      "artifact_review_gate_render",
    ]);
    expect(dispatched[1].args).toEqual({ ref: "ref-from-the-list" });
  });

  it("FORWARDS a refusal verbatim and mints nothing of its own", async () => {
    const { sink, captured } = makeSink();
    sink.callSelfMcpTool = async () => "That is not available to you.";
    await runScriptedWidgetAssistantTurn({
      ...sink,
      instructions: `Show me the verification reading for ${REF}`,
    });
    expect(captured.toolResults).toHaveLength(1);
    expect(captured.toolResults[0].result).toBe("That is not available to you.");
  });
});

describe("buildScriptedContentEditorReplyText (widget-relay stand-in)", () => {
  // The widget stream route calls this INSTEAD of the A2A dispatch under the
  // scripted provider; the return value must be shaped exactly like a real
  // content-editor agent's final text so the route's one JSON→SSE frame
  // mapping is exercised unchanged (cinatra#1137).

  it("an edit intent returns the agent's structured changes JSON (→ `changes` frame)", () => {
    const text = buildScriptedContentEditorReplyText({
      instructions: "Please rewrite the title to be punchier.",
      idKey: "postId",
      idValue: "42",
    });
    const parsed = JSON.parse(text);
    expect(parsed.postId).toBe("42");
    expect(Array.isArray(parsed.changes)).toBe(true);
    expect(parsed.changes[0]).toMatchObject({ field: "title" });
  });

  it("a drupal edit intent keys the JSON on nodeId", () => {
    const parsed = JSON.parse(
      buildScriptedContentEditorReplyText({
        instructions: "Add a short summary.",
        idKey: "nodeId",
        idValue: "7",
      }),
    );
    expect(parsed.nodeId).toBe("7");
    expect(parsed.changes).toHaveLength(1);
  });

  it("a conversational prompt returns sentinel-bearing plain text (→ `text` frame), never JSON", () => {
    const text = buildScriptedContentEditorReplyText({
      instructions: "Hello, what can you do here?",
      idKey: "postId",
      idValue: "42",
    });
    expect(text).toContain(UAT_SENTINEL);
    expect(text).toContain("WordPress");
    expect(() => JSON.parse(text)).toThrow();
  });

  it("intent is matched on the instructions only — an empty instruction is conversational", () => {
    const text = buildScriptedContentEditorReplyText({
      instructions: "",
      idKey: "nodeId",
      idValue: "",
    });
    expect(text).toContain(UAT_SENTINEL);
    expect(text).toContain("Drupal");
  });
});

describe("a turn that asks to SCHEDULE an agent (epic #2564 §VI)", () => {
  const TEMPLATE = "cbf1e985-bb4d-444a-9729-417d38a27474";

  function makeChatSink(): {
    sink: Omit<Parameters<typeof runScriptedChatAssistantTurn>[0], "instructions">;
    calls: Array<{ id: string; name: string }>;
    results: Array<{ id: string; name: string; result: string }>;
    dispatched: Array<{ name: string; args: Record<string, unknown> }>;
  } {
    const calls: Array<{ id: string; name: string }> = [];
    const results: Array<{ id: string; name: string; result: string }> = [];
    const dispatched: Array<{ name: string; args: Record<string, unknown> }> = [];
    return {
      calls,
      results,
      dispatched,
      sink: {
        onText: () => {},
        onToolCall: (call) => calls.push(call),
        onToolResult: (r) => results.push(r),
        callSelfMcpTool: async (call) => {
          dispatched.push(call as { name: string; args: Record<string, unknown> });
          return JSON.stringify({ ok: true });
        },
      },
    };
  }

  it("reads the schedule intent, and does not read it into an ordinary question", () => {
    expect(scriptedTurnAsksForScheduleProposal("Schedule that agent to run daily")).toBe(true);
    expect(scriptedTurnAsksForScheduleProposal("Set up a recurring run")).toBe(true);
    expect(scriptedTurnAsksForScheduleProposal("Which reviews are waiting for me?")).toBe(false);
    expect(scriptedTurnAsksForScheduleProposal("Show me the verification reading")).toBe(false);
  });

  it("calls schedule_proposal_render ONCE for the named template, and never lists", async () => {
    const { sink, calls, results, dispatched } = makeChatSink();
    await runScriptedChatAssistantTurn({
      ...sink,
      instructions: `Schedule agent ${TEMPLATE} to run every day at 07:30`,
    });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].name).toBe("schedule_proposal_render");
    expect(dispatched[0].args.templateId).toBe(TEMPLATE);
    expect(dispatched[0].args.schedule).toMatchObject({
      kind: "recurring",
      timezone: "UTC",
      selection: { frequency: "daily", interval: 1, hour: 7, minute: 30 },
    });
    expect(calls.map((c) => c.name)).toEqual(["schedule_proposal_render"]);
    expect(results[0].id).toBe(calls[0].id);
  });

  it("defaults the hour to 09:00 when the sentence names no time", async () => {
    const { sink, dispatched } = makeChatSink();
    await runScriptedChatAssistantTurn({
      ...sink,
      instructions: `Please schedule agent ${TEMPLATE} to run daily`,
    });
    expect(dispatched[0].args.schedule).toMatchObject({
      selection: { hour: 9, minute: 0 },
    });
  });

  it("dispatches NOTHING it could only guess — a schedule turn naming no template falls through", async () => {
    const { sink, dispatched } = makeChatSink();
    await runScriptedChatAssistantTurn({
      ...sink,
      instructions: "Schedule something for me later, please.",
    });
    expect(dispatched.map((d) => d.name)).toEqual(["artifact_review_gates_list"]);
    expect(dispatched.some((d) => d.name === "schedule_proposal_render")).toBe(false);
  });

  it("leaves the lifecycle-pull path untouched — a review question still lists then renders", async () => {
    const { sink, dispatched } = makeChatSink();
    sink.callSelfMcpTool = async (call) => {
      (dispatched as Array<{ name: string; args: Record<string, unknown> }>).push(
        call as { name: string; args: Record<string, unknown> },
      );
      return call.name === "artifact_review_gates_list"
        ? JSON.stringify({ refs: ["R".repeat(64)] })
        : JSON.stringify({ ok: true });
    };
    await runScriptedChatAssistantTurn({
      ...sink,
      instructions: "Which reviews are waiting for me?",
    });
    expect(dispatched.map((d) => d.name)).toEqual([
      "artifact_review_gates_list",
      "artifact_review_gate_render",
    ]);
  });
});
