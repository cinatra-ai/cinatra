// ---------------------------------------------------------------------------
// S2 CUTOVER PARITY GATE (cinatra#1218, epic #1216) — the replace-half proof.
// ---------------------------------------------------------------------------
// The issue's own rule: the bespoke chat-stream path may be deleted ONLY after
// this gate proves the AG-UI pipeline renders equivalently. It folds the SAME
// bespoke producer event sequence through BOTH pipelines:
//
//   LEGACY  — the exact `/chat` event loop: chat-stream-events appliers over
//             the UiMessage list, replicating chat-page.tsx's SSE loop
//             semantics byte-for-byte (separator flag consumed in loop scope,
//             empty-bubble seed, extractAgentRunId on tool results).
//   AG-UI   — the S2 pipeline: bespoke sink → ag-ui-sink-adapter → AG-UI
//             events → S3 reducer (agUiReduce) → projectConversationMessage.
//
// EQUIVALENCE is asserted at EVERY EVENT PREFIX (not only the final message):
// after each producer event, the two projected UiMessages must be deep-equal
// on every render field EXCEPT the ENUMERATED RATIFIED GAPS — each of which is
// pinned by its own explicit assertion rather than silently normalized away:
//
//   G1  tool-chip labels — TOOL_CALL_END carries only the toolCallId, so the
//       AG-UI chip label derives from the tool NAME (formatToolCallLabel);
//       the legacy chip shows the server's rich resultLabel. (Ratified by the
//       S3 reducer contract, "the bespoke → AG-UI mapping gaps".)
//   G2  serverLabel connector badges — not on the AG-UI wire; chip labels
//       lose the "<Connector> · <Action>" form. (Same ratified gap as G1.)
//   G3  thinkingSeconds — AG-UI has no thinking frames; "Thought for Ns"
//       never renders. (Ratified.)
//   G4  liveStatus between tool rounds — legacy flips back to "Thinking" on
//       the next thinking_start; AG-UI keeps "Reviewing tool results" until
//       text arrives (no thinking frames on the wire). Transient,
//       streaming-only. (Follows from the ratified thinking-frame gap;
//       surfaced for owner ratification on the PR.)
//   G5  round-separator arming — legacy arms the post-tool paragraph break on
//       thinking_end, AG-UI on TOOL_CALL_END; visible only for text emitted
//       BETWEEN tool_result and thinking_end (the reducer contract names this
//       re-keying). Additionally an EMPTY legacy text delta consumed the
//       armed separator (a preserved quirk); the adapter drops empty deltas,
//       so the AG-UI wire keeps the break.
//
// Everything else — content bytes, ordered parts trace, tool ids/names/
// statuses, the agent_run runId pin, citation normalization/dedupe/merge,
// error + errorRaw derivation — must be IDENTICAL, at every prefix.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import type { AgUiEvent } from "@cinatra-ai/agent-ui-protocol";
import { createAgUiSinkAdapter } from "../ag-ui-sink-adapter";
import {
  applyTextDeltaToMessages,
  applyThinkingStartToMessages,
  applyThinkingEndToMessages,
  applyToolCallToMessages,
  applyToolResultToMessages,
  applyCitationsToMessages,
  applyErrorToMessages,
  extractAgentRunId,
  normalizeCitations,
} from "../../../../packages/chat/src/chat-stream-events";
import { formatToolCallLabel } from "../../../../packages/chat/src/assistant-parts";
import {
  reduceAgUiEvents,
  type ConversationViewState,
} from "../../../../packages/chat/src/renderer/ag-ui-reducer";
import { projectConversationMessage } from "../../../../packages/chat/src/ag-ui-chat-client";
import type { UiMessage } from "../../../../packages/chat/src/types";

const ASSISTANT_ID = "assistant-msg-1";

type BespokeEvent = { evt: string; data: Record<string, unknown> };

