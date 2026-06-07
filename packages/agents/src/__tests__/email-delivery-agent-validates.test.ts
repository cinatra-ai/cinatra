/**
 * email-delivery-agent OAS single-send shape.
 *
 * The agent uses a single ApiNode that calls the email outreach send use case
 * directly. Trigger/wait components are intentionally absent because
 * FlowNode requires a `subflow` field this OAS does not supply, and
 * TriggerWaitNode is not available as a pyagentspec component.
 *
 * The trigger/wait machinery can return once TriggerWaitNode exists as a real
 * pyagentspec primitive.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, it, expect } from "vitest";

import { validateOasAgentJson } from "../validate-agent-json";

const oasPath = path.resolve(
  __dirname,
  "../../../../extensions/cinatra-ai/email-delivery-agent/cinatra/oas.json",
);
const pkgPath = path.resolve(
  __dirname,
  "../../../../extensions/cinatra-ai/email-delivery-agent/package.json",
);

const oas = JSON.parse(fs.readFileSync(oasPath, "utf8")) as Record<string, unknown>;
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
  version: string;
  cinatra?: { agentDependencies?: Record<string, string> };
};

describe("email-delivery-agent OAS — single-send shape", () => {
  it("validateOasAgentJson returns zero errors (full hermetic gate)", () => {
    const errors = validateOasAgentJson(oas);
    expect(errors).toEqual([]);
  });

  it("control flow is start → send → end (no sender_picker / trigger_subflow / wait_for_trigger)", () => {
    const edges = (oas.control_flow_connections as Array<{
      from_node: { $component_ref: string };
      to_node: { $component_ref: string };
    }>).map((e) => `${e.from_node.$component_ref}->${e.to_node.$component_ref}`);
    expect(edges).toEqual(["start->send", "send->end"]);
  });

  it("nodes is exactly [start, send, end] — no removed-component leftovers", () => {
    const nodes = (oas.nodes as Array<{ $component_ref: string }>).map(
      (n) => n.$component_ref,
    );
    expect(nodes).toEqual(["start", "send", "end"]);
    const refs = Object.keys(oas.$referenced_components as Record<string, unknown>);
    expect(refs.sort()).toEqual(["end", "send", "start"]);
  });

  it("Flow inputs declare campaignId, approvedDraftBundleRef, confirmedRecipientsRef, senderEmail, agent_run_id", () => {
    const inputs = oas.inputs as Array<{ title: string; type: string }>;
    const titles = inputs.map((i) => i.title).sort();
    expect(titles).toEqual([
      "agent_run_id",
      "approvedDraftBundleRef",
      "campaignId",
      "confirmedRecipientsRef",
      "senderEmail",
    ]);
  });

  it("send ApiNode targets {{CINATRA_BASE_URL}}/api/llm-bridge with agent_id='email-delivery-agent' and max_steps=10", () => {
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const send = refs.send;
    expect(send.component_type).toBe("ApiNode");
    expect(send.url).toBe("{{CINATRA_BASE_URL}}/api/llm-bridge");
    expect(send.http_method).toBe("POST");
    const data = send.data as Record<string, unknown>;
    expect(data.agent_id).toBe("email-delivery-agent");
    // max_steps must be within the bridge's cap of 20 to give the LLM
    // budget for objects_get + email_outreach_send_initial_start + status
    // polls (~5 iterations).
    expect(data.max_steps).toBe(10);
  });

  it("send ApiNode system prompt names the canonical send + status primitives", () => {
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const data = refs.send.data as Record<string, unknown>;
    const system = data.system as string;
    // The LLM must call `email_outreach_send_initial_status`
    // (the real primitive in packages/trigger-email-send), NOT the
    // non-canonical `email_outreach_campaign_async_operation_status`.
    expect(system).toContain("email_outreach_send_initial_start");
    expect(system).toContain("email_outreach_send_initial_status");
    expect(system).not.toContain("email_outreach_campaign_async_operation_status");
  });

  it("send ApiNode inputs declare exactly the 5 fields the body references", () => {
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const send = refs.send;
    const inputs = send.inputs as Array<{ title: string; type: string }>;
    expect(inputs.map((i) => i.title).sort()).toEqual([
      "agent_run_id",
      "approvedDraftBundleRef",
      "campaignId",
      "confirmedRecipientsRef",
      "senderEmail",
    ]);
  });

  it("EndNode sendResult output is fed by a DataFlowEdge from send.sendResult", () => {
    const dfes = oas.data_flow_connections as Array<Record<string, unknown>>;
    const sendResultEdge = dfes.find((e) => {
      const dest = (e.destination_node as Record<string, unknown>)?.$component_ref;
      return (
        dest === "end" &&
        e.destination_input === "sendResult" &&
        (e.source_node as Record<string, unknown>)?.$component_ref === "send"
      );
    });
    expect(sendResultEdge).toBeDefined();
  });

  it("package.json is at the v0.1.0 standard and drops the trigger-agent dependency", () => {
    expect(pkg.version).toBe("0.1.0");
    expect(pkg.cinatra?.agentDependencies).toBeUndefined();
  });

  it("hitlScreens declares only the output renderer (no sender_picker / configure / trigger-wait-status)", () => {
    const metadata = oas.metadata as Record<string, unknown>;
    const cinatra = metadata.cinatra as Record<string, unknown>;
    expect(cinatra.hitlScreens).toEqual([
      "@cinatra-ai/email-delivery-agent:output",
    ]);
  });

  it("no FlowNode / TriggerWaitNode components remain in $referenced_components", () => {
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    for (const [id, value] of Object.entries(refs)) {
      const ct = value.component_type as string;
      expect(ct).not.toBe("FlowNode");
      expect(ct).not.toBe("TriggerWaitNode");
      // Sanity: every component must be a recognized type for the stopgap.
      expect(["StartNode", "ApiNode", "EndNode"]).toContain(ct);
    }
  });
});
