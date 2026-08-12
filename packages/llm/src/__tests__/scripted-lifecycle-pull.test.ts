// ---------------------------------------------------------------------------
// The scripted widget turn's LIFECYCLE PULL (cinatra#2683, epic #2564 S8f).
//
// The subject is narrow and it is the whole point of the extension: the provider
// DECIDES WHICH PRIMITIVE TO CALL and forwards what the real one answered,
// VERBATIM. It never composes a lifecycle envelope, and it cannot — every result
// it emits came out of the injected dispatcher.
//
// What is deliberately NOT asserted here: that an envelope becomes a card. That
// is the sink's recognizer and the runtime's provenance stamp, both of which live
// outside this module and have their own tests. Asserting it here would let this
// test pass on a provider that invented the envelope — the exact failure this
// extension exists to make impossible.
// ---------------------------------------------------------------------------
import { describe, expect, it, vi } from "vitest";

import {
  SCRIPTED_LIFECYCLE_GATE_RENDER_TOOL,
  SCRIPTED_LIFECYCLE_LIST_TOOL,
  SCRIPTED_LIFECYCLE_VERIFICATION_RENDER_TOOL,
  UAT_SENTINEL,
  runScriptedChatAssistantTurn,
  runScriptedWidgetAssistantTurn,
  SCRIPTED_AGENT_RUN_TOOL,
  scriptedTurnAsksForLifecyclePull,
  scriptedTurnNamesAgentRun,
} from "../scripted-test-provider";

type Emitted = {
  text: string[];
  calls: Array<{ id: string; name: string }>;
  results: Array<{ id: string; name: string; result: string }>;
};

function sink(): Emitted & {
  onText: (c: string) => void;
  onToolCall: (c: { id: string; name: string }) => void;
  onToolResult: (r: { id: string; name: string; result: string }) => void;
} {
  const e: Emitted = { text: [], calls: [], results: [] };
  return {
    ...e,
    onText: (c) => e.text.push(c),
    onToolCall: (c) => e.calls.push(c),
    onToolResult: (r) => e.results.push(r),
  };
}

const REAL_LIST_ANSWER = JSON.stringify({ refs: ["REF-ONE", "REF-TWO"] });
const REAL_ENVELOPE = JSON.stringify({
  $cinatraLifecycleView: 1,
  viewType: "artifact_review_gate",
  ref: "REF-ONE",
});