// ---------------------------------------------------------------------------
// LEGACY pipeline — replicates chat-page.tsx's SSE loop over the appliers.
// ---------------------------------------------------------------------------

function foldLegacy(events: readonly BespokeEvent[]): UiMessage {
  let messages: UiMessage[] = [
    { id: ASSISTANT_ID, role: "assistant", content: "", thoughtGroups: [], parts: [], liveStatus: "Thinking" },
  ];
  let nextTextNeedsRoundSeparator = false;
  for (const { evt, data: d } of events) {
    if (evt === "text") {
      const delta = String(d.content ?? "");
      const consumeRoundSeparator = nextTextNeedsRoundSeparator;
      if (consumeRoundSeparator) nextTextNeedsRoundSeparator = false;
      if (delta) {
        messages = applyTextDeltaToMessages(messages, ASSISTANT_ID, delta, consumeRoundSeparator);
      }
    } else if (evt === "thinking_start") {
      messages = applyThinkingStartToMessages(messages, ASSISTANT_ID);
    } else if (evt === "thinking_end") {
      messages = applyThinkingEndToMessages(messages, ASSISTANT_ID, Number(d.seconds) || 0);
      nextTextNeedsRoundSeparator = true;
    } else if (evt === "tool_call") {
      messages = applyToolCallToMessages(messages, ASSISTANT_ID, {
        id: String(d.id),
        name: String(d.name),
        serverLabel: typeof d.serverLabel === "string" ? d.serverLabel : undefined,
      });
    } else if (evt === "tool_result") {
      messages = applyToolResultToMessages(messages, ASSISTANT_ID, {
        id: String(d.id),
        resultLabel: String(d.resultLabel ?? ""),
        serverLabel: typeof d.serverLabel === "string" ? d.serverLabel : undefined,
        runId: extractAgentRunId(String(d.name ?? ""), d.result),
      });
    } else if (evt === "citations") {
      const normalized = normalizeCitations(d.citations);
      if (normalized.length > 0) {
        messages = applyCitationsToMessages(messages, ASSISTANT_ID, normalized);
      }
    } else if (evt === "error") {
      messages = applyErrorToMessages(messages, ASSISTANT_ID, String(d.message ?? ""));
    }
  }
  return messages[0];
}

// ---------------------------------------------------------------------------
// AG-UI pipeline — sink adapter → events → reducer → projection.
// ---------------------------------------------------------------------------

async function mapToAgUi(events: readonly BespokeEvent[]): Promise<AgUiEvent[]> {
  const published: AgUiEvent[] = [];
  const adapter = createAgUiSinkAdapter({
    runId: "run-parity",
    threadId: "thread-parity",
    publish: async (event) => {
      published.push(event);
    },
  });
  adapter.start();
  for (const { evt, data } of events) adapter.send(evt, data);
  await adapter.drain();
  return published;
}

async function foldAgUi(events: readonly BespokeEvent[]): Promise<{
  message: UiMessage;
  state: ConversationViewState;
}> {
  const agUiEvents = await mapToAgUi(events);
  const state = reduceAgUiEvents(agUiEvents);
  return { message: projectConversationMessage(state, { assistantId: ASSISTANT_ID }), state };
}

// ---------------------------------------------------------------------------
// Normalization — strips ONLY the enumerated gap fields (G1–G4); everything
// else participates in the deep-equal.
// ---------------------------------------------------------------------------

function normalize(message: UiMessage): Record<string, unknown> {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    parts: (message.parts ?? []).map((p) =>
      p.kind === "tool_call"
        ? { kind: p.kind, id: p.id, name: p.name, status: p.status, ...(p.runId ? { runId: p.runId } : {}) } // G1/G2: resultLabel/serverLabel stripped
        : { kind: p.kind, content: p.content },
    ),
    thoughtGroups: (message.thoughtGroups ?? [])
      // Tool-less groups are dropped: legacy creates one on thinking_start
      // (no AG-UI equivalent — G3), and its ONLY visible content is
      // thinkingSeconds, which G3 strips (ThoughtGroupSection renders null
      // for a tool-less group with seconds <= 1).
      .filter((g) => g.toolCalls.length > 0)
      .map((g) => ({
        id: g.id,
        // G3: thinkingSeconds stripped
        toolCalls: g.toolCalls.map((tc) => ({ id: tc.id, name: tc.name, status: tc.status })), // G1/G2 stripped
      })),
    citations: message.citations ?? [],
    error: message.error,
    errorRaw: message.errorRaw,
    // G4: liveStatus stripped (pinned separately)
  };
}

