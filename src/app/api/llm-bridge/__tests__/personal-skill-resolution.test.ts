/**
 * Personal delta-skill delivery through the WayFlow llm-bridge route.
 *
 * #1360 — the personal delta skill is USER-SCOPED. Its owner is derived SOLELY
 * from the TRUSTED resolved run context (`runForPorts.runBy` — the same run the
 * route vetted to mint the user's MCP OBO actor token), never from a
 * caller-supplied identifier. This suite exercises the fail-closed contract at
 * the ROUTE boundary by making the `getCustomSkillForCurrentUserAndAgent` mock
 * FAITHFUL to the real resolver: it returns content only when a truthy
 * `ownerUserId` is passed and otherwise THROWS (mirroring
 * personal-skills.ts:143-157). The route's `.catch(() => null)` then turns an
 * unattributable call into "no personal delta", which is exactly the behaviour
 * under test:
 *   - a verified run bound to a user delivers that user's delta;
 *   - an absent run token delivers NO personal delta (no error noise);
 *   - a forged / unresolvable token is refused (and suppresses a co-present
 *     context-id — fail closed);
 *   - a token/context-id divergence is refused;
 *   - org/shared skill delivery (`getAssignedSkillIdsForAgent`) is unchanged.
 *
 * Also includes a clearRunContext-in-finally regression-lock test: when the
 * personal-skill lookup throws, the route's finally block must still call
 * clearRunContext.
 *
 * Mock topology mirrors run-context-wiring.test.ts / run-binding-mcp-actor.test.ts:
 * vi.hoisted handles, vi.mock without importOriginal, dynamic import("../route")
 * in beforeEach, and CINATRA_BRIDGE_TOKEN test fixture for auth. The real
 * `@/lib/agent-run-token` module is used (verifyRunToken is pure sha256) and
 * driven via the `readAgentRunByTokenHash` mock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const PERSONAL_DELTA = "PERSONAL-DELTA-WAYFLOW-XYZ";

const {
  runResolvedSkillAwareDeterministicLlmTaskMock,
  getCustomSkillForCurrentUserAndAgentMock,
  getAssignedSkillIdsForAgentMock,
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
  // Owner-FAITHFUL: content only when a truthy ownerUserId is supplied,
  // otherwise throw — mirroring the real resolver's "ownerUserId is required".
  getCustomSkillForCurrentUserAndAgentMock: vi.fn<
    (
      agentId: string,
      ownerUserId?: string,
    ) => Promise<{ id: string; name: string; description: string; content: string; level: "personal"; scope: string } | null>
  >(async (_agentId: string, ownerUserId?: string) => {
    if (!ownerUserId) {
      throw new Error(
        "getCustomSkillForCurrentUserAndAgent: ownerUserId is required.",
      );
    }
    return {
      id: "p1",
      name: "P",
      description: "D",
      content: PERSONAL_DELTA,
      level: "personal" as const,
      scope: "user",
    };
  }),
  getAssignedSkillIdsForAgentMock: vi.fn(async (_agentId: string) => [
    "@cinatra-ai/asset-blog:generate-blog-ideas",
  ]),
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
  // Real predicate shape: only base gpt-5 / gpt-5-mini lack hosted shell.
  openAiModelSupportsShell: (modelId: string) => modelId !== "gpt-5" && modelId !== "gpt-5-mini",
  // Bridge route imports this for cinatra_llm dispatch.
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
  getCustomSkillForCurrentUserAndAgent: getCustomSkillForCurrentUserAndAgentMock,
  // A3 (cinatra#1363): faithful copy of the real runtime-delivery predicate
  // (the real one is drift-guarded by the skills-package matrix test).
  isRuntimeDeliverableLifecycleState: (s: string | null | undefined) =>
    s === null ? true : s === undefined ? false : s === "active" || s === "deprecated",
}));

// A3 (cinatra#1363): the personal-delta lifecycle gate reads lifecycle_state via
// @/lib/database — the route's ONLY direct import from it. Default: every id is
// 'active' (deliverable), so the verified-run delta is delivered as before; the
// archived-block test reassigns this to prove the fail-closed withhold.
type PersonalLifecycleResult =
  | { ok: true; states: Map<string, string | null> }
  | { ok: false };
const defaultPersonalLifecycleReader = (ids: string[]): PersonalLifecycleResult => ({
  ok: true,
  states: new Map(ids.map((id) => [id, "active" as string | null])),
});
let personalLifecycleReader: (ids: string[]) => PersonalLifecycleResult = defaultPersonalLifecycleReader;
vi.mock("@/lib/database", () => ({
  readSkillLifecycleStates: (ids: string[]) => personalLifecycleReader(ids),
}));

vi.mock("@/lib/agents-store", () => ({
  getAssignedSkillIdsForAgent: getAssignedSkillIdsForAgentMock,
}));

// Route imports OasCinatraLlmSchema + ALLOWED_MODEL_IDS + the run reads used by
// the token-first / context-id run-selection spine (#1193 W3).
vi.mock("@cinatra-ai/agents", async () => {
  const { z } = await import("zod");
  return {
    readAgentRunByContextId: readAgentRunByContextIdMock,
    readAgentRunById: readAgentRunByIdMock,
    readAgentRunByTokenHash: readAgentRunByTokenHashMock,
    readAgentRunTokenHashById: readAgentRunTokenHashByIdMock,
    readAgentTemplateById: readAgentTemplateByIdMock,
    // Capability-matrix helpers consumed by _llm-dispatch.ts (engineering#417).
    // Pure mirrors of llm-provider-policy.ts so the dispatch capability gate +
    // actionable 503 message resolve without the heavy real barrel.
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
    describeCapabilityRequirement: (
      capability: string,
      opts?: { incompatibleProvider?: string },
    ): string => {
      const providers = (["openai", "anthropic", "gemini"] as const).filter((p) => {
        switch (capability) {
          case "media_input":
            return p === "gemini";
          case "function_tools":
            return true;
          case "native_mcp":
            return p === "openai" || p === "anthropic";
          default:
            return false;
        }
      });
      const options = providers.join(", ");
      if (opts?.incompatibleProvider) {
        return (
          `This agent requires the "${capability}" LLM capability, but the active ` +
          `provider "${opts.incompatibleProvider}" cannot satisfy it. Install and ` +
          `configure an LLM connector for one of these providers instead: ${options}.`
        );
      }
      return (
        `This agent requires the "${capability}" LLM capability, but no installed ` +
        `and configured LLM provider supports it. Install and configure an LLM ` +
        `connector for one of these providers: ${options}.`
      );
    },
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
      gemini: [
        "gemini-2.5-flash",
        "gemini-2.5-pro",
        "gemini-2.5-flash-lite",
        "gemini-1.5-pro",
      ],
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

// The honest, user-attributable run. `runBy` is the verified owner whose
// personal delta must be delivered.
const VERIFIED_RUN = {
  id: "run-1",
  orgId: "org-1",
  runBy: "user-1",
  sourceType: null,
  templateId: "tpl-1",
  projectId: null,
};
// A different run — used to prove a token/context-id divergence is refused.
const OTHER_RUN = {
  id: "run-2",
  orgId: "org-2",
  runBy: "user-2",
  sourceType: null,
  templateId: "tpl-2",
  projectId: null,
};
// Probe row (unique-index shape) the run-token verifier returns before the
// full re-read; must agree with VERIFIED_RUN's identity tuple.
const PROBE = { id: VERIFIED_RUN.id, orgId: VERIFIED_RUN.orgId, runBy: VERIFIED_RUN.runBy };
const RUN_TOKEN = "raw-run-token-xyz";

afterEach(() => {
  // env hygiene — cleared so other test files start from a known state
});

beforeEach(async () => {
  vi.clearAllMocks();
  // Bridge-token fixture for authenticated bridge requests.
  process.env.CINATRA_BRIDGE_TOKEN = "test-token-32chars-XYZXYZXYZXYZ";
  // Run-token hashing is pure sha256, but keep binding secrets deterministic.
  process.env.BETTER_AUTH_SECRET = "test-better-auth-secret-for-personal-skill";
  const mod = await import("../route");
  POST = mod.POST;
  // Restore defaults after vi.clearAllMocks resets implementations.
  getLlmMcpCredentialsMock.mockReturnValue({
    clientId: "mock-client-id-1",
    clientSecret: "secret",
  });
  runResolvedSkillAwareDeterministicLlmTaskMock.mockResolvedValue({
    text: "ok",
    artifacts: [],
  });
  // Owner-faithful default: deliver ONLY when a truthy owner is passed.
  getCustomSkillForCurrentUserAndAgentMock.mockImplementation(
    async (_agentId: string, ownerUserId?: string) => {
      if (!ownerUserId) {
        throw new Error(
          "getCustomSkillForCurrentUserAndAgent: ownerUserId is required.",
        );
      }
      return {
        id: "p1",
        name: "P",
        description: "D",
        content: PERSONAL_DELTA,
        level: "personal" as const,
        scope: "user",
      };
    },
  );
  getAssignedSkillIdsForAgentMock.mockResolvedValue([
    "@cinatra-ai/asset-blog:generate-blog-ideas",
  ]);
  // No run resolves by default (unattributable) unless a test opts in.
  readAgentRunByContextIdMock.mockResolvedValue(null);
  readAgentRunByIdMock.mockResolvedValue(null);
  readAgentRunByTokenHashMock.mockResolvedValue(null);
  readAgentRunTokenHashByIdMock.mockResolvedValue(null);
  readAgentTemplateByIdMock.mockResolvedValue(null);
});

/** Read the first argument of the first call to the LLM task mock. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function firstCallArg(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const calls = runResolvedSkillAwareDeterministicLlmTaskMock.mock.calls as any[][];
  if (calls.length === 0) {
    throw new Error("runResolvedSkillAwareDeterministicLlmTask was not called");
  }
  return calls[0]?.[0];
}

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

/** Request variant that carries loader-injected internal run-selection headers. */
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

