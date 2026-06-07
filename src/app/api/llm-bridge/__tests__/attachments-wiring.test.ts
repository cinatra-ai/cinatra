/**
 * Bridge end-to-end attachment wiring.
 *
 * Request-bound resolver invariant: ports are built ONLY from a run resolved
 * via the auth-injected x-cinatra-a2a-context-id header. A caller-supplied
 * body.agent_run_id CANNOT select the resolver namespace. If both context
 * and body resolve, they MUST match.
 *
 * Envelope parsing invariant: envelope parsing is OPT-IN via body.user_envelope.
 * Without it, body.user is verbatim. With it, strict-parse failure = 400.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type LlmProviderId = "openai" | "anthropic" | "gemini";

const {
  runResolvedSkillAwareDeterministicLlmTaskMock,
  resolveProviderAdapterMock,
  resolveConfiguredLlmRuntimeMock,
  getLlmMcpCredentialsMock,
  setRunContextMock,
  clearRunContextMock,
  readAgentRunByContextIdMock,
  consoleWarnSpy,
} = vi.hoisted(() => ({
  runResolvedSkillAwareDeterministicLlmTaskMock: vi.fn(
    async (_input: Record<string, unknown>) => ({ text: "ok", artifacts: [] }),
  ),
  resolveProviderAdapterMock: vi.fn(
    async (provider: LlmProviderId): Promise<{ provider: LlmProviderId } | null> => ({
      provider,
    }),
  ),
  resolveConfiguredLlmRuntimeMock: vi.fn(async () => ({
    runtime: { provider: "openai" as LlmProviderId },
    agentId: "test",
    deterministic: false,
  })),
  getLlmMcpCredentialsMock: vi.fn(
    (): { clientId: string; clientSecret: string } | null => null,
  ),
  setRunContextMock: vi.fn(),
  clearRunContextMock: vi.fn(),
  readAgentRunByContextIdMock: vi.fn(),
  consoleWarnSpy: vi.spyOn(console, "warn").mockImplementation(() => {}),
}));

vi.mock("server-only", () => ({}));
vi.mock("@cinatra-ai/llm", () => ({
  runResolvedSkillAwareDeterministicLlmTask:
    runResolvedSkillAwareDeterministicLlmTaskMock,
  resolveProviderAdapter: resolveProviderAdapterMock,
  resolveConfiguredLlmRuntime: resolveConfiguredLlmRuntimeMock,
  getLlmMcpCredentials: getLlmMcpCredentialsMock,
  createLocalSkillShellTool: vi.fn(() => null),
  PreferredProviderUnavailableError: class extends Error {},
  uploadFile: vi.fn(),
}));
vi.mock("@/lib/agent-run-context-registry", () => ({
  setRunContext: setRunContextMock,
  clearRunContext: clearRunContextMock,
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
vi.mock("@/lib/artifacts/provider-file-cache", () => ({
  getCachedProviderFile: vi.fn(),
  putCachedProviderFile: vi.fn(),
}));
vi.mock("@/lib/artifacts/artifact-read", () => ({
  resolveArtifactVersionForServe: vi.fn(),
}));
vi.mock("@/lib/artifacts/local-disk-blob-store", () => ({
  createLocalDiskBlobStore: () => ({ open: vi.fn() }),
}));
vi.mock("@cinatra-ai/agents", async () => {
  const { z } = await import("zod");
  return {
    readAgentRunByContextId: readAgentRunByContextIdMock,
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
const CONTEXT_ID = "ctx-abc";
const ATT1 = {
  artifactId: "a1",
  representationRevisionId: "v1",
  digest: "sha256:abc",
  mime: "application/pdf",
  originKind: "upload" as const,
  filename: "doc.pdf",
};
const ATT2 = {
  artifactId: "a2",
  representationRevisionId: "v2",
  digest: "sha256:def",
  mime: "image/png",
  originKind: "upload" as const,
};

function makeReq(
  body: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
): Request {
  return new Request("http://localhost:3000/api/llm-bridge", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cinatra-bridge-token": BRIDGE_TOKEN,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

function dispatchArg(): Record<string, unknown> {
  const call = runResolvedSkillAwareDeterministicLlmTaskMock.mock.calls[0];
  if (!call) throw new Error("expected dispatch to have been called");
  return call[0] as Record<string, unknown>;
}

beforeEach(async () => {
  vi.clearAllMocks();
  consoleWarnSpy.mockClear();
  process.env.CINATRA_BRIDGE_TOKEN = BRIDGE_TOKEN;
  runResolvedSkillAwareDeterministicLlmTaskMock.mockResolvedValue({
    text: "ok",
    artifacts: [],
  });
  const mod = await import("../route");
  POST = mod.POST;
});

describe("Bridge attachment wiring (request-bound ports)", () => {
  it("LEGACY: no attachments → orchestrate call OMITS both keys (byte-identical)", async () => {
    const res = await POST(makeReq({ user: "hello", agent_run_id: "r1" }));
    expect(res.status).toBe(200);
    const arg = dispatchArg();
    expect("attachments" in arg).toBe(false);
    expect("attachmentResolverPorts" in arg).toBe(false);
    expect(readAgentRunByContextIdMock).not.toHaveBeenCalled();
  });

  it("REQUEST-BOUND: attachments + auth-injected x-cinatra-a2a-context-id → ports scoped to run.orgId", async () => {
    readAgentRunByContextIdMock.mockResolvedValue({
      id: "r1",
      orgId: "org-tenant-A",
    });
    const res = await POST(
      makeReq(
        { user: "see attached", attachments: [ATT1] },
        { "x-cinatra-a2a-context-id": CONTEXT_ID },
      ),
    );
    expect(res.status).toBe(200);
    const arg = dispatchArg();
    expect(arg.attachments).toEqual([ATT1]);
    expect(arg.attachmentResolverPorts).toBeDefined();
    expect(readAgentRunByContextIdMock).toHaveBeenCalledWith(CONTEXT_ID);
  });

  it("FORGED agent_run_id ALONE (no context header) → ports OMITTED", async () => {
    // Caller-supplied agent_run_id MUST NOT be sufficient to select a
    // tenant orgId for the resolver — that's the exfiltration vector.
    const res = await POST(
      makeReq({
        user: "see attached",
        agent_run_id: "forged-r1",
        attachments: [ATT1],
      }),
    );
    expect(res.status).toBe(200);
    const arg = dispatchArg();
    // attachments still pass — Decision A degrades them to manifest in
    // the orchestration entry-resolver.
    expect(arg.attachments).toEqual([ATT1]);
    expect("attachmentResolverPorts" in arg).toBe(false);
  });

  it("MISMATCH between body.agent_run_id and context-id-resolved run → ports OMITTED", async () => {
    readAgentRunByContextIdMock.mockResolvedValue({
      id: "ctx-r1",
      orgId: "org-tenant-A",
    });
    const res = await POST(
      makeReq(
        {
          user: "see attached",
          agent_run_id: "body-r2", // mismatch
          attachments: [ATT1],
        },
        { "x-cinatra-a2a-context-id": CONTEXT_ID },
      ),
    );
    expect(res.status).toBe(200);
    const arg = dispatchArg();
    expect(arg.attachments).toEqual([ATT1]);
    expect("attachmentResolverPorts" in arg).toBe(false);
  });

  it("user_envelope=true: body.user JSON {text,attachments} parsed; merged with body.attachments", async () => {
    readAgentRunByContextIdMock.mockResolvedValue({
      id: "r1",
      orgId: "org-X",
    });
    const res = await POST(
      makeReq(
        {
          user: JSON.stringify({ text: "see resume", attachments: [ATT1] }),
          user_envelope: true,
          attachments: [ATT2],
        },
        { "x-cinatra-a2a-context-id": CONTEXT_ID },
      ),
    );
    expect(res.status).toBe(200);
    const arg = dispatchArg();
    expect(arg.user).toBe("see resume");
    expect(arg.attachments).toEqual([ATT1, ATT2]);
    expect(arg.attachmentResolverPorts).toBeDefined();
  });

  it("user_envelope flag ABSENT: a JSON-shaped user is preserved VERBATIM", async () => {
    const raw = JSON.stringify({ text: "hi" });
    const res = await POST(makeReq({ user: raw, agent_run_id: "r1" }));
    expect(res.status).toBe(200);
    const arg = dispatchArg();
    expect(arg.user).toBe(raw);
    expect("attachments" in arg).toBe(false);
  });

  it("user_envelope=true + invalid JSON → 400 INVALID_USER_ENVELOPE (no silent fallback)", async () => {
    const res = await POST(
      makeReq({ user: "{not json", user_envelope: true }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_USER_ENVELOPE");
    expect(runResolvedSkillAwareDeterministicLlmTaskMock).not.toHaveBeenCalled();
  });

  it("readAgentRunByContextId returns null → ports OMITTED (no cross-tenant default)", async () => {
    readAgentRunByContextIdMock.mockResolvedValue(null);
    const res = await POST(
      makeReq(
        { user: "x", attachments: [ATT1] },
        { "x-cinatra-a2a-context-id": CONTEXT_ID },
      ),
    );
    expect(res.status).toBe(200);
    const arg = dispatchArg();
    expect(arg.attachments).toEqual([ATT1]);
    expect("attachmentResolverPorts" in arg).toBe(false);
  });
});
