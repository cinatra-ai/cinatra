import { describe, it, expect, vi, beforeEach } from "vitest";

// #1214 — the agent-run cinatra self-MCP tool must carry an explicit
// `allowedTools` allowlist for in-admin CMS content-editor runs (so a denied
// tool is not advertised to the provider and a call to it is rejected by the
// hosted-MCP relay — a structured denial at dispatch, not a silent pass), and
// stay `null` (unrestricted) for every other agent run. This pins the pass-
// through in `buildLlmMcpServerToolForAgentRun`.

// server-only is a runtime marker with no test value; stub it.
vi.mock("server-only", () => ({}));

// Isolate mcp-access from its heavy @/ + external-MCP module graph — none of it
// is exercised by buildLlmMcpServerToolForAgentRun.
vi.mock("@/lib/generated/extensions.server", () => ({
  STATIC_EXTENSION_MANIFEST: [],
}));
vi.mock("@/lib/external-mcp-toolbox-loader.server", () => ({
  loadExternalMcpToolboxBySlug: vi.fn(),
  sanitizeExternalMcpToolboxTools: vi.fn(),
}));
vi.mock("@/lib/external-mcp-registry", () => ({
  buildSingleExternalMcpTool: vi.fn(),
}));
vi.mock("@/lib/llm-toolbox-providers", () => ({
  buildAllToolboxProviderTools: vi.fn(),
}));
vi.mock("@cinatra-ai/mcp-server/credentials", () => ({
  getPublicMcpServerUrl: () => "https://mcp.example.test/api/mcp",
  getLlmMcpCredentials: () => null,
  getLocalTokenEndpointUrl: () => "https://local.example.test/api/auth/token",
  getLocalMcpServerUrl: () => "https://local.example.test/api/mcp",
  hasLlmMcpAccess: () => true,
  getLlmMcpAccessStatus: () => "ok",
}));

import { buildLlmMcpServerToolForAgentRun } from "../mcp-access";
import { IN_ADMIN_CMS_MCP_ALLOWED_TOOLS } from "@cinatra-ai/mcp-server/in-admin-cms-tool-policy";

const ACTOR = {
  delegation: "agent_run" as const,
  userId: "user_1",
  orgId: "org_1",
  runId: "run_1",
  platformRole: "member" as const,
  // Shape is opaque to the builder (only threaded into the token issuer stub).
  oboCeiling: [] as never,
};

describe("buildLlmMcpServerToolForAgentRun — cinatra self-MCP allowlist (#1214)", () => {
  const issueToken = vi.fn(() => "signed-token");

  beforeEach(() => {
    issueToken.mockClear();
  });

  it("pins allowedTools to the in-admin CMS set when passed the allowlist", async () => {
    const tool = await buildLlmMcpServerToolForAgentRun(
      "openai",
      ACTOR,
      issueToken,
      [...IN_ADMIN_CMS_MCP_ALLOWED_TOOLS],
    );
    expect(tool).not.toBeNull();
    expect(tool!.serverLabel).toBe("cinatra");
    expect(tool!.allowedTools).toEqual([...IN_ADMIN_CMS_MCP_ALLOWED_TOOLS]);
    // The not-yet-rerouted direct-REST primitives are NOT advertised.
    expect(tool!.allowedTools).not.toContain("wordpress_post_delete");
    expect(tool!.allowedTools).not.toContain("wordpress_post_status");
    // Bearer carries the run-scoped OBO token.
    expect(tool!.headers?.Authorization).toBe("Bearer signed-token");
  });

  it("stays unrestricted (null) for a general agent run — default arg unchanged", async () => {
    const tool = await buildLlmMcpServerToolForAgentRun("openai", ACTOR, issueToken);
    expect(tool).not.toBeNull();
    expect(tool!.allowedTools).toBeNull();
  });

  it("passes null through explicitly (non-content-editor resolution)", async () => {
    const tool = await buildLlmMcpServerToolForAgentRun(
      "anthropic",
      ACTOR,
      issueToken,
      null,
    );
    expect(tool!.allowedTools).toBeNull();
  });
});
