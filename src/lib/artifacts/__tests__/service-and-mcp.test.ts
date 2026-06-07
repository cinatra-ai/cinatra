import { execSync } from "node:child_process";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Object store mocked (no DB). Proves the service queries the generic
// SEMANTIC_ARTIFACT_OBJECT_TYPE. Every artifact row carries the same
// object type; semantic identity is the `semantic_assertion` set. The
// MCP layer wraps ONLY the service, and the /assets/media surface is
// purged.
//
// The service filters directly on SEMANTIC_ARTIFACT_OBJECT_TYPE instead
// of per-type fan-out across `objectTypeRegistry.listArtifacts()`. The
// single-write-path invariant test asserts `artifact-creation.ts` is the
// SOLE writer entry point.

const listObjectsByFilter = vi.fn();
const getObjectById = vi.fn();
const retentionTombstone = vi.fn();

vi.mock("@/lib/objects-store", () => ({
  listObjectsByFilter: (...a: unknown[]) => listObjectsByFilter(...a),
  getObjectById: (...a: unknown[]) => getObjectById(...a),
}));
vi.mock("../artifact-retention", () => ({
  tombstoneArtifact: (i: unknown) => retentionTombstone(i),
}));
vi.mock("../artifact-creation", () => ({
  createSemanticArtifact: vi.fn(),
}));
// Service summary enrichment reads from the assertion store; tests drive
// a stub that returns no rows so summaries get the floor default identity.
vi.mock("../semantic-assertion-store", () => ({
  listEligibleAssertions: vi.fn().mockReturnValue([]),
  listEligibleAssertionsForArtifacts: vi.fn().mockReturnValue(new Map()),
  primaryExtensionFor: vi.fn().mockReturnValue("@cinatra-ai/default-artifact"),
  // Re-export the remaining stores accessed by mcp.ts (registered tools
  // are not invoked in this test; the symbols just need to resolve).
  listActiveAssertions: vi.fn(),
  getAssertionByIdForReplay: vi.fn(),
}));
vi.mock("../representation-store", () => ({
  listRepresentations: vi.fn(),
  getLatestRepresentation: vi.fn(),
  getRepresentationByIdForReplay: vi.fn(),
}));
// ensureArtifactRegistry() calls this server-only barrel (heavy import
// graph) — stub it; the test drives objectTypeRegistry.listArtifacts()
// directly via the @cinatra-ai/objects mock above.
vi.mock("@/lib/register-all-object-types", () => ({
  registerAllObjectTypes: vi.fn(),
}));
vi.mock("@/lib/authz/build-actor-context", () => ({
  buildActorContextFromPrimitive: () => ({
    principalType: "ServiceAccount",
    principalId: "svc",
  }),
}));

describe("artifact-service semantic artifact object filtering", () => {
  beforeEach(() => {
    listObjectsByFilter.mockReset();
    getObjectById.mockReset();
    retentionTombstone.mockReset();
  });
  afterEach(() => vi.resetModules());

  it("lists by filtering on the generic SEMANTIC_ARTIFACT_OBJECT_TYPE (one query, not per-extension)", async () => {
    const { listArtifacts } = await import("../artifact-service");
    listObjectsByFilter.mockImplementation((f: { type: string }) =>
      f.type === "@cinatra-ai/artifact:object"
        ? [
            {
              id: "n1",
              type: f.type,
              data: {
                artifactType: "file",
                title: "N",
                mime: "x/y",
                size: 3,
                originKind: "upload",
                latestRepresentationRevisionId: "v9",
              },
              createdAt: "2026-01-02",
              updatedAt: "2026-01-02",
            },
          ]
        : [],
    );
    const out = listArtifacts({ orgId: "org1" });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      artifactId: "n1",
      artifactType: "file",
      latestRepresentationRevisionId: "v9",
    });
    // EXACTLY ONE objects.type filter: the generic
    // `@cinatra-ai/artifact:object`; no per-extension fan-out.
    expect(listObjectsByFilter).toHaveBeenCalledTimes(1);
    expect(listObjectsByFilter).toHaveBeenCalledWith(
      expect.objectContaining({ type: "@cinatra-ai/artifact:object" }),
      undefined,
    );
  });

  it("getArtifact returns null when the object type is NOT the semantic artifact type", async () => {
    const { getArtifact } = await import("../artifact-service");
    getObjectById.mockReturnValue({ id: "c1", type: "@cinatra-ai/entity-contacts:contact", data: {} });
    expect(getArtifact({ artifactId: "c1", orgId: "o" })).toBeNull();
  });

  it("tombstone delegates to the retention path (single delete path)", async () => {
    const { tombstoneArtifact } = await import("../artifact-service");
    retentionTombstone.mockReturnValue({ referenced: true });
    expect(tombstoneArtifact({ orgId: "o", artifactId: "a" })).toEqual({
      referenced: true,
    });
    expect(retentionTombstone).toHaveBeenCalledWith({
      orgId: "o",
      artifactId: "a",
      actor: null,
    });
  });
});

