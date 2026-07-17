/**
 * llm-providers S1 (#1712, AC3) — Anthropic native_mcp fail-closed hardening.
 *
 * Under `capabilityRequired: "native_mcp"` the Anthropic adapter MUST NOT
 * silently degrade its native MCP path to function-tool emulation (function
 * tools are not native MCP — the MCP Injection Rule). Two degrade paths are
 * hardened:
 *   1. RUNTIME native failure — `client.beta.messages.create` throws (e.g. the
 *      account has not enabled the MCP client beta). Without a requirement the
 *      adapter falls back to function-tools; WITH `native_mcp` it fails closed.
 *   2. CONFIG-pinned function-tools mode — the connector is set to
 *      `mcpMode: "function-tools"` while MCP server tools are present. There is
 *      no native path to take, so under `native_mcp` it fails closed.
 *
 * The control cases prove behavior-identity: WITHOUT the requirement, both the
 * runtime failure and the pinned mode fall back exactly as before (no throw).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LlmMcpServerTool } from "../types";

// ---------------------------------------------------------------------------
// Mock the Anthropic SDK. `betaCreateMock` drives the native path (throwable);
// `messagesCreateMock` drives the standard / fallback path.
// ---------------------------------------------------------------------------
const betaCreateMock = vi.fn();
const messagesCreateMock = vi.fn();
// Observe the credential-bearing MCP `tools/list` fetch so the config-pinned
// fail-closed case can prove NO degradation request was issued.
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
import { NativeMcpCapabilityRequiredError } from "../errors";

const MCP_TOOL: LlmMcpServerTool = {
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

beforeEach(() => {
  betaCreateMock.mockReset();
  messagesCreateMock.mockReset();
  fetchMock.mockReset();
  // Default: an MCP `tools/list` returns an empty tool set (used by the
  // control fallback paths). Fail-closed paths must never reach it.
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ result: { tools: [] } }),
  });
  vi.stubGlobal("fetch", fetchMock);
  // Standard path always returns a plain text message.
  messagesCreateMock.mockResolvedValue(STANDARD_RESPONSE);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Anthropic native_mcp fail-closed hardening (#1712 AC3)", () => {
  it("fails closed when the native beta path throws AND native_mcp is required", async () => {
    betaCreateMock.mockRejectedValue(new Error("mcp-client beta not enabled"));
    const adapter = createAnthropicProviderAdapter({ apiKey: "sk-ant-test" });

    await expect(
      adapter.generate({
        system: "s",
        prompt: "p",
        tools: [MCP_TOOL],
        capabilityRequired: "native_mcp",
      }),
    ).rejects.toBeInstanceOf(NativeMcpCapabilityRequiredError);

    // Never degraded to the standard function-tools path.
    expect(messagesCreateMock).not.toHaveBeenCalled();
  });

  it("fails closed when the connector is pinned to function-tools mode AND native_mcp is required", async () => {
    const adapter = createAnthropicProviderAdapter({
      apiKey: "sk-ant-test",
      mcpMode: "function-tools",
    });

    await expect(
      adapter.generate({
        system: "s",
        prompt: "p",
        tools: [MCP_TOOL],
        capabilityRequired: "native_mcp",
      }),
    ).rejects.toBeInstanceOf(NativeMcpCapabilityRequiredError);

    // Fails before ANY degradation begins: no API call AND — critically — no
    // credential-bearing MCP `tools/list` fetch (the prohibited function-tools
    // path must not even start).
    expect(betaCreateMock).not.toHaveBeenCalled();
    expect(messagesCreateMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("CONTROL: native beta failure without a requirement falls back to function-tools (behavior-identical)", async () => {
    betaCreateMock.mockRejectedValue(new Error("mcp-client beta not enabled"));
    const adapter = createAnthropicProviderAdapter({ apiKey: "sk-ant-test" });

    const res = await adapter.generate({
      system: "s",
      prompt: "p",
      tools: [MCP_TOOL],
      // no capabilityRequired
    });

    // Degraded to the standard path and returned a response — no fail-closed.
    expect(res.text).toBe("ok");
    expect(messagesCreateMock).toHaveBeenCalled();
  });

  it("CONTROL: function-tools mode without a requirement does not fail closed", async () => {
    const adapter = createAnthropicProviderAdapter({
      apiKey: "sk-ant-test",
      mcpMode: "function-tools",
    });

    const res = await adapter.generate({
      system: "s",
      prompt: "p",
      tools: [MCP_TOOL],
      // no capabilityRequired
    });

    expect(res.text).toBe("ok");
    expect(betaCreateMock).not.toHaveBeenCalled();
    expect(messagesCreateMock).toHaveBeenCalled();
  });
});
