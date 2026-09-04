/**
 * cinatra#3033 (fix leg 2) — the idea batch materializes from the answer the
 * bridge actually gets back.
 *
 * The recorded failure, verbatim from the run:
 *
 *   ideaBatchDocument [@cinatra-ai/blog-idea-artifact]: titleFrom output
 *   "ideaBatchTitle" did not resolve to a non-empty string
 *
 * The refusal itself is correct and stays: an empty title is not a title. What
 * was wrong is one frame earlier. The idea generator's EndNode declares
 * `ideas`, `ideaBatchTitle`, `ideaBatchDocument` and `notes`, the runtime
 * derives an `output_schema` from those declarations and sends it with the
 * bridge call, and the host answers with what the provider produced. The host
 * shaped that answer with a bare `JSON.parse`, so an answer that carried the
 * declared object inside a fenced block came back as `{ output: <the text> }`;
 * every declared output then fell to its EndNode default and the run died here
 * naming a binding rather than the call.
 *
 * This suite drives the REAL materializer over the REAL shaping, on the idea
 * generator's own binding, so the two halves are pinned as one road.
 *
 *   npx vitest run src/lib/artifacts/__tests__/w9-idea-batch-materializes-from-the-bridge-answer.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  poolQueryMock,
  getAgentPackageMock,
  getPublishedExtensionSummaryMock,
  listArtifactsMock,
  registerAllObjectTypesMock,
  createSemanticArtifactMock,
  claimMaterializationMock,
  buildFinalizeMaterializationQueryMock,
  readFinalizedMaterializationMock,
  isWriteAllowedMock,
  resolveBoundArtifactTargetMock,
  enqueueArtifactMatchRunMock,
} = vi.hoisted(() => ({
  poolQueryMock: vi.fn(),
  getAgentPackageMock: vi.fn(),
  getPublishedExtensionSummaryMock: vi.fn(),
  listArtifactsMock: vi.fn(),
  registerAllObjectTypesMock: vi.fn(),
  resolveBoundArtifactTargetMock: vi.fn(),
  createSemanticArtifactMock: vi.fn(),
  claimMaterializationMock: vi.fn(),
  buildFinalizeMaterializationQueryMock: vi.fn(() => ({ text: "UPDATE finalize", values: [] })),
  readFinalizedMaterializationMock: vi.fn(async (): Promise<unknown> => null),
  isWriteAllowedMock: vi.fn(async () => true),
  enqueueArtifactMatchRunMock: vi.fn(async (): Promise<void> => {}),
}));

// The shaping helper lives beside the bridge route's dispatch resolver, whose
// module also pulls the agents barrel for the model allowlist. Only the four
// names that module imports are needed here, and none of them takes part in
// the shaping — so they are stubbed to keep this suite hermetic.
vi.mock("@cinatra-ai/agents", () => ({
  ALLOWED_MODEL_IDS: {},
  LLM_PROVIDERS: [],
  canProviderSatisfyCapability: () => true,
  describeCapabilityRequirement: () => "",
}));
vi.mock("@/lib/db/pooled", () => ({ getPooledDb: () => ({ query: poolQueryMock }) }));
vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://test",
  postgresSchema: "public",
}));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: vi.fn() }));
vi.mock("@cinatra-ai/registries", () => ({
  getAgentPackage: getAgentPackageMock,
  getPublishedExtensionSummary: getPublishedExtensionSummaryMock,
}));
vi.mock("@/lib/verdaccio-config", () => ({
  loadVerdaccioConfigForReads: vi.fn(async () => ({
    registryUrl: "http://registry.test",
    token: "test-token",
  })),
}));
vi.mock("@cinatra-ai/objects/registry", () => ({
  objectTypeRegistry: { listArtifacts: listArtifactsMock },
}));
vi.mock("@/lib/register-all-object-types", () => ({
  registerAllObjectTypes: registerAllObjectTypesMock,
}));
vi.mock("../resolve-bound-artifact-type", () => ({
  resolveBoundArtifactTarget: resolveBoundArtifactTargetMock,
}));
vi.mock("../artifact-creation", () => ({ createSemanticArtifact: createSemanticArtifactMock }));
vi.mock("../materialization-ledger", () => ({
  claimMaterialization: claimMaterializationMock,
  buildFinalizeMaterializationQuery: buildFinalizeMaterializationQueryMock,
  readFinalizedMaterialization: readFinalizedMaterializationMock,
  isMaterializationFinalizeConflict: (err: unknown) =>
    err instanceof Error && err.message.includes("materialization-finalize-conflict"),
}));
vi.mock("../artifact-extension-access", () => ({
  isArtifactExtensionWriteAllowed: isWriteAllowedMock,
}));
vi.mock("../matcher-enqueue", () => ({
  enqueueArtifactMatchRun: enqueueArtifactMatchRunMock,
  artifactMatchJobId: (p: { orgId: string; artifactId: string; representationRevisionId: string }) =>
    `artifact-match__${p.orgId}__${p.artifactId}__${p.representationRevisionId}`,
  ARTIFACT_MATCH_RETRY_POLICY: { attempts: 3, backoff: { type: "exponential", delay: 5_000 } },
}));
vi.mock("../artifact-authoring", () => ({
  MAX_AUTHORED_CONTENT_BYTES: 10 * 1024 * 1024,
  TEXT_AUTHORING_COMPATIBLE_MIMES: new Set([
    "text/markdown",
    "text/plain",
    "text/html",
    "application/json",
    "application/xml",
  ]),
}));

import {
  materializeRunArtifacts,
  __resetRunPackageBindingsCacheForTests,
} from "../run-artifact-materializer";
import { shapeBridgeAnswer } from "@/app/api/llm-bridge/_llm-dispatch";

/** The idea artifact extension, exactly as the generator's EndNode names it. */
const IDEA_EXT = "@cinatra-ai/blog-idea-artifact";

