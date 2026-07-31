/**
 * The LLM bridge must resolve "which run is calling" from the ONE dispatch-minted
 * per-run credential and nothing else (#1193).
 *
 * Run selection for OBO minting is valid ONLY via the `X-Cinatra-Run-Token`
 * header (verifyRunToken -> unique-index row -> re-read by the SERVER-DERIVED
 * id). The two legacy selectors are RETIRED and locked out below:
 *   - the auth-injected `x-cinatra-a2a-context-id` lookup, and
 *   - the dispatcher-signed `cinatra_run_binding` (module deleted outright).
 * A forgeable `body.agent_run_id` never could select, and still cannot — but it
 * now also fails CLOSED (403) rather than silently proceeding unattributed.
 *
 * CRITICAL: unlike the attachment-wiring tests (which only mock
 * `readAgentRunByContextId`), this suite mocks the PRODUCTION
 * `readAgentRunById` path so it actually exercises the code the original
 * vulnerability lived in. The OBO mint is observed via the
 * `cinatraMcpToolOverride` passed to the orchestration layer:
 * `resolveAgentRunMcpActor` is only called when a run was selected for minting,
 * so its (non-)invocation is the load-bearing assertion.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
  // cinatra#2090 S3: the declared-edge projection the route consults when a
  // co-located bundle probe misses. Null here = "no declared skill edge",
  // which keeps every case in this file on the co-located path.
  resolveDeclaredSkillEdgeForExtensionDir: vi.fn(async () => null),
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
    // Run-execution-environment seam consumed by the route via
    // resolve-run-execution-binding.ts (exec-plane S3 A2, cinatra#1708). These
    // runs declare NO environment, so the resolver reports `kind:"none"` and the
    // binding resolves to L0 — the route path under test is unchanged.
    resolveRunExecutionEnvironment: () => ({ kind: "none" }),
    // …and the DECLARATION-SOURCE reader's pin classifier (epic #1705). These
    // runs carry no A2A version pin, so the classifier is never invoked; the
    // readers exist only to satisfy the module's imports.
    resolvePinnedRunSnapshot: async () => null,
    readAgentTemplateVersionById: async () => null,
    readAgentTemplateVersionBySemver: async () => null,
    PinnedRunSnapshotUnreachableError: class extends Error {},
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

const RUN_TOKEN = "raw-run-token-xyz";
const PROBE = {
  id: VICTIM_RUN.id,
  orgId: VICTIM_RUN.orgId,
  runBy: VICTIM_RUN.runBy,
};

describe("bridge run-token selection for MCP OBO minting", () => {
  it("ATTACK: forged body.agent_run_id with no token must NOT select a run — and is now REFUSED", async () => {
    // readAgentRunById would return the target run if called — but it must
    // NEVER be called from a raw body id.
    readAgentRunByIdMock.mockResolvedValue(TARGET_RUN);
    const res = await POST(
      makeReq({ user: "hi", agent_run_id: TARGET_RUN.id }),
    );
    // #1193 strengthened this from "served, unattributed" to "refused": a body
    // that CLAIMS a run it cannot prove is a forgery attempt, and continuing
    // would run the model step with the claim silently dropped.
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(
      expect.objectContaining({ code: "run_token_absent" }),
    );
    // The forgeable body id never reached a run read.
    expect(readAgentRunByIdMock).not.toHaveBeenCalled();
    expect(resolveAgentRunMcpActorMock).not.toHaveBeenCalled();
    expect(issueAgentRunMcpActorTokenMock).not.toHaveBeenCalled();
  });

  it("ATTACK: valid token for run-victim + forged body.agent_run_id=run-target is REFUSED (never mints for the forged run)", async () => {
    readAgentRunByTokenHashMock.mockResolvedValue(PROBE);
    readAgentRunByIdMock.mockImplementation(async (id: string) =>
      id === VICTIM_RUN.id ? VICTIM_RUN : TARGET_RUN,
    );
    const res = await POST(
      makeReqH(
        { user: "hi", agent_run_id: TARGET_RUN.id }, // forged
        { "x-cinatra-run-token": RUN_TOKEN },
      ),
    );
    // The token outranks the body id, so the forged run could never have been
    // SELECTED — but asserting one run while authenticating as another is a
    // forgery signal, and the context routes 403 that same shape. Refuse.
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(
      expect.objectContaining({ code: "run_mismatch" }),
    );
    // Critically: the forged run was NEVER read, and nothing was minted for it.
    expect(readAgentRunByIdMock).not.toHaveBeenCalledWith(TARGET_RUN.id);
    expect(resolveAgentRunMcpActorMock).not.toHaveBeenCalled();
    expect(issueAgentRunMcpActorTokenMock).not.toHaveBeenCalled();
  });

  it("DEFENSE-IN-DEPTH: token probe resolves but the fresh row mismatches orgId → no mint", async () => {
    readAgentRunByTokenHashMock.mockResolvedValue(PROBE);
    // The live row now carries a DIFFERENT org (ownership moved, or a torn /
    // rewritten row): the probe-vs-re-read divergence must refuse.
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

  it("DEFENSE-IN-DEPTH: resolveAgentRunMcpActor returning null falls back to the machine token (never an elevation) + durable binding (#1195)", async () => {
    readAgentRunByTokenHashMock.mockResolvedValue(PROBE);
    readAgentRunByIdMock.mockResolvedValue(VICTIM_RUN);
    resolveAgentRunMcpActorMock.mockResolvedValue(null); // demoted user
    readAgentRunTokenHashByIdMock.mockResolvedValue("a".repeat(64));
    const res = await POST(
      makeReqH({ user: "hi" }, { "x-cinatra-run-token": RUN_TOKEN }),
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
    readAgentRunByTokenHashMock.mockResolvedValue(PROBE);
    readAgentRunByIdMock.mockResolvedValue(VICTIM_RUN);
    resolveAgentRunMcpActorMock.mockResolvedValue(null);
    readAgentRunTokenHashByIdMock.mockResolvedValue(null); // legacy run
    const res = await POST(
      makeReqH({ user: "hi" }, { "x-cinatra-run-token": RUN_TOKEN }),
    );
    expect(res.status).toBe(200);
    const override = await invokeOverride();
    // The machine tool is still served; only the binding write is skipped.
    expect(override).toEqual(expect.objectContaining({ type: "mcp" }));
    expect(writeDurableRunContextBindingMock).not.toHaveBeenCalled();
  });

  it("#1195: OBO mint SUCCESS writes NO durable binding (the OBO token itself carries run identity)", async () => {
    readAgentRunByTokenHashMock.mockResolvedValue(PROBE);
    readAgentRunByIdMock.mockResolvedValue(VICTIM_RUN);
    readAgentRunTokenHashByIdMock.mockResolvedValue("a".repeat(64));
    const res = await POST(
      makeReqH({ user: "hi" }, { "x-cinatra-run-token": RUN_TOKEN }),
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
    readAgentRunByTokenHashMock.mockResolvedValue(PROBE);
    readAgentRunByIdMock.mockResolvedValue(VICTIM_RUN);
    resolveAgentRunMcpActorMock.mockResolvedValue(null); // machine fallback path
    readAgentRunTokenHashByIdMock.mockResolvedValue("a".repeat(64));
    const res = await POST(
      makeReqH(
        { user: "hi", cinatra_llm: { preferredProvider: "openai" } },
        { "x-cinatra-run-token": RUN_TOKEN },
      ),
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
    readAgentRunByTokenHashMock.mockResolvedValue(PROBE);
    readAgentRunByIdMock.mockResolvedValue(VICTIM_RUN);
    const res = await POST(
      makeReqH(
        { user: "hi", cinatra_llm: { preferredProvider: "anthropic" } },
        { "x-cinatra-run-token": RUN_TOKEN },
      ),
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
    readAgentRunByTokenHashMock.mockResolvedValue(PROBE);
    readAgentRunByIdMock.mockResolvedValue({
      ...VICTIM_RUN,
      sourceType: "public_site_widget",
    });
    const res = await POST(
      makeReqH({ user: "hi" }, { "x-cinatra-run-token": RUN_TOKEN }),
    );
    expect(res.status).toBe(200);
    const tool = await invokeOverride();
    expect(tool).toEqual(expect.objectContaining({ type: "mcp-tool" }));
    const allowlistArg = (
      buildLlmMcpServerToolForAgentRunMock.mock.calls[0] as unknown[]
    )[3];
    expect(Array.isArray(allowlistArg)).toBe(true);
    expect((allowlistArg as string[]).length).toBeGreaterThan(0);
  });

  // --- #1193 RETIREMENT: the context-id serving channel is GONE --------------

  it("RETIRED: a resolvable x-cinatra-a2a-context-id no longer selects a run, and a claimed run without a token is REFUSED", async () => {
    // Pre-#1193 this was the HAPPY PATH: the context-id header selected the run
    // and minted OBO. It must no longer select anything — and because the body
    // CLAIMS a run it cannot prove, the request now fails closed rather than
    // executing the model step with the claim silently dropped.
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
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(
      expect.objectContaining({ code: "run_token_absent" }),
    );
    // Refused BEFORE the provider dispatch — never mid-stream.
    expect(runResolvedSkillAwareDeterministicLlmTaskMock).not.toHaveBeenCalled();
    expect(resolveAgentRunMcpActorMock).not.toHaveBeenCalled();
  });

  it("RETIRED: a context-id alone (no run claimed) selects no run but still SERVES", async () => {
    // Availability carve-out: a request that never claimed a run has no identity
    // to lose, so it proceeds unattributed rather than being refused.
    readAgentRunByContextIdMock.mockResolvedValue(VICTIM_RUN);
    const res = await POST(
      makeReqH({ user: "hi" }, { "x-cinatra-a2a-context-id": "ctx-victim" }),
    );
    expect(res.status).toBe(200);
    await invokeOverride();
    expect(resolveAgentRunMcpActorMock).not.toHaveBeenCalled();
    expect(issueAgentRunMcpActorTokenMock).not.toHaveBeenCalled();
  });

  it("FAIL CLOSED: a claimed run with an UNRESOLVABLE token is refused with a distinct code", async () => {
    readAgentRunByTokenHashMock.mockResolvedValue(null);
    const res = await POST(
      makeReqH(
        { user: "hi", agent_run_id: VICTIM_RUN.id },
        { "x-cinatra-run-token": "garbage-token" },
      ),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(
      expect.objectContaining({ code: "run_token_unresolvable" }),
    );
    expect(runResolvedSkillAwareDeterministicLlmTaskMock).not.toHaveBeenCalled();
  });

  it("FAIL CLOSED: a claimed run whose token DIVERGES from a co-present context-id is refused", async () => {
    readAgentRunByTokenHashMock.mockResolvedValue(PROBE);
    readAgentRunByIdMock.mockResolvedValue(VICTIM_RUN);
    readAgentRunByContextIdMock.mockResolvedValue(TARGET_RUN); // names ANOTHER run
    const res = await POST(
      makeReqH(
        { user: "hi", agent_run_id: VICTIM_RUN.id },
        {
          "x-cinatra-run-token": RUN_TOKEN,
          "x-cinatra-a2a-context-id": "ctx-other",
        },
      ),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(
      expect.objectContaining({ code: "run_mismatch" }),
    );
  });

  it("REFUSES a claimed run BEFORE dispatch resolution runs (placement lock)", async () => {
    // A `cinatra_llm` body drives provider/capability resolution, and the Gemini
    // media-input branch downstream returns its OWN response. An identity check
    // placed after either would let the provider execute and return 200 with the
    // caller's claim silently dropped. Refusal must win the race.
    const res = await POST(
      makeReq({
        user: "hi",
        agent_run_id: VICTIM_RUN.id,
        cinatra_llm: { preferredProvider: "gemini" },
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(
      expect.objectContaining({ code: "run_token_absent" }),
    );
    // Neither the provider nor the dispatch resolver was consulted.
    expect(runResolvedSkillAwareDeterministicLlmTaskMock).not.toHaveBeenCalled();
    expect(resolveProviderAdapterMock).not.toHaveBeenCalled();
  });

  it("the identity gate precedes every dispatch path in the source", () => {
    const src = readFileSync(join(__dirname, "..", "route.ts"), "utf8");
    const gate = src.indexOf("#1193 RUN-IDENTITY GATE");
    const dispatchResolve = src.indexOf("resolveCinatraLlmDispatch(body.cinatra_llm");
    const mediaBranch = src.indexOf("const wantsMediaInput");
    expect(gate).toBeGreaterThan(-1);
    // A regression that moves the gate below either of these reopens the
    // claimed-identity downgrade.
    expect(gate).toBeLessThan(dispatchResolve);
    expect(gate).toBeLessThan(mediaBranch);
  });

  it("the route source consults no retired run selector", () => {
    const src = readFileSync(
      join(__dirname, "..", "route.ts"),
      "utf8",
    );
    // The signed-binding module is deleted; no import or verify call may remain.
    expect(src).not.toMatch(/verifyAgentRunBinding/);
    expect(src).not.toMatch(/agent-run-binding/);
    // The context-id may still be READ (cross-check) but must never be assigned
    // as the selected run.
    expect(src).not.toMatch(/runFromContext\s*=\s*runFromContextId/);
  });

  it("W1: mint carries the PERSISTED ceiling chain onto the actor + token", async () => {
    readAgentRunByTokenHashMock.mockResolvedValue(PROBE);
    readAgentRunByIdMock.mockResolvedValue(VICTIM_RUN);
    const res = await POST(
      makeReqH({ user: "hi" }, { "x-cinatra-run-token": RUN_TOKEN }),
    );
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
    readAgentRunByTokenHashMock.mockResolvedValue(PROBE);
    // A run whose backfill was missed / anchor was corrupt → obo_ceiling NULL.
    readAgentRunByIdMock.mockResolvedValue({ ...VICTIM_RUN, oboCeiling: null });
    const res = await POST(
      makeReqH({ user: "hi" }, { "x-cinatra-run-token": RUN_TOKEN }),
    );
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
    readAgentRunByTokenHashMock.mockResolvedValue(PROBE);
    // Persisted chain is org-only ([{organization, org-victim}]).
    readAgentRunByIdMock.mockResolvedValue(VICTIM_RUN);
    // But the LOCKED template now anchors at USER tier → re-derived chain adds
    // {user, user-victim}, which the persisted org-only chain does NOT contain.
    readAgentTemplateByIdMock.mockResolvedValue({
      ownerLevel: "user",
      ownerId: "user-victim",
    });
    const res = await POST(
      makeReqH({ user: "hi" }, { "x-cinatra-run-token": RUN_TOKEN }),
    );
    expect(res.status).toBe(200);
    const override = await invokeOverride();
    expect(resolveAgentRunMcpActorMock).toHaveBeenCalledTimes(1);
    // Machine-token fallback (never an un-ceilinged OBO mint); #1195 mints it
    // in-bridge.
    expect(override).toEqual(expect.objectContaining({ type: "mcp" }));
    expect(buildLlmMcpServerToolForAgentRunMock).not.toHaveBeenCalled();
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

  it("TOKEN AGREES with body.agent_run_id ⇒ mints for the token-resolved run", async () => {
    readAgentRunByTokenHashMock.mockResolvedValue(PROBE);
    readAgentRunByIdMock.mockResolvedValue(VICTIM_RUN);
    const res = await POST(
      makeReqH(
        { user: "hi", agent_run_id: VICTIM_RUN.id }, // agrees
        { "x-cinatra-run-token": RUN_TOKEN },
      ),
    );
    expect(res.status).toBe(200);
    // Selection still comes from the SERVER-DERIVED id, not the body value.
    expect(readAgentRunByIdMock).toHaveBeenCalledWith(VICTIM_RUN.id);
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
