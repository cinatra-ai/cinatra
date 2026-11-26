/**
 * cinatra#3089 — the LIST MODE of the `artifact_materialize` tool on the real
 * materializer core (`materializeToolArtifactList`): one `materialize_tool`
 * write per member under its own ledger identity, every member authorized
 * before the first write, a retried call reusing the members already filed.
 * The module graph is mocked as materialize-tool-artifact.test.ts mocks it.
 *
 *   npx vitest run src/lib/artifacts/__tests__/materialize-tool-artifact-list-3089.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const {
  poolQueryMock,
  getAgentPackageMock,
  listArtifactsMock,
  resolveTypeMock,
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
  listArtifactsMock: vi.fn(),
  resolveTypeMock: vi.fn((): unknown => null),
  registerAllObjectTypesMock: vi.fn(),
  createSemanticArtifactMock: vi.fn(),
  claimMaterializationMock: vi.fn(),
  buildFinalizeMaterializationQueryMock: vi.fn(() => ({
    text: "UPDATE finalize",
    values: [],
  })),
  readFinalizedMaterializationMock: vi.fn(async (): Promise<unknown> => null),
  isWriteAllowedMock: vi.fn(async () => true),
  resolveBoundArtifactTargetMock: vi.fn(),
  enqueueArtifactMatchRunMock: vi.fn(async (): Promise<void> => {}),
}));

vi.mock("@/lib/db/pooled", async () => ({
  ...await vi.importActual<typeof import("@/lib/db/pooled")>("@/lib/db/pooled"),
  getPooledDb: () => ({ query: poolQueryMock, connect: async () => ({ query: poolQueryMock, release: () => {} }) }),
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
// getAgentPackage now requires an explicit VerdaccioConfig (cinatra#1454); the
// materializer loads it via this host wrapper. The mocked getAgentPackage
// ignores the value, so a stub config suffices.
vi.mock("@/lib/verdaccio-config", () => ({
  loadVerdaccioConfigForReads: vi.fn(async () => ({
    registryUrl: "http://registry.test",
    token: "test-token",
  })),
}));
vi.mock("@cinatra-ai/objects/registry", () => ({
  objectTypeRegistry: { listArtifacts: listArtifactsMock, resolve: resolveTypeMock },
}));
vi.mock("@/lib/register-all-object-types", () => ({
  registerAllObjectTypes: registerAllObjectTypesMock,
}));
vi.mock("../resolve-bound-artifact-type", () => ({
  resolveBoundArtifactTarget: resolveBoundArtifactTargetMock,
}));
// The schema check is the REAL one the creation boundary runs (cinatra#3089).
vi.mock("../artifact-creation", async () => ({
  createSemanticArtifact: createSemanticArtifactMock,
  artifactPayloadSchemaError: (await vi.importActual<typeof import("../artifact-creation")>("../artifact-creation"))
    .artifactPayloadSchemaError,
}));
vi.mock("../materialization-ledger", async () => ({
  // cinatra#4762: the reused revision's restamp, as the module ships it.
  restampReusedRevision: (await vi.importActual<typeof import("../materialization-ledger")>("../materialization-ledger")).restampReusedRevision,
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
// cinatra#1891 A3: the shared write core POST-COMMIT enqueues the meaning-matcher
// via `./matcher-enqueue` (dynamic import). Stub it so this UNIT suite stays
// hermetic — the real seam opens a live BullMQ/Redis connection (hangs on an
// unreachable broker); its behavior is covered by the enqueue suite + live walk.
vi.mock("../matcher-enqueue", () => ({
  enqueueArtifactMatchRun: enqueueArtifactMatchRunMock,
  artifactMatchJobId: (p: { orgId: string; artifactId: string; representationRevisionId: string }) =>
    `artifact-match__${p.orgId}__${p.artifactId}__${p.representationRevisionId}`,
  ARTIFACT_MATCH_RETRY_POLICY: { attempts: 3, backoff: { type: "exponential", delay: 5_000 } },
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
  materializeListMemberOutputId,
  materializeToolArtifactList,
  MATERIALIZE_LIST_OUTPUT_ID_PREFIX,
  __resetRunPackageBindingsCacheForTests,
} from "../run-artifact-materializer";
import { MATERIALIZE_LIST_NODE_ID_PREFIX } from "@/app/api/agents/passthrough/artifact-materialize-shaper";

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
  nodeId: "file_bodies",
  extension: EXT,
  mime: "text/markdown",
  members: [
    { title: "For Ann", content: "Hi Ann", data: { contactId: "c-1", campaignId: "camp-1" } },
    { title: "For Bob", content: "Hi Bob", data: { contactId: "c-2", campaignId: "camp-1" } },
  ],
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
  resolveTypeMock.mockReturnValue(null);
  // Mirror the legacy `${extension}:artifact` lookup off the same fixture.
  resolveBoundArtifactTargetMock.mockImplementation(
    async ({ extension }: { extension: string }) => {
      const defs = listArtifactsMock() as Array<{
        type: string;
        isArtifact?: { accepts?: { file?: { mimeTypes?: string[] } } };
      }>;
      const def = defs.find((d) => d.type === `${extension}:artifact`);
      if (!def) {
        return {
          ok: false,
          error: `artifact extension "${extension}" is not installed/registered on this host`,
        };
      }
      return {
        ok: true,
        target: {
          objectTypeId: def.type,
          acceptedFileMimeTypes: def.isArtifact?.accepts?.file?.mimeTypes ?? [],
        },
      };
    },
  );
  isWriteAllowedMock.mockResolvedValue(true);
  claimMaterializationMock.mockResolvedValue({ kind: "claimed", ledgerId: "led-1" });
  createSemanticArtifactMock.mockResolvedValue({
    artifactId: "art-1",
    representationRevisionId: "rep-1",
  });
});

describe("materializeToolArtifactList (cinatra#3089)", () => {
  it("files one artifact per member, in order, each under its own materialize_tool ledger identity with its typed data", async () => {
    createSemanticArtifactMock
      .mockResolvedValueOnce({ artifactId: "art-1", representationRevisionId: "rep-1" })
      .mockResolvedValueOnce({ artifactId: "art-2", representationRevisionId: "rep-2" });
    const outcome = await materializeToolArtifactList(BASE_INPUT);
    expect(outcome).toEqual({
      ok: true,
      artifacts: [
        { artifactId: "art-1", representationRevisionId: "rep-1" },
        { artifactId: "art-2", representationRevisionId: "rep-2" },
      ],
      deduped: false,
    });
    expect(claimMaterializationMock).toHaveBeenCalledTimes(2);
    for (const [index, call] of claimMaterializationMock.mock.calls.entries()) {
      expect(call[0]).toMatchObject({
        runId: "run-1",
        orgId: "org-a",
        outputId: materializeListMemberOutputId("file_bodies", index),
        nodeId: "file_bodies",
        path: "materialize_tool",
        extension: EXT,
      });
    }
    const creates = createSemanticArtifactMock.mock.calls.map((c) => c[0]);
    expect(creates.map((c) => [c.title, c.typedData])).toEqual([
      ["For Ann", { contactId: "c-1", campaignId: "camp-1", runId: "run-1" }],
      ["For Bob", { contactId: "c-2", campaignId: "camp-1", runId: "run-1" }],
    ]);
    expect(creates.every((c) => c.createdByRunId === "run-1" && c.declaredMime === "text/markdown")).toBe(true);
  });

  it("keys each member in a reserved namespace no node id can enter, one string per (node, position)", () => {
    expect(MATERIALIZE_LIST_OUTPUT_ID_PREFIX).toBe(MATERIALIZE_LIST_NODE_ID_PREFIX);
    expect(materializeListMemberOutputId("file_bodies", 0)).toBe('cinatra:list/"file_bodies"/0');
    expect(materializeListMemberOutputId("a/1", 2)).not.toBe(materializeListMemberOutputId("a", 12));
    expect(materializeListMemberOutputId("file_bodies", 0).startsWith(MATERIALIZE_LIST_NODE_ID_PREFIX)).toBe(true);
  });

  it("authorizes every member before the first write: a refused member files nothing", async () => {
    const tooLarge = "x".repeat(10 * 1024 * 1024 + 1);
    const outcome = await materializeToolArtifactList({
      ...BASE_INPUT,
      members: [BASE_INPUT.members[0]!, { title: "Big", content: tooLarge }],
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toMatch(/^member 2: /);
    expect(claimMaterializationMock).not.toHaveBeenCalled();
    expect(createSemanticArtifactMock).not.toHaveBeenCalled();

    const blank = await materializeToolArtifactList({ ...BASE_INPUT, members: [{ title: " ", content: "c" }] });
    expect(blank).toEqual({ ok: false, error: "member 1: title must be a non-empty string" });
    expect(await materializeToolArtifactList({ ...BASE_INPUT, members: [] })).toEqual({
      ok: false,
      error: "a list call files at least one member",
    });
  });

  it("checks every member's typed data against the type's schema before the first write", async () => {
    resolveTypeMock.mockReturnValue({
      schema: z.object({ runId: z.string(), visibility: z.enum(["PUBLIC", "CONNECTIONS"]) }).passthrough(),
    });
    const outcome = await materializeToolArtifactList({
      ...BASE_INPUT,
      members: [
        { title: "Post 1", content: "One", data: { visibility: "PUBLIC" } },
        { title: "Post 2", content: "Two", data: { visibility: "EVERYONE" } },
      ],
    });
    expect(claimMaterializationMock).not.toHaveBeenCalled();
    expect(createSemanticArtifactMock).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toMatch(/^member 2: object payload does not satisfy the declared schema/);
  });

  it("a retried call reuses the members already filed and files only the rest", async () => {
    claimMaterializationMock
      .mockResolvedValueOnce({ kind: "finalized", artifactId: "art-1", representationRevisionId: "rep-1", path: "materialize_tool" })
      .mockResolvedValueOnce({ kind: "claimed", ledgerId: "led-2" });
    createSemanticArtifactMock.mockResolvedValueOnce({ artifactId: "art-2", representationRevisionId: "rep-2" });
    const partial = await materializeToolArtifactList(BASE_INPUT);
    expect(partial).toEqual({
      ok: true,
      artifacts: [
        { artifactId: "art-1", representationRevisionId: "rep-1" },
        { artifactId: "art-2", representationRevisionId: "rep-2" },
      ],
      deduped: false,
    });
    expect(createSemanticArtifactMock).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    claimMaterializationMock
      .mockResolvedValueOnce({ kind: "finalized", artifactId: "art-1", representationRevisionId: "rep-1", path: "materialize_tool" })
      .mockResolvedValueOnce({ kind: "finalized", artifactId: "art-2", representationRevisionId: "rep-2", path: "materialize_tool" });
    const again = await materializeToolArtifactList(BASE_INPUT);
    expect(again).toMatchObject({ ok: true, deduped: true });
    expect(createSemanticArtifactMock).not.toHaveBeenCalled();
  });

  it("names the member whose write failed and never throws", async () => {
    createSemanticArtifactMock
      .mockResolvedValueOnce({ artifactId: "art-1", representationRevisionId: "rep-1" })
      .mockRejectedValueOnce(new Error("disk full"));
    const outcome = await materializeToolArtifactList(BASE_INPUT);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toMatch(/^member 2: .*disk full/);
  });
});
