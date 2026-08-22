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
 *   - execution serves that runtime WITHOUT resolving an adapter, in the TYPE
 *     shape the caller declared (`outputSchema`) — conforming by type, not by
 *     constraint; the last describe block below pins EXACTLY what that means;
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
import {
  UAT_SENTINEL,
  SCRIPTED_TEST_MODEL,
  runScriptedBridgeCompletion,
} from "./scripted-test-provider";
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

  it("an EXHAUSTED explicit pin stays null — the scripted runtime never answers a pin", async () => {
    enableScriptedDevelopmentRuntime();
    // The caller named the providers it accepts and none resolved. The pin is
    // authoritative: "unavailable" is the answer, not a substitute runtime the
    // caller never asked for.
    expect(await resolveConfiguredLlmRuntime({ preferredProviders: ["openai"] })).toBeNull();
    expect(await resolveConfiguredLlmRuntime({ preferredProviders: ["anthropic", "gemini"] })).toBeNull();
  });

  it("a pin that RESOLVES is unaffected — the pinned provider still wins verbatim", async () => {
    enableScriptedDevelopmentRuntime();
    availability.anthropic = true;
    expect(await resolveConfiguredLlmRuntime({ preferredProviders: ["anthropic"] })).toEqual({
      provider: "anthropic",
      model: "anthropic-configured-default",
    });
  });

  it("the DEFAULT resolution (no pin) is the only arm the scripted runtime serves", async () => {
    enableScriptedDevelopmentRuntime();
    expect(await resolveConfiguredLlmRuntime({ openaiConnection: null })).toEqual({
      provider: "scripted",
      model: SCRIPTED_TEST_MODEL,
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

  it("answers in the TYPE SHAPE the caller declared, so a structured-output step parses", async () => {
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


// ---------------------------------------------------------------------------
// The structured-output contract (cinatra#2910).
//
// The scripted completion is NOT a JSON-Schema implementation, and these cases
// are the honest statement of that: they pin what IS honored and — just as
// deliberately — DOCUMENT what is not, so a caller reads the boundary here
// instead of discovering it in a validator. Anything outside the honored set
// yields a minimal conforming-BY-TYPE value.
// ---------------------------------------------------------------------------
describe("the scripted structured-output contract — conforming by TYPE, not by constraint", () => {
  /** Parse the completion's text for one declared schema. */
  function scriptedOutputFor(outputSchema: Record<string, unknown>): unknown {
    enableScriptedDevelopmentRuntime();
    const response = runScriptedBridgeCompletion({ user: "produce it", outputSchema });
    return JSON.parse(response.text ?? "");
  }

  describe("HONORED", () => {
    it("`const` is the pinned value and `enum` is its FIRST member", () => {
      expect(
        scriptedOutputFor({
          type: "object",
          required: ["kind", "status"],
          properties: {
            kind: { const: "report" },
            status: { type: "string", enum: ["draft", "published"] },
          },
        }),
      ).toEqual({ kind: "report", status: "draft" });
    });

    it("`required` names the members; an object without it takes every declared property", () => {
      expect(
        Object.keys(
          scriptedOutputFor({
            type: "object",
            properties: { a: { type: "boolean" }, b: { type: "integer" } },
          }) as Record<string, unknown>,
        ).sort(),
      ).toEqual(["a", "b"]);
    });

    it("a required name with NO declared property schema still appears", () => {
      expect(
        scriptedOutputFor({ type: "object", required: ["undeclared"], properties: {} }),
      ).toEqual({ undeclared: expect.stringContaining(UAT_SENTINEL) });
    });

    it("each scalar type takes its minimal value and every string carries the sentinel", () => {
      expect(
        scriptedOutputFor({
          type: "object",
          required: ["s", "n", "i", "b", "z"],
          properties: {
            s: { type: "string" },
            n: { type: "number" },
            i: { type: "integer" },
            b: { type: "boolean" },
            z: { type: "null" },
          },
        }),
      ).toEqual({
        s: expect.stringContaining(UAT_SENTINEL),
        n: 0,
        i: 0,
        b: false,
        z: null,
      });
    });

    it("`oneOf` / `anyOf` take their FIRST member", () => {
      expect(
        scriptedOutputFor({
          type: "object",
          required: ["one", "any"],
          properties: {
            one: { oneOf: [{ type: "boolean" }, { type: "string" }] },
            any: { anyOf: [{ type: "integer" }, { type: "string" }] },
          },
        }),
      ).toEqual({ one: false, any: 0 });
    });
  });

  describe("NOT honored — documented, not implied", () => {
    it("`allOf` is the FIRST member only: later members' properties are NOT composed in", () => {
      // A caller that splits one object across `allOf` members gets only the
      // first member's shape. This is the cap, stated: it is not a merge.
      expect(
        scriptedOutputFor({
          allOf: [
            { type: "object", required: ["first"], properties: { first: { type: "string" } } },
            { type: "object", required: ["second"], properties: { second: { type: "string" } } },
          ],
        }),
      ).toEqual({ first: expect.stringContaining(UAT_SENTINEL) });
    });

    it("numeric bounds are IGNORED — a number is always 0, even under `minimum`", () => {
      expect(
        scriptedOutputFor({
          type: "object",
          required: ["score"],
          properties: { score: { type: "integer", minimum: 5, maximum: 10, multipleOf: 5 } },
        }),
      ).toEqual({ score: 0 });
    });

    it("`minItems` is IGNORED — an array is always exactly one element", () => {
      const out = scriptedOutputFor({
        type: "object",
        required: ["rows"],
        properties: { rows: { type: "array", minItems: 3, items: { type: "integer" } } },
      }) as { rows: unknown[] };
      expect(out.rows).toEqual([0]);
    });

    it("`minLength` / `pattern` / `format` are IGNORED — a string is the sentinel string", () => {
      const out = scriptedOutputFor({
        type: "object",
        required: ["code"],
        properties: {
          code: { type: "string", minLength: 64, pattern: "^[0-9]+$", format: "uuid" },
        },
      }) as { code: string };
      expect(out.code).toContain(UAT_SENTINEL);
      expect(out.code).not.toMatch(/^[0-9]+$/);
    });

    it("DEPTH CAP: past six levels a node yields a STRING whatever type it declared", () => {
      // Eight nested objects, each `{next: <the next one>}`. The root is
      // produced at depth 0, so the object reached by the Nth `next` is
      // produced at depth N — and the cap (`depth > 6`) bites at depth 7.
      // The bound is what keeps a `$ref`-recursive schema terminating; the
      // cost is that a node stops matching its own declaration there, and that
      // cost is DOCUMENTED here rather than implied away.
      let schema: Record<string, unknown> = { type: "object", properties: {} };
      for (let i = 0; i < 8; i += 1) {
        schema = { type: "object", required: ["next"], properties: { next: schema } };
      }
      const out = scriptedOutputFor(schema);

      const step = (value: unknown, times: number): unknown => {
        let node = value;
        for (let i = 0; i < times; i += 1) node = (node as Record<string, unknown>).next;
        return node;
      };

      // Depth 6 — the last honored level: still the declared object.
      expect(typeof step(out, 6)).toBe("object");
      // Depth 7 — past the cap: a declared OBJECT comes back as a string.
      expect(typeof step(out, 7)).toBe("string");
      expect(step(out, 7)).toContain(UAT_SENTINEL);
    });
  });
});
