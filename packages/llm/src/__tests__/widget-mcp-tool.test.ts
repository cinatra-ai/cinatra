import { describe, it, expect, vi } from "vitest";

// S5 (cinatra#1221) — buildLlmMcpServerToolForWidget mints the cinatra self-MCP
// tool carrying the injected `cinatra.widget.mcp-obo` OBO token. The CLOSED
// `delegated-widget` tool policy is applied at the MCP transport (keyed off the
// VERIFIED actor), so this builder passes NO tool-level allowlist (null) — the
// authoritative cap can never drift from a caller-supplied list.

vi.mock("server-only", () => ({}));
vi.mock("@/lib/generated/extensions.server", () => ({ STATIC_EXTENSION_MANIFEST: [] }));
vi.mock("@/lib/external-mcp-toolbox-loader.server", () => ({
  loadExternalMcpToolboxBySlug: vi.fn(),
  sanitizeExternalMcpToolboxTools: vi.fn(),
}));
vi.mock("@/lib/external-mcp-registry", () => ({ buildSingleExternalMcpTool: vi.fn() }));
vi.mock("@/lib/llm-toolbox-providers", () => ({ buildAllToolboxProviderTools: vi.fn() }));

let publicUrl: string | null = "https://mcp.example.test/api/mcp";
vi.mock("@cinatra-ai/mcp-server/credentials", () => ({
  getPublicMcpServerUrl: () => publicUrl,
  getLlmMcpCredentials: () => null,
  getLocalTokenEndpointUrl: () => "https://local.example.test/api/auth/token",
  getLocalMcpServerUrl: () => "https://local.example.test/api/mcp",
  hasLlmMcpAccess: () => true,
  getLlmMcpAccessStatus: () => "ok",
}));

import { buildLlmMcpServerToolForWidget, type WidgetMcpActor } from "../mcp-access";

const ACTOR: WidgetMcpActor = {
  userId: "user_7",
  orgId: "org_3",
  instanceId: "inst_42",
  kind: "wordpress",
  jti: "turn-nonce-1",
};

describe("buildLlmMcpServerToolForWidget (S5)", () => {
  it("builds the cinatra self-MCP tool with the injected widget OBO token and NO tool-level allowlist", async () => {
    publicUrl = "https://mcp.example.test/api/mcp";
    const issue = vi.fn((a: WidgetMcpActor) => `widget.${a.kind}.${a.jti}`);
    const tool = await buildLlmMcpServerToolForWidget("openai", ACTOR, issue);
    expect(tool).not.toBeNull();
    expect(tool!.serverLabel).toBe("cinatra");
    // The transport applies delegated-widget; the tool advertises no allowlist.
    expect(tool!.allowedTools).toBeNull();
    expect(tool!.headers?.Authorization).toBe("Bearer widget.wordpress.turn-nonce-1");
    // The full actor (pinned instance + kind + jti) is handed to the issuer.
    expect(issue).toHaveBeenCalledWith(ACTOR);
  });

  it("returns null (fail-closed — machine token, denied at boundary) when the public MCP URL is unset", async () => {
    publicUrl = null;
    const tool = await buildLlmMcpServerToolForWidget("anthropic", ACTOR, vi.fn(() => "t"));
    expect(tool).toBeNull();
  });

  it("returns null when the token issuer throws (never falls open)", async () => {
    publicUrl = "https://mcp.example.test/api/mcp";
    const tool = await buildLlmMcpServerToolForWidget("openai", ACTOR, () => {
      throw new Error("no secret");
    });
    expect(tool).toBeNull();
  });
});
