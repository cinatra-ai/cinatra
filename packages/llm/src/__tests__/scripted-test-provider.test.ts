import { describe, expect, it } from "vitest";

import type { OrchestrateStreamInput } from "../types";
import {
  UAT_SENTINEL,
  assertScriptedProviderNotProduction,
  buildScriptedContentEditorReplyText,
  isScriptedTestProviderEnabled,
  runScriptedStream,
  runScriptedWidgetAssistantTurn,
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