describe("scripted widget turn — the lifecycle pull", () => {
  it("LISTS then RENDERS through the injected dispatcher, forwarding both results verbatim", async () => {
    const s = sink();
    const callSelfMcpTool = vi.fn(async (call: { name: string }) =>
      call.name === SCRIPTED_LIFECYCLE_LIST_TOOL ? REAL_LIST_ANSWER : REAL_ENVELOPE,
    );

    await runScriptedWidgetAssistantTurn({
      instructions: "Which reviews are waiting for me right now?",
      assistantHandle: "wordpress",
      callSelfMcpTool,
      onText: s.onText,
      onToolCall: s.onToolCall,
      onToolResult: s.onToolResult,
    });

    // The ORDER and the ARGUMENTS are the model-layer decision this stands in for.
    expect(callSelfMcpTool.mock.calls.map(([c]) => c.name)).toEqual([
      SCRIPTED_LIFECYCLE_LIST_TOOL,
      SCRIPTED_LIFECYCLE_GATE_RENDER_TOOL,
    ]);
    // The render is addressed by a ref the LIST returned — never a ref this
    // module chose, which is what "refs, never content" means on the read side.
    expect(callSelfMcpTool.mock.calls[1][0].args).toEqual({ ref: "REF-ONE" });

    // VERBATIM. Byte-for-byte, both of them: the envelope the producer minted is
    // what reaches the sink, because anything else would not be the producer's.
    expect(s.results.map((r) => r.result)).toEqual([REAL_LIST_ANSWER, REAL_ENVELOPE]);
    expect(s.results.map((r) => r.name)).toEqual([
      SCRIPTED_LIFECYCLE_LIST_TOOL,
      SCRIPTED_LIFECYCLE_GATE_RENDER_TOOL,
    ]);
    // Each result is bound to the tool_call it answers.
    expect(s.results.map((r) => r.id)).toEqual(s.calls.map((c) => c.id));
  });

  it("selects the VERIFICATION primitive when that is what was asked for", async () => {
    const s = sink();
    const callSelfMcpTool = vi.fn(async (call: { name: string }) =>
      call.name === SCRIPTED_LIFECYCLE_LIST_TOOL ? REAL_LIST_ANSWER : "Not available to you.",
    );

    await runScriptedWidgetAssistantTurn({
      instructions: "Show me the verification reading for that review.",
      assistantHandle: "wordpress",
      callSelfMcpTool,
      onText: s.onText,
      onToolCall: s.onToolCall,
      onToolResult: s.onToolResult,
    });

    expect(callSelfMcpTool.mock.calls[1][0].name).toBe(
      SCRIPTED_LIFECYCLE_VERIFICATION_RENDER_TOOL,
    );
    // A REFUSAL travels unchanged too. The provider does not soften it, retry it,
    // or substitute a card for it — "not available to you" is the answer.
    expect(s.results[1].result).toBe("Not available to you.");
  });

  it("renders NOTHING beyond the list when the caller may read no gate", async () => {
    const s = sink();
    const callSelfMcpTool = vi.fn(async () => JSON.stringify({ refs: [] }));

    await runScriptedWidgetAssistantTurn({
      instructions: "Which reviews are waiting for me?",
      assistantHandle: "wordpress",
      callSelfMcpTool,
      onText: s.onText,
      onToolCall: s.onToolCall,
      onToolResult: s.onToolResult,
    });

    expect(callSelfMcpTool).toHaveBeenCalledTimes(1);
    expect(s.results).toHaveLength(1);
  });

  it("never emits a lifecycle result when NO dispatcher was injected", async () => {
    const s = sink();
    await runScriptedWidgetAssistantTurn({
      instructions: "Which reviews are waiting for me right now?",
      assistantHandle: "wordpress",
      onText: s.onText,
      onToolCall: s.onToolCall,
      onToolResult: s.onToolResult,
    });
    // The pull is unreachable without the runtime's real dispatcher, so the turn
    // is the plain sentinel reply it has always been.
    expect(s.calls).toHaveLength(0);
    expect(s.results).toHaveLength(0);
    expect(s.text.join("")).toContain(UAT_SENTINEL);
  });

  it("degrades to the plain reply — never a card — when the dispatch FAILS", async () => {
    const s = sink();
    const callSelfMcpTool = vi.fn(async () => {
      throw new Error("self-MCP dispatch: tools/call answered HTTP 401");
    });

    await runScriptedWidgetAssistantTurn({
      instructions: "Which reviews are waiting for me right now?",
      assistantHandle: "wordpress",
      callSelfMcpTool,
      onText: s.onText,
      onToolCall: s.onToolCall,
      onToolResult: s.onToolResult,
    });

    // The tool_call was announced and then answered by nothing. A tool call that
    // did not happen produces no result — the honest outcome, and structurally
    // the only one available: this module has no envelope to fall back on.
    expect(s.results).toHaveLength(0);
    expect(s.text.join("")).toContain(UAT_SENTINEL);
  });

  it("keeps the CONTENT-EDITOR stand-in unchanged for an edit instruction", async () => {
    const s = sink();
    const callSelfMcpTool = vi.fn(async () => JSON.stringify({ refs: [] }));

    await runScriptedWidgetAssistantTurn({
      instructions: "Shorten the headline on this page",
      assistantHandle: "wordpress",
      callSelfMcpTool,
      onText: s.onText,
      onToolCall: s.onToolCall,
      onToolResult: s.onToolResult,
    });

    // No lifecycle word in the instruction ⇒ the pull never fires and the twelve
    // existing WP/Drupal scenarios are byte-unaffected by this extension.
    expect(callSelfMcpTool).not.toHaveBeenCalled();
    expect(s.calls.map((c) => c.name)).toEqual(["wordpress_content_editor_run"]);
  });
});