async function expectPrefixParity(events: readonly BespokeEvent[]): Promise<void> {
  for (let i = 1; i <= events.length; i++) {
    const prefix = events.slice(0, i);
    const legacy = foldLegacy(prefix);
    const { message: agUi } = await foldAgUi(prefix);
    expect(normalize(agUi), `prefix of ${i} event(s), last: ${prefix[i - 1].evt}`).toEqual(
      normalize(legacy),
    );
  }
}

// ---------------------------------------------------------------------------
// The corpus — realistic producer orderings (the runtime emits per round:
// thinking_start · tool events · thinking_end · text).
// ---------------------------------------------------------------------------

const PLAIN_TEXT: BespokeEvent[] = [
  { evt: "text", data: { content: "Provider tokens split **bo" } },
  { evt: "text", data: { content: "ld** arbitrarily" } },
  { evt: "text", data: { content: " — no stray separators." } },
  { evt: "done", data: {} },
];

const TOOL_ROUND: BespokeEvent[] = [
  { evt: "thinking_start", data: { round: 1 } },
  { evt: "tool_call", data: { id: "t1", name: "objects_list" } },
  { evt: "tool_result", data: { id: "t1", name: "objects_list", resultLabel: "3 objects found", result: "[1,2,3]" } },
  { evt: "thinking_end", data: { round: 1, seconds: 2 } },
  { evt: "text", data: { content: "Found three objects." } },
  { evt: "done", data: {} },
];

const TEXT_THEN_TOOL_THEN_TEXT: BespokeEvent[] = [
  { evt: "text", data: { content: "Let me check." } },
  { evt: "thinking_start", data: { round: 1 } },
  { evt: "tool_call", data: { id: "t1", name: "campaigns_create" } },
  { evt: "tool_result", data: { id: "t1", name: "campaigns_create", resultLabel: "Campaign created", result: "{}" } },
  { evt: "thinking_end", data: { round: 1, seconds: 1 } },
  { evt: "text", data: { content: "Done — the paragraph break precedes this." } },
  { evt: "done", data: {} },
];

const AGENT_RUN: BespokeEvent[] = [
  { evt: "tool_call", data: { id: "t1", name: "agent_run" } },
  { evt: "tool_result", data: { id: "t1", name: "agent_run", resultLabel: "Run started", result: JSON.stringify({ runId: "child-run-42", status: "queued" }) } },
  { evt: "text", data: { content: "The run is underway." } },
  { evt: "done", data: {} },
];

const CITATIONS: BespokeEvent[] = [
  { evt: "text", data: { content: "Sourced answer." } },
  { evt: "citations", data: { citations: [
    { index: 1, title: "First", url: "https://a.example/1" },
    { title: "", url: "https://b.example/2" },
  ] } },
  // Duplicate url merges away; new url appends — both pipelines share
  // normalizeCitations + mergeCitations.
  { evt: "citations", data: { citations: [
    { title: "First again", url: "https://a.example/1" },
    { title: "Third", url: "https://c.example/3" },
  ] } },
  { evt: "done", data: {} },
];

const ERROR_MIDSTREAM: BespokeEvent[] = [
  { evt: "text", data: { content: "Partial answer" } },
  { evt: "error", data: { message: JSON.stringify({ error: { message: "Provider rate limited" } }) } },
];

