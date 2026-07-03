/**
 * Run-completion artifact materializer (cinatra#923) unit tests.
 *
 *   npx vitest run src/lib/artifacts/__tests__/run-artifact-materializer.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  poolQueryMock,
  getAgentPackageMock,
  listArtifactsMock,
  registerAllObjectTypesMock,
  createSemanticArtifactMock,
  claimMaterializationMock,
  buildFinalizeMaterializationQueryMock,
  readFinalizedMaterializationMock,
  isWriteAllowedMock,
} = vi.hoisted(() => ({
  poolQueryMock: vi.fn(),
  getAgentPackageMock: vi.fn(),
  listArtifactsMock: vi.fn(),
  registerAllObjectTypesMock: vi.fn(),
  createSemanticArtifactMock: vi.fn(),
  claimMaterializationMock: vi.fn(),
  buildFinalizeMaterializationQueryMock: vi.fn(() => ({
    text: "UPDATE finalize",
    values: [],
  })),
  readFinalizedMaterializationMock: vi.fn(async (): Promise<unknown> => null),
  isWriteAllowedMock: vi.fn(async () => true),
}));

vi.mock("@/lib/db/pooled", () => ({
  getPooledDb: () => ({ query: poolQueryMock }),
}));
vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://test",
  postgresSchema: "public",
}));
vi.mock("@/lib/postgres-schema-init", () => ({
  ensurePostgresSchema: vi.fn(),
}));
vi.mock("@cinatra-ai/registries", () => ({
  getAgentPackage: getAgentPackageMock,
}));
vi.mock("@cinatra-ai/objects/registry", () => ({
  objectTypeRegistry: { listArtifacts: listArtifactsMock },
}));
vi.mock("@/lib/register-all-object-types", () => ({
  registerAllObjectTypes: registerAllObjectTypesMock,
}));
vi.mock("../artifact-creation", () => ({
  createSemanticArtifact: createSemanticArtifactMock,
}));
vi.mock("../materialization-ledger", () => ({
  claimMaterialization: claimMaterializationMock,
  buildFinalizeMaterializationQuery: buildFinalizeMaterializationQueryMock,
  readFinalizedMaterialization: readFinalizedMaterializationMock,
  // Real predicate logic (message-marker match) so the recovery path is
  // exercised against the same contract the ledger module ships.
  isMaterializationFinalizeConflict: (err: unknown) =>
    err instanceof Error && err.message.includes("materialization-finalize-conflict"),
}));
vi.mock("../artifact-extension-access", () => ({
  isArtifactExtensionWriteAllowed: isWriteAllowedMock,
}));
// artifact-authoring pulls the full authoring stack; the materializer needs
// only its two exported constants. Values mirror the real module; the
// REAL-module set equality with the grammar module is pinned in
// artifact-authoring.test.ts.
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

const EXT = "@cinatra-ai/blog-post-artifact";

function packageFixture(opts?: {
  binding?: Record<string, unknown> | null;
  produces?: Array<{ extension: string }>;
}) {
  const binding =
    opts?.binding === undefined
      ? {
          extension: EXT,
          contentFrom: "draft",
          declaredMime: "text/markdown",
          titleFrom: "title",
        }
      : opts.binding;
  const draftOutput: Record<string, unknown> = { title: "draft", type: "string" };
  if (binding) draftOutput.cinatra = { artifact: binding };
  return {
    manifest: {
      name: "@test/agent",
      cinatra: { produces: opts?.produces ?? [{ extension: EXT }] },
    },
    payload: {
      component_type: "Flow",
      $referenced_components: {
        endNode: {
          component_type: "EndNode",
          id: "endNode",
          name: "End",
          outputs: [
            draftOutput,
            { title: "title", type: "string" },
            { title: "structured", type: "object" },
          ],
        },
      },
    },
  };
}

function artifactDef(mimes: string[] = ["text/markdown", "application/json"]) {
  return {
    type: `${EXT}:artifact`,
    isArtifact: { accepts: { file: { mimeTypes: mimes } } },
  };
}

const BASE_INPUT = {
  runId: "run-1",
  orgId: "org-a",
  templateId: "tpl-1",
  packageVersion: "1.2.3",
  createdBy: "user-1",
  endNodeOutputs: { draft: "# Hello", title: "My Draft" } as Record<string, unknown>,
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetRunPackageBindingsCacheForTests();
  poolQueryMock.mockResolvedValue({ rows: [{ package_name: "@test/agent" }] });
  getAgentPackageMock.mockResolvedValue(packageFixture());
  listArtifactsMock.mockReturnValue([artifactDef()]);
  isWriteAllowedMock.mockResolvedValue(true);
  claimMaterializationMock.mockResolvedValue({ kind: "claimed", ledgerId: "led-1" });
  createSemanticArtifactMock.mockResolvedValue({
    artifactId: "art-1",
    representationRevisionId: "rep-1",
  });
});

describe("materializeRunArtifacts", () => {
  it("materializes a declared binding through createSemanticArtifact with the ledger finalize op", async () => {
    const outcomes = await materializeRunArtifacts(BASE_INPUT);
    expect(outcomes).toEqual([
      {
        ok: true,
        outputId: "draft",
        nodeId: "endNode",
        extension: EXT,
        artifactId: "art-1",
        representationRevisionId: "rep-1",
        deduped: false,
      },
    ]);
    expect(claimMaterializationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-a",
        runId: "run-1",
        outputId: "draft",
        nodeId: "endNode",
        path: "end_node_binding",
        extension: EXT,
      }),
    );
    const createInput = createSemanticArtifactMock.mock.calls[0][0];
    expect(createInput).toMatchObject({
      orgId: "org-a",
      createdBy: "user-1",
      ownerLevel: "organization",
      ownerId: "org-a",
      title: "My Draft",
      declaredMime: "text/markdown",
      originKind: "agent_generated",
      createdByRunId: "run-1",
      producerAssertionExtension: EXT,
      skipFallbackClassification: true,
    });
    // The additional Tx2 composer wires the finalize op with the freshly
    // allocated ids.
    const composed = createInput.additionalTx2Queries({
      artifactId: "art-1",
      representationRevisionId: "rep-1",
    });
    expect(composed).toEqual([{ text: "UPDATE finalize", values: [] }]);
    expect(buildFinalizeMaterializationQueryMock).toHaveBeenCalledWith({
      ledgerId: "led-1",
      orgId: "org-a",
      artifactId: "art-1",
      representationRevisionId: "rep-1",
    });
  });

  it("returns the finalized refs without writing when the ledger dedupes (re-drive)", async () => {
    claimMaterializationMock.mockResolvedValue({
      kind: "finalized",
      artifactId: "art-prev",
      representationRevisionId: "rep-prev",
    });
    const outcomes = await materializeRunArtifacts(BASE_INPUT);
    expect(outcomes).toEqual([
      expect.objectContaining({
        ok: true,
        artifactId: "art-prev",
        representationRevisionId: "rep-prev",
        deduped: true,
      }),
    ]);
    expect(createSemanticArtifactMock).not.toHaveBeenCalled();
  });

  it("returns [] when the template has no package or the package no bindings", async () => {
    poolQueryMock.mockResolvedValue({ rows: [] });
    expect(await materializeRunArtifacts(BASE_INPUT)).toEqual([]);

    poolQueryMock.mockResolvedValue({ rows: [{ package_name: "@test/agent" }] });
    getAgentPackageMock.mockResolvedValue(packageFixture({ binding: null }));
    expect(await materializeRunArtifacts(BASE_INPUT)).toEqual([]);
    expect(createSemanticArtifactMock).not.toHaveBeenCalled();
  });

  it("records a visible failure when the sentinel surfaced no outputs", async () => {
    const outcomes = await materializeRunArtifacts({
      ...BASE_INPUT,
      endNodeOutputs: null,
    });
    expect(outcomes).toEqual([
      expect.objectContaining({
        ok: false,
        outputId: "draft",
        extension: EXT,
        error: expect.stringContaining("sentinel absent"),
      }),
    ]);
  });

  it("fails the output when titleFrom does not resolve to a non-empty string", async () => {
    const outcomes = await materializeRunArtifacts({
      ...BASE_INPUT,
      endNodeOutputs: { draft: "# Hello", title: "   " },
    });
    expect(outcomes[0]).toMatchObject({
      ok: false,
      error: expect.stringContaining('titleFrom output "title"'),
    });
    expect(createSemanticArtifactMock).not.toHaveBeenCalled();
  });

  it("fails when the extension is not installed or does not accept the MIME", async () => {
    listArtifactsMock.mockReturnValue([]);
    let outcomes = await materializeRunArtifacts(BASE_INPUT);
    expect(outcomes[0]).toMatchObject({
      ok: false,
      error: expect.stringContaining("not installed"),
    });

    listArtifactsMock.mockReturnValue([artifactDef(["text/html"])]);
    outcomes = await materializeRunArtifacts(BASE_INPUT);
    expect(outcomes[0]).toMatchObject({
      ok: false,
      error: expect.stringContaining("accepts [text/html]"),
    });
  });

  it("fails closed when the extension is not write-allowed for the org", async () => {
    isWriteAllowedMock.mockResolvedValue(false);
    const outcomes = await materializeRunArtifacts(BASE_INPUT);
    expect(outcomes[0]).toMatchObject({
      ok: false,
      error: expect.stringContaining("not write-allowed"),
    });
    expect(createSemanticArtifactMock).not.toHaveBeenCalled();
  });

  it("JSON-serializes a structured output ONLY for application/json bindings", async () => {
    getAgentPackageMock.mockResolvedValue(
      packageFixture({
        binding: {
          extension: EXT,
          contentFrom: "structured",
          declaredMime: "application/json",
          titleFrom: "title",
        },
      }),
    );
    const outcomes = await materializeRunArtifacts({
      ...BASE_INPUT,
      endNodeOutputs: { structured: { a: 1 }, title: "T" },
    });
    expect(outcomes[0]).toMatchObject({ ok: true });

    // Same structured value under text/markdown → refused (no invention).
    __resetRunPackageBindingsCacheForTests();
    getAgentPackageMock.mockResolvedValue(
      packageFixture({
        binding: {
          extension: EXT,
          contentFrom: "structured",
          declaredMime: "text/markdown",
          titleFrom: "title",
        },
      }),
    );
    const refused = await materializeRunArtifacts({
      ...BASE_INPUT,
      endNodeOutputs: { structured: { a: 1 }, title: "T" },
    });
    expect(refused[0]).toMatchObject({
      ok: false,
      error: expect.stringContaining("structured values are only accepted for application/json"),
    });
  });

  it("surfaces binding-collection errors as failed outcomes (never throws)", async () => {
    getAgentPackageMock.mockResolvedValue(
      packageFixture({
        binding: {
          extension: "@cinatra-ai/not-produced-artifact",
          contentFrom: "draft",
          declaredMime: "text/markdown",
          titleFrom: "title",
        },
      }),
    );
    const outcomes = await materializeRunArtifacts(BASE_INPUT);
    expect(outcomes).toEqual([
      expect.objectContaining({
        ok: false,
        outputId: "(binding-validation)",
        error: expect.stringContaining("cinatra.produces"),
      }),
    ]);
  });

  it("fails CLOSED when the package manifest declares no produces at all", async () => {
    getAgentPackageMock.mockResolvedValue(packageFixture({ produces: [] }));
    const outcomes = await materializeRunArtifacts(BASE_INPUT);
    expect(outcomes).toEqual([
      expect.objectContaining({
        ok: false,
        outputId: "(binding-validation)",
        error: expect.stringContaining("cinatra.produces"),
      }),
    ]);
    expect(createSemanticArtifactMock).not.toHaveBeenCalled();
  });

  it("recovers the winner's refs when a concurrent drive finalized the claim first", async () => {
    createSemanticArtifactMock.mockRejectedValue(
      new Error(
        'invalid input syntax for type integer: "materialization-finalize-conflict: claim already finalized by a concurrent writer; rows=0"',
      ),
    );
    readFinalizedMaterializationMock.mockResolvedValue({
      artifactId: "art-winner",
      representationRevisionId: "rep-winner",
    });
    const outcomes = await materializeRunArtifacts(BASE_INPUT);
    expect(outcomes).toEqual([
      expect.objectContaining({
        ok: true,
        artifactId: "art-winner",
        representationRevisionId: "rep-winner",
        deduped: true,
      }),
    ]);
    expect(readFinalizedMaterializationMock).toHaveBeenCalledWith({
      orgId: "org-a",
      ledgerId: "led-1",
    });
  });

  it("a NON-conflict create failure stays a visible per-output failure", async () => {
    createSemanticArtifactMock.mockRejectedValue(new Error("disk full"));
    const outcomes = await materializeRunArtifacts(BASE_INPUT);
    expect(outcomes).toEqual([
      expect.objectContaining({
        ok: false,
        error: expect.stringContaining("disk full"),
      }),
    ]);
    expect(readFinalizedMaterializationMock).not.toHaveBeenCalled();
  });

  it("degrades a wholesale package-fetch failure to one visible outcome", async () => {
    getAgentPackageMock.mockRejectedValue(new Error("registry unreachable"));
    const outcomes = await materializeRunArtifacts(BASE_INPUT);
    expect(outcomes).toEqual([
      expect.objectContaining({
        ok: false,
        outputId: "(binding-resolution)",
        error: expect.stringContaining("registry unreachable"),
      }),
    ]);
  });

  it("continues past a failing binding to materialize the rest", async () => {
    const pkg = packageFixture();
    const endNode = (
      pkg.payload.$referenced_components as Record<string, { outputs: unknown[] }>
    ).endNode;
    endNode.outputs = [
      ...endNode.outputs,
      {
        title: "second",
        type: "string",
        cinatra: {
          artifact: {
            extension: EXT,
            contentFrom: "missing_output",
            declaredMime: "text/markdown",
            titleFrom: "title",
          },
        },
      },
    ];
    getAgentPackageMock.mockResolvedValue(pkg);
    const outcomes = await materializeRunArtifacts(BASE_INPUT);
    // "missing_output" fails collection (does not name an EndNode output);
    // the draft binding still materializes.
    expect(outcomes).toHaveLength(2);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.ok)).toHaveLength(1);
  });

  it("caches bindings per pinned package version only", async () => {
    await materializeRunArtifacts(BASE_INPUT);
    await materializeRunArtifacts(BASE_INPUT);
    expect(getAgentPackageMock).toHaveBeenCalledTimes(1);

    await materializeRunArtifacts({ ...BASE_INPUT, packageVersion: null });
    await materializeRunArtifacts({ ...BASE_INPUT, packageVersion: null });
    // Unpinned (dist-tag default) is never cached.
    expect(getAgentPackageMock).toHaveBeenCalledTimes(3);
  });
});
