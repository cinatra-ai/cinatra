/**
 * llm-providers S2 (#1713, AC2) — Anthropic approval-vocabulary fail-closed
 * refusal.
 *
 * Anthropic's declared `approval` capability is "unsupported": neither its
 * native `mcp_servers` serialization nor its function-tools bridge carries an
 * approval knob. An MCP server toolbox declaring `approval:
 * "approval_required"` therefore MUST be refused fail-closed — silently
 * auto-executing it would drop an operator-required approval step (the
 * portable-fiction hazard AC2 retires). The refusal fires BEFORE any
 * credential-bearing request (no Anthropic API call, no MCP `tools/list`
 * fetch), in BOTH generate and stream, in BOTH mcpMode configurations.
 *
 * Controls prove `auto_execute` and the absent-value default (`undefined` ⇒
 * `auto_execute`) pass through with no behavior change.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LlmMcpServerTool } from "../types";

const betaCreateMock = vi.fn();
const messagesCreateMock = vi.fn();
// Observe the credential-bearing MCP `tools/list` fetch so the fail-closed
// cases can prove NO degradation request was issued.
const fetchMock = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    beta = { messages: { create: betaCreateMock } };
    messages = { create: messagesCreateMock };
    constructor(_config: unknown) {}
  }
  return { default: MockAnthropic };
});

// Telemetry writes log files — no-op in tests.
vi.mock("../telemetry", () => ({
  writeAnthropicLogFile: vi.fn(async () => {}),
}));

import { createAnthropicProviderAdapter } from "../providers/anthropic";
import { McpApprovalUnsupportedError } from "../errors";

const APPROVAL_REQUIRED_TOOL: LlmMcpServerTool = {
  type: "mcp",
  serverLabel: "external-guarded",
  serverUrl: "http://mcp.invalid/api/mcp",
  headers: { Authorization: "Bearer test" },
  approval: "approval_required",
};

const AUTO_EXECUTE_TOOL: LlmMcpServerTool = {
  type: "mcp",
  serverLabel: "cinatra",
  serverUrl: "http://mcp.invalid/api/mcp",
  headers: { Authorization: "Bearer test" },
  approval: "auto_execute",
};

const ABSENT_APPROVAL_TOOL: LlmMcpServerTool = {
  type: "mcp",
  serverLabel: "cinatra",
  serverUrl: "http://mcp.invalid/api/mcp",
  headers: { Authorization: "Bearer test" },
};

const STANDARD_RESPONSE = {
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
};

const streamCallbacks = {
  onTextDelta: vi.fn(),
  onToolCall: vi.fn(),
  onToolResult: vi.fn(),
  onStepStart: vi.fn(),
  onStepEnd: vi.fn(),
  onError: vi.fn(),
};

beforeEach(() => {
  betaCreateMock.mockReset();
  messagesCreateMock.mockReset();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ result: { tools: [] } }),
  });
  vi.stubGlobal("fetch", fetchMock);
  messagesCreateMock.mockResolvedValue(STANDARD_RESPONSE);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Anthropic approval_required fail-closed refusal (#1713 AC2)", () => {
  it("generate: refuses an approval_required toolbox before ANY request (native mode)", async () => {
    const adapter = createAnthropicProviderAdapter({ apiKey: "sk-ant-test" });

    await expect(
      adapter.generate({ system: "s", prompt: "p", tools: [APPROVAL_REQUIRED_TOOL] }),
    ).rejects.toBeInstanceOf(McpApprovalUnsupportedError);

    expect(betaCreateMock).not.toHaveBeenCalled();
    expect(messagesCreateMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("generate: refuses in function-tools mode too — before the credential-bearing tools/list fetch", async () => {
    const adapter = createAnthropicProviderAdapter({
      apiKey: "sk-ant-test",
      mcpMode: "function-tools",
    });

    await expect(
      adapter.generate({ system: "s", prompt: "p", tools: [APPROVAL_REQUIRED_TOOL] }),
    ).rejects.toBeInstanceOf(McpApprovalUnsupportedError);

    expect(betaCreateMock).not.toHaveBeenCalled();
    expect(messagesCreateMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("generate: the refusal names the offending server labels and carries the domain code", async () => {
    const adapter = createAnthropicProviderAdapter({ apiKey: "sk-ant-test" });

    const err = await adapter
      .generate({ system: "s", prompt: "p", tools: [APPROVAL_REQUIRED_TOOL] })
      .then(
        () => null,
        (e: unknown) => e as McpApprovalUnsupportedError,
      );

    expect(err).toBeInstanceOf(McpApprovalUnsupportedError);
    expect(err?.code).toBe("mcp_approval_unsupported");
    expect(err?.provider).toBe("anthropic");
    expect(err?.serverLabels).toEqual(["external-guarded"]);
    expect(err?.message).toContain('"external-guarded"');
  });

  it("stream: refuses an approval_required toolbox before ANY request", async () => {
    const adapter = createAnthropicProviderAdapter({ apiKey: "sk-ant-test" });

    await expect(
      adapter.stream({
        system: "s",
        messages: [{ role: "user", content: "p" }],
        tools: [APPROVAL_REQUIRED_TOOL],
        ...streamCallbacks,
      }),
    ).rejects.toBeInstanceOf(McpApprovalUnsupportedError);

    expect(betaCreateMock).not.toHaveBeenCalled();
    expect(messagesCreateMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stream: refuses in function-tools mode too — before the credential-bearing tools/list fetch", async () => {
    const adapter = createAnthropicProviderAdapter({
      apiKey: "sk-ant-test",
      mcpMode: "function-tools",
    });

    await expect(
      adapter.stream({
        system: "s",
        messages: [{ role: "user", content: "p" }],
        tools: [APPROVAL_REQUIRED_TOOL],
        ...streamCallbacks,
      }),
    ).rejects.toBeInstanceOf(McpApprovalUnsupportedError);

    expect(betaCreateMock).not.toHaveBeenCalled();
    expect(messagesCreateMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("CONTROL: an explicit auto_execute toolbox passes through (function-tools mode, no refusal)", async () => {
    const adapter = createAnthropicProviderAdapter({
      apiKey: "sk-ant-test",
      mcpMode: "function-tools",
    });

    const res = await adapter.generate({
      system: "s",
      prompt: "p",
      tools: [AUTO_EXECUTE_TOOL],
    });

    expect(res.text).toBe("ok");
    expect(messagesCreateMock).toHaveBeenCalled();
  });

  it("CONTROL: an ABSENT approval value defaults to auto_execute (undefined ⇒ auto_execute) — no refusal", async () => {
    const adapter = createAnthropicProviderAdapter({
      apiKey: "sk-ant-test",
      mcpMode: "function-tools",
    });

    const res = await adapter.generate({
      system: "s",
      prompt: "p",
      tools: [ABSENT_APPROVAL_TOOL],
    });

    expect(res.text).toBe("ok");
    expect(messagesCreateMock).toHaveBeenCalled();
  });
});
