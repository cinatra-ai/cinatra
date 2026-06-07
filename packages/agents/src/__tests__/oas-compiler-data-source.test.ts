import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { compileOasAgentJson, __resetRegistryCacheForTests } from "../oas-compiler";
// Single source of truth for the data-source literal.
import { GMAIL_SEND_AS_DATA_SOURCE } from "@cinatra-ai/agent-ui-protocol/server";

// ---------------------------------------------------------------------------
// Minimal valid agent.json fixture builder.
//
// The flowSchema requires:
//   agentspec_version, component_type: "Flow", id, name,
//   metadata.cinatra.type, inputs, outputs, start_node, nodes,
//   control_flow_connections, $referenced_components
//
// We declare two components: a StartNode and an EndNode, connected by a
// single ControlFlowEdge. The StartNode carries the test inputs and the
// metadata.cinatra map we want to exercise.
// ---------------------------------------------------------------------------

function buildAgentJson(opts: {
  withInputDataSource?: boolean;
  withRenderer?: boolean;
} = {}): Record<string, unknown> {
  const cinatra: Record<string, unknown> = {
    required: ["senderEmail"],
    inputTitles: { senderEmail: "Sender Email" },
  };
  if (opts.withRenderer) {
    cinatra.inputRenderers = {
      senderEmail: "@cinatra-ai/email-outreach-agent:gmail-sender",
    };
  }
  if (opts.withInputDataSource) {
    cinatra.inputDataSources = {
      senderEmail: GMAIL_SEND_AS_DATA_SOURCE,
    };
  }

  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "test-flow",
    name: "Test Flow",
    metadata: {
      cinatra: {
        type: "leaf",
      },
    },
    inputs: [{ title: "senderEmail", type: "string" }],
    outputs: [],
    start_node: { $component_ref: "startNode" },
    nodes: [
      { $component_ref: "startNode" },
      { $component_ref: "endNode" },
    ],
    control_flow_connections: [
      {
        component_type: "ControlFlowEdge",
        name: "start-to-end",
        from_node: { $component_ref: "startNode" },
        to_node: { $component_ref: "endNode" },
      },
    ],
    $referenced_components: {
      startNode: {
        component_type: "StartNode",
        id: "startNode",
        name: "Start",
        inputs: [{ title: "senderEmail", type: "string" }],
        metadata: { cinatra },
      },
      endNode: {
        component_type: "EndNode",
        id: "endNode",
        name: "End",
        outputs: [],
      },
    },
  };
}

let tempDir: string;

beforeEach(() => {
  __resetRegistryCacheForTests();
  tempDir = mkdtempSync(path.join(tmpdir(), "oas-compiler-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeFixture(opts: { withInputDataSource?: boolean; withRenderer?: boolean }): string {
  const agentJsonPath = path.join(tempDir, "agent.json");
  writeFileSync(agentJsonPath, JSON.stringify(buildAgentJson(opts), null, 2));
  return agentJsonPath;
}

describe("oas-compiler — x-data-source", () => {
  it("writes x-data-source from inputDataSources", async () => {
    const agentJsonPath = writeFixture({ withInputDataSource: true });
    // registryPath points to a nonexistent file; loadGlobalRegistry falls back gracefully to {}.
    const result = await compileOasAgentJson({
      packageName: "@test/pkg",
      agentJsonPath,
      registryPath: path.join(tempDir, "components.json"),
    });
    // compileOasAgentJson returns { ok: true, value: { inputSchema, ... } }
    expect(result.ok).toBe(true);
    if (!result.ok) return; // narrow type for TS
    const properties = (result.value.inputSchema as { properties: Record<string, unknown> }).properties;
    const senderProp = properties.senderEmail as Record<string, unknown>;
    expect(senderProp["x-data-source"]).toBe(GMAIL_SEND_AS_DATA_SOURCE);
  });

  it("omits x-data-source when not declared", async () => {
    const agentJsonPath = writeFixture({ withInputDataSource: false });
    const result = await compileOasAgentJson({
      packageName: "@test/pkg",
      agentJsonPath,
      registryPath: path.join(tempDir, "components.json"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const properties = (result.value.inputSchema as { properties: Record<string, unknown> }).properties;
    const senderProp = properties.senderEmail as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(senderProp, "x-data-source")).toBe(false);
  });

  it("preserves x-renderer alongside x-data-source", async () => {
    const agentJsonPath = writeFixture({ withInputDataSource: true, withRenderer: true });
    const result = await compileOasAgentJson({
      packageName: "@test/pkg",
      agentJsonPath,
      registryPath: path.join(tempDir, "components.json"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const properties = (result.value.inputSchema as { properties: Record<string, unknown> }).properties;
    const senderProp = properties.senderEmail as Record<string, unknown>;
    expect(senderProp["x-renderer"]).toBe("@cinatra-ai/email-outreach-agent:gmail-sender");
    expect(senderProp["x-data-source"]).toBe(GMAIL_SEND_AS_DATA_SOURCE);
  });
});
