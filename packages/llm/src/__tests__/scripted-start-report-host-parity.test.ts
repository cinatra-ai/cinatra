// ---------------------------------------------------------------------------
// ONE REPORT, BOTH HOSTS (cinatra#2935, lifecycle-b W5d).
// ---------------------------------------------------------------------------
// The assistant is the only road from a conversation to a run, and on a
// key-free stack this module is the assistant. What it says after a start is
// therefore the turn's line, and this file pins that line on BOTH hosts the
// slice serves: the first-party chat, whose door is `agent_run`, and the site
// widget inside a third-party application, whose door is `agent_named_start`.
//
// THE DEFECT THIS ANSWERS, seen in the real run rather than imagined: inside a
// third-party application the assistant's line WAS the tool result — the
// machine envelope, printed. It happened because the platform's answer for a
// started run carried no sentence, so an assistant told to report the answer
// and add nothing to it had only the envelope to report. The same model on the
// same call relayed a REFUSAL as a sentence, because a refusal answers with
// one. The fix is the platform's, not the model's: the answer carries the
// report, and the assistant says it back.
//
// SO THE ASSERTION IS PARITY, not a wording. Both hosts are driven with the
// SAME platform answer and their lines must be the same bytes — anything else
// would be one host's reading of a report rather than the report.
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";

import {
  SCRIPTED_AGENT_RUN_TOOL,
  SCRIPTED_NAMED_AGENT_START_TOOL,
  runScriptedChatAssistantTurn,
  runScriptedWidgetAssistantTurn,
} from "../scripted-test-provider";
import type { ScriptedSelfMcpDispatch } from "../scripted-test-provider";

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

const START_SENTENCE =
  "Dispatched `@cinatra-ai/blog-draft-writer-agent` " +
  "(runId: `06a703fe-e779-4ba5-852c-73c41c513924`, status: `queued`). The run started.";

/** What `agent_run` answers the chat assistant — the platform's own report. */
const CHAT_ANSWER = JSON.stringify({
  runId: "06a703fe-e779-4ba5-852c-73c41c513924",
  status: "queued",
  message: START_SENTENCE,
});

/** What `agent_named_start` answers the widget assistant: the SAME report,
 *  relayed through the widget's own door. */
const WIDGET_ANSWER = JSON.stringify({
  ok: true,
  runId: "06a703fe-e779-4ba5-852c-73c41c513924",
  status: "queued",
  message: START_SENTENCE,
});

/** The platform's refusal for a start the person may not make. */
const REFUSAL = "You can't start this agent. Nothing was started.";
const WIDGET_REFUSAL_ANSWER = JSON.stringify({ ok: false, message: REFUSAL });
const CHAT_REFUSAL_ANSWER = JSON.stringify({ error: REFUSAL });

const DRIVING_SENTENCE =
  "use @cinatra-ai/blog-draft-writer-agent to draft a short post about retrieval augmented generation";

async function chatLine(answer: string): Promise<Emitted> {
  const s = sink();
  const callSelfMcpTool = vi.fn<ScriptedSelfMcpDispatch>(async () => answer);
  await runScriptedChatAssistantTurn({
    instructions: DRIVING_SENTENCE,
    callSelfMcpTool,
    onText: s.onText,
    onToolCall: s.onToolCall,
    onToolResult: s.onToolResult,
  });
  return s;
}

async function widgetLine(answer: string): Promise<Emitted> {
  const s = sink();
  const callSelfMcpTool = vi.fn<ScriptedSelfMcpDispatch>(async () => answer);
  await runScriptedWidgetAssistantTurn({
    instructions: DRIVING_SENTENCE,
    assistantHandle: "wordpress",
    callSelfMcpTool,
    onText: s.onText,
    onToolCall: s.onToolCall,
    onToolResult: s.onToolResult,
  });
  return s;
}

describe("the line a start answers with, on both hosts", () => {
  it("HOST PARITY: the report each host says back is the same bytes, and the whole of what it says about the start", async () => {
    const chat = await chatLine(CHAT_ANSWER);
    const widget = await widgetLine(WIDGET_ANSWER);

    // Each host opens with the stand-in's OWN marker — the deterministic
    // provider announces itself, on both hosts, whatever the turn goes on to
    // do. That prefix is not the report and is not what this asserts; what
    // follows it is, and it must be the platform's sentence and nothing else.
    const reportOf = (emitted: Emitted): string => {
      const line = emitted.text.join("");
      const at = line.indexOf(START_SENTENCE);
      return at === -1 ? line : line.slice(at);
    };

    expect(reportOf(chat)).toBe(START_SENTENCE);
    expect(reportOf(widget)).toBe(START_SENTENCE);
    expect(reportOf(chat)).toBe(reportOf(widget));
  });

  it("NEVER THE ENVELOPE: no host prints the machine answer it was given", async () => {
    for (const emitted of [await chatLine(CHAT_ANSWER), await widgetLine(WIDGET_ANSWER)]) {
      const line = emitted.text.join("");
      expect(line).not.toContain('"runId":');
      expect(line).not.toContain('"status":');
      expect(line).not.toContain('"ok":');
      expect(line).not.toContain(CHAT_ANSWER);
      expect(line).not.toContain(WIDGET_ANSWER);
    }
  });

  it("each host uses ITS OWN door, and the result still travels to the sink verbatim", async () => {
    const chat = await chatLine(CHAT_ANSWER);
    const widget = await widgetLine(WIDGET_ANSWER);

    expect(chat.calls.map((c) => c.name)).toEqual([SCRIPTED_AGENT_RUN_TOOL]);
    expect(widget.calls.map((c) => c.name)).toEqual([SCRIPTED_NAMED_AGENT_START_TOOL]);
    // The card is drawn from the tool result, so it may not be rewritten.
    expect(chat.results.map((r) => r.result)).toEqual([CHAT_ANSWER]);
    expect(widget.results.map((r) => r.result)).toEqual([WIDGET_ANSWER]);
    // One start, at most, per turn — on either host.
    expect(chat.calls).toHaveLength(1);
    expect(widget.calls).toHaveLength(1);
  });

  it("THE REFUSAL IS RELAYED, word for word, on both hosts and with no diagnostic in it", async () => {
    const chat = await chatLine(CHAT_REFUSAL_ANSWER);
    const widget = await widgetLine(WIDGET_REFUSAL_ANSWER);

    for (const emitted of [chat, widget]) {
      const line = emitted.text.join("");
      expect(line).toContain(REFUSAL);
      // The diagnostic the person used to be shown, named so it cannot return.
      expect(line).not.toContain("agent-template-scope");
      expect(line).not.toContain("not_project_member");
      expect(line).not.toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
      );
      // A refusal settles nothing: no run is claimed.
      expect(line).not.toContain("runId:");
    }
  });
});
