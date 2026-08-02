/**
 * REGRESSION PIN (cinatra#2335 AC1): the object classifier passes NO explicit
 * model to the resolved provider's adapter.
 *
 * ## The bug this pins closed
 *
 * `/configuration/llm` used to render an "Objects classification" row that
 * stored a BARE model string under the metadata key
 * `connector_config:objects_classification_model` (hardcoded fallback
 * `"gpt-4o-mini"`, options hardcoded to five OpenAI `gpt-4*` ids). Every
 * `classifyObject` caller read that key and forwarded it as
 * `{ model }`, and `packages/llm` forwards `input.model` VERBATIM to whichever
 * adapter the runtime resolved. On an Anthropic-default instance (possible
 * since the setup-time provider choice, #2213) the Anthropic adapter therefore
 * received an OpenAI model id it cannot serve — a per-call provider failure
 * that made every un-hinted `objects_save` fail closed and refuse the write.
 *
 * The override is retired: `classifyObject` no longer takes a model option and
 * the read/write DB helpers are deleted, so each adapter applies its own
 * `input.model ?? configuredModel` fallback and the call always lands on a
 * model the resolved provider actually serves.
 *
 * ## What this test really runs
 *
 * The REAL classifier module (`../classifier`) and the REAL `objects_save`
 * handler run. `@cinatra-ai/llm` is a double, because its barrel is not
 * loadable in this package's sandbox — but the double is deliberately THIN: it
 * reproduces the two production lines that matter (resolve the runtime, then
 * `adapter.generate({ …, model: input.model, … })`) and delegates to a fake
 * adapter per provider. `parseStructuredJson` is the REAL implementation.
 *
 * Three guards keep the double from silently drifting away from production:
 *  - the classifier's own call object is asserted to carry NO `model` PROPERTY
 *    at all (`not.toHaveProperty`), not merely an undefined one;
 *  - a source-text pin on `packages/llm/src/index.ts` asserting the adapter
 *    call still forwards `model: input.model` verbatim;
 *  - a NEGATIVE CONTROL proving the fake Anthropic adapter genuinely rejects
 *    `gpt-4o-mini` — i.e. the harness would have caught the old behaviour and
 *    is not passing vacuously. (Only the ANTHROPIC arm can be a negative
 *    control: OpenAI genuinely serves `gpt-4o-mini`, which is precisely why the
 *    override went unnoticed until an instance could be Anthropic-default.)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

vi.mock("server-only", () => ({}));

const TYPE_ID = "@cinatra-ai/entity-contacts:contact";

/**
 * The fake provider adapters + the shared recording state.
 *
 * Each fake mirrors the SHAPE of the real connector-owned adapters: a
 * configured default model plus `const resolvedModel = input.model ?? model`
 * (anthropic-connector `src/adapter/anthropic-adapter.ts`), and a catalog the
 * provider can actually serve — an id outside it is a per-call failure, which
 * is exactly how a `gpt-4o-mini` override behaved against Anthropic.
 */
const h = vi.hoisted(() => {
  const FAKE_ADAPTERS: Record<
    string,
    { configuredModel: string; catalog: string[] }
  > = {
    anthropic: {
      configuredModel: "claude-sonnet-4-5",
      catalog: ["claude-opus-4-8", "claude-sonnet-4-5", "claude-haiku-4-5"],
    },
    openai: {
      configuredModel: "gpt-5-mini",
      // `gpt-4o-mini` IS in OpenAI's catalog — the retired override was a
      // no-op-shaped bug there, which is exactly why it survived until an
      // instance could be Anthropic-default.
      catalog: ["gpt-5.5", "gpt-5", "gpt-5-mini", "gpt-4o-mini"],
    },
  };

  const state = {
    /** Which provider the operator stored as the instance default. */
    provider: "anthropic",
    /** Every adapter.generate() call: what model (if any) the adapter was handed. */
    generateCalls: [] as Array<{
      provider: string;
      explicitModel: unknown;
      resolvedModel: string;
    }>,
    /**
     * The raw request objects the classifier handed to
     * `runResolvedDeterministicLlmTask` — asserted for the ABSENCE of a `model`
     * PROPERTY (not merely an undefined value).
     */
    classifierTaskInputs: [] as Array<Record<string, unknown>>,
    /**
     * Every connector-config key read while a save runs. The legacy
     * `objects_classification_model` row is SEEDED below and must never appear
     * here — it is left inert by design (no cleanup migration, #2335).
     */
    connectorConfigReads: [] as string[],
  };

  function fakeGenerate(provider: string, input: Record<string, unknown>) {
    const adapter = FAKE_ADAPTERS[provider];
    const explicitModel = input.model;
    const resolvedModel = (explicitModel as string | undefined) ?? adapter.configuredModel;
    state.generateCalls.push({ provider, explicitModel, resolvedModel });
    if (!adapter.catalog.includes(resolvedModel)) {
      throw new Error(
        `[fake-${provider}] model "${resolvedModel}" is not in this provider's catalog`,
      );
    }
    return {
      text: JSON.stringify({
        objectTypeId: TYPE_ID,
        confidence: 0.95,
        normalizedData: JSON.stringify({ name: "Acme" }),
        isNewType: false,
        inferredTypeName: "contact",
        inferredCategory: "profile",
        canonicalKeys: null,
      }),
    };
  }

  return { FAKE_ADAPTERS, state, fakeGenerate };
});

