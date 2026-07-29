/**
 * #1401 — the WayFlow llm-bridge route wires a TRUSTWORTHY actor, derived from
 * the verified run context, into assigned-skill resolution so ownership-scoped
 * (team/org/project/workspace) custom-skill assignments reach agent runs.
 *
 * This suite drives the ROUTE and pins the FORWARDING contract at the route
 * boundary: the route derives the actor by handing the vetted `runForPorts` to
 * `resolveAssignedSkillsActorForRun` (never a caller-supplied id), then passes
 * the result to `getAssignedSkillIdsForAgent`:
 *
 *   - VERIFIED run (real human `runBy` + `orgId`, selected via the run-token or
 *     context-id spine) ⇒ the resolver is called with THAT run and its result
 *     is passed as the 2nd argument (acceptance #1 / #4);
 *   - resolver returns `undefined` (its fail-closed contract — no run, nonmember
 *     owner, worker run, or a build failure) ⇒ the resolver is called
 *     ACTOR-LESS (arity 1), byte-identical to today's delivery (acceptance #2);
 *   - a caller-supplied `body.agent_run_id` alone never promotes a run, so the
 *     resolver is handed `null`.
 *
 * The resolver's OWN gating (live membership, cinatra#408 suppression,
 * fail-closed) is unit-tested in
 * src/lib/__tests__/agent-run-actor-resolve.test.ts. Topology mirrors
 * personal-skill-resolution.test.ts; the personal-delta path is untouched here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  runResolvedSkillAwareDeterministicLlmTaskMock,
  getCustomSkillForCurrentUserAndAgentMock,
  getAssignedSkillIdsForAgentMock,
  resolveAssignedSkillsActorForRunMock,
  resolveAgentRunMcpActorMock,
  clearRunContextMock,
  setRunContextMock,
  getLlmMcpCredentialsMock,
  readAgentRunByContextIdMock,
  readAgentRunByIdMock,
  readAgentRunByTokenHashMock,
  readAgentRunTokenHashByIdMock,
  readAgentTemplateByIdMock,
} = vi.hoisted(() => ({
  runResolvedSkillAwareDeterministicLlmTaskMock: vi.fn(async () => ({
    text: "ok",
    artifacts: [],
  })),
  getCustomSkillForCurrentUserAndAgentMock: vi.fn(async () => null),
  getAssignedSkillIdsForAgentMock: vi.fn(async () => [
    "@cinatra-ai/asset-blog:generate-blog-ideas",
  ]),
  resolveAssignedSkillsActorForRunMock: vi.fn(),
  resolveAgentRunMcpActorMock: vi.fn(async () => null),
  clearRunContextMock: vi.fn(),
  setRunContextMock: vi.fn(),
  getLlmMcpCredentialsMock: vi.fn(
    (): { clientId: string; clientSecret: string } | null => ({
      clientId: "mock-client-id-1",
      clientSecret: "secret",
    }),
  ),
  readAgentRunByContextIdMock: vi.fn(
    async (): Promise<Record<string, unknown> | null> => null,
  ),
  readAgentRunByIdMock: vi.fn(
    async (): Promise<Record<string, unknown> | null> => null,
  ),
  readAgentRunByTokenHashMock: vi.fn(
    async (): Promise<{ id: string; orgId: string; runBy: string | null } | null> =>
      null,
  ),
  readAgentRunTokenHashByIdMock: vi.fn(async (): Promise<string | null> => null),
  readAgentTemplateByIdMock: vi.fn(
    async (): Promise<Record<string, unknown> | null> => null,
  ),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/agent-run-context-registry", () => ({
  setRunContext: setRunContextMock,
  clearRunContext: clearRunContextMock,
}));

vi.mock("@cinatra-ai/llm", () => ({
  runResolvedSkillAwareDeterministicLlmTask: runResolvedSkillAwareDeterministicLlmTaskMock,
  getLlmMcpCredentials: getLlmMcpCredentialsMock,
  resolveConfiguredLlmRuntime: vi.fn(async () => ({
    runtime: { provider: "openai" },
    agentId: "test",
    deterministic: false,
  })),
  createLocalSkillShellTool: vi.fn(() => null),
  openAiModelSupportsShell: (modelId: string) =>
    modelId !== "gpt-5" && modelId !== "gpt-5-mini",
  resolveProviderAdapter: vi.fn(async () => ({})),
  PreferredProviderUnavailableError: class PreferredProviderUnavailableError extends Error {
    requestedProvider: string;
    reason: string;
    constructor(requestedProvider: string, reason: string) {
      super(`Preferred provider ${requestedProvider} unavailable (${reason})`);
      this.requestedProvider = requestedProvider;
      this.reason = reason;
    }
  },
}));

vi.mock("@cinatra-ai/skills", () => ({
  // cinatra#2090 S3: the declared-edge projection the route consults when a
  // co-located bundle probe misses. Null here = "no declared skill edge",
  // which keeps every case in this file on the co-located path.
  resolveDeclaredSkillEdgeForExtensionDir: vi.fn(async () => null),
  getCustomSkillForCurrentUserAndAgent: getCustomSkillForCurrentUserAndAgentMock,
}));

vi.mock("@/lib/agents-store", () => ({
  getAssignedSkillIdsForAgent: getAssignedSkillIdsForAgentMock,
}));

// The route sources BOTH the assigned-skills resolver and the MCP-actor
// resolver from this module. Mock both; the resolver's internal gating is
// unit-tested in agent-run-actor-resolve.test.ts.
vi.mock("@/lib/agent-run-actor-resolve", () => ({
  resolveAssignedSkillsActorForRun: resolveAssignedSkillsActorForRunMock,
  resolveAgentRunMcpActor: resolveAgentRunMcpActorMock,
}));

vi.mock("@cinatra-ai/agents", async () => {
  const { z } = await import("zod");
  return {
    readAgentRunByContextId: readAgentRunByContextIdMock,
    readAgentRunById: readAgentRunByIdMock,
    readAgentRunByTokenHash: readAgentRunByTokenHashMock,
    readAgentRunTokenHashById: readAgentRunTokenHashByIdMock,
    readAgentTemplateById: readAgentTemplateByIdMock,
    canProviderSatisfyCapability: (provider: string, capability: string): boolean => {
      switch (capability) {
        case "media_input":
          return provider === "gemini";
        case "function_tools":
          return provider === "openai" || provider === "anthropic" || provider === "gemini";
        case "native_mcp":
          return provider === "openai" || provider === "anthropic";
        default:
          return false;
      }
    },
    describeCapabilityRequirement: (): string => "cap",
    OasCinatraLlmSchema: z
      .object({
        preferredProvider: z.enum(["openai", "anthropic", "gemini"]).optional(),
        preferredModel: z.string().min(1).optional(),
        capabilityRequired: z
          .enum(["media_input", "function_tools", "native_mcp"])
          .optional(),
      })
      .strict()
      .optional(),
    LLM_PROVIDERS: ["openai", "anthropic", "gemini"] as const,
    LLM_CAPABILITIES: ["media_input", "function_tools", "native_mcp"] as const,
    ALLOWED_MODEL_IDS: {
      openai: ["gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini"],
      anthropic: [
        "claude-sonnet-4-6",
        "claude-opus-4-7",
        "claude-3-7-sonnet-latest",
        "claude-3-5-haiku-latest",
      ],
      gemini: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite", "gemini-1.5-pro"],
    },
  };
});

vi.mock("@/lib/a2a-auth", () => ({
  verifyLangGraphBridgeToken: vi.fn(async () => ({
    ok: false,
    response: new Response("forbidden", { status: 403 }),
  })),
}));

let POST: (req: Request) => Promise<Response>;

// The membership-expanded actor the resolver returns for a verified, in-scope run.
const SCOPED_ACTOR = {
  principalType: "HumanUser" as const,
  principalId: "user-1",
  organizationId: "org-1",
  teamIds: ["team-1"],
  projectIds: ["proj-1"],
  platformRole: "member" as const,
  authSource: "a2a" as const,
  policyVersion: "v2",
};

// A verified, human-owned run.
const VERIFIED_RUN = {
  id: "run-1",
  orgId: "org-1",
  runBy: "user-1",
  sourceType: null,
  templateId: "tpl-1",
  projectId: null,
  dependentInstallId: "inst-7",
};
const PROBE = { id: VERIFIED_RUN.id, orgId: VERIFIED_RUN.orgId, runBy: VERIFIED_RUN.runBy };
const RUN_TOKEN = "raw-run-token-xyz";

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.CINATRA_BRIDGE_TOKEN = "test-token-32chars-XYZXYZXYZXYZ";
  process.env.BETTER_AUTH_SECRET = "test-better-auth-secret-for-assigned-skill";
  const mod = await import("../route");
  POST = mod.POST;
  getLlmMcpCredentialsMock.mockReturnValue({
    clientId: "mock-client-id-1",
    clientSecret: "secret",
  });
  runResolvedSkillAwareDeterministicLlmTaskMock.mockResolvedValue({ text: "ok", artifacts: [] });
  getCustomSkillForCurrentUserAndAgentMock.mockResolvedValue(null);
  getAssignedSkillIdsForAgentMock.mockResolvedValue([
    "@cinatra-ai/asset-blog:generate-blog-ideas",
  ]);
  // Default: fail-closed (actor-less). Verified-run tests opt in to an actor.
  resolveAssignedSkillsActorForRunMock.mockResolvedValue(undefined);
  resolveAgentRunMcpActorMock.mockResolvedValue(null);
  readAgentRunByContextIdMock.mockResolvedValue(null);
  readAgentRunByIdMock.mockResolvedValue(null);
  readAgentRunByTokenHashMock.mockResolvedValue(null);
  readAgentRunTokenHashByIdMock.mockResolvedValue(null);
  readAgentTemplateByIdMock.mockResolvedValue(null);
});

function makeRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/llm-bridge", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cinatra-bridge-token": "test-token-32chars-XYZXYZXYZXYZ",
    },
    body: JSON.stringify(body),
  });
}
function makeRequestH(body: unknown, headers: Record<string, string>): Request {
  return new Request("http://localhost:3000/api/llm-bridge", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cinatra-bridge-token": "test-token-32chars-XYZXYZXYZXYZ",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/** The recorded argument list of the first getAssignedSkillIdsForAgent call. */
