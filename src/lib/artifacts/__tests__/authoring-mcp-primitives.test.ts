/**
 * Artifact authoring MCP handler behavior tests.
 *
 * These tests exercise the actual handler bodies:
 *   - parentStepId is not accepted from tool input and is stripped before
 *     authorArtifact() receives the request.
 *   - runId is pulled from mcpRequestContextStorage and threaded through.
 *   - structured errors carry `error.reason` for the chat to branch on.
 *
 *   npx vitest run src/lib/artifacts/__tests__/authoring-mcp-primitives.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  authorArtifactMock,
  searchArtifactExtensionsMock,
  getArtifactExtensionMock,
  getAuthoringChainMock,
  ctxRunIdHolder,
} = vi.hoisted(() => ({
  authorArtifactMock: vi.fn(),
  searchArtifactExtensionsMock: vi.fn(),
  getArtifactExtensionMock: vi.fn(),
  getAuthoringChainMock: vi.fn(),
  ctxRunIdHolder: { runId: undefined as string | undefined },
}));

vi.mock("../artifact-authoring", () => ({
  authorArtifact: authorArtifactMock,
  searchArtifactExtensions: searchArtifactExtensionsMock,
  getArtifactExtension: getArtifactExtensionMock,
}));
vi.mock("../authoring-recursion-ledger", () => ({
  getAuthoringChain: getAuthoringChainMock,
}));
vi.mock("../artifact-service", () => ({
  listArtifacts: vi.fn(),
  getArtifact: vi.fn(),
  tombstoneArtifact: vi.fn(),
}));
vi.mock("../semantic-assertion-store", () => ({
  listEligibleAssertions: vi.fn(),
  listActiveAssertions: vi.fn(),
  getAssertionByIdForReplay: vi.fn(),
}));
vi.mock("../representation-store", () => ({
  listRepresentations: vi.fn(),
  getLatestRepresentation: vi.fn(),
  getRepresentationByIdForReplay: vi.fn(),
}));
vi.mock("@/lib/sealed-room", () => ({
  assertProjectReadAccess: vi.fn(),
}));
vi.mock("@/lib/authz/build-actor-context", () => ({
  buildActorContextFromPrimitive: () => ({
    principalType: "HumanUser",
    principalId: "user-1",
    organizationId: "org-a",
    teamIds: [],
    projectIds: [],
    authSource: "ui",
    policyVersion: "v2",
  }),
}));
vi.mock("@cinatra-ai/mcp-server", () => ({
  mcpRequestContextStorage: {
    getStore: () => ({
      orgId: "org-a",
      userId: "user-1",
      runId: ctxRunIdHolder.runId,
    }),
  },
}));

import { registerArtifactPrimitives } from "../mcp";

type Tool = {
  name: string;
  handler: (input: unknown) => Promise<unknown>;
};

function captureTools(): { tools: Tool[]; server: { registerTool: unknown } } {
  const tools: Tool[] = [];
  const server = {
    registerTool: (name: string, _meta: unknown, handler: Tool["handler"]) => {
      tools.push({ name, handler });
    },
  };
  return { tools, server };
}

function findTool(tools: Tool[], name: string): Tool {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
}

function parseEnvelope(raw: unknown): Record<string, unknown> {
  const env = raw as { structuredContent?: Record<string, unknown> };
  return env.structuredContent ?? {};
}

describe("artifact_authoring_emit handler behavior", () => {
  beforeEach(() => {
    authorArtifactMock.mockReset();
    searchArtifactExtensionsMock.mockReset();
    getArtifactExtensionMock.mockReset();
    getAuthoringChainMock.mockReset();
    ctxRunIdHolder.runId = undefined;
  });

  it("rejects parentStepId as an input (not in zod schema)", async () => {
    const { tools, server } = captureTools();
    registerArtifactPrimitives(server as never);
    const tool = findTool(tools, "artifact_authoring_emit");
    authorArtifactMock.mockResolvedValue({
      ok: true,
      artifactId: "art-1",
      representationRevisionId: "rep-1",
      depth: 0,
      authoringStepId: "aut_root",
    });
    // Pass an LLM-supplied parentStepId. Zod's `.strict()` is not
    // applied, so `.parse` silently strips unknown keys and the field
    // is discarded. The key assertion is that authorArtifact() receives
    // parentStepId: null regardless of what the input contained.
    await tool.handler({
      extension: "@cinatra-ai/marketing-icp-artifact",
      content: "x",
      declaredMime: "text/markdown",
      title: "Smuggle Test",
      parentStepId: "aut_SPOOFED_BY_MODEL",
    });
    expect(authorArtifactMock).toHaveBeenCalledTimes(1);
    const call = authorArtifactMock.mock.calls[0][0];
    expect(call.parentStepId).toBeNull();
    expect(call.parentStepId).not.toBe("aut_SPOOFED_BY_MODEL");
  });

  it("propagates runId from request context to service", async () => {
    ctxRunIdHolder.runId = "run_xyz";
    const { tools, server } = captureTools();
    registerArtifactPrimitives(server as never);
    const tool = findTool(tools, "artifact_authoring_emit");
    authorArtifactMock.mockResolvedValue({
      ok: true,
      artifactId: "art-1",
      representationRevisionId: "rep-1",
      depth: 0,
      authoringStepId: "aut_root",
    });
    await tool.handler({
      extension: "@cinatra-ai/marketing-icp-artifact",
      content: "x",
      declaredMime: "text/markdown",
      title: "Run Provenance",
    });
    expect(authorArtifactMock.mock.calls[0][0].runId).toBe("run_xyz");
  });

  it("runId is null when context has no runId (chat-skill direct path)", async () => {
    ctxRunIdHolder.runId = undefined;
    const { tools, server } = captureTools();
    registerArtifactPrimitives(server as never);
    const tool = findTool(tools, "artifact_authoring_emit");
    authorArtifactMock.mockResolvedValue({
      ok: true,
      artifactId: "art-1",
      representationRevisionId: "rep-1",
      depth: 0,
      authoringStepId: "aut_root",
    });
    await tool.handler({
      extension: "@cinatra-ai/marketing-icp-artifact",
      content: "x",
      declaredMime: "text/markdown",
      title: "Chat Direct",
    });
    expect(authorArtifactMock.mock.calls[0][0].runId).toBeNull();
  });

  it("structured rejection surfaces as error with .reason + .detail", async () => {
    const { tools, server } = captureTools();
    registerArtifactPrimitives(server as never);
    const tool = findTool(tools, "artifact_authoring_emit");
    authorArtifactMock.mockResolvedValue({
      ok: false,
      reason: "cycle",
      message: "cycle detected",
      detail: "marketing-icp already in chain",
    });
    await expect(
      tool.handler({
        extension: "@cinatra-ai/marketing-icp-artifact",
        content: "x",
        declaredMime: "text/markdown",
        title: "X",
      }),
    ).rejects.toMatchObject({
      message: "cycle detected",
      reason: "cycle",
      detail: "marketing-icp already in chain",
    });
  });

  it("happy path returns envelope with artifactId + depth + authoringStepId", async () => {
    const { tools, server } = captureTools();
    registerArtifactPrimitives(server as never);
    const tool = findTool(tools, "artifact_authoring_emit");
    authorArtifactMock.mockResolvedValue({
      ok: true,
      artifactId: "art-x",
      representationRevisionId: "rep-x",
      depth: 0,
      authoringStepId: "aut_root",
    });
    const raw = await tool.handler({
      extension: "@cinatra-ai/marketing-icp-artifact",
      content: "x",
      declaredMime: "text/markdown",
      title: "X",
    });
    const env = parseEnvelope(raw);
    expect(env).toMatchObject({
      artifactId: "art-x",
      representationRevisionId: "rep-x",
      depth: 0,
      authoringStepId: "aut_root",
    });
  });
});

describe("artifact_extension_search handler", () => {
  beforeEach(() => {
    authorArtifactMock.mockReset();
    searchArtifactExtensionsMock.mockReset();
    getArtifactExtensionMock.mockReset();
  });

  it("returns the search results in an envelope", async () => {
    const { tools, server } = captureTools();
    registerArtifactPrimitives(server as never);
    const tool = findTool(tools, "artifact_extension_search");
    searchArtifactExtensionsMock.mockReturnValue([
      {
        packageName: "@cinatra-ai/marketing-icp-artifact",
        label: "marketing-icp",
        acceptedMimes: ["text/markdown"],
        hasAuthoringSkill: true,
        score: 1.0,
      },
    ]);
    const raw = await tool.handler({ query: "icp" });
    const env = parseEnvelope(raw);
    expect(env.results).toBeDefined();
    expect((env.results as unknown[]).length).toBe(1);
  });

  it("validates query is required + non-empty", async () => {
    const { tools, server } = captureTools();
    registerArtifactPrimitives(server as never);
    const tool = findTool(tools, "artifact_extension_search");
    await expect(tool.handler({})).rejects.toThrow();
    await expect(tool.handler({ query: "" })).rejects.toThrow();
  });
});

describe("artifact_extension_get handler", () => {
  beforeEach(() => {
    getArtifactExtensionMock.mockReset();
  });

  it("returns the manifest view when extension installed", async () => {
    const { tools, server } = captureTools();
    registerArtifactPrimitives(server as never);
    const tool = findTool(tools, "artifact_extension_get");
    getArtifactExtensionMock.mockReturnValue({
      packageName: "@cinatra-ai/marketing-icp-artifact",
      label: "marketing-icp",
      acceptedMimes: ["text/markdown"],
      authoringSkillIds: [
        "@cinatra-ai/marketing-icp-artifact:marketing-icp-author",
      ],
      matcherSkillIds: [],
      agentDependencies: [],
    });
    const raw = await tool.handler({
      extension: "@cinatra-ai/marketing-icp-artifact",
    });
    const env = parseEnvelope(raw);
    expect(env.manifest).toBeDefined();
  });

  it("throws on extension not installed", async () => {
    const { tools, server } = captureTools();
    registerArtifactPrimitives(server as never);
    const tool = findTool(tools, "artifact_extension_get");
    getArtifactExtensionMock.mockReturnValue(null);
    await expect(
      tool.handler({ extension: "@cinatra-ai/nope-artifact" }),
    ).rejects.toThrow(/not installed/);
  });
});

describe("artifact_authoring_chain_get handler", () => {
  beforeEach(() => {
    getAuthoringChainMock.mockReset();
  });

  it("returns the chain rows in an envelope", async () => {
    const { tools, server } = captureTools();
    registerArtifactPrimitives(server as never);
    const tool = findTool(tools, "artifact_authoring_chain_get");
    getAuthoringChainMock.mockReturnValue([
      {
        authoringStepId: "aut_root",
        orgId: "org-a",
        parentStepId: null,
        extension: "@cinatra-ai/marketing-icp-artifact",
        depth: 0,
        runId: null,
        status: "committed",
        startedAt: "2026-05-19T10:00:00Z",
        completedAt: "2026-05-19T10:05:00Z",
      },
    ]);
    const raw = await tool.handler({ authoringStepId: "aut_root" });
    const env = parseEnvelope(raw);
    expect((env.chain as unknown[]).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Delegated-chat allowlist gate for artifact authoring MCP primitives.
// ---------------------------------------------------------------------------

describe("delegated-chat allowlist policy", () => {
  it("calls isDelegatedChatMcpToolAllowed() for each new primitive (not source-text grep)", async () => {
    // Exercise the actual policy function so a future deny-token
    // addition that hides the tool fails this test.
    const { isDelegatedChatMcpToolAllowed } = await import(
      "@cinatra-ai/mcp-server/delegated-chat-tool-policy"
    );
    for (const name of [
      "artifact_extension_search",
      "artifact_extension_get",
      "artifact_authoring_emit",
      "artifact_authoring_chain_get",
      "artifacts_get",
    ]) {
      expect(isDelegatedChatMcpToolAllowed(name)).toBe(true);
    }
  });

  it("denies obvious mutators not on the allowlist (sanity gate)", async () => {
    const { isDelegatedChatMcpToolAllowed } = await import(
      "@cinatra-ai/mcp-server/delegated-chat-tool-policy"
    );
    expect(
      isDelegatedChatMcpToolAllowed("artifact_authoring_DELETE"),
    ).toBe(false);
  });
});