vi.mock("@/lib/objects-store", () => ({
  upsertObjectAndEnqueue: vi.fn(),
  getObjectById: vi.fn(),
  listObjectsByFilter: vi.fn(),
  softDeleteObject: vi.fn(),
}));

vi.mock("@/lib/objects-dual-write", () => ({
  shadowUpsertObject: vi.fn(),
}));

// Host-side write gate the save path lazy-imports; irrelevant to the model
// contract under test, so it allows (same stand-in the scope-visibility suite
// uses).
vi.mock("@/lib/objects/draftable-lock-gate", () => ({
  assertDraftableWriteAllowed: async () => {},
}));

vi.mock("../graphiti-client", () => ({
  addEpisode: vi.fn(async () => ({ uuid: "ep-1", episode_id: "ep-1" })),
  deleteEpisode: vi.fn(async () => ({ ok: true })),
  searchNodes: vi.fn(async () => ({ nodes: [] })),
  getEpisodes: vi.fn(async () => ({ episodes: [] })),
  identityHashToUuid: (hash: string, _g: string) => `uuid-${hash}`,
}));

/**
 * The SEEDED legacy metadata row. An install that used the retired admin select
 * still carries `connector_config:objects_classification_model = "gpt-4o-mini"`.
 * This mock serves it — and the assertions below prove nothing ever asks for it.
 */
vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: vi.fn((key: string, fallback: unknown) => {
    h.state.connectorConfigReads.push(key);
    return key === "objects_classification_model" ? "gpt-4o-mini" : fallback;
  }),
}));

vi.mock("@cinatra-ai/llm", async () => {
  // The REAL structured-JSON extractor (a dependency-free leaf).
  const { parseStructuredJson } = await import("../../../llm/src/structured-json");
  return {
    // Mirrors resolveConfiguredLlmRuntime's EXACT binding to the stored
    // provider (packages/llm/src/index.ts + registry.ts).
    resolveConfiguredLlmRuntime: vi.fn(async () => ({ provider: h.state.provider })),
    // Mirrors runResolvedDeterministicLlmTask → runDeterministicLlmTask: the
    // runtime's provider selects the adapter and `input.model` is forwarded
    // verbatim (pinned against the real source by the drift test below).
    runResolvedDeterministicLlmTask: vi.fn(
      async (input: {
        runtime: { provider: string };
        system: string;
        user: string;
        model?: string;
        outputSchema?: Record<string, unknown>;
        maxSteps?: number;
        maxOutputTokens?: number;
        logLabel?: string;
      }) => {
        h.state.classifierTaskInputs.push(input as unknown as Record<string, unknown>);
        return h.fakeGenerate(input.runtime.provider, {
          system: input.system,
          prompt: input.user,
          model: input.model,
          outputSchema: input.outputSchema,
          maxSteps: input.maxSteps,
          maxTokens: input.maxOutputTokens,
          logLabel: input.logLabel,
        });
      },
    ),
    parseStructuredJson,
  };
});

import { createObjectsPrimitiveHandlers } from "../mcp/handlers";
import { upsertObjectAndEnqueue } from "@/lib/objects-store";
import { objectTypeRegistry } from "../registry";

const mockUpsert = upsertObjectAndEnqueue as unknown as ReturnType<typeof vi.fn>;

const ACTOR = {
  actorType: "model",
  source: "agent",
  ...({ orgId: "org-1", agentId: "a1", runId: "r1" } as unknown as Record<string, unknown>),
} as never;