const MULTI_TOOL: BespokeEvent[] = [
  { evt: "thinking_start", data: { round: 1 } },
  { evt: "tool_call", data: { id: "t1", name: "web_search" } },
  { evt: "tool_call", data: { id: "t2", name: "objects_list" } },
  { evt: "tool_result", data: { id: "t2", name: "objects_list", resultLabel: "1 object found", result: "[1]" } },
  { evt: "tool_result", data: { id: "t1", name: "web_search", resultLabel: "2 sources found" } },
  { evt: "thinking_end", data: { round: 1, seconds: 4 } },
  { evt: "text", data: { content: "Cross-referenced." } },
  { evt: "done", data: {} },
];

const CONNECTOR_LABELED: BespokeEvent[] = [
  { evt: "tool_call", data: { id: "t1", name: "wordpress_post_create_draft", serverLabel: "external-wordpress-connector" } },
  { evt: "tool_result", data: { id: "t1", name: "wordpress_post_create_draft", resultLabel: "Wordpress · Post Create Draft", serverLabel: "external-wordpress-connector", result: "{}" } },
  { evt: "done", data: {} },
];

describe("S2 parity gate — prefix equivalence (bespoke appliers vs AG-UI pipeline)", () => {
  it("plain streaming text", async () => expectPrefixParity(PLAIN_TEXT));
  it("single tool round with post-round paragraph break", async () => expectPrefixParity(TOOL_ROUND));
  it("text → tool round → text", async () => expectPrefixParity(TEXT_THEN_TOOL_THEN_TEXT));
  it("agent_run pins the SAME runId on the tool part in both pipelines", async () => {
    await expectPrefixParity(AGENT_RUN);
    const legacy = foldLegacy(AGENT_RUN);
    const { message: agUi } = await foldAgUi(AGENT_RUN);
    const runPart = (m: UiMessage) => (m.parts ?? []).find((p) => p.kind === "tool_call" && p.name === "agent_run");
    expect((runPart(agUi) as { runId?: string })?.runId).toBe("child-run-42");
    expect((runPart(legacy) as { runId?: string })?.runId).toBe("child-run-42");
  });
  it("citations normalize, dedupe and merge identically", async () => expectPrefixParity(CITATIONS));
  it("mid-stream error derives the same friendly error + errorRaw", async () => {
    await expectPrefixParity(ERROR_MIDSTREAM);
    const legacy = foldLegacy(ERROR_MIDSTREAM);
    const { message: agUi } = await foldAgUi(ERROR_MIDSTREAM);
    expect(agUi.error).toBe("Provider rate limited");
    expect(agUi.error).toBe(legacy.error);
    expect(agUi.errorRaw).toBe(legacy.errorRaw);
  });
  it("interleaved multi-tool round (out-of-order results)", async () => expectPrefixParity(MULTI_TOOL));
  it("connector-labelled round matches modulo the label gaps", async () =>
    expectPrefixParity(CONNECTOR_LABELED));
});

