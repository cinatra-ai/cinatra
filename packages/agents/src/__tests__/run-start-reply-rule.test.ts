// ONE REPLY RULE FOR A START (cinatra#2935, lifecycle-b W5d).
// ---------------------------------------------------------------------------
// From the plan (PLAN: Agents Lifecycle (B), "The card is the visible truth"):
//
//   "After the action fires, the card re-reads its state from the server and
//    settles in place. The assistant's line reports what came back and adds
//    nothing. Where the sentence and the card could disagree, the card is
//    right."
//
// THE CARD IS WHAT SHOWS A RUN'S PROGRESS, so the model is not told to chase it.
// Until this change `agent_run`'s description carried TWO rules in one text: say
// the platform's sentence back exactly, AND "MUST be followed by `agent_run_get`
// polling until a terminal status". In the turn the final W5d captures caught, the
// second one is what the model did — the chat host answers in prose of its own
// ("The blog draft run is paused for human input before it starts. Run ID: …")
// while the widget, whose door carries the reply rule ALONE, relayed the
// platform's sentence word for word. One text, two rules, two hosts, two
// answers.
//
// So the reply rule is now the ONLY reply rule, it is ONE string, and both doors
// carry the same bytes of it. `agent_run_get` stays a tool the person can ask
// for; nothing tells the model to call it after a start.
//
// EVERY CASE HERE IS RED BEFORE THAT CHANGE: the mandate is in the description
// the first case reads, and the shared constant the others pin does not exist.

import { describe, expect, it } from "vitest";

import { AGENT_BUILDER_TOOL_META } from "../mcp/schemas";
import { RUN_START_REPLY_RULE } from "../run-status";

const agentRun = () => AGENT_BUILDER_TOOL_META["agent_run"]!.description;
const agentRunGet = () => AGENT_BUILDER_TOOL_META["agent_run_get"]!.description;

/**
 * A polling MANDATE, as text: an order to follow a start with the read
 * primitive. Written as three separate readings rather than one clever regex so
 * a failure names which shape came back.
 */
const POLL_MANDATE = [
  /MUST be followed by/i,
  /\bpoll(ing)?\b[^.]*\buntil\b/i,
  /\bpoll this\b/i,
];

describe("the reply rule a start answers with", () => {
  it("agent_run carries the report rule", () => {
    expect(agentRun()).toContain(RUN_START_REPLY_RULE);
  });

  it("agent_run ENDS on the report rule — nothing is said after it", () => {
    expect(agentRun().endsWith(RUN_START_REPLY_RULE)).toBe(true);
  });

  it("agent_run orders NO poll after a start", () => {
    for (const shape of POLL_MANDATE) expect(agentRun()).not.toMatch(shape);
  });

  it("agent_run never names the read primitive as a follow-up", () => {
    expect(agentRun()).not.toContain("agent_run_get");
  });

  it("agent_run_get is a read the person can ask for, not a poll a start owes", () => {
    // The tool stays. What goes is the ORDER attached to it: its own
    // description told the model to poll it after `agent_run`, which is the
    // same mandate written a second time.
    expect(agentRunGet()).toBeTruthy();
    for (const shape of POLL_MANDATE) expect(agentRunGet()).not.toMatch(shape);
    expect(agentRunGet()).not.toMatch(/after\s+`?agent_run`?\b/i);
  });

  it("the rule says the platform's sentence is the reply, and adds no second action", () => {
    // The words that make it a REPORT rule rather than an instruction to act.
    expect(RUN_START_REPLY_RULE).toContain("say it back exactly as it is written");
    expect(RUN_START_REPLY_RULE).toContain("add nothing to it");
    // And the rule itself never re-introduces the poll it replaced.
    for (const shape of POLL_MANDATE) expect(RUN_START_REPLY_RULE).not.toMatch(shape);
  });
});