/**
 * The generator's declared EndNode outputs, and the schema the runtime derives
 * from them for the bridge call.
 */
const DECLARED = ["ideas", "ideaBatchTitle", "ideaBatchDocument", "notes"] as const;
const IDEA_OUTPUT_SCHEMA = {
  type: "object",
  properties: Object.fromEntries(
    DECLARED.map((name) => [name, { type: name === "ideas" ? "array" : "string", title: name }]),
  ),
  required: [...DECLARED],
  additionalProperties: false,
};

/** What the model produced — the declared envelope, inside a fenced block. */
const ENVELOPE = {
  ideas: [{ title: "Why migrations are the hardest part" }],
  ideaBatchTitle: "Blog ideas: self-hosting upgrade paths (1 idea)",
  ideaBatchDocument: "## Why migrations are the hardest part\n\nA summary.\n",
  notes: "One cluster, nothing excluded.",
};
const FENCED_ANSWER = "```json\n" + JSON.stringify(ENVELOPE) + "\n```";

function ideaPackageFixture() {
  return {
    manifest: { name: "@cinatra-ai/blog-idea-generator-agent", cinatra: { produces: [{ extension: IDEA_EXT }] } },
    payload: {
      component_type: "Flow",
      $referenced_components: {
        end: {
          component_type: "EndNode",
          id: "end",
          name: "End",
          outputs: [
            { title: "ideas", type: "array", default: [] },
            { title: "ideaBatchTitle", type: "string", default: "" },
            {
              title: "ideaBatchDocument",
              type: "string",
              default: "",
              cinatra: {
                artifact: {
                  extension: IDEA_EXT,
                  contentFrom: "ideaBatchDocument",
                  declaredMime: "text/markdown",
                  titleFrom: "ideaBatchTitle",
                },
              },
            },
            { title: "notes", type: "string", default: "" },
          ],
        },
      },
    },
  };
}

const BASE_INPUT = {
  runId: "run-idea-1",
  orgId: "org-a",
  templateId: "tpl-idea",
  packageVersion: "0.1.0",
  createdBy: "user-1",
  endNodeOutputs: {} as Record<string, unknown>,
};

/** The EndNode's own defaults — what a declared output falls back to. */
const ENDNODE_DEFAULTS: Record<string, unknown> = {
  ideas: [],
  ideaBatchTitle: "",
  ideaBatchDocument: "",
  notes: "",
};

/**
 * The runtime maps the bridge body back onto the declared outputs by key; a
 * key the body does not carry keeps the EndNode default.
 */