describe("/api/llm-bridge personal delta-skill identity (#1360)", () => {
  it("VERIFIED run (token-first): delivers the run owner's personal delta, keyed on the verified runBy", async () => {
    readAgentRunByTokenHashMock.mockResolvedValue(PROBE);
    readAgentRunByIdMock.mockResolvedValue(VERIFIED_RUN);
    const req = makeRequestH(
      { user: "hi", agent_id: "agent-x" },
      { "x-cinatra-run-token": RUN_TOKEN },
    );
    await POST(req);
    // Identity comes ONLY from the verified run context (runBy), not the caller.
    expect(getCustomSkillForCurrentUserAndAgentMock).toHaveBeenCalledWith(
      "agent-x",
      VERIFIED_RUN.runBy,
    );
    expect(firstCallArg().customSkillContent).toBe(PERSONAL_DELTA);
  });

  it("VERIFIED run (context-id channel): delivers the run owner's personal delta", async () => {
    readAgentRunByContextIdMock.mockResolvedValue(VERIFIED_RUN);
    const req = makeRequestH(
      { user: "hi", agent_id: "agent-x" },
      { "x-cinatra-a2a-context-id": "ctx-1" },
    );
    await POST(req);
    expect(getCustomSkillForCurrentUserAndAgentMock).toHaveBeenCalledWith(
      "agent-x",
      VERIFIED_RUN.runBy,
    );
    expect(firstCallArg().customSkillContent).toBe(PERSONAL_DELTA);
  });

  it("A3 (cinatra#1363): an ARCHIVED personal delta is WITHHELD from delivery (fail-closed), even for the verified owner", async () => {
    // The resolver still returns the owner's personal skill, but lifecycle_state
    // = archived ⇒ the bridge gate drops it before provider delivery.
    personalLifecycleReader = (ids) => ({
      ok: true,
      states: new Map(ids.map((id) => [id, id === "p1" ? "archived" : "active"])),
    });
    try {
      readAgentRunByTokenHashMock.mockResolvedValue(PROBE);
      readAgentRunByIdMock.mockResolvedValue(VERIFIED_RUN);
      const req = makeRequestH(
        { user: "hi", agent_id: "agent-x" },
        { "x-cinatra-run-token": RUN_TOKEN },
      );
      await POST(req);
      // Owner identity WAS resolved (resolver invoked with the verified runBy),
      // but the archived delta is NOT delivered to the provider.
      expect(getCustomSkillForCurrentUserAndAgentMock).toHaveBeenCalledWith(
        "agent-x",
        VERIFIED_RUN.runBy,
      );
      expect(firstCallArg().customSkillContent).toBeUndefined();
    } finally {
      personalLifecycleReader = defaultPersonalLifecycleReader;
    }
  });

  it("ABSENT run: no verified identity ⇒ NO personal delta (owner undefined, resolver fails closed)", async () => {
    // No run token, no context-id → runForPorts is null → owner undefined.
    const req = makeRequest({ user: "hi", agent_id: "agent-x" });
    await POST(req);
    expect(getCustomSkillForCurrentUserAndAgentMock).toHaveBeenCalledWith(
      "agent-x",
      undefined,
    );
    expect(firstCallArg().customSkillContent).toBeUndefined();
  });

  it("FORGED/unresolvable run token: refused, and it SUPPRESSES a co-present context-id (fail closed)", async () => {
    // A non-empty token that hashes to no row is tampering: it must NOT downgrade
    // to the weaker context-id selector, even though the context-id WOULD resolve.
    readAgentRunByTokenHashMock.mockResolvedValue(null); // unresolvable
    readAgentRunByContextIdMock.mockResolvedValue(VERIFIED_RUN); // would resolve
    const req = makeRequestH(
      { user: "hi", agent_id: "agent-x" },
      {
        "x-cinatra-run-token": "garbage-token",
        "x-cinatra-a2a-context-id": "ctx-1",
      },
    );
    await POST(req);
    expect(getCustomSkillForCurrentUserAndAgentMock).toHaveBeenCalledWith(
      "agent-x",
      undefined,
    );
    expect(firstCallArg().customSkillContent).toBeUndefined();
  });

  it("MISMATCH: token selects one run but a co-present context-id names a DIFFERENT run ⇒ refused (no personal delta)", async () => {
    readAgentRunByTokenHashMock.mockResolvedValue(PROBE); // token → run-1
    readAgentRunByIdMock.mockResolvedValue(VERIFIED_RUN);
    readAgentRunByContextIdMock.mockResolvedValue(OTHER_RUN); // context-id → run-2
    const req = makeRequestH(
      { user: "hi", agent_id: "agent-x" },
      {
        "x-cinatra-run-token": RUN_TOKEN,
        "x-cinatra-a2a-context-id": "ctx-2",
      },
    );
    await POST(req);
    // Divergence nulls runForPorts → owner undefined → no personal delta.
    expect(getCustomSkillForCurrentUserAndAgentMock).toHaveBeenCalledWith(
      "agent-x",
      undefined,
    );
    expect(firstCallArg().customSkillContent).toBeUndefined();
  });

  it("MISMATCH: token probe resolves but the fresh re-read row DIVERGES (orgId changed) ⇒ refused", async () => {
    readAgentRunByTokenHashMock.mockResolvedValue(PROBE);
    readAgentRunByIdMock.mockResolvedValue({ ...VERIFIED_RUN, orgId: "org-changed" });
    const req = makeRequestH(
      { user: "hi", agent_id: "agent-x" },
      { "x-cinatra-run-token": RUN_TOKEN },
    );
    await POST(req);
    expect(getCustomSkillForCurrentUserAndAgentMock).toHaveBeenCalledWith(
      "agent-x",
      undefined,
    );
    expect(firstCallArg().customSkillContent).toBeUndefined();
  });

  it("a forged body.agent_run_id can NEVER select the owner (only a verified run can)", async () => {
    // body.agent_run_id is caller-controlled; with no verified run it must not
    // promote any identity. readAgentRunById must never be called from a body id.
    readAgentRunByIdMock.mockResolvedValue(VERIFIED_RUN); // would resolve IF called
    const req = makeRequest({ user: "hi", agent_id: "agent-x", agent_run_id: VERIFIED_RUN.id });
    await POST(req);
    expect(readAgentRunByIdMock).not.toHaveBeenCalled();
    expect(getCustomSkillForCurrentUserAndAgentMock).toHaveBeenCalledWith(
      "agent-x",
      undefined,
    );
    expect(firstCallArg().customSkillContent).toBeUndefined();
  });
});

