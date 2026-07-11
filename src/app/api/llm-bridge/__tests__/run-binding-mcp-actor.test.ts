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
  buildLlmMcpServerToolMock,
  readAgentRunTokenHashByIdMock,
  writeDurableRunContextBindingMock,
  clearDurableRunContextBindingsMock,
  readAgentRunByContextIdMock,
  readAgentRunByTokenHashMock,
  readAgentRunByIdMock,
  readAgentTemplateByIdMock,
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
  // #1195 — the bridge now mints the machine fallback tool ITSELF (inside the
  // override) so it can key the durable run-context binding to the exact
  // per-mint access token. MACHINE_TOOL mirrors buildCinatraMcpServerTool's
  // shape (headers.Authorization carries the bearer the bridge reads back).
  buildLlmMcpServerToolMock: vi.fn(
    async (): Promise<{ type: string; headers: { Authorization: string } } | null> => ({
      type: "mcp",
      headers: { Authorization: "Bearer machine-token-abc" },
    }),
  ),
  readAgentRunTokenHashByIdMock: vi.fn(async (): Promise<string | null> => null),
  writeDurableRunContextBindingMock: vi.fn(
    async (): Promise<string | null> => "cinatra:run-ctx:v1:test-key",
  ),
  clearDurableRunContextBindingsMock: vi.fn(async () => {}),
  readAgentRunByContextIdMock: vi.fn(),
  readAgentRunByTokenHashMock: vi.fn(
    async (): Promise<{
      id: string;
      orgId: string;
      runBy: string | null;
    } | null> => null,
  ),
  readAgentRunByIdMock: vi.fn(),
  readAgentTemplateByIdMock: vi.fn(),
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
  buildLlmMcpServerTool: buildLlmMcpServerToolMock,
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
vi.mock("@/lib/agent-run-context-durable", () => ({
  writeDurableRunContextBinding: writeDurableRunContextBindingMock,
  clearDurableRunContextBindings: clearDurableRunContextBindingsMock,
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
  };
});

let POST: (req: Request) => Promise<Response>;
const BRIDGE_TOKEN = "test-token-32chars-XYZXYZXYZXYZ";
const AUTH_SECRET = "test-better-auth-secret-for-binding-unit";

