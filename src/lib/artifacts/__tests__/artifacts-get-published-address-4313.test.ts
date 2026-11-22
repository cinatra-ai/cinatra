import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// cinatra#4313: artifacts_get answers the published page address.
//
// After a person publishes a post, the WordPress publish run merges three keys
// into the post artifact's `objects.data` through `objects_update`:
// `wordpressPublishedUrl`, `wordpressPublishedExternalId` and
// `wordpressPublishedRevisionId`. The issue's reading takes that address back
// through `artifacts_get`, so the artifact summary must carry the three keys.
// This suite reads them through the service (`getArtifact`), the run-scoped
// handler (`extensionArtifactGet`) and the MCP `artifacts_get` tool. The URL
// passes only as an absolute http/https URL (the `sourceUrl` check), and a row
// without the keys answers none of them. Object store mocked (no DB), with the
// same mocks as connector-ref-source-url.test.ts and service-and-mcp.test.ts.

const listObjectsByFilter = vi.fn();
const getObjectById = vi.fn();

vi.mock("@/lib/objects-store", () => ({
  listObjectsByFilter: (...a: unknown[]) => listObjectsByFilter(...a),
  getObjectById: (...a: unknown[]) => getObjectById(...a),
}));
vi.mock("../artifact-retention", () => ({
  tombstoneArtifact: vi.fn(),
}));
vi.mock("../artifact-creation", () => ({
  createSemanticArtifact: vi.fn(),
}));
vi.mock("../semantic-assertion-store", () => ({
  listEligibleAssertions: vi.fn().mockReturnValue([]),
  listEligibleAssertionsForArtifacts: vi.fn().mockReturnValue(new Map()),
  listArtifactIdsForExtension: vi.fn(),
  primaryExtensionFor: vi.fn().mockReturnValue("@cinatra-ai/default-artifact"),
  listActiveAssertions: vi.fn(),
  getAssertionByIdForReplay: vi.fn(),
}));
vi.mock("../representation-store", () => ({
  listRepresentations: vi.fn(),
  getLatestRepresentation: vi.fn(),
  getRepresentationByIdForReplay: vi.fn(),
}));
vi.mock("@/lib/objects/effective-identity", () => ({
  resolveArtifactEffectiveIdentities: vi.fn().mockReturnValue(new Map()),
  resolveArtifactEffectiveIdentity: vi.fn().mockReturnValue({
    identity: { kind: "default-artifact", selectable: false, assertionId: null },
    eligibleExtensions: [],
  }),
}));
// The live presentation resolver opens a Postgres session; this unit suite
// must never reach a database, so it is mocked like the effective identity.
vi.mock("@/lib/objects/presentation-identity", () => ({
  resolveArtifactPresentationIdentities: vi.fn().mockReturnValue(new Map()),
  resolveArtifactPresentationIdentity: vi.fn().mockReturnValue({
    identity: { kind: "default-artifact", selectable: false, assertionId: null },
    tier: "claim-backed",
    suggestions: [],
  }),
}));
vi.mock("@/lib/register-all-object-types", () => ({
  registerAllObjectTypes: vi.fn(),
}));
vi.mock("@/lib/authz/build-actor-context", () => ({
  buildActorContextFromPrimitive: () => ({
    principalType: "ServiceAccount",
    principalId: "svc",
  }),
}));
// The MCP tool reads its organization from the request scope.
vi.mock("@/lib/mcp-tool-scope", () => ({
  resolveScope: () => ({ orgId: "org1", userId: null, actor: undefined }),
}));

const ARTIFACT_TYPE = "@cinatra-ai/artifact:object";

const ADDRESS = {
  wordpressPublishedUrl: "https://blog.example.com/2026/09/the-lighthouse/",
  wordpressPublishedExternalId: "4711",
  wordpressPublishedRevisionId: "rev-wp-2",
};

const ADDRESS_KEYS = [
  "wordpressPublishedUrl",
  "wordpressPublishedExternalId",
  "wordpressPublishedRevisionId",
] as const;