describe("/api/llm-bridge org/shared skill delivery is unchanged (#1360)", () => {
  it("forwards assigned skillIds resolved from agent_id (verified run present)", async () => {
    readAgentRunByTokenHashMock.mockResolvedValue(PROBE);
    readAgentRunByIdMock.mockResolvedValue(VERIFIED_RUN);
    const req = makeRequestH(
      { user: "hi", agent_id: "agent-x" },
      { "x-cinatra-run-token": RUN_TOKEN },
    );
    await POST(req);
    expect(getAssignedSkillIdsForAgentMock).toHaveBeenCalledOnce();
    expect(getAssignedSkillIdsForAgentMock).toHaveBeenCalledWith("agent-x");
    expect(firstCallArg().skillIds).toEqual(["@cinatra-ai/asset-blog:generate-blog-ideas"]);
  });

  it("delivers org/shared skillIds even when NO personal delta applies (unattributable run)", async () => {
    // The org/shared path is agent-scoped, not user-scoped: it is delivered
    // byte-identically regardless of whether a personal owner resolved.
    const req = makeRequest({ user: "hi", agent_id: "agent-x" });
    await POST(req);
    expect(getAssignedSkillIdsForAgentMock).toHaveBeenCalledWith("agent-x");
    expect(firstCallArg().skillIds).toEqual(["@cinatra-ai/asset-blog:generate-blog-ideas"]);
    expect(firstCallArg().customSkillContent).toBeUndefined();
  });

  it("does NOT call personal-skill or skill-id resolvers when agent_id is omitted", async () => {
    const req = makeRequest({ user: "hi" });
    await POST(req);
    expect(getCustomSkillForCurrentUserAndAgentMock).not.toHaveBeenCalled();
    expect(getAssignedSkillIdsForAgentMock).not.toHaveBeenCalled();
    expect(firstCallArg().skillIds).toEqual([]);
    expect(firstCallArg().customSkillContent).toBeUndefined();
  });
});

