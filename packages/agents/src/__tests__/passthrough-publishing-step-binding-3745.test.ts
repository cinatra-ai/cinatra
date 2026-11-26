/**
 * cinatra#3745 — a direct passthrough publishing step declares the tool its request names, and its call is bound to
 * what the person reviewed.
 *
 * (1) The step-tool reader (findStepToolDeclaration, read by the single-use consumption and by the passthrough's
 *     argument preparation) reads a top-level `/api/agents/passthrough` ApiNode that declares `publishes: true` as
 *     declaring exactly its literal `data.tool`. Every other shape declares nothing, as before.
 * (2) callArgumentsReleased, the consumption's check of a call that names its arguments: a shown argument must be the
 *     text a declared row of the card displayed; a routing id must equal the value frozen with the decision.
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

describe("a call that names its arguments is bound to what the card displayed, and its routing ids to the frozen values", () => {
  const ROLES = { shown: ["senderEmail"], routing: ["campaignId", "approvedDraftBundleRef"] };
  const surfaced = { campaignId: "c-1", senderEmail: "me@example.com", approvedDraftBundleRef: "b-1" };
  const decision = (declaredRows: Array<{ label: string; input: string }>) =>
    ({ status: "released", decidedBy: "user-1", surfacedValues: surfaced, declaredRows }) as never;
  const shownSender = decision([{ label: "Sender", input: "senderEmail" }]);

  it("admits a shown argument its card displayed and routing ids equal to the frozen values, and names the latter", () => {
    expect(consumption.callArgumentsReleased(shownSender,
      { campaignId: "c-1", senderEmail: "me@example.com", approvedDraftBundleRef: "b-1" }, ROLES))
      .toEqual({ ok: true, displayed: ["senderEmail"], frozenNotDisplayed: ["campaignId", "approvedDraftBundleRef"] });
  });

  it("refuses a shown argument the decision surfaced but no row of its card displayed", () => {
    // Before: the surfaced value alone was enough, whether or not a row showed it.
    expect(consumption.callArgumentsReleased(decision([]), { campaignId: "c-1", senderEmail: "me@example.com" }, ROLES))
      .toEqual({ ok: false });
    expect(consumption.callArgumentsReleased(decision([{ label: "Campaign", input: "campaignId" }]),
      { senderEmail: "me@example.com" }, ROLES)).toEqual({ ok: false });
  });

  it("refuses a differing value, an unsurfaced routing id, an argument the tool does not split, and a non-object", () => {
    expect(consumption.callArgumentsReleased(shownSender, { senderEmail: "other@example.com" }, ROLES)).toEqual({ ok: false });
    expect(consumption.callArgumentsReleased(shownSender, { campaignId: "c-2" }, ROLES)).toEqual({ ok: false });
    expect(consumption.callArgumentsReleased(shownSender, { campaignId: ["c-1"] }, ROLES)).toEqual({ ok: false });
    expect(consumption.callArgumentsReleased(shownSender, { approvedDraftBundleRef: "b-1", confirmedRecipientsRef: "r-1" }, ROLES))
      .toEqual({ ok: false });
    for (const args of [null, undefined, "c-1", ["c-1"]]) {
      expect(consumption.callArgumentsReleased(shownSender, args, ROLES)).toEqual({ ok: false });
    }
  });
});