describe("S2 parity gate — the enumerated ratified gaps, pinned explicitly", () => {
  it("G1: AG-UI chip label derives from the tool NAME; legacy shows the server resultLabel", async () => {
    const legacy = foldLegacy(TOOL_ROUND);
    const { message: agUi } = await foldAgUi(TOOL_ROUND);
    const agUiChip = agUi.thoughtGroups?.[0]?.toolCalls[0];
    const legacyChip = legacy.thoughtGroups?.[0]?.toolCalls[0];
    expect(agUiChip?.resultLabel).toBe(formatToolCallLabel({ name: "objects_list" }));
    expect(legacyChip?.resultLabel).toBe("3 objects found");
  });

  it("G2: serverLabel connector badges are not on the AG-UI wire", async () => {
    const legacy = foldLegacy(CONNECTOR_LABELED);
    const { message: agUi } = await foldAgUi(CONNECTOR_LABELED);
    expect(legacy.thoughtGroups?.[0]?.toolCalls[0]?.serverLabel).toBe("external-wordpress-connector");
    expect(agUi.thoughtGroups?.[0]?.toolCalls[0]?.serverLabel).toBeUndefined();
  });

  it("G3: thinkingSeconds never populates on the AG-UI side", async () => {
    const legacy = foldLegacy(TOOL_ROUND);
    const { message: agUi } = await foldAgUi(TOOL_ROUND);
    expect(legacy.thoughtGroups?.[0]?.thinkingSeconds).toBe(2);
    expect(agUi.thoughtGroups?.[0]?.thinkingSeconds).toBeUndefined();
  });

  it("G4: between rounds AG-UI keeps 'Reviewing tool results' where legacy flips to 'Thinking'", async () => {
    const prefix = [...TOOL_ROUND.slice(0, 4), { evt: "thinking_start", data: { round: 2 } }];
    const legacy = foldLegacy(prefix);
    const { message: agUi } = await foldAgUi(prefix);
    expect(legacy.liveStatus).toBe("Thinking");
    expect(agUi.liveStatus).toBe("Reviewing tool results");
  });

  it("G5: text between tool_result and thinking_end gets the paragraph break on AG-UI only", async () => {
    const events: BespokeEvent[] = [
      { evt: "text", data: { content: "before" } },
      { evt: "tool_call", data: { id: "t1", name: "objects_list" } },
      { evt: "tool_result", data: { id: "t1", name: "objects_list", resultLabel: "x" } },
      { evt: "text", data: { content: "after" } }, // pre-thinking_end text
      { evt: "done", data: {} },
    ];
    const legacy = foldLegacy(events);
    const { message: agUi } = await foldAgUi(events);
    expect(legacy.content).toBe("beforeafter"); // separator not armed yet (thinking_end keying)
    expect(agUi.content).toBe("before\n\nafter"); // TOOL_CALL_END keying (reducer contract)
  });

  it("liveStatus parity holds at the NON-gap checkpoints", async () => {
    // While a tool runs → both show the tool-progress status.
    const runningPrefix = TOOL_ROUND.slice(0, 2);
    const legacyRunning = foldLegacy(runningPrefix);
    const { message: agUiRunning } = await foldAgUi(runningPrefix);
    expect(agUiRunning.liveStatus).toBe(legacyRunning.liveStatus);
    // After a tool result → both "Reviewing tool results".
    const reviewedPrefix = TOOL_ROUND.slice(0, 3);
    expect((await foldAgUi(reviewedPrefix)).message.liveStatus).toBe(
      foldLegacy(reviewedPrefix).liveStatus,
    );
    // Once visible text streams → both clear the status line.
    const textPrefix = TOOL_ROUND.slice(0, 5);
    const legacyText = foldLegacy(textPrefix);
    const { message: agUiText } = await foldAgUi(textPrefix);
    expect(legacyText.liveStatus).toBeUndefined();
    expect(agUiText.liveStatus).toBeUndefined();
  });
});

describe("S2 parity gate — Slack-mode projection", () => {
  it("omits `parts` and keeps thoughtGroups + flat content (the pinned Slack layout)", async () => {
    const { state } = await foldAgUi(TOOL_ROUND);
    const slack = projectConversationMessage(state, { assistantId: ASSISTANT_ID, slackMode: true });
    expect("parts" in slack).toBe(false);
    expect(slack.content).toBe("Found three objects.");
    expect(slack.thoughtGroups?.[0]?.toolCalls[0]?.id).toBe("t1");
    expect("liveStatus" in slack).toBe(false);
  });

  it("omits empty collections the legacy Slack reveal never set", async () => {
    const { state } = await foldAgUi(PLAIN_TEXT);
    const slack = projectConversationMessage(state, { assistantId: ASSISTANT_ID, slackMode: true });
    expect("thoughtGroups" in slack).toBe(false);
    expect("citations" in slack).toBe(false);
    expect("error" in slack).toBe(false);
  });
});
