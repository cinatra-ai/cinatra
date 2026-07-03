/**
 * Deterministic `artifact_materialize` tool path (cinatra#925) unit tests —
 * `materializeToolArtifact` shares the write core + idempotency ledger with
 * the #923 run-completion path; here we pin the tool-specific contract:
 * fail-closed produces parity, ledger identity (`path:'materialize_tool'`,
 * output_id = the calling node id), and the concurrent-loser recovery.
 *
 *   npx vitest run src/lib/artifacts/__tests__/materialize-tool-artifact.test.ts
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
// only its two exported constants (values mirror the real module).
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
  materializeToolArtifact,
  __resetRunPackageBindingsCacheForTests,
} from "../run-artifact-materializer";

const EXT = "@cinatra-ai/blog-post-artifact";

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
  nodeId: "persist_draft",
  extension: EXT,
  title: "My Draft",
  mime: "text/markdown",
  content: "# Hello",
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetRunPackageBindingsCacheForTests();
  poolQueryMock.mockResolvedValue({ rows: [{ package_name: "@test/agent" }] });
  getAgentPackageMock.mockResolvedValue({
    manifest: {
      name: "@test/agent",
      cinatra: { produces: [{ extension: EXT }] },
    },
    // No OAS payload needed by the tool path — produces comes from the
    // manifest even when the payload is absent.
    payload: null,
  });
  listArtifactsMock.mockReturnValue([artifactDef()]);
  isWriteAllowedMock.mockResolvedValue(true);
  claimMaterializationMock.mockResolvedValue({ kind: "claimed", ledgerId: "led-1" });
  createSemanticArtifactMock.mockResolvedValue({
    artifactId: "art-1",
    representationRevisionId: "rep-1",
  });
});

describe("materializeToolArtifact", () => {
  it("writes through createSemanticArtifact under the materialize_tool ledger identity", async () => {
    const outcome = await materializeToolArtifact(BASE_INPUT);
    expect(outcome).toEqual({
      ok: true,
      artifactId: "art-1",
      representationRevisionId: "rep-1",
      deduped: false,
    });
    expect(claimMaterializationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-a",
        runId: "run-1",
        outputId: "persist_draft",
        nodeId: "persist_draft",
        path: "materialize_tool",
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

  it("FAILS CLOSED when the extension is not in the run package's produces", async () => {
    const outcome = await materializeToolArtifact({
      ...BASE_INPUT,
      extension: "@cinatra-ai/other-artifact",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("@cinatra-ai/other-artifact");
    expect(outcome.error).toContain("cinatra.produces");
    expect(createSemanticArtifactMock).not.toHaveBeenCalled();
    expect(claimMaterializationMock).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED on an empty/absent produces block", async () => {
    getAgentPackageMock.mockResolvedValue({
      manifest: { name: "@test/agent" },
      payload: null,
    });
    const outcome = await materializeToolArtifact(BASE_INPUT);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("cinatra.produces");
  });

  it("fails when the run's template has no package name", async () => {
    poolQueryMock.mockResolvedValue({ rows: [] });
    const outcome = await materializeToolArtifact(BASE_INPUT);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("has no package name");
  });

  it("rejects a non-text-authorable MIME", async () => {
    const outcome = await materializeToolArtifact({
      ...BASE_INPUT,
      mime: "image/png",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("not text-authorable");
  });

  it("rejects a MIME the extension does not accept", async () => {
    const outcome = await materializeToolArtifact({
      ...BASE_INPUT,
      mime: "text/plain",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("the call declared MIME");
  });

  it("rejects an uninstalled extension and a write-denied org", async () => {
    listArtifactsMock.mockReturnValue([]);
    let outcome = await materializeToolArtifact(BASE_INPUT);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain("not installed/registered");
    }

    listArtifactsMock.mockReturnValue([artifactDef()]);
    isWriteAllowedMock.mockResolvedValue(false);
    outcome = await materializeToolArtifact(BASE_INPUT);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain("not write-allowed");
    }
  });

  it("rejects over-cap content and an empty title", async () => {
    let outcome = await materializeToolArtifact({
      ...BASE_INPUT,
      content: "x".repeat(10 * 1024 * 1024 + 1),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("exceeds the");

    outcome = await materializeToolArtifact({ ...BASE_INPUT, title: "   " });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("title must be a non-empty string");
  });

  it("returns the finalized refs without writing on a ledger dedupe (retry)", async () => {
    claimMaterializationMock.mockResolvedValue({
      kind: "finalized",
      artifactId: "art-prev",
      representationRevisionId: "rep-prev",
    });
    const outcome = await materializeToolArtifact(BASE_INPUT);
    expect(outcome).toEqual({
      ok: true,
      artifactId: "art-prev",
      representationRevisionId: "rep-prev",
      deduped: true,
    });
    expect(createSemanticArtifactMock).not.toHaveBeenCalled();
  });

  it("recovers the winner's refs when the finalize guard aborts a concurrent loser", async () => {
    createSemanticArtifactMock.mockRejectedValue(
      new Error("materialization-finalize-conflict: claim already finalized"),
    );
    readFinalizedMaterializationMock.mockResolvedValue({
      artifactId: "art-winner",
      representationRevisionId: "rep-winner",
    });
    const outcome = await materializeToolArtifact(BASE_INPUT);
    expect(outcome).toEqual({
      ok: true,
      artifactId: "art-winner",
      representationRevisionId: "rep-winner",
      deduped: true,
    });
  });

  it("never throws — infra failures come back as error outcomes", async () => {
    claimMaterializationMock.mockRejectedValue(new Error("db down"));
    const outcome = await materializeToolArtifact(BASE_INPUT);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("materialization failed: db down");
  });
});