describe("/api/llm-bridge personal skill resolution — resolver-null + cleanup", () => {
  it("forwards customSkillContent === undefined when the resolver returns null for a verified owner", async () => {
    readAgentRunByTokenHashMock.mockResolvedValue(PROBE);
    readAgentRunByIdMock.mockResolvedValue(VERIFIED_RUN);
    // Verified owner, but no personal skill exists for this (owner, agent).
    getCustomSkillForCurrentUserAndAgentMock.mockResolvedValueOnce(null);
    const req = makeRequestH(
      { user: "hi", agent_id: "agent-x" },
      { "x-cinatra-run-token": RUN_TOKEN },
    );
    await POST(req);
    expect(firstCallArg().customSkillContent).toBeUndefined();
  });

  it("clearRunContext still runs in finally even if the personal-skill lookup throws", async () => {
    // Regression lock: the personal-skill lookup must be INSIDE the try block
    // (with the LLM task) so the finally always calls clearRunContext, even when
    // the lookup fails before the LLM task runs.
    getCustomSkillForCurrentUserAndAgentMock.mockRejectedValueOnce(
      new Error("personal-skill lookup failed"),
    );
    const req = makeRequest({
      user: "hi",
      agent_run_id: "run-X",
      agent_id: "agent-x",
    });
    await POST(req);
    expect(clearRunContextMock).toHaveBeenCalledOnce();
  });
});
