/**
 * llm-providers S2 (#1713, AC2) — OpenAI approval-vocabulary translation.
 *
 * OpenAI's declared `approval` capability honours both values, so the adapter
 * translates the provider-neutral vocabulary onto the Responses API knob:
 *
 *   approval: "approval_required"  → require_approval: "always"
 *   approval: "auto_execute"       → require_approval: "never"
 *   approval: undefined            → require_approval: "never"
 *
 * `require_approval` is ALWAYS emitted: omitting it would let OpenAI's
 * server-side default ("always") decide, contradicting the ratified
 * `undefined` ⇒ `auto_execute` rule. The retired three-value `requireApproval`
 * vocabulary ("never"/"always"/"read-only") must never reach the wire.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LlmMcpServerTool } from "../types";

const createMock = vi.fn();

vi.mock("openai", () => ({
  default: class {
    responses = { create: createMock };
    constructor(_opts: unknown) {}
  },
}));

// Provider surfaces resolve to "absent" — the adapter's log-writer lookup
// no-ops; serialization is independent of the surface.
vi.mock("@/lib/llm-provider-surfaces", () => ({
  getLlmProviderSurface: vi.fn(() => null),
  requireLlmProviderSurface: vi.fn((providerId: string) => {
    throw new Error(`The "${providerId}" LLM provider connector is not installed/active`);
  }),
  listLlmProviderSurfaces: vi.fn(() => []),
}));

import { createOpenAIProviderAdapter } from "../providers/openai";

function mcpTool(approval?: LlmMcpServerTool["approval"]): LlmMcpServerTool {
  return {
    type: "mcp",
    serverLabel: "cinatra",
    serverUrl: "https://mcp.example.test/api/mcp",
    headers: { Authorization: "Bearer test" },
    ...(approval !== undefined ? { approval } : {}),
  };
}

/** The MCP tool definition the adapter sent on its (only) responses.create call. */
function sentMcpToolDef(): Record<string, unknown> {
  expect(createMock).toHaveBeenCalledTimes(1);
  const body = createMock.mock.calls[0][0] as { tools?: Array<Record<string, unknown>> };
  const def = (body.tools ?? []).find((t) => t.type === "mcp");
  expect(def).toBeDefined();
  return def as Record<string, unknown>;
}

beforeEach(() => {
  createMock.mockReset();
  // Minimal completed response: no output items → no tool loop, generate returns.
  createMock.mockResolvedValue({ output: [], model: "gpt-5.5" });
});

describe("OpenAI MCP approval serialization (#1713 AC2)", () => {
  it('translates approval_required → require_approval: "always"', async () => {
    const adapter = createOpenAIProviderAdapter({ apiKey: "sk-test" });
    await adapter.generate({ system: "s", prompt: "p", tools: [mcpTool("approval_required")] });

    expect(sentMcpToolDef().require_approval).toBe("always");
  });

  it('translates auto_execute → require_approval: "never"', async () => {
    const adapter = createOpenAIProviderAdapter({ apiKey: "sk-test" });
    await adapter.generate({ system: "s", prompt: "p", tools: [mcpTool("auto_execute")] });

    expect(sentMcpToolDef().require_approval).toBe("never");
  });

  it('codifies the default: an ABSENT approval value emits require_approval: "never" (undefined ⇒ auto_execute)', async () => {
    const adapter = createOpenAIProviderAdapter({ apiKey: "sk-test" });
    await adapter.generate({ system: "s", prompt: "p", tools: [mcpTool(undefined)] });

    // ALWAYS emitted — never left to OpenAI's server-side default ("always").
    expect(sentMcpToolDef().require_approval).toBe("never");
  });

  it("never emits a retired three-value requireApproval token on the wire", async () => {
    const adapter = createOpenAIProviderAdapter({ apiKey: "sk-test" });
    await adapter.generate({
      system: "s",
      prompt: "p",
      tools: [mcpTool("approval_required")],
    });

    const def = sentMcpToolDef();
    expect(def).not.toHaveProperty("requireApproval");
    expect(["always", "never"]).toContain(def.require_approval);
  });
});
