/**
 * Regression coverage for scanOasForLiteralSecrets.
 *
 * Locks the scanner contract:
 *   - Walks the scanned OAS field set (body, config, headers, params,
 *     system_prompt, prompt_template, message) for high-entropy literal
 *     credential patterns (sk-*, gho_*, ya29.*, xoxb-*, AKIA*, JWT).
 *   - Ignores Jinja `{{var}}`, env-style `${VAR}`, angle-bracket placeholders,
 *     explicit redaction markers, low-entropy strings, top-level package
 *     description, and Markdown documentation examples in description fields.
 *
 * The implementation must report deterministic blocker findings for literal
 * credentials in scanned fields while allowing placeholder and redacted examples.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/scan-oas-literal-secrets.test.ts
 */
import { describe, expect, it } from "vitest";

import { scanOasForLiteralSecrets } from "../validate-agent-json";

// ---------------------------------------------------------------------------
// Minimal OAS Flow 26.1.0 fixture builders. Each helper hosts a single
// scanned field on a referenced component so the scan has a concrete path.
// ---------------------------------------------------------------------------

type OasFixture = Record<string, unknown>;

function buildOasWithApiNodeBody(body: Record<string, unknown>): OasFixture {
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "test-flow",
    name: "Test Flow",
    description: "Test fixture",
    metadata: { cinatra: { type: "node" } },
    nodes: [{ $component_ref: "start" }, { $component_ref: "api_step" }, { $component_ref: "end" }],
    start_node: { $component_ref: "start" },
    control_flow_connections: [],
    $referenced_components: {
      start: { component_type: "StartNode", id: "start" },
      end: { component_type: "EndNode", id: "end" },
      api_step: {
        component_type: "ApiNode",
        id: "api_step",
        url: "{{CINATRA_BASE_URL}}/api/echo",
        method: "POST",
        body,
      },
    },
  };
}

function buildOasWithApiNodeHeaders(headers: Record<string, string>): OasFixture {
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
      api_step: {
        component_type: "ApiNode",
        id: "api_step",
        url: "https://example.com",
        method: "GET",
        headers,
      },
    },
  };
}

function buildOasWithApiNodeData(data: Record<string, unknown>): OasFixture {
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
      api_step: {
        component_type: "ApiNode",
        id: "api_step",
        url: "{{CINATRA_BASE_URL}}/api/echo",
        method: "POST",
        data,
      },
    },
  };
}

function buildOasWithAgentSystemPrompt(systemPrompt: string): OasFixture {
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
      agent_one: {
        component_type: "Agent",
        id: "agent_one",
        system_prompt: systemPrompt,
      },
    },
  };
}

function buildOasWithMcpToolboxConfig(config: Record<string, unknown>): OasFixture {
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
        url: "{{CINATRA_BASE_URL}}/api/mcp",
        config,
      },
    },
  };
}

