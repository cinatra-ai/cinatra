/**
 * cinatra#2339 — per-provider outputSchema sanitization at the core→adapter seam.
 *
 * Anthropic rejects a subset of JSON Schema validation keywords inside
 * `output_config.format.schema` with a 400, and both `packages/llm` and the
 * connector adapters forwarded `outputSchema` VERBATIM — so the classifier's
 * `confidence: { minimum: 0, maximum: 1 }` broke un-hinted classification on an
 * Anthropic-default instance.
 *
 * These are BOUNDARY tests: they drive each real orchestration entry point and
 * assert on what the ADAPTER was handed. That is what makes the guarantee cover
 * every `outputSchema` consumer — the classifier, the artifact matcher, the
 * arbitrary caller-supplied schemas from the llm-bridge route and agent
 * templates — rather than only the one consumer that reported the bug.
 *
 * There are exactly FOUR schema-capable adapter methods: three `generate()`
 * dispatch sites plus `generateWithFileInput()`. `StreamInput` carries no
 * `outputSchema` (see `llm-provider-adapter-contract.ts`), so `stream()` has
 * nothing to sanitize — the "missing" fifth site is a type-level fact, pinned
 * by the last test here.
 *
 * Harness mirrors `toolbox-build-context-threading.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { emptyInjectedSkillSet } from "../tests/__helpers__/injected-skills";
import type { GenerateInput, LlmResponse, FileInputGenerateInput } from "./types";

// ---------------------------------------------------------------------------
// Mocks — registered BEFORE the module-under-test is imported
// ---------------------------------------------------------------------------

vi.mock("./mcp-access", () => ({
  buildLlmMcpServerTool: vi.fn(async () => null),
  buildExternalMcpServerTools: vi.fn(async () => []),
}));

vi.mock("@/lib/external-mcp-registry", () => ({
  buildRegisteredExternalMcpServerTools: vi.fn(async () => []),
  buildSingleExternalMcpTool: vi.fn(async () => null),
}));

vi.mock("@/lib/external-mcp-toolbox-loader.server", () => ({
  loadExternalMcpToolboxBySlug: vi.fn(async () => null),
  sanitizeExternalMcpToolboxTools: vi.fn((tools: unknown) => tools),
}));

vi.mock("@/lib/llm-toolbox-providers", () => ({
  buildToolboxProviderTools: vi.fn(async () => null),
}));

vi.mock("@/lib/llm-provider-surfaces", () => ({
  getLlmProviderAdapterSurface: vi.fn((providerId: string) =>
    providerId === "openai" || providerId === "anthropic"
      ? {
          abiVersion: 1 as const,
          providerId,
          createAdapter: async () => ({
            provider: providerId,
            defaultModel: "mock-model",
            generate: _generateMock,
            generateWithFileInput: _generateWithFileInputMock,
            stream: vi.fn(async () => undefined),
          }),
        }
      : null,
  ),
  getLlmProviderSurface: vi.fn(() => null),
  requireLlmProviderSurface: vi.fn((providerId: string) => {
    throw new Error(`The "${providerId}" LLM provider connector is not installed/active`);
  }),
  listLlmProviderSurfaces: vi.fn(() => []),
}));

vi.mock("@/lib/database", () => ({
  readDefaultLlmProviderFromDatabase: vi.fn(() => "anthropic"),
  readDefaultImageProviderFromDatabase: vi.fn(() => null),
  readLlmProviderFailoverPolicyFromDatabase: vi.fn(() => "exact"),
}));

// Break the circular workspace self-import (./index → ./tools/skills →
// @cinatra-ai/skills → @cinatra-ai/llm).
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

const mockResponse = (): LlmResponse => ({
  text: '{"ok":true}',
  status: null,
  incompleteReason: null,
  rawBody: "",
  usage: undefined,
  model: "mock-model",
});

const _generateMock = vi.fn(async (_input: GenerateInput): Promise<LlmResponse> => mockResponse());
const _generateWithFileInputMock = vi.fn(
  async (_input: FileInputGenerateInput): Promise<LlmResponse> => mockResponse(),
);

import {
  generate,
  generateWithFileInput,
  runDeterministicLlmTask,
  runSkillAwareDeterministicLlmTask,
} from "./index";
import { withActorContext } from "./actor-context";
import type { ActorContext } from "@/lib/authz/actor-context";

const testActor: ActorContext = {
  principalType: "HumanUser",
  principalId: "u-test",
  organizationId: "org-test",
  authSource: "ui",
  policyVersion: "v2",
};
const runWithActor = <T,>(fn: () => Promise<T>): Promise<T> =>
  Promise.resolve(withActorContext(testActor, fn));

/**
 * The classifier's real schema shape — the one that produced
 * `output_config.format.schema: For 'number' type, properties maximum, minimum
 * are not supported` against api.anthropic.com.
 */
