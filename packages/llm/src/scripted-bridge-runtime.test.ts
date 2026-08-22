/**
 * cinatra#2910 — the scripted test provider serves the BRIDGE path.
 *
 * `/api/llm-bridge` is the surface an agent run performs its model call on. It
 * resolves a runtime (`resolveConfiguredLlmRuntime`) and then executes it
 * (`runResolvedSkillAwareDeterministicLlmTask`); both resolved a real provider
 * adapter and nothing else, so a credential-free stack with
 * `CINATRA_TEST_LLM_PROVIDER=scripted` answered every agent model call with
 * `503 NO_LLM_PROVIDER` — the chat surface had a scripted seam, the agent-run
 * surface had none.
 *
 * What these pin:
 *   - resolution yields the scripted runtime when the flag is on and NO adapter
 *     resolves (it used to yield `null`);
 *   - it stays a LAST RESORT — a configured provider still wins;
 *   - execution serves that runtime WITHOUT resolving an adapter, in the shape
 *     the caller declared (`outputSchema`);
 *   - the production fence bites on BOTH new branches: a set flag outside an
 *     explicit development runtime throws before any scripted output exists;
 *   - with the flag OFF nothing changes (the negative control).
 *
 * Mock topology mirrors `resolve-configured-runtime-exact-binding.test.ts` —
 * per-provider availability is driven through the connector adapter surface.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./mcp-access", () => ({
  withoutReservedFirstPartyLabelTools: vi.fn((tools: unknown[]) => tools),
  buildLlmMcpServerTool: vi.fn(async () => null),
  buildExternalMcpServerTools: vi.fn(async () => []),
}));

vi.mock("@/lib/external-mcp-registry", () => ({
  buildRegisteredExternalMcpServerTools: vi.fn(async () => []),
  buildSingleExternalMcpTool: vi.fn(async () => null),
}));

// Per-provider availability: `resolveProviderAdapter(provider)` resolves an
// adapter iff the connector-registered adapter surface is present AND its
// `createAdapter()` returns non-null. A credential-free stack is every flag
// false — the state this issue is about.
const availability = { openai: false, gemini: false, anthropic: false } as Record<string, boolean>;
const createAdapter = vi.fn(async (providerId: string) => ({
  provider: providerId,
  defaultModel: `${providerId}-configured-default`,
}));
vi.mock("@/lib/llm-provider-surfaces", () => ({
  getLlmProviderAdapterSurface: vi.fn((providerId: string) =>
    availability[providerId]
      ? {
          abiVersion: 1 as const,
          providerId,
          createAdapter: async () => createAdapter(providerId),
        }
      : null,
  ),
  getLlmProviderSurface: vi.fn(() => null),
  requireLlmProviderSurface: vi.fn((providerId: string) => {
    throw new Error(`The "${providerId}" LLM provider connector is not installed/active`);
  }),
  listLlmProviderSurfaces: vi.fn(() => []),
}));

const openaiConnectionMock = vi.fn(async () => null as { apiKey: string } | null);
vi.mock("@/lib/connector-modules.server", () => ({
  loadConnectorModule: vi.fn(async (slug: string) =>
    slug === "openai-connector"
      ? { getConfiguredOpenAIConnection: openaiConnectionMock }
      : null,
  ),
}));

vi.mock("@/lib/database", () => ({
  readDefaultLlmProviderFromDatabase: vi.fn(() => "openai"),
  readDefaultImageProviderFromDatabase: vi.fn(() => null),
  readLlmProviderFailoverPolicyFromDatabase: vi.fn(() => "exact"),
}));

// Break the circular workspace self-import (./index -> ./tools/skills ->
// @cinatra-ai/skills -> @cinatra-ai/llm).
vi.mock("./tools/skills", () => ({
  buildSkillTools: vi.fn().mockResolvedValue([]),
  buildSkillContext: vi.fn().mockResolvedValue(""),
  readSkillContent: vi.fn().mockResolvedValue(null),
  createShellTool: vi.fn(),
  createLocalSkillShellTool: vi.fn(),
  createMcpServerTool: vi.fn(),
  createWebSearchTool: vi.fn(),
  buildMcpTools: vi.fn(),
}));

vi.mock("@cinatra-ai/metric-usage-api", () => ({
  emitUsageEvent: vi.fn(),
}));

import {
  resolveConfiguredLlmRuntime,
  runResolvedDeterministicLlmTask,
  runResolvedSkillAwareDeterministicLlmTask,
} from "./index";
import { UAT_SENTINEL, SCRIPTED_TEST_MODEL } from "./scripted-test-provider";
import type { ResolvedInjectedSkillSet } from "@cinatra-ai/skills/injection";
import { POLICY_VERSION, type ActorContext } from "@/lib/authz/actor-context";

/**
 * The scripted branch returns BEFORE the injection contract is consulted, so
 * this set is never read. The cast says exactly that rather than standing up a
 * real resolved set (which would need ports and a catalog these cases have no
 * use for).
 */
