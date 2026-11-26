/**
 * cinatra#4150 — a step that declares its tools is offered them from the product's own tool server.
 *
 * The bridge (src/app/api/llm-bridge/route.ts) gives an ordinary agent-run step the toolbox
 * ["cinatra-mcp"] and a self-MCP override built by buildLlmMcpServerToolForAgentRun with the
 * allowlist resolveAgentRunCinatraMcpAllowedTools(false) (null: no catalog ceiling), plus the
 * step's declared policy. This test runs that assembly through the real skill-aware entry point;
 * only the provider adapter (a capture double) and the self-MCP's heavy module graph are doubles.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActorContext } from "@/lib/authz/actor-context";

const h = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/generated/extensions.server", () => ({ STATIC_EXTENSION_MANIFEST: [] }));
vi.mock("@/lib/external-mcp-toolbox-loader.server", () => ({
  loadExternalMcpToolboxBySlug: vi.fn(),
  sanitizeExternalMcpToolboxTools: vi.fn(),
}));
vi.mock("@/lib/external-mcp-registry", () => ({
  buildRegisteredExternalMcpServerTools: vi.fn(async () => []),
  buildSingleExternalMcpTool: vi.fn(async () => null),
}));
vi.mock("@/lib/llm-toolbox-providers", () => ({ buildAllToolboxProviderTools: vi.fn(async () => []) }));
vi.mock("@cinatra-ai/mcp-server/credentials", () => ({
  getPublicMcpServerUrl: () => "https://mcp.example.test/api/mcp",
  getLlmMcpCredentials: () => null,
  getLocalTokenEndpointUrl: () => "https://local.example.test/api/auth/token",
  getLocalMcpServerUrl: () => "https://local.example.test/api/mcp",
  hasLlmMcpAccess: () => true,
  getLlmMcpAccessStatus: () => "ok",
}));
vi.mock("@/lib/llm-provider-surfaces", () => ({
  getLlmProviderAdapterSurface: vi.fn((providerId: string) =>
    providerId === "openai"
      ? {
          abiVersion: 1 as const,
          providerId: "openai",
          createAdapter: async () => ({
            provider: "openai" as const,
            defaultModel: "mock-model",
            generate: async (input: Record<string, unknown>) => {
              h.calls.push(input);
              return { text: "", usage: undefined, model: "mock-model" };
            },
          }),
        }
      : null,
  ),
  getLlmProviderSurface: vi.fn(() => null),
  requireLlmProviderSurface: vi.fn((providerId: string) => {
    throw new Error(`The "${providerId}" LLM provider connector is not installed/active`);
  }),
  listLlmProviderSurfaces: vi.fn(() => []),
}));
vi.mock("@/lib/database", () => ({
  readDefaultLlmProviderFromDatabase: vi.fn(() => "openai"),
  readDefaultImageProviderFromDatabase: vi.fn(() => null),
}));
vi.mock("../tools/skills", () => ({
  buildSkillTools: vi.fn().mockResolvedValue([]),
  buildSkillContext: vi.fn().mockResolvedValue(""),
  readSkillContent: vi.fn().mockResolvedValue(null),
  createShellTool: vi.fn(),
  createLocalSkillShellTool: vi.fn(),
  createMcpServerTool: vi.fn(),
  createWebSearchTool: vi.fn(),
  buildMcpTools: vi.fn(),
}));

import { runSkillAwareDeterministicLlmTask } from "../index";
import { buildLlmMcpServerToolForAgentRun } from "../mcp-access";
import { resolveAgentRunCinatraMcpAllowedTools } from "@cinatra-ai/mcp-server/in-admin-cms-tool-policy";

const actorContext: ActorContext = {
  principalType: "HumanUser",
  principalId: "user-1",
  authSource: "ui",
  policyVersion: "v2",
};
const ACTOR = { delegation: "agent_run" as const, userId: "user_1", orgId: "org_1", runId: "run_1",
  platformRole: "member" as const, oboCeiling: [] as never };
const SITE_TOOLS = ["wordpress_site_tools_list", "wordpress_site_tool_write"];

/** One ordinary agent-run model call, assembled as the bridge assembles it. */
async function offeredTools(stepToolPolicy: unknown): Promise<unknown> {
  h.calls.length = 0;
  await runSkillAwareDeterministicLlmTask({
    provider: "openai",
    system: "s",
    user: "u",
    declaredToolboxIds: ["cinatra-mcp"],
    injectedSkills: { members: [], dropped: [] } as never,
    skipExternalMcpRegistry: true,
    toolboxBuildContext: { surface: "agent_run" },
    actorContext,
    cinatraMcpToolOverride: () => buildLlmMcpServerToolForAgentRun("openai", ACTOR, () => "signed-token",
      resolveAgentRunCinatraMcpAllowedTools(false)),
    ...(stepToolPolicy ? { stepToolPolicy } : {}),
  } as never);
  expect(h.calls).toHaveLength(1);
  return h.calls[0]!.tools;
}

beforeEach(() => {
  h.calls.length = 0;
});

describe("a declared step on an ordinary agent run (cinatra#4150)", () => {
  // red-first-expect: AssertionError: expected undefined to deeply equal [ ObjectContaining{…} ]
  it("is offered exactly its declared tools from the product's own tool server", async () => {
    const tools = await offeredTools({ kind: "declared", tools: SITE_TOOLS });
    expect(tools).toEqual([expect.objectContaining({ type: "mcp", serverLabel: "cinatra", allowedTools: SITE_TOOLS })]);
  });

  it("a step without declarations keeps the unrestricted self-MCP offer", async () => {
    const tools = await offeredTools(undefined);
    expect(tools).toEqual([expect.objectContaining({ type: "mcp", serverLabel: "cinatra", allowedTools: null })]);
  });

  it("a step that declares no tool is still offered none", async () => {
    expect(await offeredTools({ kind: "declared", tools: [] })).toBeUndefined();
  });
});
