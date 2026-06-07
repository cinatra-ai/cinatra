/**
 * Regression coverage for scanOasForUntrustedUrls.
 *
 * Locks the allow-list contract for A2AAgent.agent_url and MCPToolBox.url:
 *   - Positive: non-allowlisted hosts/schemes yield findings with location.
 *   - Negative: {{CINATRA_BASE_URL}} placeholders and relative paths yield none.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/scan-oas-untrusted-urls.test.ts
 */
import { describe, expect, it } from "vitest";

import { scanOasForUntrustedUrls } from "../validate-agent-json";

type OasFixture = Record<string, unknown>;

function buildOasWithA2AAgent(agentUrl: string): OasFixture {
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "test-flow",
    name: "Test Flow",
    description: "Test fixture",
    metadata: { cinatra: { type: "node" } },
    nodes: [],
    start_node: { $component_ref: "start" },
    control_flow_connections: [],
    $referenced_components: {
      remote_agent: {
        component_type: "A2AAgent",
        id: "remote_agent",
        agent_url: agentUrl,
      },
    },
  };
}

function buildOasWithMcpToolbox(url: string): OasFixture {
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "test-flow",
    name: "Test Flow",
    description: "Test fixture",
    metadata: { cinatra: { type: "node" } },
    nodes: [],
    start_node: { $component_ref: "start" },
    control_flow_connections: [],
    $referenced_components: {
      mcp_box: {
        component_type: "MCPToolBox",
        id: "mcp_box",
        url,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Positive fixtures — each MUST yield at least one finding.
// ---------------------------------------------------------------------------

const POSITIVE_FIXTURES: Array<{ name: string; oas: OasFixture; expectedLocationField: string }> = [
  {
    name: "A2AAgent.agent_url with non-allowlisted host",
    oas: buildOasWithA2AAgent("http://attacker.example.com/a2a"),
    expectedLocationField: "agent_url",
  },
  {
    name: "MCPToolBox.url with non-allowlisted host",
    oas: buildOasWithMcpToolbox("https://malicious.example.com/mcp"),
    expectedLocationField: "url",
  },
  {
    name: "A2AAgent.agent_url with non-allowlisted scheme",
    oas: buildOasWithA2AAgent("ws://internal-only/a2a"),
    expectedLocationField: "agent_url",
  },
];

// ---------------------------------------------------------------------------
// Negative fixtures — each MUST yield zero findings.
// ---------------------------------------------------------------------------

const NEGATIVE_FIXTURES: Array<{ name: string; oas: OasFixture }> = [
  {
    name: "A2AAgent.agent_url with {{CINATRA_BASE_URL}} placeholder",
    oas: buildOasWithA2AAgent("{{CINATRA_BASE_URL}}/api/a2a"),
  },
  {
    name: "MCPToolBox.url with {{CINATRA_BASE_URL}} placeholder",
    oas: buildOasWithMcpToolbox("{{CINATRA_BASE_URL}}/api/mcp"),
  },
  {
    name: "MCPToolBox.url with relative path",
    oas: buildOasWithMcpToolbox("/api/mcp"),
  },
  {
    name: "A2AAgent.agent_url with relative path",
    oas: buildOasWithA2AAgent("/api/a2a"),
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("scanOasForUntrustedUrls — positive fixtures yield findings", () => {
  it.each(POSITIVE_FIXTURES)("$name", ({ oas, expectedLocationField }) => {
    const findings = scanOasForUntrustedUrls(oas);
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(finding).toMatchObject({
        code: expect.any(String),
        severity: "blocker",
        source: "deterministic",
      });
      expect(finding.location).toBeDefined();
      const locStr = JSON.stringify(finding.location);
      expect(locStr).toContain(expectedLocationField);
    }
  });
});

describe("scanOasForUntrustedUrls — negative fixtures yield zero findings", () => {
  it.each(NEGATIVE_FIXTURES)("$name", ({ oas }) => {
    const findings = scanOasForUntrustedUrls(oas);
    expect(findings).toEqual([]);
  });
});