const NO_INJECTED_SKILLS = {
  members: [],
  dropped: [],
} as unknown as ResolvedInjectedSkillSet;

const ORIGINAL_ENV = {
  flag: process.env.CINATRA_TEST_LLM_PROVIDER,
  runtimeMode: process.env.CINATRA_RUNTIME_MODE,
  actor: process.env.CINATRA_REQUIRE_ACTOR_CONTEXT,
};

/** The credential-free DEVELOPMENT stack the scripted provider exists for. */
function enableScriptedDevelopmentRuntime() {
  process.env.CINATRA_TEST_LLM_PROVIDER = "scripted";
  process.env.CINATRA_RUNTIME_MODE = "development";
  // `NODE_ENV` is read-only at the type level; the stub is the supported seam.
  vi.stubEnv("NODE_ENV", "test");
}

const ACTOR: ActorContext = {
  principalType: "InternalWorker",
  principalId: "scripted-bridge-runtime-test",
  authSource: "worker",
  policyVersion: POLICY_VERSION,
};

beforeEach(() => {
  vi.clearAllMocks();
  availability.openai = false;
  availability.gemini = false;
  availability.anthropic = false;
  openaiConnectionMock.mockResolvedValue(null);
  delete process.env.CINATRA_TEST_LLM_PROVIDER;
  process.env.CINATRA_RUNTIME_MODE = "development";
});

afterEach(() => {
  vi.unstubAllEnvs();
  process.env.CINATRA_TEST_LLM_PROVIDER = ORIGINAL_ENV.flag;
  process.env.CINATRA_RUNTIME_MODE = ORIGINAL_ENV.runtimeMode;
  process.env.CINATRA_REQUIRE_ACTOR_CONTEXT = ORIGINAL_ENV.actor;
  if (ORIGINAL_ENV.flag === undefined) delete process.env.CINATRA_TEST_LLM_PROVIDER;
  if (ORIGINAL_ENV.runtimeMode === undefined) delete process.env.CINATRA_RUNTIME_MODE;
  if (ORIGINAL_ENV.actor === undefined) delete process.env.CINATRA_REQUIRE_ACTOR_CONTEXT;
});

describe("resolveConfiguredLlmRuntime — the scripted bridge runtime (cinatra#2910)", () => {
  it("yields the scripted runtime when the flag is on and NO adapter resolves", async () => {
    enableScriptedDevelopmentRuntime();
    expect(await resolveConfiguredLlmRuntime()).toEqual({
      provider: "scripted",
      model: SCRIPTED_TEST_MODEL,
    });
  });

  it("NEGATIVE CONTROL: with the flag OFF the same credential-free stack still resolves null", async () => {
    expect(await resolveConfiguredLlmRuntime()).toBeNull();
  });

  it("LAST RESORT: a configured provider still wins over the scripted runtime", async () => {
    enableScriptedDevelopmentRuntime();
    availability.openai = true;
    openaiConnectionMock.mockResolvedValue({ apiKey: "sk-openai" });
    expect(await resolveConfiguredLlmRuntime()).toEqual({
      provider: "openai",
      connection: { apiKey: "sk-openai" },
      model: "openai-configured-default",
    });
  });

  it("FENCE: a production-shaped runtime REFUSES rather than resolving a scripted runtime", async () => {
    process.env.CINATRA_TEST_LLM_PROVIDER = "scripted";
    process.env.CINATRA_RUNTIME_MODE = "production";
    await expect(resolveConfiguredLlmRuntime()).rejects.toThrow(
      /must NEVER run outside development/,
    );
  });

  it("FENCE: NODE_ENV=production refuses even under an explicit development runtime mode", async () => {
    process.env.CINATRA_TEST_LLM_PROVIDER = "scripted";
    process.env.CINATRA_RUNTIME_MODE = "development";
    vi.stubEnv("NODE_ENV", "production");
    await expect(resolveConfiguredLlmRuntime()).rejects.toThrow(
      /must NEVER run outside development/,
    );
  });
});