function buildOasWithApiNodeDescription(description: string): OasFixture {
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "test-flow",
    name: "Test Flow",
    description: "Reviews generated email drafts for quality, tone, and accuracy.",
    metadata: { cinatra: { type: "node" } },
    nodes: [],
    start_node: { $component_ref: "start" },
    control_flow_connections: [],
    $referenced_components: {
      api_step: {
        component_type: "ApiNode",
        id: "api_step",
        description,
        url: "{{CINATRA_BASE_URL}}/api/echo",
        method: "POST",
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Positive fixtures — each MUST yield at least one ReviewFinding.
// ---------------------------------------------------------------------------

const POSITIVE_FIXTURES: Array<{ name: string; oas: OasFixture }> = [
  {
    name: "OpenAI sk- prefix in ApiNode body Authorization",
    oas: buildOasWithApiNodeBody({
      Authorization: "Bearer sk-1234567890abcdef1234567890abcdef",
    }),
  },
  {
    name: "GitHub ghp_ PAT in ApiNode headers",
    oas: buildOasWithApiNodeHeaders({
      "x-github-token": "ghp_1234567890abcdef1234567890abcdef1234567890",
    }),
  },
  {
    name: "AWS AKIA prefix in ApiNode data",
    oas: buildOasWithApiNodeData({
      AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
    }),
  },
  {
    name: "Google OAuth ya29. token in Agent system_prompt",
    oas: buildOasWithAgentSystemPrompt(
      "Use this token to call the API: ya29.A0AVA9y1aABcDeFgHiJkLmNoPqRsTuVwXyZ1234567890abcdefg",
    ),
  },
  {
    name: "Slack xoxb- bot token in MCPToolBox config",
    oas: buildOasWithMcpToolboxConfig({
      slack_token: "xoxb-1234-5678-abcdefghijklmnopqrstuvwxyz",
    }),
  },
  {
    name: "JWT-shaped credential in ApiNode body",
    oas: buildOasWithApiNodeBody({
      Authorization:
        "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.signature",
    }),
  },
];

// ---------------------------------------------------------------------------
// Negative fixtures — each MUST yield zero findings.
// ---------------------------------------------------------------------------

const NEGATIVE_FIXTURES: Array<{ name: string; oas: OasFixture }> = [
  {
    name: "Jinja placeholder Bearer {{token}}",
    oas: buildOasWithApiNodeBody({ Authorization: "Bearer {{token}}" }),
  },
  {
    name: "Env-style placeholder Bearer ${TOKEN}",
    oas: buildOasWithApiNodeBody({ Authorization: "Bearer ${TOKEN}" }),
  },
  {
    name: "Bare env-style placeholder ${TOKEN} in headers",
    oas: buildOasWithApiNodeHeaders({ "x-api-token": "${TOKEN}" }),
  },
  {
    name: "Angle-bracket placeholder Bearer <API_KEY>",
    oas: buildOasWithApiNodeBody({ Authorization: "Bearer <API_KEY>" }),
  },
  {
    name: "Angle-bracket placeholder <SECRET> in data",
    oas: buildOasWithApiNodeData({ secret: "<SECRET>" }),
  },
  {
    name: 'Explicit redaction marker "***"',
    oas: buildOasWithApiNodeHeaders({ Authorization: "***" }),
  },
  {
    name: 'Explicit redaction marker "REDACTED"',
    oas: buildOasWithApiNodeHeaders({ Authorization: "REDACTED" }),
  },
  {
    name: "Explicit example marker sk-EXAMPLE",
    oas: buildOasWithApiNodeBody({ Authorization: "Bearer sk-EXAMPLE" }),
  },
  {
    name: "Short low-entropy strings (true, v1, 1.0.0, GET, POST)",
    oas: buildOasWithApiNodeBody({
      enabled: "true",
      version: "v1",
      semver: "1.0.0",
      verb1: "GET",
      verb2: "POST",
    }),
  },
  {
    name: "Top-level package description is NOT scanned",
    oas: {
      agentspec_version: "26.1.0",
      component_type: "Flow",
      id: "test-flow",
      name: "Test Flow",
      description:
        "This package handles sk-1234567890abcdef1234567890abcdef key rotation logic.",
      metadata: { cinatra: { type: "node" } },
      nodes: [],
      start_node: { $component_ref: "start" },
      control_flow_connections: [],
      $referenced_components: {},
    },
  },
  {
    name: "Markdown doc example in description field is NOT scanned",
    oas: buildOasWithApiNodeDescription(
      "Use `sk-1234567890abcdef1234567890abcdef` as your API key",
    ),
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("scanOasForLiteralSecrets — positive fixtures yield findings", () => {
  it.each(POSITIVE_FIXTURES)("$name", ({ oas }) => {
    const findings = scanOasForLiteralSecrets(oas);
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(finding).toMatchObject({
        code: expect.any(String),
        severity: "blocker",
        message: expect.any(String),
        source: "deterministic",
      });
    }
  });

  it("at least one positive fixture emits a 'literal credential' or 'literal secret' message", () => {
    const allMessages = POSITIVE_FIXTURES.flatMap(({ oas }) =>
      scanOasForLiteralSecrets(oas).map((f: { message: string }) => f.message),
    );
    const matched = allMessages.some((m) =>
      /literal credential|literal secret/i.test(m),
    );
    expect(matched).toBe(true);
  });
});

describe("scanOasForLiteralSecrets — negative fixtures yield zero findings", () => {
  it.each(NEGATIVE_FIXTURES)("$name", ({ oas }) => {
    const findings = scanOasForLiteralSecrets(oas);
    expect(findings).toEqual([]);
  });
});
