/**
 * email-delivery-agent OAS — send-confirmation gated shape (cinatra#1961).
 *
 * Per the owner ruling 2026-07-22 (groganz), EVERY campaign send pauses at a
 * confirmation gate. The flow is start → prepare → confirmation_gate → send →
 * end: a read-only prepare step summarizes the pending send from the real
 * campaign data, an InputMessageNode approval gate surfaces that summary, and
 * the send node (the unchanged #1946 primitive path) runs ONLY after the
 * operator approves. Trigger/wait components remain absent (TriggerWaitNode is
 * not a pyagentspec component).
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
  cinatra?: { agentDependencies?: Record<string, string>; hasApprovalGates?: boolean };
};

describe("email-delivery-agent OAS — send-confirmation gated shape", () => {
  it("validateOasAgentJson returns zero errors (full hermetic gate)", () => {
    const errors = validateOasAgentJson(oas);
    expect(errors).toEqual([]);
  });

  it("control flow is start → prepare → confirmation_gate → send → end", () => {
    const edges = (oas.control_flow_connections as Array<{
      from_node: { $component_ref: string };
      to_node: { $component_ref: string };
    }>).map((e) => `${e.from_node.$component_ref}->${e.to_node.$component_ref}`);
    expect(edges).toEqual([
      "start->prepare",
      "prepare->confirmation_gate",
      "confirmation_gate->send",
      "send->end",
    ]);
  });

  it("nodes is exactly [start, prepare, confirmation_gate, send, end]", () => {
    const nodes = (oas.nodes as Array<{ $component_ref: string }>).map(
      (n) => n.$component_ref,
    );
    expect(nodes).toEqual(["start", "prepare", "confirmation_gate", "send", "end"]);
    const refs = Object.keys(oas.$referenced_components as Record<string, unknown>);
    expect(refs.sort()).toEqual([
      "confirmation_gate",
      "end",
      "prepare",
      "send",
      "start",
    ]);
  });

  it("RESUME CANNOT SKIP THE GATE: the only control-flow edge into `send` is from confirmation_gate", () => {
    // The owner ruling requires that the send never runs without an approval.
    // Structurally that means the gate is the sole predecessor of `send` — no
    // start->send / prepare->send bypass edge exists, so a resume lands at the
    // gate and can only proceed through it.
    const edges = oas.control_flow_connections as Array<{
      from_node: { $component_ref: string };
      to_node: { $component_ref: string };
    }>;
    const intoSend = edges.filter((e) => e.to_node.$component_ref === "send");
    expect(intoSend.map((e) => e.from_node.$component_ref)).toEqual(["confirmation_gate"]);
  });

  it("confirmation_gate is an InputMessageNode approval gate (requiresApproval + surfaceGateInputs + self-namespaced renderer)", () => {
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const gate = refs.confirmation_gate;
    expect(gate.component_type).toBe("InputMessageNode");
    const cin = ((gate.metadata as Record<string, unknown>).cinatra) as Record<string, unknown>;
    expect(cin.requiresApproval).toBe(true);
    expect(cin.surfaceGateInputs).toBe(true);
    expect(cin.renderer).toBe("@cinatra-ai/email-delivery-agent:send-confirmation");
    expect(typeof cin.a2uiSurfaceId).toBe("string");
    // Surfaces exactly the fields the pack renderer reads: value.campaignId +
    // value.senderEmail + value.summary.{recipientCount,draftCount,scheduledAt}.
    const inputTitles = (gate.inputs as Array<{ title: string }>).map((i) => i.title).sort();
    expect(inputTitles).toEqual(["campaignId", "senderEmail", "summary"]);
    // InputMessageNode must declare >=1 output; the gate resolves userResponse.
    const outputs = gate.outputs as Array<{ title: string }>;
    expect(outputs.length).toBeGreaterThanOrEqual(1);
    expect(outputs[0].title).toBe("userResponse");
  });

  it("prepare is a read-only summarizer that produces `summary` and never writes", () => {
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const prepare = refs.prepare;
    expect(prepare.component_type).toBe("ApiNode");
    expect(prepare.url).toBe("{{CINATRA_BASE_URL}}/api/llm-bridge");
    const cin = ((prepare.metadata as Record<string, unknown>).cinatra) as Record<string, unknown>;
    expect(cin.riskClass).toBe("read_only");
    // Read-only: the prepare node must not invoke a write/passthrough tool.
    expect((prepare.data as Record<string, unknown>).tool).toBeUndefined();
    const outputs = prepare.outputs as Array<{ title: string }>;
    expect(outputs.map((o) => o.title)).toContain("summary");
    // The summary must be produced from the real refs (objects_get), not placeholders.
    const system = (prepare.data as Record<string, unknown>).system as string;
    expect(system).toContain("objects_get");
    expect(system).toMatch(/recipientCount/);
    expect(system).toMatch(/draftCount/);
  });

  it("the prepare summary shape feeds the gate.summary input via a DataFlowEdge", () => {
    const dfes = oas.data_flow_connections as Array<Record<string, unknown>>;
    const edge = dfes.find(
      (e) =>
        (e.source_node as Record<string, unknown>)?.$component_ref === "prepare" &&
        e.source_output === "summary" &&
        (e.destination_node as Record<string, unknown>)?.$component_ref === "confirmation_gate" &&
        e.destination_input === "summary",
    );
    expect(edge).toBeDefined();
  });

  it("send ApiNode targets {{CINATRA_BASE_URL}}/api/llm-bridge with agent_id='email-delivery-agent' and max_steps=10", () => {
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const send = refs.send;
    expect(send.component_type).toBe("ApiNode");
    expect(send.url).toBe("{{CINATRA_BASE_URL}}/api/llm-bridge");
    expect(send.http_method).toBe("POST");
    const data = send.data as Record<string, unknown>;
    expect(data.agent_id).toBe("email-delivery-agent");
    expect(data.max_steps).toBe(10);
  });

  it("send ApiNode system prompt names the canonical send + status primitives and is consistent with the gate", () => {
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const data = refs.send.data as Record<string, unknown>;
    const system = data.system as string;
    expect(system).toContain("email_outreach_send_initial_start");
    expect(system).toContain("email_outreach_send_initial_status");
    expect(system).not.toContain("email_outreach_campaign_async_operation_status");
    // Prompt/OAS consistency: the send node runs post-approval; the pre-gate
    // "do NOT pause for confirmation" framing is gone and the gate is cited.
    expect(system).not.toContain("Do NOT pause for confirmation");
    expect(system).toMatch(/confirm/i);
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

  it("EndNode sendResult is fed from send.sendResult and userResponse from the gate", () => {
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
    const userResponseEdge = dfes.find((e) => {
      const dest = (e.destination_node as Record<string, unknown>)?.$component_ref;
      return (
        dest === "end" &&
        e.destination_input === "userResponse" &&
        (e.source_node as Record<string, unknown>)?.$component_ref === "confirmation_gate"
      );
    });
    expect(userResponseEdge).toBeDefined();
  });

  it("package.json declares the pinned milestone version, drops trigger-agent dependency, and declares hasApprovalGates:true", () => {
    expect(pkg.version).toBe("0.1.2"); // cinatra#2090 fold bumped the patch
    expect(pkg.cinatra?.agentDependencies).toBeUndefined();
    // The agent now carries a real approval gate — the manifest classifies it truthfully.
    expect(pkg.cinatra?.hasApprovalGates).toBe(true);
  });

  it("hitlScreens declares the send-confirmation gate and the output renderer", () => {
    const metadata = oas.metadata as Record<string, unknown>;
    const cinatra = metadata.cinatra as Record<string, unknown>;
    expect(cinatra.hitlScreens).toEqual([
      "@cinatra-ai/email-delivery-agent:send-confirmation",
      "@cinatra-ai/email-delivery-agent:output",
    ]);
  });

  it("no FlowNode / TriggerWaitNode components remain; only Start/Api/InputMessage/End", () => {
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    for (const value of Object.values(refs)) {
      const ct = value.component_type as string;
      expect(ct).not.toBe("FlowNode");
      expect(ct).not.toBe("TriggerWaitNode");
      expect(["StartNode", "ApiNode", "InputMessageNode", "EndNode"]).toContain(ct);
    }
  });
});
