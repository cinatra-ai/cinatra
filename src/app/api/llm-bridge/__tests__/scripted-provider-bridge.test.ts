/**
 * cinatra#2910 — the bridge serves an agent's model call from the scripted test
 * provider on a credential-free stack.
 *
 * WHAT WAS BROKEN. `POST /api/llm-bridge` is the surface a WayFlow agent run
 * performs its model call on. With `CINATRA_TEST_LLM_PROVIDER=scripted` set and
 * no provider connector registered, runtime resolution returned `null` and the
 * route answered `503 {code:"NO_LLM_PROVIDER"}` — so no credential-free run
 * could reach an artifact, while the boolean availability helpers reported the
 * instance as configured.
 *
 * THE SEAM THIS FILE EXERCISES. The `@cinatra-ai/llm` barrel is unresolvable in
 * the root vitest sandbox (every bridge suite mocks it), so the two entry
 * points are stood in for HERE — but they delegate to the REAL scripted
 * functions (`@cinatra-ai/llm/scripted-test-provider`, aliased to source),
 * which are the same functions `packages/llm/src/index.ts` calls: the resolver
 * returns `resolveScriptedLlmRuntime()` after real adapter resolution finds
 * nothing, and the executor returns `runScriptedBridgeCompletion(...)` for a
 * scripted runtime. What is proven here is therefore the ROUTE's behaviour on
 * that runtime — that it does not 503, that it answers with the completion,
 * that its provider-keyed reads survive a runtime that is not a provider, and
 * that its auth and its production fence are untouched. The resolver/executor
 * wiring itself is pinned in `packages/llm/src/scripted-bridge-runtime.test.ts`
 * against the real barrel.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@cinatra-ai/llm", async () => {
  const scripted = await import("@cinatra-ai/llm/scripted-test-provider");
  return {
    // Credential-free stack: NO provider adapter resolves, so the barrel's
    // resolver falls through to its last line — the scripted helper.
    resolveConfiguredLlmRuntime: vi.fn(async () => scripted.resolveScriptedLlmRuntime()),
    runResolvedSkillAwareDeterministicLlmTask: vi.fn(
      async (input: {
        runtime: { provider: string; model: string };
        system?: string;
        user?: string;
        outputSchema?: Record<string, unknown>;
      }) => {
        if (scripted.isScriptedLlmRuntime(input.runtime)) {
          return scripted.runScriptedBridgeCompletion({
            system: input.system,
            user: input.user,
            outputSchema: input.outputSchema,
            model: input.runtime.model,
          });
        }
        // The real executor resolves an adapter here; on this stack there is
        // none, which is what made the scripted path necessary.
        throw new Error("no LLM provider adapter is resolvable");
      },
    ),
    resolveImplicitGlobalProviderOrder: vi.fn(() => ({
      storedProvider: "openai",
      policy: "exact" as const,
      providers: ["openai"],
    })),
    createLocalSkillShellTool: vi.fn(() => null),
    buildLlmMcpServerToolForAgentRun: vi.fn(async () => null),
    buildLlmMcpServerTool: vi.fn(async () => null),
    resolveProviderAdapter: vi.fn(async () => null),
    openAiModelSupportsShell: (modelId: string) =>
      modelId !== "gpt-5" && modelId !== "gpt-5-mini",
    getLlmMcpCredentials: vi.fn(() => null),
    PreferredProviderUnavailableError: class PreferredProviderUnavailableError extends Error {
      requestedProvider: string;
      reason: string;
      constructor(requestedProvider: string, reason: string) {
        super(`Preferred provider ${requestedProvider} unavailable (${reason})`);
        this.requestedProvider = requestedProvider;
        this.reason = reason;
      }
    },
  };
});

vi.mock("@/lib/a2a-auth", () => ({
  verifyLangGraphBridgeToken: vi.fn(async () => ({
    ok: false,
    response: new Response("forbidden", { status: 403 }),
  })),
}));

vi.mock("@cinatra-ai/skills", () => ({
  resolveDeclaredSkillEdgeForExtensionDir: vi.fn(async () => null),
  getCustomSkillForCurrentUserAndAgent: vi.fn(async () => null),
}));

vi.mock("@/lib/agents-store", () => ({
  getAssignedSkillIdsForAgent: vi.fn(async () => []),
}));

vi.mock("@cinatra-ai/agents", async () => {
  const { z } = await import("zod");
  return {
    readAgentRunByContextId: vi.fn(async () => null),
    readAgentRunById: vi.fn(async () => null),
    readAgentRunByTokenHash: vi.fn(async () => null),
    readAgentRunTokenHashById: vi.fn(async () => null),
    readAgentTemplateById: vi.fn(async () => null),
    canProviderSatisfyCapability: (provider: string, capability: string): boolean =>
      capability === "native_mcp"
        ? provider === "openai" || provider === "anthropic"
        : capability === "media_input"
          ? provider === "gemini"
          : true,
    describeCapabilityRequirement: () => "capability unavailable",
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
      openai: ["gpt-5", "gpt-5-mini", "gpt-4.1"],
      anthropic: ["claude-sonnet-4-6"],
      gemini: ["gemini-2.5-flash"],
    },
  };
});

import { UAT_SENTINEL } from "@cinatra-ai/llm/scripted-test-provider";

const BRIDGE_TOKEN = "scripted-bridge-token-32chars-AAA";

const ORIGINAL_ENV = {
  flag: process.env.CINATRA_TEST_LLM_PROVIDER,
  runtimeMode: process.env.CINATRA_RUNTIME_MODE,
  bridgeToken: process.env.CINATRA_BRIDGE_TOKEN,
};

let POST: (req: Request) => Promise<Response>;

/** A minimal agent model call, exactly as WayFlow performs one. */
function bridgeRequest(
  body: Record<string, unknown>,
  token: string = BRIDGE_TOKEN,
): Request {
  return new Request("http://localhost:3000/api/llm-bridge", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cinatra-bridge-token": token,
    },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.CINATRA_BRIDGE_TOKEN = BRIDGE_TOKEN;
  // The credential-free DEVELOPMENT stack the scripted provider exists for.
  process.env.CINATRA_TEST_LLM_PROVIDER = "scripted";
  process.env.CINATRA_RUNTIME_MODE = "development";
  const mod = await import("../route");
  POST = mod.POST;
});