const SCHEMA_WITH_RANGE = {
  type: "object",
  additionalProperties: false,
  required: ["objectTypeId", "confidence"],
  properties: {
    objectTypeId: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
} as const;

/** What the adapter was handed on the most recent `generate` call. */
function lastGenerateSchema(): Record<string, unknown> | undefined {
  const call = _generateMock.mock.calls.at(-1);
  return call?.[0].outputSchema;
}

beforeEach(() => {
  vi.clearAllMocks();
  _generateMock.mockImplementation(async () => mockResponse());
  _generateWithFileInputMock.mockImplementation(async () => mockResponse());
});

describe("outputSchema sanitization seam — anthropic-bound requests (cinatra#2339)", () => {
  it("runDeterministicLlmTask strips the unsupported range keywords", async () => {
    await runWithActor(() =>
      runDeterministicLlmTask({
        provider: "anthropic",
        system: "s",
        user: "u",
        outputSchema: SCHEMA_WITH_RANGE as unknown as Record<string, unknown>,
        declaredToolboxIds: [],
      }),
    );

    const sent = lastGenerateSchema() as Record<string, Record<string, Record<string, unknown>>>;
    expect(sent.properties.confidence).not.toHaveProperty("minimum");
    expect(sent.properties.confidence).not.toHaveProperty("maximum");
    // The constraint is not lost — it is restated in a keyword every provider
    // accepts, so the model still receives the guidance.
    expect(String(sent.properties.confidence.description)).toContain("minimum 0");
    expect(String(sent.properties.confidence.description)).toContain("maximum 1");
    // Everything else is untouched.
    expect(sent.properties.objectTypeId).toEqual({ type: "string" });
    expect(sent.additionalProperties as unknown).toBe(false);
  });

  it("runSkillAwareDeterministicLlmTask strips them too", async () => {
    const injectedSkills = await emptyInjectedSkillSet();
    await runWithActor(() =>
      runSkillAwareDeterministicLlmTask({
        injectedSkills,
        provider: "anthropic",
        system: "s",
        user: "u",
        outputSchema: SCHEMA_WITH_RANGE as unknown as Record<string, unknown>,
        declaredToolboxIds: [],
      }),
    );

    const sent = lastGenerateSchema() as Record<string, Record<string, Record<string, unknown>>>;
    expect(sent.properties.confidence).not.toHaveProperty("minimum");
    expect(sent.properties.confidence).not.toHaveProperty("maximum");
  });

  it("generate() keys the policy off the RESOLVED provider when none was requested", async () => {
    // No `provider` on the input ⇒ the implicit-global default (mocked to
    // anthropic) resolves the adapter. Sanitization must follow the adapter,
    // not the absent request field.
    await runWithActor(() =>
      generate({
        system: "s",
        prompt: "u",
        outputSchema: SCHEMA_WITH_RANGE as unknown as Record<string, unknown>,
        declaredToolboxIds: [],
      }),
    );

    const sent = lastGenerateSchema() as Record<string, Record<string, Record<string, unknown>>>;
    expect(sent.properties.confidence).not.toHaveProperty("minimum");
  });

  it("generateWithFileInput() sanitizes the fourth schema-capable method", async () => {
    await generateWithFileInput({
      provider: "anthropic",
      system: "s",
      prompt: "u",
      fileId: "file-1",
      outputSchema: SCHEMA_WITH_RANGE as unknown as Record<string, unknown>,
    });

    const sent = _generateWithFileInputMock.mock.calls.at(-1)?.[0].outputSchema as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    expect(sent.properties.confidence).not.toHaveProperty("minimum");
    expect(sent.properties.confidence).not.toHaveProperty("maximum");
  });
});

describe("outputSchema sanitization seam — OpenAI behaviour is unchanged", () => {
  it("runDeterministicLlmTask hands OpenAI the IDENTICAL schema reference", async () => {
    await runWithActor(() =>
      runDeterministicLlmTask({
        provider: "openai",
        system: "s",
        user: "u",
        outputSchema: SCHEMA_WITH_RANGE as unknown as Record<string, unknown>,
        declaredToolboxIds: [],
      }),
    );

    // Reference identity, not deep equality: the OpenAI request bytes cannot
    // have changed if the very same object was forwarded.
    expect(lastGenerateSchema()).toBe(SCHEMA_WITH_RANGE);
  });

  it("runSkillAwareDeterministicLlmTask hands OpenAI the IDENTICAL reference", async () => {
    const injectedSkills = await emptyInjectedSkillSet();
    await runWithActor(() =>
      runSkillAwareDeterministicLlmTask({
        injectedSkills,
        provider: "openai",
        system: "s",
        user: "u",
        outputSchema: SCHEMA_WITH_RANGE as unknown as Record<string, unknown>,
        declaredToolboxIds: [],
      }),
    );

    expect(lastGenerateSchema()).toBe(SCHEMA_WITH_RANGE);
  });

  it("generate() hands OpenAI the IDENTICAL reference", async () => {
    await runWithActor(() =>
      generate({
        provider: "openai",
        system: "s",
        prompt: "u",
        outputSchema: SCHEMA_WITH_RANGE as unknown as Record<string, unknown>,
        declaredToolboxIds: [],
      }),
    );

    expect(lastGenerateSchema()).toBe(SCHEMA_WITH_RANGE);
  });

  it("generateWithFileInput() hands OpenAI the IDENTICAL reference", async () => {
    await generateWithFileInput({
      provider: "openai",
      system: "s",
      prompt: "u",
      fileId: "file-1",
      outputSchema: SCHEMA_WITH_RANGE as unknown as Record<string, unknown>,
    });

    expect(_generateWithFileInputMock.mock.calls.at(-1)?.[0].outputSchema).toBe(SCHEMA_WITH_RANGE);
  });

  it("a schema with no unsupported keyword is reference-identical for anthropic too", async () => {
    const clean = {
      type: "object",
      additionalProperties: false,
      required: ["a"],
      properties: { a: { type: "string", enum: ["x", "y"] } },
    };

    await runWithActor(() =>
      runDeterministicLlmTask({
        provider: "anthropic",
        system: "s",
        user: "u",
        outputSchema: clean,
        declaredToolboxIds: [],
      }),
    );

    expect(lastGenerateSchema()).toBe(clean);
  });
});

describe("outputSchema sanitization seam — coverage of the schema-capable surface", () => {
  it("`StreamInput` has no outputSchema, so stream() has nothing to sanitize", () => {
    // Type-level pin: if a future ABI change adds `outputSchema` to StreamInput,
    // this assignment stops compiling and whoever makes that change is forced
    // to extend the seam rather than silently reopening the bug.
    type StreamHasNoOutputSchema =
      "outputSchema" extends keyof import("./types").StreamInput ? false : true;
    const pinned: StreamHasNoOutputSchema = true;
    expect(pinned).toBe(true);
  });
});