describe("artifacts MCP module semantic primitives", () => {
  it("registers the artifact CRUD wrappers and semantic primitives", async () => {
    const { createArtifactsModule } = await import("../mcp");
    const registered: string[] = [];
    const server = {
      registerTool: (name: string) => registered.push(name),
    } as never;
    createArtifactsModule().registerCapabilities(server);
    expect(registered.sort()).toEqual([
      // Original artifact CRUD wrappers.
      "artifacts_get",
      "artifacts_list",
      "artifacts_tombstone",
      // Semantic identity reads.
      "artifact_assertion_get",
      "artifact_assertion_list",
      "artifact_representation_get",
      "artifact_representation_latest",
      "artifact_representation_list",
      // Chat-driven authoring primitives.
      "artifact_authoring_chain_get",
      "artifact_authoring_emit",
      "artifact_extension_get",
      "artifact_extension_search",
    ].sort());
  });
});

describe("Media route purge gate", () => {
  it("only the explicit allow-list of lib-service files imports ./artifact-creation (single write path)", () => {
    // `artifact-write.ts` is a thin deprecated shim over
    // `artifact-creation.ts`; both files keep the single-write-path
    // invariant.
    //
    // `artifact-template.ts` and `artifact-authoring.ts` are
    // SERVICE-LAYER lib modules that compose createSemanticArtifact with
    // the assertion service. They are part of the canonical write path
    // (same invariants enforced), not alternate writers. They are
    // explicitly allow-listed here so the single-write-path invariant
    // remains a positive list: new importers still fail this test by
    // default.
    const ALLOW_LIST = [
      "artifact-service.ts",
      "artifact-write.ts",
      "artifact-template.ts",
      "artifact-authoring.ts",
      // URL-import lib service. Wraps the fetch-and-normalize helper
      // with createSemanticArtifact; the server action
      // (library-import-actions.ts) calls THIS module, not the writer
      // directly.
      "artifact-url-import.ts",
      // Blog materializers — SERVICE-LAYER lib modules that push
      // agent-produced blog idea / image / post-body bytes through
      // createSemanticArtifact + assertSemanticType (same single-write-path
      // invariants), one artifact per call. They are part of the canonical
      // write path, not alternate writers.
      "blog-idea-artifact-materializer.ts",
      "blog-image-materializer.ts",
      "blog-post-artifact-materializer.ts",
      // NOT an importer: the objects surface-inventory documents the writer
      // file in its raw-object-access allow-list as a string literal
      // ("src/lib/artifacts/artifact-creation.ts"). It contains no import of
      // the write path; excluded so the path-substring grep arm above does
      // not false-positive on the inventory entry.
      "surface-inventory.ts",
    ];
    const root = path.join(__dirname, "../../../..");
    const grepFilter = ALLOW_LIST.map((f) => `grep -v "${f}"`).join(" | ");
    const out = execSync(
      `grep -rln "artifacts/artifact-creation\\|from \\"./artifact-creation\\"\\|from \\"../artifact-creation\\"" src 2>/dev/null | ${grepFilter} | grep -v __tests__ || true`,
      { cwd: root, encoding: "utf8" },
    ).trim();
    expect(out).toBe("");
  });

  it("only artifact-service.ts imports the deprecated artifact-write.ts shim", () => {
    // The deprecated shim must not gain new importers; otherwise the
    // single-write-path invariant erodes from the OTHER side: an importer
    // would silently bypass the semantic contract.
    const root = path.join(__dirname, "../../../..");
    const out = execSync(
      `grep -rln "artifacts/artifact-write\\|from \\"./artifact-write\\"\\|from \\"../artifact-write\\"" src 2>/dev/null | grep -v "artifact-service.ts" | grep -v "artifact-creation.ts" | grep -v __tests__ || true`,
      { cwd: root, encoding: "utf8" },
    ).trim();
    expect(out).toBe("");
  });

  it("no /assets/media reference remains outside the preflight doc", () => {
    const root = path.join(__dirname, "../../../..");
    const out = execSync(
      // exclude the preflight doc (documents the gate) and this guard test
      // itself (mentions the path) — both legitimately contain the string.
      `grep -rn "assets/media" src packages 2>/dev/null | grep -v artifacts-preflight | grep -v service-and-mcp.test || true`,
      { cwd: root, encoding: "utf8" },
    ).trim();
    expect(out).toBe("");
  });
});
