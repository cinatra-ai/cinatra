/**
 * cinatra#4150 — a step that declares its tools is offered them from the product's own tool server.
 *
 * The bridge (src/app/api/llm-bridge/route.ts) gives an ordinary agent-run step the toolbox
 * ["cinatra-mcp"] and a self-MCP override built by buildLlmMcpServerToolForAgentRun with the
 * allowlist resolveAgentRunCinatraMcpAllowedTools(isEditor, served), where `served` is the tool list
 * the server serves the run when the step declares tools, and null otherwise. This test runs that
 * assembly through the real skill-aware entry point and the unchanged offer filter; only the
 * provider adapter (a capture double) and the self-MCP's heavy module graph are doubles.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActorContext } from "@/lib/authz/actor-context";

const h = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/generated/extensions.server", () => ({ STATIC_EXTENSION_MANIFEST: [] }));
vi.mock("@/lib/external-mcp-toolbox-loader.server", () => ({
  // An outside tool server with a known catalog, reached as a declared toolbox.
  loadExternalMcpToolboxBySlug: vi.fn(async (slug: string) => slug === "outside-toolbox"
    ? { buildTools: async () => [{ type: "mcp", serverLabel: "outside", serverUrl: "https://outside.test/mcp",
        allowedTools: ["outside_lookup", "outside_write"] }] }
    : null),
  sanitizeExternalMcpToolboxTools: vi.fn((_slug: string, tools: unknown) => tools),
}));
vi.mock("@/lib/external-mcp-registry", () => ({
  buildRegisteredExternalMcpServerTools: vi.fn(async () => []),
  buildSingleExternalMcpTool: vi.fn(async () => null),
}));
vi.mock("@/lib/llm-toolbox-providers", () => ({ buildAllToolboxProviderTools: vi.fn(async () => []),
  buildToolboxProviderTools: vi.fn(async () => null) }));
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
import {
  IN_ADMIN_CMS_MCP_ALLOWED_TOOLS,
  resolveAgentRunCinatraMcpAllowedTools,
} from "@cinatra-ai/mcp-server/in-admin-cms-tool-policy";

const actorContext: ActorContext = {
  principalType: "HumanUser",
  principalId: "user-1",
  authSource: "ui",
  policyVersion: "v2",
};
const ACTOR = { delegation: "agent_run" as const, userId: "user_1", orgId: "org_1", runId: "run_1",
  platformRole: "member" as const, oboCeiling: [] as never };
const SITE_TOOLS = ["wordpress_site_tools_list", "wordpress_site_tool_write"];
/** What the product's server serves the run (a stand-in for its own registration pass). */
const SERVED = [...SITE_TOOLS, "drupal_node_get", "artifact_get", "memory_search"];

/** One ordinary agent-run model call, assembled as the bridge assembles it. */
async function offeredTools(stepToolPolicy: { kind: string; tools?: string[] } | undefined,
  extra: Record<string, unknown> = {}, isEditor = false): Promise<unknown> {
  h.calls.length = 0;
  const served = stepToolPolicy?.kind === "declared" ? SERVED : null;
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
      resolveAgentRunCinatraMcpAllowedTools(isEditor, served)),
    ...(stepToolPolicy ? { stepToolPolicy } : {}),
    ...extra,
  } as never);
  expect(h.calls).toHaveLength(1);
  return h.calls[0]!.tools;
}

const self = (allowedTools: string[] | null) =>
  expect.objectContaining({ type: "mcp", serverLabel: "cinatra", allowedTools });

beforeEach(() => {
  h.calls.length = 0;
});

describe("a declared step on an ordinary agent run (cinatra#4150)", () => {
  // red-first-expect: AssertionError: expected undefined to deeply equal [ ObjectContaining{…} ]
  it("is offered exactly its declared tools from the product's own tool server", async () => {
    const tools = await offeredTools({ kind: "declared", tools: SITE_TOOLS });
    expect(tools).toEqual([self(SITE_TOOLS)]);
  });

  // red-first-expect: AssertionError: expected undefined to deeply equal [ ObjectContaining{…} ]
  it("is not offered a declared name the product does not serve", async () => {
    const tools = await offeredTools({ kind: "declared", tools: [SITE_TOOLS[0]!, "not_served_tool"] });
    expect(tools).toEqual([self([SITE_TOOLS[0]!])]);
  });

  // red-first-expect: AssertionError: expected [ { type: 'mcp', …(3) } ] to deeply equal ArrayContaining{…}
  it("keeps a declared tool of an outside server with that server", async () => {
    const tools = await offeredTools({ kind: "declared", tools: [SITE_TOOLS[0]!, "outside_lookup"] },
      { declaredToolboxIds: ["cinatra-mcp", "outside-toolbox"] });
    expect(tools).toEqual(expect.arrayContaining([self([SITE_TOOLS[0]!]),
      expect.objectContaining({ serverLabel: "outside", allowedTools: ["outside_lookup"] })]));
    expect(tools).toHaveLength(2);
  });

  // Guard (passes before and after): an undeclared step keeps the unrestricted self-MCP offer.
  it("a step without declarations keeps the unrestricted self-MCP offer", async () => {
    expect(await offeredTools(undefined)).toEqual([self(null)]);
  });

  // Guard (passes before and after): a step that declares no tool is still offered none.
  it("a step that declares no tool is still offered none", async () => {
    expect(await offeredTools({ kind: "declared", tools: [] })).toBeUndefined();
  });

  // red-first-expect: AssertionError: expected [ { type: 'mcp', …(7) } ] to deeply equal [ ObjectContaining{…} ]
  it("an in-admin CMS editor run keeps its own narrower list: never a served tool outside it", async () => {
    const declared = [...SITE_TOOLS, "artifact_get", "drupal_node_update"];
    const tools = await offeredTools({ kind: "declared", tools: declared }, {}, true);
    // artifact_get is served but outside the editor list; drupal_node_update is on the list but not served.
    expect(tools).toEqual([self(["wordpress_site_tool_write", "wordpress_site_tools_list"])]);
    expect(IN_ADMIN_CMS_MCP_ALLOWED_TOOLS).toContain("drupal_node_update");
  });
});