// ---------------------------------------------------------------------------
// The COOKIE-SESSION `/chat` turn — the same pull, the other surface.
// ---------------------------------------------------------------------------
describe("scripted chat turn — the same lifecycle pull on /chat", () => {
  it("LISTS then RENDERS through the injected dispatcher, forwarding both results verbatim", async () => {
    const s = sink();
    const callSelfMcpTool = vi.fn(async (call: { name: string }) =>
      call.name === SCRIPTED_LIFECYCLE_LIST_TOOL ? REAL_LIST_ANSWER : REAL_ENVELOPE,
    );

    await runScriptedChatAssistantTurn({
      instructions: "Which reviews are waiting for me right now?",
      callSelfMcpTool,
      onText: s.onText,
      onToolCall: s.onToolCall,
      onToolResult: s.onToolResult,
    });

    expect(callSelfMcpTool.mock.calls.map(([c]) => c.name)).toEqual([
      SCRIPTED_LIFECYCLE_LIST_TOOL,
      SCRIPTED_LIFECYCLE_GATE_RENDER_TOOL,
    ]);
    // The SAME primitives, in the same order, addressed by a ref the list
    // returned — so the two surfaces' proofs compare like for like.
    expect(s.results.map((r) => r.result)).toEqual([REAL_LIST_ANSWER, REAL_ENVELOPE]);
    expect(s.results.map((r) => r.id)).toEqual(s.calls.map((c) => c.id));
    // The turn still reads as a turn: one sentinel-bearing line above the card.
    expect(s.text.join("")).toContain(UAT_SENTINEL);
  });

  it("NO CMS STAND-IN on /chat: an edit-shaped lifecycle question emits no content-editor tool", async () => {
    const s = sink();
    const callSelfMcpTool = vi.fn(async () => JSON.stringify({ refs: [] }));

    await runScriptedChatAssistantTurn({
      // "update" is an edit word AND "review" a lifecycle one — on the widget this
      // is the pull's precedence rule; on /chat the CMS branch does not exist at
      // all, which is the point: this turn can only ever call the real primitives.
      instructions: "Update me on the review that is waiting.",
      callSelfMcpTool,
      onText: s.onText,
      onToolCall: s.onToolCall,
      onToolResult: s.onToolResult,
    });

    expect(s.calls.map((c) => c.name)).toEqual([SCRIPTED_LIFECYCLE_LIST_TOOL]);
    expect(s.calls.some((c) => c.name.endsWith("_content_editor_run"))).toBe(false);
  });

  it("degrades to the plain reply — never a card — when the dispatch FAILS", async () => {
    const s = sink();
    const callSelfMcpTool = vi.fn(async () => {
      throw new Error("self-MCP dispatch: tools/call answered HTTP 401");
    });

    await runScriptedChatAssistantTurn({
      instructions: "Which reviews are waiting for me right now?",
      callSelfMcpTool,
      onText: s.onText,
      onToolCall: s.onToolCall,
      onToolResult: s.onToolResult,
    });

    expect(s.results).toHaveLength(0);
    expect(s.text.join("")).toContain(UAT_SENTINEL);
  });

  it("the INTENT PREDICATE the runtime asks is the provider's own reading", () => {
    // The runtime gates its /chat short-circuit on this answer, so the predicate
    // and the turn must agree: what it accepts is exactly what drives a pull.
    expect(scriptedTurnAsksForLifecyclePull("Which reviews are waiting for me?")).toBe(true);
    expect(scriptedTurnAsksForLifecyclePull("Show me the verification reading.")).toBe(true);
    expect(scriptedTurnAsksForLifecyclePull("Please rewrite the title.")).toBe(false);
    expect(scriptedTurnAsksForLifecyclePull("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The AGENT-RUN scenario (cinatra#2683) — the undo chip's mount site.
// ---------------------------------------------------------------------------
// The chip renders under an `agent_run` tool part and nowhere else, so on a
// key-free stack it had no mount site at all. What is asserted here is only what
// this module decides: the part is emitted, it carries THE RUN THE PERSON NAMED,
// and no other scenario is disturbed. Whether a chip then appears is the chip's
// own real read against the §VI eligibility gate — deliberately not stood in for.
// ---------------------------------------------------------------------------
describe("scripted widget turn — the agent-run reference", () => {
  const RUN_ID = "run-671960a9-35e0-4fc1-80e2-2333fc23e28c";

  it("emits ONE agent_run part carrying the run the person named", async () => {
    const s = sink();
    await runScriptedWidgetAssistantTurn({
      instructions: `Show me the agent run ${RUN_ID}`,
      assistantHandle: "wordpress",
      onText: s.onText,
      onToolCall: s.onToolCall,
      onToolResult: s.onToolResult,
    });

    expect(s.calls.map((c) => c.name)).toEqual([SCRIPTED_AGENT_RUN_TOOL]);
    expect(s.results).toHaveLength(1);
    // The sink pins the inline card's run id off THIS shape and nothing else.
    expect(JSON.parse(s.results[0].result)).toEqual({ runId: RUN_ID });
    // The tool_result belongs to the tool_call — the reducer joins them by id.
    expect(s.results[0].id).toBe(s.calls[0].id);
    expect(s.text.join("")).toContain(UAT_SENTINEL);
  });

  it("INVENTS NO RUN: an instruction that names none emits no agent_run part", async () => {
    const s = sink();
    await runScriptedWidgetAssistantTurn({
      instructions: "Undo the last thing you did",
      assistantHandle: "wordpress",
      onText: s.onText,
      onToolCall: s.onToolCall,
      onToolResult: s.onToolResult,
    });
    expect(s.calls.map((c) => c.name)).not.toContain(SCRIPTED_AGENT_RUN_TOOL);
  });

  it("the CMS stand-in still wins for an ordinary edit, and the pull still wins over both", async () => {
    // The twelve UAT scenarios say "rewrite the title" and name no run: unchanged.
    const edit = sink();
    await runScriptedWidgetAssistantTurn({
      instructions: "Please rewrite the title",
      assistantHandle: "wordpress",
      onText: edit.onText,
      onToolCall: edit.onToolCall,
      onToolResult: edit.onToolResult,
    });
    expect(edit.calls.map((c) => c.name)).toEqual(["wordpress_content_editor_run"]);

    // A turn that is BOTH a lifecycle question and names a run is a lifecycle
    // question — the narrower reading, and the one with a dispatcher behind it.
    const both = sink();
    const callSelfMcpTool = vi.fn(async () => JSON.stringify({ refs: [] }));
    await runScriptedWidgetAssistantTurn({
      instructions: `Which reviews are waiting from ${RUN_ID}?`,
      assistantHandle: "wordpress",
      callSelfMcpTool,
      onText: both.onText,
      onToolCall: both.onToolCall,
      onToolResult: both.onToolResult,
    });
    expect(both.calls.map((c) => c.name)).toEqual([SCRIPTED_LIFECYCLE_LIST_TOOL]);
  });

  it("the run-id reading is the SHAPE the platform mints, not any token", () => {
    expect(scriptedTurnNamesAgentRun(`about ${RUN_ID} please`)).toBe(RUN_ID);
    // The bare-uuid form too — this must not depend on the `run-` prefix.
    const bare = RUN_ID.slice("run-".length);
    expect(scriptedTurnNamesAgentRun(`show ${bare}`)).toBe(bare);
    expect(scriptedTurnNamesAgentRun("run-short")).toBeNull();
    expect(scriptedTurnNamesAgentRun("run-not-a-uuid-at-all-really")).toBeNull();
    expect(scriptedTurnNamesAgentRun("no run here")).toBeNull();
    expect(scriptedTurnNamesAgentRun("")).toBeNull();
  });
});