afterEach(() => {
  process.env.CINATRA_TEST_LLM_PROVIDER = ORIGINAL_ENV.flag;
  process.env.CINATRA_RUNTIME_MODE = ORIGINAL_ENV.runtimeMode;
  process.env.CINATRA_BRIDGE_TOKEN = ORIGINAL_ENV.bridgeToken;
  if (ORIGINAL_ENV.flag === undefined) delete process.env.CINATRA_TEST_LLM_PROVIDER;
  if (ORIGINAL_ENV.runtimeMode === undefined) delete process.env.CINATRA_RUNTIME_MODE;
  if (ORIGINAL_ENV.bridgeToken === undefined) delete process.env.CINATRA_BRIDGE_TOKEN;
});

describe("/api/llm-bridge under the scripted test provider (cinatra#2910)", () => {
  it("answers a model call with a scripted completion instead of 503 NO_LLM_PROVIDER", async () => {
    const res = await POST(bridgeRequest({ user: "write the report", agent_id: "reporter" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { output?: string };
    expect(String(body.output)).toContain(UAT_SENTINEL);
  });

  it("answers a STRUCTURED step in the shape the agent declared", async () => {
    const res = await POST(
      bridgeRequest({
        user: "produce the artifact",
        agent_id: "reporter",
        output_schema: {
          type: "object",
          required: ["title", "body"],
          properties: { title: { type: "string" }, body: { type: "string" } },
        },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title?: string; body?: string };
    expect(Object.keys(body).sort()).toEqual(["body", "title"]);
    expect(String(body.title)).toContain(UAT_SENTINEL);
  });

  it("AUTH IS UNTOUCHED: a wrong bridge token is still 403, scripted or not", async () => {
    const res = await POST(
      bridgeRequest({ user: "write the report" }, "wrong-token-32chars-BBBBBBBBBBB"),
    );
    expect(res.status).toBe(403);
  });

  it("FENCE: a production runtime mode refuses — no scripted output, no 2xx", async () => {
    process.env.CINATRA_RUNTIME_MODE = "production";
    const res = await POST(bridgeRequest({ user: "write the report" }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("NO_LLM_PROVIDER");
    expect(JSON.stringify(body)).not.toContain(UAT_SENTINEL);
  });

  it("NEGATIVE CONTROL: with the flag OFF the route still refuses with NO_LLM_PROVIDER", async () => {
    delete process.env.CINATRA_TEST_LLM_PROVIDER;
    const res = await POST(bridgeRequest({ user: "write the report" }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code?: string; provider?: string };
    expect(body.code).toBe("NO_LLM_PROVIDER");
    expect(body.provider).toBe("openai");
  });
});