describe("executing the scripted runtime (cinatra#2910)", () => {
  it("serves a deterministic completion WITHOUT resolving any provider adapter", async () => {
    enableScriptedDevelopmentRuntime();
    const runtime = await resolveConfiguredLlmRuntime();
    const response = await runResolvedSkillAwareDeterministicLlmTask({
      runtime: runtime!,
      system: "you are an agent",
      user: "write the report",
      injectedSkills: NO_INJECTED_SKILLS,
      actorContext: ACTOR,
    });
    expect(response.text).toContain(UAT_SENTINEL);
    expect(response.model).toBe(SCRIPTED_TEST_MODEL);
    // The whole point: no adapter was resolved anywhere along the path.
    expect(createAdapter).not.toHaveBeenCalled();
  });

  it("answers in the SHAPE the caller declared, so a structured-output step parses", async () => {
    enableScriptedDevelopmentRuntime();
    const runtime = await resolveConfiguredLlmRuntime();
    const response = await runResolvedSkillAwareDeterministicLlmTask({
      runtime: runtime!,
      system: "",
      user: "produce the artifact",
      injectedSkills: NO_INJECTED_SKILLS,
      actorContext: ACTOR,
      outputSchema: {
        type: "object",
        required: ["title", "sections", "published"],
        properties: {
          title: { type: "string" },
          sections: { type: "array", items: { type: "string" } },
          published: { type: "boolean" },
          ignored: { type: "string" },
        },
      },
    });
    const parsed = JSON.parse(response.text ?? "");
    expect(Object.keys(parsed).sort()).toEqual(["published", "sections", "title"]);
    expect(parsed.title).toContain(UAT_SENTINEL);
    expect(parsed.sections).toHaveLength(1);
    expect(parsed.published).toBe(false);
  });

  it("the single-shot sibling entry point serves it too", async () => {
    enableScriptedDevelopmentRuntime();
    const runtime = await resolveConfiguredLlmRuntime();
    const response = await runResolvedDeterministicLlmTask({
      runtime: runtime!,
      system: "",
      user: "classify this",
      actorContext: ACTOR,
    });
    expect(response.text).toContain(UAT_SENTINEL);
    expect(createAdapter).not.toHaveBeenCalled();
  });

  it("FENCE: execution refuses under a production runtime, before any scripted output exists", async () => {
    enableScriptedDevelopmentRuntime();
    const runtime = await resolveConfiguredLlmRuntime();
    // The runtime was minted on a development stack; the process is then
    // production-shaped when the call is made.
    process.env.CINATRA_RUNTIME_MODE = "production";
    await expect(
      runResolvedSkillAwareDeterministicLlmTask({
        runtime: runtime!,
        system: "",
        user: "write the report",
        injectedSkills: NO_INJECTED_SKILLS,
        actorContext: ACTOR,
      }),
    ).rejects.toThrow(/must NEVER run outside development/);
  });

  it("keeps the actor-context gate: a scripted call with no frame fails like a provider call", async () => {
    enableScriptedDevelopmentRuntime();
    process.env.CINATRA_REQUIRE_ACTOR_CONTEXT = "true";
    const runtime = await resolveConfiguredLlmRuntime();
    await expect(
      runResolvedSkillAwareDeterministicLlmTask({
        runtime: runtime!,
        system: "",
        user: "write the report",
        injectedSkills: NO_INJECTED_SKILLS,
      }),
    ).rejects.toThrow(/requires actorContext/);
  });

  it("a PINNED provider is still honored (and its unavailability still reported)", async () => {
    enableScriptedDevelopmentRuntime();
    const runtime = await resolveConfiguredLlmRuntime();
    await expect(
      runResolvedSkillAwareDeterministicLlmTask({
        runtime: runtime!,
        preferredProvider: "anthropic",
        system: "",
        user: "write the report",
        injectedSkills: NO_INJECTED_SKILLS,
        actorContext: ACTOR,
      }),
    ).rejects.toThrow(/unavailable/);
  });
});
