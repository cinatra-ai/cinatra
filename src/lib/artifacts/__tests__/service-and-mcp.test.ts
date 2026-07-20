import { execSync } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";

// Object store mocked (no DB). Proves the service's type-driven read filter
// (epic #1785 wave A4): the library / get / tombstone gates admit the generic
// base (legacy rows, until the A6 purge) PLUS every registered isArtifact PACK
// type read from `objectTypeRegistry.listArtifacts()` — the A3 writer stamps a
// row's EXACT declared pack type into objects.type, so a generic-only filter
// would strand every pack-typed row. Semantic identity is still the
// `semantic_assertion` set. The MCP layer wraps ONLY the service, and the
// /assets/media surface is purged. The single-write-path invariant test
// asserts `artifact-creation.ts` is the SOLE writer entry point.
const GENERIC_ARTIFACT_TYPE = "@cinatra-ai/artifact:object";
const PACK_TYPE = "@cinatra-ai/pdf-artifact:document";
const PACK_EXT = "@cinatra-ai/pdf-artifact";

/** Register a synthetic isArtifact PACK type so `artifactObjectTypeIds()`
 *  admits it (the A3 base-pack shape). registerAllObjectTypes is mocked no-op,
 *  so the registry carries only what a test registers. */
function registerPackType(): void {
  objectTypeRegistry.register(
    {
      type: PACK_TYPE,
      category: "report",
      schema: z.record(z.string(), z.unknown()),
      lifecycle: { sources: ["agent"], mutableBy: ["agent"] },
      renderers: { listRow: null, card: null, detail: null },
      isArtifact: { accepts: { file: { mimeTypes: ["application/pdf"] } } },
      dispositions: { projection: "artifact-safe" },
    } as never,
    PACK_EXT,
  );
}

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
// Service summary enrichment resolves through the effective-identity
// service (cinatra#1426); the stub returns no enrichment so summaries get
// the floor default identity.
vi.mock("@/lib/objects/effective-identity", () => ({
  resolveArtifactEffectiveIdentities: vi.fn().mockReturnValue(new Map()),
  resolveArtifactEffectiveIdentity: vi.fn().mockReturnValue({
    identity: { kind: "default-artifact", selectable: false, assertionId: null },
    eligibleExtensions: [],
  }),
}));
// The assertion store still backs the extension filter + the MCP semantic
// primitives; stubbed (registered tools are not invoked here).
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
    objectTypeRegistry._clearForTests();
  });
  afterEach(() => {
    objectTypeRegistry._clearForTests();
    vi.resetModules();
  });

  it("lists by fanning out over the generic base AND every registered isArtifact pack type (type-driven; epic #1785 A4)", async () => {
    registerPackType();
    const { listArtifacts } = await import("../artifact-service");
    const rowFor = (type: string, id: string) => ({
      id,
      type,
      data: {
        artifactType: "file",
        title: id,
        mime: "x/y",
        size: 3,
        originKind: "upload",
        latestRepresentationRevisionId: `${id}-v9`,
      },
      createdAt: "2026-01-02",
      updatedAt: "2026-01-02",
    });
    listObjectsByFilter.mockImplementation((f: { type: string }) =>
      f.type === GENERIC_ARTIFACT_TYPE
        ? [rowFor(GENERIC_ARTIFACT_TYPE, "n1")]
        : f.type === PACK_TYPE
          ? [rowFor(PACK_TYPE, "p1")]
          : [],
    );
    const out = listArtifacts({ orgId: "org1" });
    // Both the legacy generic row AND the pack-typed row surface.
    expect(out.map((o) => o.artifactId).sort()).toEqual(["n1", "p1"]);
    // Fan-out over the type-driven set: the generic base + the registered pack.
    const filteredTypes = listObjectsByFilter.mock.calls.map(
      (c) => (c[0] as { type: string }).type,
    );
    expect(filteredTypes.sort()).toEqual([GENERIC_ARTIFACT_TYPE, PACK_TYPE].sort());
  });

  it("getArtifact returns null when the object type is NOT a registered artifact type", async () => {
    registerPackType();
    const { getArtifact } = await import("../artifact-service");
    getObjectById.mockReturnValue({ id: "c1", type: "@cinatra-ai/entity-contacts:contact", data: {} });
    expect(getArtifact({ artifactId: "c1", orgId: "o" })).toBeNull();
  });

  it("getArtifact returns the summary for a registered isArtifact PACK-typed row (library-visible; epic #1785 A4)", async () => {
    registerPackType();
    const { getArtifact } = await import("../artifact-service");
    getObjectById.mockReturnValue({
      id: "p1",
      type: PACK_TYPE,
      data: {
        artifactType: "file",
        title: "doc",
        mime: "application/pdf",
        size: 12,
        originKind: "upload",
        latestRepresentationRevisionId: "p1-v1",
      },
      ownerLevel: "organization",
      ownerId: "org1",
      visibility: "organization",
    });
    const got = getArtifact({ artifactId: "p1", orgId: "org1" });
    expect(got).not.toBeNull();
    expect(got).toMatchObject({ artifactId: "p1", objectType: PACK_TYPE });
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
      // Internal (actor-less) callers attribute the canonical soft-delete
      // change event to the system principal (cinatra#1428).
      actorKind: "system",
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
      // Row-scope promotion request (cinatra#1437) — opens a pending request
      // in the approvals area; the widen happens only via approvals_decide.
      "artifact_promote_request",
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
      // Declarative run-completion materializer (cinatra#923) — the
      // SERVICE-LAYER module that pushes EndNode-binding-declared outputs
      // through createSemanticArtifact under the idempotency ledger (the
      // ledger finalize is tx-composed INTO the writer's own transaction).
      // Part of the canonical write path, not an alternate writer.
      "run-artifact-materializer.ts",
      // NOT an importer: the objects surface-inventory documents the writer
      // file in its raw-object-access allow-list as a string literal
      // ("src/lib/artifacts/artifact-creation.ts"). It contains no import of
      // the write path; excluded so the path-substring grep arm above does
      // not false-positive on the inventory entry.
      "surface-inventory.ts",
      // NOT an importer: the #303 postgres-sync-bridge caller inventory lists
      // the writer file as a string-literal classification KEY
      // ("src/lib/artifacts/artifact-creation.ts" -> migratable-request-path).
      // It is a pure read-only data/types module with NO imports at all;
      // excluded for the same reason as surface-inventory.ts above.
      "postgres-sync-inventory.ts",
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