// The honest run that the binding is signed for. Carries the persisted OBO
// scope-ceiling chain the mint path re-derives + containment-checks (W1).
const VICTIM_RUN = {
  id: "run-victim",
  orgId: "org-victim",
  runBy: "user-victim",
  sourceType: null,
  templateId: "tpl-victim",
  projectId: null,
  oboCeiling: [{ tier: "organization", id: "org-victim" }],
};
// A different tenant's run an attacker would try to select.
const TARGET_RUN = {
  id: "run-target",
  orgId: "org-target",
  runBy: "user-target",
  sourceType: null,
  templateId: "tpl-target",
  projectId: null,
  oboCeiling: [{ tier: "organization", id: "org-target" }],
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

// Variant that also sets loader-injected internal headers (the run token +
// a2a context id) so the W3 token-first path can be exercised.
function makeReqH(
  body: Record<string, unknown>,
  headers: Record<string, string>,
): Request {
  return new Request("http://localhost:3000/api/llm-bridge", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cinatra-bridge-token": BRIDGE_TOKEN,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.CINATRA_BRIDGE_TOKEN = BRIDGE_TOKEN;
  process.env.BETTER_AUTH_SECRET = AUTH_SECRET;
  readAgentRunByContextIdMock.mockResolvedValue(null);
  readAgentRunByTokenHashMock.mockResolvedValue(null);
  // Default template anchor: org-owned by the victim's org. deriveOboCeilingChain
  // → [{organization, org-victim}], which VICTIM_RUN.oboCeiling contains, so the
  // mint-time containment check passes on the happy paths.
  readAgentTemplateByIdMock.mockResolvedValue({
    ownerLevel: "organization",
    ownerId: "org-victim",
  });
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
  buildLlmMcpServerToolMock.mockResolvedValue({
    type: "mcp",
    headers: { Authorization: "Bearer machine-token-abc" },
  });
  readAgentRunTokenHashByIdMock.mockResolvedValue(null);
  writeDurableRunContextBindingMock.mockResolvedValue(
    "cinatra:run-ctx:v1:test-key",
  );
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

  it("DEFENSE-IN-DEPTH: resolveAgentRunMcpActor returning null falls back to the machine token (never an elevation) + durable binding (#1195)", async () => {
    const binding = issueAgentRunBinding({
      runId: VICTIM_RUN.id,
      orgId: VICTIM_RUN.orgId,
      runBy: VICTIM_RUN.runBy,
    });
    readAgentRunByIdMock.mockResolvedValue(VICTIM_RUN);
    resolveAgentRunMcpActorMock.mockResolvedValue(null); // demoted user
    readAgentRunTokenHashByIdMock.mockResolvedValue("a".repeat(64));
    const res = await POST(
      makeReq({ user: "hi", cinatra_run_binding: binding }),
    );
    expect(res.status).toBe(200);
    const override = await invokeOverride();
    expect(resolveAgentRunMcpActorMock).toHaveBeenCalledTimes(1);
    // Null actor → the bridge mints the SAME anonymous machine token the
    // orchestration layer used to mint (never an elevation), now in-bridge so
    // the durable run-context binding keys on the exact per-mint bearer.
    expect(override).toEqual(
      expect.objectContaining({
        type: "mcp",
        headers: { Authorization: "Bearer machine-token-abc" },
      }),
    );
    expect(buildLlmMcpServerToolForAgentRunMock).not.toHaveBeenCalled();
    expect(writeDurableRunContextBindingMock).toHaveBeenCalledTimes(1);
    expect(writeDurableRunContextBindingMock).toHaveBeenCalledWith(
      "machine-token-abc",
      expect.objectContaining({ tokenHash: "a".repeat(64) }),
    );
  });

  it("#1195: a run WITHOUT a dispatch-minted credential hash writes NO durable binding (registry-only legacy path)", async () => {
    const binding = issueAgentRunBinding({
      runId: VICTIM_RUN.id,
      orgId: VICTIM_RUN.orgId,
      runBy: VICTIM_RUN.runBy,
    });
    readAgentRunByIdMock.mockResolvedValue(VICTIM_RUN);
    resolveAgentRunMcpActorMock.mockResolvedValue(null);
    readAgentRunTokenHashByIdMock.mockResolvedValue(null); // legacy run
    const res = await POST(
      makeReq({ user: "hi", cinatra_run_binding: binding }),
    );
    expect(res.status).toBe(200);
    const override = await invokeOverride();
    // The machine tool is still served; only the binding write is skipped.
    expect(override).toEqual(expect.objectContaining({ type: "mcp" }));
    expect(writeDurableRunContextBindingMock).not.toHaveBeenCalled();
  });

  it("#1195: OBO mint SUCCESS writes NO durable binding (the OBO token itself carries run identity)", async () => {
    const binding = issueAgentRunBinding({
      runId: VICTIM_RUN.id,
      orgId: VICTIM_RUN.orgId,
      runBy: VICTIM_RUN.runBy,
    });
    readAgentRunByIdMock.mockResolvedValue(VICTIM_RUN);
    readAgentRunTokenHashByIdMock.mockResolvedValue("a".repeat(64));
    const res = await POST(
      makeReq({ user: "hi", cinatra_run_binding: binding }),
    );
    expect(res.status).toBe(200);
    const override = await invokeOverride();
    expect(override).toEqual(expect.objectContaining({ type: "mcp-tool" }));
    expect(buildLlmMcpServerToolMock).not.toHaveBeenCalled();
    expect(writeDurableRunContextBindingMock).not.toHaveBeenCalled();
  });

  it("#1195: a cinatra_llm dispatch to a provider OTHER than the configured runtime still installs the override — machine fallback mints for the EFFECTIVE provider and binds", async () => {
    // Configured runtime is gemini; the OAS dispatch block routes the task to
    // openai. Gating the override on the CONFIGURED provider would install no
    // override at all — the orchestration would mint an unbound machine token
    // and this run would ride the alias-prone in-process registry.
    // (`...Once` — mockResolvedValue would bleed into later tests: the suite's
    // beforeEach clearAllMocks clears CALLS, not implementations.)
    resolveConfiguredLlmRuntimeMock.mockResolvedValueOnce({
      provider: "gemini" as LlmProviderId,
    });
    const binding = issueAgentRunBinding({
      runId: VICTIM_RUN.id,
      orgId: VICTIM_RUN.orgId,
      runBy: VICTIM_RUN.runBy,
    });
    readAgentRunByIdMock.mockResolvedValue(VICTIM_RUN);
    resolveAgentRunMcpActorMock.mockResolvedValue(null); // machine fallback path
    readAgentRunTokenHashByIdMock.mockResolvedValue("a".repeat(64));
    const res = await POST(
      makeReq({
        user: "hi",
        cinatra_run_binding: binding,
        cinatra_llm: { preferredProvider: "openai" },
      }),
    );
    expect(res.status).toBe(200);
    const override = await invokeOverride();
    expect(override).toEqual(expect.objectContaining({ type: "mcp" }));
    // The machine mint targets the provider the task actually RUNS on.
    expect(buildLlmMcpServerToolMock).toHaveBeenCalledWith("openai");
    expect(writeDurableRunContextBindingMock).toHaveBeenCalledWith(
      "machine-token-abc",
      expect.objectContaining({ tokenHash: "a".repeat(64) }),
    );
  });

  it("#1195: the OBO tool is built for the dispatch-EFFECTIVE provider, not the configured runtime", async () => {
    resolveConfiguredLlmRuntimeMock.mockResolvedValueOnce({
      provider: "gemini" as LlmProviderId,
    });
    const binding = issueAgentRunBinding({
      runId: VICTIM_RUN.id,
      orgId: VICTIM_RUN.orgId,
      runBy: VICTIM_RUN.runBy,
    });
    readAgentRunByIdMock.mockResolvedValue(VICTIM_RUN);
    const res = await POST(
      makeReq({
        user: "hi",
        cinatra_run_binding: binding,
        cinatra_llm: { preferredProvider: "anthropic" },
      }),
    );
    expect(res.status).toBe(200);
    const override = await invokeOverride();
    expect(override).toEqual(expect.objectContaining({ type: "mcp-tool" }));
    // First arg is the provider the task actually runs on (the 4th arg — the
    // CMS allowlist — is legitimately undefined for non-CMS packages).
    expect(buildLlmMcpServerToolForAgentRunMock).toHaveBeenCalledTimes(1);
    expect(
      (buildLlmMcpServerToolForAgentRunMock.mock.calls[0] as unknown[])[0],
    ).toBe("anthropic");
  });

  it("STICKY CMS PIN: a public_site_widget carrier run mints with the pinned CMS allowlist even when package membership is indeterminate (widget-stream runtime trust, slice 2)", async () => {
    // The run-level discriminator alone pins the allowlist: the template
    // carries NO packageName here (membership indeterminate / would be false),
    // and a runtime grant revoked AFTER run creation looks exactly like this —
    // the live widget-carrier run must NEVER widen to unrestricted self-MCP.
    const binding = issueAgentRunBinding({
      runId: VICTIM_RUN.id,
      orgId: VICTIM_RUN.orgId,
      runBy: VICTIM_RUN.runBy,
    });
    readAgentRunByIdMock.mockResolvedValue({
      ...VICTIM_RUN,
      sourceType: "public_site_widget",
    });
    const res = await POST(makeReq({ user: "hi", cinatra_run_binding: binding }));
    expect(res.status).toBe(200);
    const tool = await invokeOverride();
    expect(tool).toEqual(expect.objectContaining({ type: "mcp-tool" }));
    const allowlistArg = (
      buildLlmMcpServerToolForAgentRunMock.mock.calls[0] as unknown[]
    )[3];
    expect(Array.isArray(allowlistArg)).toBe(true);
    expect((allowlistArg as string[]).length).toBeGreaterThan(0);
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

  it("W1: mint carries the PERSISTED ceiling chain onto the actor + token", async () => {
    const binding = issueAgentRunBinding({
      runId: VICTIM_RUN.id,
      orgId: VICTIM_RUN.orgId,
      runBy: VICTIM_RUN.runBy,
    });
    readAgentRunByIdMock.mockResolvedValue(VICTIM_RUN);
    const res = await POST(makeReq({ user: "hi", cinatra_run_binding: binding }));
    expect(res.status).toBe(200);
    const tool = await invokeOverride();
    expect(tool).not.toBeNull();
    // Re-derives from the run's LOCKED template anchor.
    expect(readAgentTemplateByIdMock).toHaveBeenCalledWith(VICTIM_RUN.templateId);
    expect(buildLlmMcpServerToolForAgentRunMock).toHaveBeenCalledTimes(1);
    // The actor handed to the token issuer carries the PERSISTED chain (not the
    // re-derived subset — superset-safe for composed-child parent elements).
    // The mock is a zero-arg `vi.fn()` factory, so its call-args infer as an
    // empty tuple; cast the call record through `unknown[]` to read positional
    // arg 1 (the actor handed to the token issuer).
    const actorArg = (
      buildLlmMcpServerToolForAgentRunMock.mock.calls[0] as unknown[]
    )[1] as { oboCeiling?: unknown };
    expect(actorArg.oboCeiling).toEqual(VICTIM_RUN.oboCeiling);
  });

  it("W1: persisted ceiling MISSING on the run → fail closed (no OBO mint)", async () => {
    const binding = issueAgentRunBinding({
      runId: VICTIM_RUN.id,
      orgId: VICTIM_RUN.orgId,
      runBy: VICTIM_RUN.runBy,
    });
    // A run whose backfill was missed / anchor was corrupt → obo_ceiling NULL.
    readAgentRunByIdMock.mockResolvedValue({ ...VICTIM_RUN, oboCeiling: null });
    const res = await POST(makeReq({ user: "hi", cinatra_run_binding: binding }));
    expect(res.status).toBe(200);
    const override = await invokeOverride();
    expect(resolveAgentRunMcpActorMock).toHaveBeenCalledTimes(1);
    // Missing persisted chain is never contained → machine-token fallback
    // (denied at the boundary), never an un-ceilinged OBO mint. #1195 mints
    // the fallback in-bridge (same tool, plus the durable binding).
    expect(override).toEqual(expect.objectContaining({ type: "mcp" }));
    expect(buildLlmMcpServerToolForAgentRunMock).not.toHaveBeenCalled();
  });

  it("W1: mint-time ceiling mismatch (persisted does NOT contain re-derived) → fail closed", async () => {
    const binding = issueAgentRunBinding({
      runId: VICTIM_RUN.id,
      orgId: VICTIM_RUN.orgId,
      runBy: VICTIM_RUN.runBy,
    });
    // Persisted chain is org-only ([{organization, org-victim}]).
    readAgentRunByIdMock.mockResolvedValue(VICTIM_RUN);
    // But the LOCKED template now anchors at USER tier → re-derived chain adds
    // {user, user-victim}, which the persisted org-only chain does NOT contain.
    readAgentTemplateByIdMock.mockResolvedValue({
      ownerLevel: "user",
      ownerId: "user-victim",
    });
    const res = await POST(makeReq({ user: "hi", cinatra_run_binding: binding }));
    expect(res.status).toBe(200);
    const override = await invokeOverride();
    expect(resolveAgentRunMcpActorMock).toHaveBeenCalledTimes(1);
    // Machine-token fallback (never an un-ceilinged OBO mint); #1195 mints it
    // in-bridge.
    expect(override).toEqual(expect.objectContaining({ type: "mcp" }));
    expect(buildLlmMcpServerToolForAgentRunMock).not.toHaveBeenCalled();
  });

  it("guards the binding purpose constant against accidental edits", () => {
    expect(AGENT_RUN_BINDING_PURPOSE).toBe("llm-bridge-run-select");
  });
});

// ---------------------------------------------------------------------------
// #1193 run-token spine (W3) — the llm-bridge resolves the run TOKEN-FIRST off
// the one dispatch-minted credential (X-Cinatra-Run-Token → verifyRunToken →
// unique-index row), with the context-id + dispatcher-signed binding kept as
// measured legacy fallbacks. Absent token ⇒ the legacy paths above are
// UNCHANGED (proven by every binding/context-id test in the block above, which
// sends no run-token header); present-but-unresolvable ⇒ FAIL CLOSED.
// ---------------------------------------------------------------------------
const RUN_TOKEN = "raw-run-token-xyz";
const PROBE = {
  id: VICTIM_RUN.id,
  orgId: VICTIM_RUN.orgId,
  runBy: VICTIM_RUN.runBy,
};

describe("bridge run-token-first selection (W3)", () => {
  it("HAPPY: a valid run token selects the run for OBO, re-read by the SERVER-DERIVED id (never a body id)", async () => {
    readAgentRunByTokenHashMock.mockResolvedValue(PROBE);
    readAgentRunByIdMock.mockResolvedValue(VICTIM_RUN);
    const res = await POST(
      makeReqH({ user: "hi" }, { "x-cinatra-run-token": RUN_TOKEN }),
    );
    expect(res.status).toBe(200);
    // The full row is re-read by the id the TOKEN resolved, never a body id.
    expect(readAgentRunByIdMock).toHaveBeenCalledWith(VICTIM_RUN.id);
    await invokeOverride();
    expect(resolveAgentRunMcpActorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: VICTIM_RUN.id,
        orgId: VICTIM_RUN.orgId,
        runBy: VICTIM_RUN.runBy,
      }),
    );
  });

  it("TOKEN WINS over a forged body.agent_run_id (token is authoritative)", async () => {
    readAgentRunByTokenHashMock.mockResolvedValue(PROBE);
    readAgentRunByIdMock.mockResolvedValue(VICTIM_RUN);
    const res = await POST(
      makeReqH(
        { user: "hi", agent_run_id: TARGET_RUN.id }, // forged — must be ignored
        { "x-cinatra-run-token": RUN_TOKEN },
      ),
    );
    expect(res.status).toBe(200);
    expect(readAgentRunByIdMock).toHaveBeenCalledWith(VICTIM_RUN.id);
    expect(readAgentRunByIdMock).not.toHaveBeenCalledWith(TARGET_RUN.id);
    await invokeOverride();
    expect(resolveAgentRunMcpActorMock).toHaveBeenCalledWith(
      expect.objectContaining({ runId: VICTIM_RUN.id }),
    );
  });

  it("TOKEN OUTRANKS a co-present dispatcher-signed binding for a DIFFERENT run (binding channel not consulted)", async () => {
    readAgentRunByTokenHashMock.mockResolvedValue(PROBE);
    readAgentRunByIdMock.mockResolvedValue(VICTIM_RUN);
    const attackerBinding = issueAgentRunBinding({
      runId: TARGET_RUN.id,
      orgId: TARGET_RUN.orgId,
      runBy: TARGET_RUN.runBy,
    });
    const res = await POST(
      makeReqH(
        { user: "hi", cinatra_run_binding: attackerBinding },
        { "x-cinatra-run-token": RUN_TOKEN },
      ),
    );
    expect(res.status).toBe(200);
    // Token selected the run first, so the binding path never reads TARGET.
    expect(readAgentRunByIdMock).toHaveBeenCalledWith(VICTIM_RUN.id);
    expect(readAgentRunByIdMock).not.toHaveBeenCalledWith(TARGET_RUN.id);
    await invokeOverride();
    expect(resolveAgentRunMcpActorMock).toHaveBeenCalledWith(
      expect.objectContaining({ runId: VICTIM_RUN.id }),
    );
  });

  it("FAIL CLOSED: a present-but-unresolvable token suppresses the context-id fallback (no OBO mint)", async () => {
    readAgentRunByTokenHashMock.mockResolvedValue(null); // unresolvable
    readAgentRunByContextIdMock.mockResolvedValue(VICTIM_RUN); // WOULD resolve
    const res = await POST(
      makeReqH(
        { user: "hi" },
        {
          "x-cinatra-run-token": "garbage-token",
          "x-cinatra-a2a-context-id": "ctx-victim",
        },
      ),
    );
    expect(res.status).toBe(200);
    await invokeOverride();
    // An invalid token must not downgrade to the weaker context-id selector.
    expect(resolveAgentRunMcpActorMock).not.toHaveBeenCalled();
    expect(issueAgentRunMcpActorTokenMock).not.toHaveBeenCalled();
  });

  it("FAIL CLOSED: a present-but-unresolvable token suppresses the dispatcher-signed binding fallback (no OBO mint)", async () => {
    readAgentRunByTokenHashMock.mockResolvedValue(null); // unresolvable
    const binding = issueAgentRunBinding({
      runId: VICTIM_RUN.id,
      orgId: VICTIM_RUN.orgId,
      runBy: VICTIM_RUN.runBy,
    });
    readAgentRunByIdMock.mockResolvedValue(VICTIM_RUN);
    const res = await POST(
      makeReqH(
        { user: "hi", cinatra_run_binding: binding },
        { "x-cinatra-run-token": "garbage-token" },
      ),
    );
    expect(res.status).toBe(200);
    // The binding channel is suppressed → the signed binding is never verified.
    expect(readAgentRunByIdMock).not.toHaveBeenCalled();
    await invokeOverride();
    expect(resolveAgentRunMcpActorMock).not.toHaveBeenCalled();
  });

  it("FAIL CLOSED: token probe resolves but the fresh re-read row DIVERGES (orgId changed) → no OBO mint", async () => {
    readAgentRunByTokenHashMock.mockResolvedValue(PROBE);
    readAgentRunByIdMock.mockResolvedValue({
      ...VICTIM_RUN,
      orgId: "org-changed",
    });
    const res = await POST(
      makeReqH({ user: "hi" }, { "x-cinatra-run-token": RUN_TOKEN }),
    );
    expect(res.status).toBe(200);
    expect(readAgentRunByIdMock).toHaveBeenCalledWith(VICTIM_RUN.id);
    await invokeOverride();
    expect(resolveAgentRunMcpActorMock).not.toHaveBeenCalled();
  });

  it("DIVERGENCE: token selects a run but a co-present context-id names a DIFFERENT run → refuse OBO", async () => {
    readAgentRunByTokenHashMock.mockResolvedValue(PROBE);
    readAgentRunByIdMock.mockResolvedValue(VICTIM_RUN);
    readAgentRunByContextIdMock.mockResolvedValue(TARGET_RUN); // disagrees
    const res = await POST(
      makeReqH(
        { user: "hi" },
        {
          "x-cinatra-run-token": RUN_TOKEN,
          "x-cinatra-a2a-context-id": "ctx-target",
        },
      ),
    );
    expect(res.status).toBe(200);
    await invokeOverride();
    // A divergent trustworthy context-id refuses the OBO mint (W2 invariant).
    expect(resolveAgentRunMcpActorMock).not.toHaveBeenCalled();
  });

  it("a co-present context-id that AGREES with the token still mints (no false divergence)", async () => {
    readAgentRunByTokenHashMock.mockResolvedValue(PROBE);
    readAgentRunByIdMock.mockResolvedValue(VICTIM_RUN);
    readAgentRunByContextIdMock.mockResolvedValue(VICTIM_RUN); // same run
    const res = await POST(
      makeReqH(
        { user: "hi" },
        {
          "x-cinatra-run-token": RUN_TOKEN,
          "x-cinatra-a2a-context-id": "ctx-victim",
        },
      ),
    );
    expect(res.status).toBe(200);
    await invokeOverride();
    expect(resolveAgentRunMcpActorMock).toHaveBeenCalledWith(
      expect.objectContaining({ runId: VICTIM_RUN.id }),
    );
  });
});