function firstAssignedCall(): unknown[] {
  const calls = getAssignedSkillIdsForAgentMock.mock.calls as unknown[][];
  if (calls.length === 0) throw new Error("getAssignedSkillIdsForAgent was not called");
  return calls[0];
}

describe("/api/llm-bridge assigned-skills actor wiring (#1401) — VERIFIED run", () => {
  it("hands the vetted run to the resolver and forwards its actor (token-first channel)", async () => {
    readAgentRunByTokenHashMock.mockResolvedValue(PROBE);
    readAgentRunByIdMock.mockResolvedValue(VERIFIED_RUN);
    resolveAssignedSkillsActorForRunMock.mockResolvedValue(SCOPED_ACTOR);
    await POST(makeRequestH({ user: "hi", agent_id: "agent-x" }, { "x-cinatra-run-token": RUN_TOKEN }));

    // The resolver receives the VETTED run (not a caller-supplied id) — #4.
    expect(resolveAssignedSkillsActorForRunMock).toHaveBeenCalledOnce();
    expect(resolveAssignedSkillsActorForRunMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "run-1", runBy: "user-1", orgId: "org-1" }),
    );
    // Its actor is passed to the resolver as the 2nd argument.
    expect(firstAssignedCall()).toEqual(["agent-x", SCOPED_ACTOR]);
  });

  it("also wires the actor when the run is selected via the context-id channel", async () => {
    readAgentRunByContextIdMock.mockResolvedValue(VERIFIED_RUN);
    resolveAssignedSkillsActorForRunMock.mockResolvedValue(SCOPED_ACTOR);
    await POST(makeRequestH({ user: "hi", agent_id: "agent-x" }, { "x-cinatra-a2a-context-id": "ctx-1" }));
    expect(resolveAssignedSkillsActorForRunMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "run-1", runBy: "user-1" }),
    );
    expect(firstAssignedCall()).toEqual(["agent-x", SCOPED_ACTOR]);
  });
});

