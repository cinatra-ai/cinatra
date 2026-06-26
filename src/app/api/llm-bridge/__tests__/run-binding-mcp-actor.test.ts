/**
 * Regression: the LLM bridge must NOT mint an MCP OBO actor
 * token from a forgeable `body.agent_run_id`. Run selection for OBO minting
 * is only valid via:
 *   - an auth-injected `x-cinatra-a2a-context-id` lookup, OR
 *   - a dispatcher-signed `cinatra_run_binding` whose verified
 *     {runId, orgId, runBy} matches a freshly-read `agent_runs` row.
 *
 * CRITICAL: unlike the existing attachment-wiring tests (which only mock
 * `readAgentRunByContextId`), this suite mocks the PRODUCTION
 * `readAgentRunById` fallback path so it actually exercises the code that
 * the vulnerability lived in. The OBO mint is observed via the
 * `cinatraMcpToolOverride` passed to the orchestration layer:
 * `resolveAgentRunMcpActor` is only called when a run was selected for
 * minting, so its (non-)invocation is the load-bearing assertion.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  issueAgentRunBinding,
  AGENT_RUN_BINDING_PURPOSE,
} from "@/lib/agent-run-binding";

type LlmProviderId = "openai" | "anthropic" | "gemini";

const {
  runResolvedSkillAwareDeterministicLlmTaskMock,
  resolveProviderAdapterMock,
  resolveConfiguredLlmRuntimeMock,
  getLlmMcpCredentialsMock,
  buildLlmMcpServerToolForAgentRunMock,
  readAgentRunByContextIdMock,
  readAgentRunByIdMock,
  resolveAgentRunMcpActorMock,
  issueAgentRunMcpActorTokenMock,
} = vi.hoisted(() => ({
  runResolvedSkillAwareDeterministicLlmTaskMock: vi.fn(
    async (_input: Record<string, unknown>) => ({ text: "ok", artifacts: [] }),
  ),
  resolveProviderAdapterMock: vi.fn(
    async (provider: LlmProviderId): Promise<{ provider: LlmProviderId } | null> => ({
      provider,
    }),
  ),
  // resolveConfiguredLlmRuntime returns the runtime object directly; the
  // route reads `resolvedRuntime.provider`. The openai provider gates the
  // cinatraMcpToolOverride factory creation.
  resolveConfiguredLlmRuntimeMock: vi.fn(async () => ({
    provider: "openai" as LlmProviderId,
  })),
  getLlmMcpCredentialsMock: vi.fn(
    (): { clientId: string; clientSecret: string } | null => null,
  ),
  buildLlmMcpServerToolForAgentRunMock: vi.fn(() => ({ type: "mcp-tool" })),
  readAgentRunByContextIdMock: vi.fn(),
  readAgentRunByIdMock: vi.fn(),
  resolveAgentRunMcpActorMock: vi.fn(),
  issueAgentRunMcpActorTokenMock: vi.fn(() => "obo-token"),
}));

vi.mock("server-only", () => ({}));
vi.mock("@cinatra-ai/llm", () => ({
  runResolvedSkillAwareDeterministicLlmTask:
    runResolvedSkillAwareDeterministicLlmTaskMock,
  resolveProviderAdapter: resolveProviderAdapterMock,
  resolveConfiguredLlmRuntime: resolveConfiguredLlmRuntimeMock,
  getLlmMcpCredentials: getLlmMcpCredentialsMock,
  buildLlmMcpServerToolForAgentRun: buildLlmMcpServerToolForAgentRunMock,
  createLocalSkillShellTool: vi.fn(() => null),
  openAiModelSupportsShell: (modelId: string) =>
    modelId !== "gpt-5" && modelId !== "gpt-5-mini",
  PreferredProviderUnavailableError: class extends Error {},
  uploadFile: vi.fn(),
}));
vi.mock("@/lib/agent-run-context-registry", () => ({
  setRunContext: vi.fn(),
  clearRunContext: vi.fn(),
}));
vi.mock("@/lib/a2a-auth", () => ({
  verifyLangGraphBridgeToken: vi.fn(async () => ({
    ok: false,
    response: new Response("forbidden", { status: 403 }),
  })),
}));
vi.mock("@cinatra-ai/skills", () => ({
  getCustomSkillForCurrentUserAndAgent: vi.fn(async () => null),
}));
vi.mock("@/lib/agents-store", () => ({
  getAssignedSkillIdsForAgent: vi.fn(async () => []),
}));
vi.mock("@/lib/agent-run-mcp-actor-token", () => ({
  issueAgentRunMcpActorToken: issueAgentRunMcpActorTokenMock,
}));
vi.mock("@/lib/agent-run-actor-resolve", () => ({
  resolveAgentRunMcpActor: resolveAgentRunMcpActorMock,
}));
vi.mock("@cinatra-ai/agents", async () => {
  const { z } = await import("zod");
  return {
    readAgentRunByContextId: readAgentRunByContextIdMock,
    readAgentRunById: readAgentRunByIdMock,
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
  };
});

let POST: (req: Request) => Promise<Response>;
const BRIDGE_TOKEN = "test-token-32chars-XYZXYZXYZXYZ";
const AUTH_SECRET = "test-better-auth-secret-for-binding-unit";

// The honest run that the binding is signed for.
const VICTIM_RUN = {
  id: "run-victim",
  orgId: "org-victim",
  runBy: "user-victim",
  sourceType: null,
};
// A different tenant's run an attacker would try to select.
const TARGET_RUN = {
  id: "run-target",
  orgId: "org-target",
  runBy: "user-target",
  sourceType: null,
};

function makeReq(body: Record<string, unknown>): Request {
  return new Request("http://localhost:3000/api/llm-bridge", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cinatra-bridge-token": BRIDGE_TOKEN,
    },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.CINATRA_BRIDGE_TOKEN = BRIDGE_TOKEN;
  process.env.BETTER_AUTH_SECRET = AUTH_SECRET;
  readAgentRunByContextIdMock.mockResolvedValue(null);
  resolveAgentRunMcpActorMock.mockResolvedValue({
    delegation: "agent_run",
    userId: VICTIM_RUN.runBy,
    orgId: VICTIM_RUN.orgId,
    runId: VICTIM_RUN.id,
    platformRole: "member",
  });
  runResolvedSkillAwareDeterministicLlmTaskMock.mockResolvedValue({
    text: "ok",
    artifacts: [],
  });
  const mod = await import("../route");
  POST = mod.POST;
});

// Force the cinatraMcpToolOverride factory to actually execute (it is lazy:
// the route returns it as a thunk to the orchestration layer). Invoking it
// is what calls resolveAgentRunMcpActor.
async function invokeOverride(): Promise<unknown> {
  const call = runResolvedSkillAwareDeterministicLlmTaskMock.mock.calls[0];
  if (!call) throw new Error("expected dispatch to have been called");
  const arg = call[0] as { cinatraMcpToolOverride?: () => Promise<unknown> };
  if (!arg.cinatraMcpToolOverride) return undefined;
  return arg.cinatraMcpToolOverride();
}

describe("bridge run binding for MCP OBO minting", () => {
  it("ATTACK: forged body.agent_run_id (no binding) must NOT select a run for OBO minting", async () => {
    // readAgentRunById would return the target run if called — but it must
    // NEVER be called from a raw body id.
    readAgentRunByIdMock.mockResolvedValue(TARGET_RUN);
    const res = await POST(
      makeReq({ user: "hi", agent_run_id: TARGET_RUN.id }),
    );
    expect(res.status).toBe(200);
    // The production fallback must not promote a body id to a run read.
    expect(readAgentRunByIdMock).not.toHaveBeenCalled();
    // No cinatraMcpToolOverride should have been provided (no runForPorts).
    await invokeOverride();
    expect(resolveAgentRunMcpActorMock).not.toHaveBeenCalled();
    expect(issueAgentRunMcpActorTokenMock).not.toHaveBeenCalled();
  });

  it("ATTACK: valid binding for run-victim + forged body.agent_run_id=run-target mints OBO for run-victim ONLY", async () => {
    const binding = issueAgentRunBinding({
      runId: VICTIM_RUN.id,
      orgId: VICTIM_RUN.orgId,
      runBy: VICTIM_RUN.runBy,
    });
    // The binding's verified runId is run-victim; readAgentRunById is called
    // with the SIGNED id, never the body id.
    readAgentRunByIdMock.mockImplementation(async (id: string) =>
      id === VICTIM_RUN.id ? VICTIM_RUN : TARGET_RUN,
    );
    const res = await POST(
      makeReq({
        user: "hi",
        agent_run_id: TARGET_RUN.id, // forged — must be ignored
        cinatra_run_binding: binding,
      }),
    );
    expect(res.status).toBe(200);
    expect(readAgentRunByIdMock).toHaveBeenCalledTimes(1);
    expect(readAgentRunByIdMock).toHaveBeenCalledWith(VICTIM_RUN.id);
    await invokeOverride();
    // OBO mint resolves for the BINDING's run, not the forged body id.
    expect(resolveAgentRunMcpActorMock).toHaveBeenCalledTimes(1);
    expect(resolveAgentRunMcpActorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: VICTIM_RUN.id,
        orgId: VICTIM_RUN.orgId,
        runBy: VICTIM_RUN.runBy,
      }),
    );
  });

  it("ATTACK: binding with a tampered signature is rejected (no OBO mint)", async () => {
    const binding = issueAgentRunBinding({
      runId: VICTIM_RUN.id,
      orgId: VICTIM_RUN.orgId,
      runBy: VICTIM_RUN.runBy,
    });
    const tampered = binding.slice(0, -2) + "xx";
    readAgentRunByIdMock.mockResolvedValue(VICTIM_RUN);
    const res = await POST(
      makeReq({ user: "hi", cinatra_run_binding: tampered }),
    );
    expect(res.status).toBe(200);
    expect(readAgentRunByIdMock).not.toHaveBeenCalled();
    await invokeOverride();
    expect(resolveAgentRunMcpActorMock).not.toHaveBeenCalled();
  });

  it("ATTACK: binding signed with the WRONG secret is rejected", async () => {
    process.env.BETTER_AUTH_SECRET = "attacker-secret";
    const forged = issueAgentRunBinding({
      runId: TARGET_RUN.id,
      orgId: TARGET_RUN.orgId,
      runBy: TARGET_RUN.runBy,
    });
    process.env.BETTER_AUTH_SECRET = AUTH_SECRET; // restore the real key
    readAgentRunByIdMock.mockResolvedValue(TARGET_RUN);
    const res = await POST(
      makeReq({ user: "hi", cinatra_run_binding: forged }),
    );
    expect(res.status).toBe(200);
    expect(readAgentRunByIdMock).not.toHaveBeenCalled();
    await invokeOverride();
    expect(resolveAgentRunMcpActorMock).not.toHaveBeenCalled();
  });

  it("DEFENSE-IN-DEPTH: binding runId resolves but the fresh row mismatches orgId → no mint", async () => {
    const binding = issueAgentRunBinding({
      runId: VICTIM_RUN.id,
      orgId: VICTIM_RUN.orgId,
      runBy: VICTIM_RUN.runBy,
    });
    // The live row now carries a DIFFERENT org (e.g. ownership moved / forged
    // binding pointing at a non-matching row): must refuse.
    readAgentRunByIdMock.mockResolvedValue({
      ...VICTIM_RUN,
      orgId: "org-changed",
    });
    const res = await POST(
      makeReq({ user: "hi", cinatra_run_binding: binding }),
    );
    expect(res.status).toBe(200);
    expect(readAgentRunByIdMock).toHaveBeenCalledWith(VICTIM_RUN.id);
    await invokeOverride();
    expect(resolveAgentRunMcpActorMock).not.toHaveBeenCalled();
  });

  it("DEFENSE-IN-DEPTH: resolveAgentRunMcpActor returning null yields a null override (machine-token fallback)", async () => {
    const binding = issueAgentRunBinding({
      runId: VICTIM_RUN.id,
      orgId: VICTIM_RUN.orgId,
      runBy: VICTIM_RUN.runBy,
    });
    readAgentRunByIdMock.mockResolvedValue(VICTIM_RUN);
    resolveAgentRunMcpActorMock.mockResolvedValue(null); // demoted user
    const res = await POST(
      makeReq({ user: "hi", cinatra_run_binding: binding }),
    );
    expect(res.status).toBe(200);
    const override = await invokeOverride();
    expect(resolveAgentRunMcpActorMock).toHaveBeenCalledTimes(1);
    // Null actor → null tool override → orchestration falls back to the
    // anonymous machine token (never an elevation).
    expect(override).toBeNull();
    expect(buildLlmMcpServerToolForAgentRunMock).not.toHaveBeenCalled();
  });

  it("HAPPY PATH: a resolved x-cinatra-a2a-context-id still mints (binding-free legacy path preserved)", async () => {
    readAgentRunByContextIdMock.mockResolvedValue(VICTIM_RUN);
    const req = new Request("http://localhost:3000/api/llm-bridge", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cinatra-bridge-token": BRIDGE_TOKEN,
        "x-cinatra-a2a-context-id": "ctx-victim",
      },
      body: JSON.stringify({ user: "hi", agent_run_id: VICTIM_RUN.id }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    // No body-id fallback read on the context-id-resolved path.
    expect(readAgentRunByIdMock).not.toHaveBeenCalled();
    await invokeOverride();
    expect(resolveAgentRunMcpActorMock).toHaveBeenCalledWith(
      expect.objectContaining({ runId: VICTIM_RUN.id }),
    );
  });

  it("guards the binding purpose constant against accidental edits", () => {
    expect(AGENT_RUN_BINDING_PURPOSE).toBe("llm-bridge-run-select");
  });
});
