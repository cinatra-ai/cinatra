/**
 * Regression coverage for scanOasForLlmBridgeWiring.
 *
 * Locks the contract that any ApiNode pointing at /api/llm-bridge MUST
 * carry an `agent_id` in its body, data, or config — otherwise the bridge
 * call will fail the per-agent identity check.
 *
 *   - Positive: bridge ApiNode missing agent_id → finding at the node id.
 *   - Negative: bridge ApiNode with agent_id in body/data/config → no finding;
 *               non-bridge ApiNode → no finding regardless.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/scan-oas-llm-bridge-wiring.test.ts
 */
import { describe, expect, it } from "vitest";

import { scanOasForLlmBridgeWiring } from "../validate-agent-json";

type OasFixture = Record<string, unknown>;

function buildOasWithApiNode(apiNodeProps: Record<string, unknown>): OasFixture {
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "test-flow",
    name: "Test Flow",
    description: "Test fixture",
    metadata: { cinatra: { type: "node" } },
    nodes: [
      { $component_ref: "start" },
      { $component_ref: "api_step" },
      { $component_ref: "end" },
    ],
    start_node: { $component_ref: "start" },
    control_flow_connections: [],
    $referenced_components: {
      start: { component_type: "StartNode", id: "start" },
      end: { component_type: "EndNode", id: "end" },
      api_step: {
        component_type: "ApiNode",
        id: "api_step",
        method: "POST",
        ...apiNodeProps,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Positive fixtures — each MUST yield a finding pointing at the ApiNode id.
// ---------------------------------------------------------------------------

const POSITIVE_FIXTURES: Array<{ name: string; oas: OasFixture }> = [
  {
    name: "bridge ApiNode with no body and no data and no config",
    oas: buildOasWithApiNode({
      url: "{{CINATRA_BASE_URL}}/api/llm-bridge",
    }),
  },
  {
    name: "bridge ApiNode (relative URL) with body lacking agent_id",
    oas: buildOasWithApiNode({
      url: "/api/llm-bridge",
      body: { system: "you are a helper", user: "hello" },
    }),
  },
  {
    name: "bridge ApiNode with data carrying agent_run_id but missing agent_id",
    oas: buildOasWithApiNode({
      url: "{{CINATRA_BASE_URL}}/api/llm-bridge",
      data: {
        system: "you are a helper",
        user: "hello",
        agent_run_id: "{{ agent_run_id }}",
      },
    }),
  },
];

// ---------------------------------------------------------------------------
// Negative fixtures — each MUST yield zero findings.
// ---------------------------------------------------------------------------

const NEGATIVE_FIXTURES: Array<{ name: string; oas: OasFixture }> = [
  {
    name: "bridge ApiNode with agent_id in data → no finding",
    oas: buildOasWithApiNode({
      url: "{{CINATRA_BASE_URL}}/api/llm-bridge",
      data: { agent_id: "my-agent", system: "...", user: "..." },
    }),
  },
  {
    name: "non-bridge ApiNode (different endpoint) → no finding",
    oas: buildOasWithApiNode({
      url: "{{CINATRA_BASE_URL}}/api/other",
      body: {},
    }),
  },
  {
    name: "bridge ApiNode with agent_id in config → no finding",
    oas: buildOasWithApiNode({
      url: "{{CINATRA_BASE_URL}}/api/llm-bridge",
      config: { agent_id: "x" },
    }),
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("scanOasForLlmBridgeWiring — positive fixtures yield findings", () => {
  it.each(POSITIVE_FIXTURES)("$name", ({ oas }) => {
    const findings = scanOasForLlmBridgeWiring(oas);
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(finding).toMatchObject({
        code: expect.any(String),
        severity: "blocker",
        source: "deterministic",
      });
      // location MUST identify the ApiNode by component id "api_step"
      expect(finding.location).toBeDefined();
      const locStr = JSON.stringify(finding.location);
      expect(locStr).toContain("api_step");
    }
  });

  it("at least one positive fixture emits an 'agent_id' message", () => {
    const allMessages = POSITIVE_FIXTURES.flatMap(({ oas }) =>
      scanOasForLlmBridgeWiring(oas).map((f: { message: string }) => f.message),
    );
    expect(allMessages.some((m: string) => /agent_id/i.test(m))).toBe(true);
  });
});

describe("scanOasForLlmBridgeWiring — negative fixtures yield zero findings", () => {
  it.each(NEGATIVE_FIXTURES)("$name", ({ oas }) => {
    const findings = scanOasForLlmBridgeWiring(oas);
    expect(findings).toEqual([]);
  });
});