function makeRecord(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "obj-1",
    type: TYPE_ID,
    parentId: null,
    parentType: null,
    data: { name: "Acme" },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    createdBy: null,
    orgId: "org-1",
    source: "agent",
    runId: "r1",
    agentId: "a1",
    packageVersion: null,
    agentSpecVersion: null,
    version: 1,
    deletedAt: null,
    ...overrides,
  };
}

/** An UN-HINTED save: no typeHint, so the classifier's static fast-path is
 *  skipped and the LLM path (the one that used to carry the override) runs. */
function unhintedSave() {
  const handlers = createObjectsPrimitiveHandlers();
  return handlers.objects_save({
    primitiveName: "objects_save",
    input: { rawData: { name: "Acme", domain: "acme.test" } },
    actor: ACTOR,
    mode: "agentic",
  } as never);
}

beforeEach(() => {
  mockUpsert.mockReset();
  mockUpsert.mockReturnValue(makeRecord());
  h.state.generateCalls.length = 0;
  h.state.classifierTaskInputs.length = 0;
  h.state.connectorConfigReads.length = 0;
  objectTypeRegistry._clearForTests();
  objectTypeRegistry.register(
    { type: TYPE_ID, category: "record", description: "Contact" } as never,
    "@cinatra-ai/entity-contacts",
  );
});

describe("classifier model override retired (#2335 AC1)", () => {
  for (const provider of ["anthropic", "openai"] as const) {
    it(`un-hinted objects_save on an ${provider}-default instance: the adapter gets NO explicit model and the write persists`, async () => {
      h.state.provider = provider;

      const res = await unhintedSave();

      // The classifier really went down the LLM path (not the static fast-path).
      expect(h.state.generateCalls).toHaveLength(1);
      const call = h.state.generateCalls[0];
      expect(call.provider).toBe(provider);

      // AC1: the classifier's own request object carries no `model` PROPERTY —
      // asserted on presence, not on an undefined value.
      expect(h.state.classifierTaskInputs).toHaveLength(1);
      expect(h.state.classifierTaskInputs[0]).not.toHaveProperty("model");

      // AC1: and therefore NO explicit model reaches the adapter.
      expect(call.explicitModel).toBeUndefined();

      // …so the adapter's own fallback picks a model it can actually serve.
      expect(call.resolvedModel).toBe(h.FAKE_ADAPTERS[provider].configuredModel);
      expect(h.FAKE_ADAPTERS[provider].catalog).toContain(call.resolvedModel);

      // AC1: persistence succeeds on BOTH providers.
      expect(mockUpsert).toHaveBeenCalledOnce();
      expect(mockUpsert.mock.calls[0][0].upsertInput.type).toBe(TYPE_ID);
      expect((res as { objectId: string }).objectId).toBe("obj-1");
    });

    it(`the seeded legacy objects_classification_model row stays inert on ${provider}`, async () => {
      h.state.provider = provider;
      await unhintedSave();
      // The row still exists in the DB (the mock serves it, and there is no
      // cleanup migration by design) — but nothing reads it any more.
      expect(h.state.connectorConfigReads).not.toContain("objects_classification_model");
    });
  }

  it("NEGATIVE CONTROL — the fake Anthropic adapter really does reject the retired gpt-4o-mini override", () => {
    // Proves this harness is not passing vacuously: had the override survived,
    // the Anthropic arm above would have failed exactly the way the bug did in
    // production (live: `404 not_found_error: model: gpt-4o-mini`).
    expect(() => h.fakeGenerate("anthropic", { model: "gpt-4o-mini" })).toThrow(
      /not in this provider's catalog/,
    );
    // …and NOT on OpenAI, which genuinely serves that model. That asymmetry IS
    // the bug's history: the override looked harmless while OpenAI was the only
    // possible default.
    expect(() => h.fakeGenerate("openai", { model: "gpt-4o-mini" })).not.toThrow();
  });

  it("ANTI-DRIFT — packages/llm still forwards input.model to the adapter verbatim", () => {
    // The double above stands in for this forwarding. If production ever stops
    // passing `input.model` straight through (or starts defaulting it), this
    // test file's premise changes and must be revisited.
    const source = readFileSync(
      fileURLToPath(new URL("../../../llm/src/index.ts", import.meta.url)),
      "utf8",
    );
    expect(source).toContain("const response = await adapter.generate({");
    expect(source).toMatch(/const response = await adapter\.generate\(\{[\s\S]*?\n\s*model: input\.model,/);
  });
});