function endNodeOutputsFrom(body: unknown): Record<string, unknown> {
  const carried = body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
  return Object.fromEntries(
    DECLARED.map((name) => [name, name in carried ? carried[name] : ENDNODE_DEFAULTS[name]]),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetRunPackageBindingsCacheForTests();
  poolQueryMock.mockResolvedValue({
    rows: [{ package_name: "@cinatra-ai/blog-idea-generator-agent" }],
  });
  getAgentPackageMock.mockResolvedValue(ideaPackageFixture());
  listArtifactsMock.mockReturnValue([
    { type: `${IDEA_EXT}:artifact`, isArtifact: { accepts: { file: { mimeTypes: ["text/markdown"] } } } },
  ]);
  resolveBoundArtifactTargetMock.mockImplementation(async ({ extension }: { extension: string }) => {
    const defs = listArtifactsMock() as Array<{
      type: string;
      isArtifact?: { accepts?: { file?: { mimeTypes?: string[] } } };
    }>;
    const def = defs.find((d) => d.type === `${extension}:artifact`);
    if (!def) {
      return { ok: false, error: `artifact extension "${extension}" is not installed/registered on this host` };
    }
    return {
      ok: true,
      target: {
        objectTypeId: def.type,
        acceptedFileMimeTypes: def.isArtifact?.accepts?.file?.mimeTypes ?? [],
      },
    };
  });
  isWriteAllowedMock.mockResolvedValue(true);
  claimMaterializationMock.mockResolvedValue({ kind: "claimed", ledgerId: "led-1" });
  createSemanticArtifactMock.mockResolvedValue({
    artifactId: "art-idea-1",
    representationRevisionId: "rep-idea-1",
  });
});

describe("the idea batch, from the bridge answer to the materialized row", () => {
  it("reproduces the recorded refusal when the answer's declared outputs are lost", async () => {
    // What the bare-parse shaping produced: the whole text under `output`, so
    // every declared output kept its EndNode default.
    const lost = { output: FENCED_ANSWER };
    const outcomes = await materializeRunArtifacts({
      ...BASE_INPUT,
      endNodeOutputs: endNodeOutputsFrom(lost),
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      ok: false,
      outputId: "ideaBatchDocument",
      extension: IDEA_EXT,
      error: 'titleFrom output "ideaBatchTitle" did not resolve to a non-empty string',
    });
    expect(createSemanticArtifactMock).not.toHaveBeenCalled();
  });

  it("materializes the idea batch from the SAME answer once the declared shape is honoured", async () => {
    const shaped = shapeBridgeAnswer({
      text: FENCED_ANSWER,
      outputSchema: IDEA_OUTPUT_SCHEMA,
    });
    expect(shaped.missingDeclaredOutputs).toEqual([]);

    const outcomes = await materializeRunArtifacts({
      ...BASE_INPUT,
      endNodeOutputs: endNodeOutputsFrom(shaped.body),
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ ok: true, outputId: "ideaBatchDocument", extension: IDEA_EXT });
    expect(createSemanticArtifactMock).toHaveBeenCalledTimes(1);
    expect(createSemanticArtifactMock.mock.calls[0][0]).toMatchObject({
      title: ENVELOPE.ideaBatchTitle,
      declaredMime: "text/markdown",
      objectType: `${IDEA_EXT}:artifact`,
      producerAssertionExtension: IDEA_EXT,
      originKind: "agent_generated",
    });
  });

  it("still refuses, and names the empty output at the call, when the answer really carries no title", async () => {
    const shaped = shapeBridgeAnswer({
      text: JSON.stringify({ ...ENVELOPE, ideaBatchTitle: "" }),
      outputSchema: IDEA_OUTPUT_SCHEMA,
    });
    expect(shaped.missingDeclaredOutputs).toEqual(["ideaBatchTitle"]);

    const outcomes = await materializeRunArtifacts({
      ...BASE_INPUT,
      endNodeOutputs: endNodeOutputsFrom(shaped.body),
    });
    expect(outcomes[0]).toMatchObject({
      ok: false,
      error: 'titleFrom output "ideaBatchTitle" did not resolve to a non-empty string',
    });
  });
});