function postRow(data: Record<string, unknown>) {
  return {
    id: "post-1",
    type: ARTIFACT_TYPE,
    data: {
      artifactType: "file",
      title: "The lighthouse",
      mime: "text/markdown",
      size: 12,
      originKind: "agent_generated",
      ...data,
    },
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-02T00:00:00Z",
  };
}

beforeEach(() => {
  listObjectsByFilter.mockReset();
  getObjectById.mockReset();
});
afterEach(() => vi.resetModules());

describe("cinatra#4313: artifacts_get answers the published page address", () => {
  it("getArtifact carries the three address keys the publish run wrote", async () => {
    const { getArtifact } = await import("../artifact-service");
    getObjectById.mockReturnValue(postRow(ADDRESS));
    const summary = getArtifact({ artifactId: "post-1", orgId: "org1" });
    expect(summary?.wordpressPublishedUrl).toBe(ADDRESS.wordpressPublishedUrl);
    expect(summary?.wordpressPublishedExternalId).toBe("4711");
    expect(summary?.wordpressPublishedRevisionId).toBe("rev-wp-2");
  });

  it("the run-scoped artifacts_get handler answers the address", async () => {
    const { extensionArtifactGet } = await import("../extension-artifact-reads");
    getObjectById.mockReturnValue(postRow(ADDRESS));
    const artifact = await extensionArtifactGet(
      {
        admission: {
          packageName: "@cinatra-ai/w7-reader-agent",
          packageVersion: "1.0.0",
          admittedPackages: ["@cinatra-ai/artifact"],
          admittedTypes: [ARTIFACT_TYPE],
          declarationDigest: "0".repeat(64),
        },
        orgId: "org1",
        runId: "run-4313",
        audit: async () => {},
      },
      { artifactId: "post-1" },
    );
    expect(artifact.objectType).toBe(ARTIFACT_TYPE);
    expect(artifact.wordpressPublishedUrl).toBe(ADDRESS.wordpressPublishedUrl);
    expect(artifact.wordpressPublishedExternalId).toBe("4711");
    expect(artifact.wordpressPublishedRevisionId).toBe("rev-wp-2");
  });

  it("the MCP artifacts_get tool answers the address in its result", async () => {
    const { createArtifactsModule } = await import("../mcp");
    const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
    const server = {
      registerTool: (name: string, _meta: unknown, handler: (input: unknown) => Promise<unknown>) =>
        handlers.set(name, handler),
    } as never;
    createArtifactsModule().registerCapabilities(server);
    getObjectById.mockReturnValue(postRow(ADDRESS));
    const result = (await handlers.get("artifacts_get")!({ artifactId: "post-1" })) as {
      content: Array<{ type: string; text: string }>;
      structuredContent: { artifact: Record<string, unknown> };
    };
    for (const key of ADDRESS_KEYS) {
      expect(result.structuredContent.artifact[key]).toBe(ADDRESS[key]);
    }
    const text = JSON.parse(result.content[0]!.text) as { artifact: Record<string, unknown> };
    expect(text.artifact.wordpressPublishedUrl).toBe(ADDRESS.wordpressPublishedUrl);
  });

  it("leaves out a URL that is not an absolute http/https URL, and keys that are not non-empty strings", async () => {
    const { getArtifact } = await import("../artifact-service");
    for (const wordpressPublishedUrl of ["javascript:alert(1)", "/2026/09/the-lighthouse/", "", 42]) {
      getObjectById.mockReturnValue(
        postRow({
          wordpressPublishedUrl,
          wordpressPublishedExternalId: 4711,
          wordpressPublishedRevisionId: "",
        }),
      );
      const summary = getArtifact({ artifactId: "post-1", orgId: "org1" });
      expect(summary).not.toBeNull();
      for (const key of ADDRESS_KEYS) expect(summary).not.toHaveProperty(key);
    }
  });

  it("a row without the address answers none of the keys, so its summary keeps its shape", async () => {
    const { getArtifact } = await import("../artifact-service");
    getObjectById.mockReturnValue(postRow({}));
    const summary = getArtifact({ artifactId: "post-1", orgId: "org1" });
    expect(summary).not.toBeNull();
    for (const key of ADDRESS_KEYS) expect(summary).not.toHaveProperty(key);
    expect(summary?.sourceUrl).toBeNull();
  });
});