describe("/api/llm-bridge assigned-skills actor wiring (#1401) — fail-closed / actor-less", () => {
  it("resolver returns undefined (fail-closed) ⇒ resolver called ACTOR-LESS (arity 1)", async () => {
    readAgentRunByTokenHashMock.mockResolvedValue(PROBE);
    readAgentRunByIdMock.mockResolvedValue(VERIFIED_RUN);
    resolveAssignedSkillsActorForRunMock.mockResolvedValue(undefined); // e.g. nonmember / build failure
    await POST(makeRequestH({ user: "hi", agent_id: "agent-x" }, { "x-cinatra-run-token": RUN_TOKEN }));
    expect(resolveAssignedSkillsActorForRunMock).toHaveBeenCalledOnce();
    expect(firstAssignedCall()).toEqual(["agent-x"]);
  });

  it("ABSENT run ⇒ resolver handed null, delivery is ACTOR-LESS (regression pin)", async () => {
    await POST(makeRequest({ user: "hi", agent_id: "agent-x" }));
    // cinatra#2091 S4: with NO server-verified run owner the contract does not
    // even ask for a scope-aware actor — the assignment resolves actor-less
    // (arity 1), which is the SAME delivery this pinned, reached one step
    // earlier and strictly more fail-closed.
    expect(resolveAssignedSkillsActorForRunMock).not.toHaveBeenCalled();
    expect(firstAssignedCall()).toEqual(["agent-x"]);
  });

  it("a caller-supplied body.agent_run_id alone never promotes a run (resolver handed null)", async () => {
    readAgentRunByIdMock.mockResolvedValue(VERIFIED_RUN); // would resolve IF the route read a body id
    await POST(makeRequest({ user: "hi", agent_id: "agent-x", agent_run_id: VERIFIED_RUN.id }));
    expect(readAgentRunByIdMock).not.toHaveBeenCalled();
    // cinatra#2091 S4: with NO server-verified run owner the contract does not
    // even ask for a scope-aware actor — the assignment resolves actor-less
    // (arity 1), which is the SAME delivery this pinned, reached one step
    // earlier and strictly more fail-closed.
    expect(resolveAssignedSkillsActorForRunMock).not.toHaveBeenCalled();
    expect(firstAssignedCall()).toEqual(["agent-x"]);
  });

  it("forged/unresolvable run token (suppresses a co-present context-id) ⇒ resolver handed null", async () => {
    readAgentRunByTokenHashMock.mockResolvedValue(null); // unresolvable
    readAgentRunByContextIdMock.mockResolvedValue(VERIFIED_RUN); // would resolve
    await POST(
      makeRequestH(
        { user: "hi", agent_id: "agent-x" },
        { "x-cinatra-run-token": "garbage", "x-cinatra-a2a-context-id": "ctx-1" },
      ),
    );
    // cinatra#2091 S4: with NO server-verified run owner the contract does not
    // even ask for a scope-aware actor — the assignment resolves actor-less
    // (arity 1), which is the SAME delivery this pinned, reached one step
    // earlier and strictly more fail-closed.
    expect(resolveAssignedSkillsActorForRunMock).not.toHaveBeenCalled();
    expect(firstAssignedCall()).toEqual(["agent-x"]);
  });

  it("does NOT resolve assigned skills (or derive an actor) when agent_id is omitted", async () => {
    readAgentRunByTokenHashMock.mockResolvedValue(PROBE);
    readAgentRunByIdMock.mockResolvedValue(VERIFIED_RUN);
    await POST(makeRequestH({ user: "hi" }, { "x-cinatra-run-token": RUN_TOKEN }));
    expect(getAssignedSkillIdsForAgentMock).not.toHaveBeenCalled();
    expect(resolveAssignedSkillsActorForRunMock).not.toHaveBeenCalled();
  });
});
