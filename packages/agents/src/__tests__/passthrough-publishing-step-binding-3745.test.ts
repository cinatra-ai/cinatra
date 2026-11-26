/**
 * cinatra#3745 — a direct passthrough publishing step declares the tool its request names, and its call is bound to
 * what the person reviewed.
 *
 * (1) The step-tool reader (findStepToolDeclaration, read by the single-use consumption and by the passthrough's
 *     argument preparation) reads a top-level `/api/agents/passthrough` ApiNode that declares `publishes: true` as
 *     declaring exactly its literal `data.tool`. Every other shape declares nothing, as before.
 * (2) callArgumentsReleased, the consumption's check of a call that names its arguments: every argument must be the
 *     value the released decision surfaced under the same name.
 */
import { describe, expect, it } from "vitest";

import { findStepToolDeclaration } from "../validate-oas-runtime-invariants";
import * as consumption from "../run-action-decision-consumption";

const SEND = "email_outreach_send_initial_start";

/** The shape of the email agents' flows: a read step, then the publishing send on the passthrough. */
function flow(send: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    component_type: "Flow",
    nodes: [{ $component_ref: "start" }, { $component_ref: "send" }, { $component_ref: "end" }],
    $referenced_components: {
      start: { component_type: "StartNode", id: "start" },
      send: {
        component_type: "ApiNode",
        id: "send",
        url: "{{CINATRA_BASE_URL}}/api/agents/passthrough",
        data: { tool: SEND, input: { campaignId: "{{ campaignId }}" } },
        metadata: { cinatra: { publishes: true } },
        ...send,
      },
      end: { component_type: "EndNode", id: "end" },
      ...extra,
    },
  };
}

describe("a direct passthrough publishing step declares the tool its request names", () => {
  it("declares exactly the literal tool of a top-level publishing passthrough node", () => {
    expect(findStepToolDeclaration(flow(), "send")).toEqual({ kind: "declared", tools: [SEND] });
  });

  it("declares nothing for any other shape", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["no publication", { metadata: { cinatra: {} } }],
      ["publishes not the JSON boolean", { metadata: { cinatra: { publishes: "true" } } }],
      ["another target", { url: "{{CINATRA_BASE_URL}}/api/other" }],
      ["an id other than its key", { id: "send-2" }],
      ["a templated tool", { data: { tool: "{{ tool }}" } }],
      ["a tool with upper-case letters", { data: { tool: "Email_send" } }],
      ["the extension dispatch", { data: { tool: "extension_tool" } }],
      ["no tool", { data: {} }],
    ];
    for (const [why, send] of cases) {
      expect(findStepToolDeclaration(flow(send), "send"), why).toEqual({ kind: "undeclared" });
    }
    // Not listed in the root nodes.
    const unlisted = flow();
    unlisted.nodes = [{ $component_ref: "start" }, { $component_ref: "end" }];
    expect(findStepToolDeclaration(unlisted, "send")).toEqual({ kind: "undeclared" });
    // Another step of the same flow.
    expect(findStepToolDeclaration(flow(), "start")).toEqual({ kind: "undeclared" });
  });
});

describe("a call that names its arguments is bound to the values the decision surfaced", () => {
  const surfaced = {
    campaignId: "c-1",
    senderEmail: "me@example.com",
    emailBodies: [{ artifactId: "a-1", representationRevisionId: "r-1" }],
  };

  it("admits arguments that are each the surfaced value under the same name", () => {
    // red-first-expect: callArgumentsReleased is not a function
    expect(consumption.callArgumentsReleased(surfaced, { campaignId: "c-1", senderEmail: "me@example.com" })).toBe(true);
    expect(consumption.callArgumentsReleased(surfaced, {
      emailBodies: [{ representationRevisionId: "r-1", artifactId: "a-1" }],
    })).toBe(true);
  });

  it("refuses an argument the decision did not surface, or one that differs from it", () => {
    // red-first-expect: callArgumentsReleased is not a function
    expect(consumption.callArgumentsReleased(surfaced, { campaignId: "c-2" })).toBe(false);
    expect(consumption.callArgumentsReleased(surfaced, { campaignId: "c-1", senderEmail: "other@example.com" })).toBe(false);
    expect(consumption.callArgumentsReleased(surfaced, { campaignId: "c-1", approvedDraftBundleRef: "b-1" })).toBe(false);
    expect(consumption.callArgumentsReleased(surfaced, {
      emailBodies: [{ artifactId: "a-1", representationRevisionId: "r-2" }],
    })).toBe(false);
    expect(consumption.callArgumentsReleased(surfaced, { campaignId: ["c-1"] })).toBe(false);
    for (const args of [null, undefined, "c-1", ["c-1"]]) {
      expect(consumption.callArgumentsReleased(surfaced, args)).toBe(false);
    }
  });
});
