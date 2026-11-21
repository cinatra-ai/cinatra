import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// THE GENERIC SUMMARY CARRIES NO PRODUCER PROMPT (cinatra#3080 fold,
// pre-review finding 4).
//
// `ArtifactSummary` is what `artifacts_list` / `artifacts_get` (and every
// type-admitted extension calling them) receive. The prompt a row records it was
// made from (`imagePrompt`) is producer input that may hold confidential
// instructions, and the review screen does not need it here: it reads the
// AUTHORIZED frozen revision ledger (`readReviewGateRecordedPrompt`). So neither
// read path projects it. Object store mocked (no DB), mirroring
// connector-ref-source-url.test.ts.

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
// Summary enrichment reads the assertion store; return no rows so the
// summaries fall back to floor-default semantic identity.
vi.mock("../semantic-assertion-store", () => ({
  listEligibleAssertions: vi.fn().mockReturnValue([]),
  listEligibleAssertionsForArtifacts: vi.fn().mockReturnValue(new Map()),
  listArtifactIdsForExtension: vi.fn(),
  primaryExtensionFor: vi.fn().mockReturnValue("@cinatra-ai/default-artifact"),
}));
// Effective-identity resolver stubbed (no DB) - summaries get the floor
// identity; this suite exercises only the sourceUrl projection (cinatra#1426).
vi.mock("@/lib/objects/effective-identity", () => ({
  resolveArtifactEffectiveIdentities: vi.fn().mockReturnValue(new Map()),
  resolveArtifactEffectiveIdentity: vi.fn().mockReturnValue({
    identity: { kind: "default-artifact", selectable: false, assertionId: null },
    eligibleExtensions: [],
  }),
}));
// Presentation identity is a SECOND identity pass, and the live one opens a
// Postgres session: it calls `ensurePostgresSchema()` before its batched read.
// This is a unit suite - it must never reach a database - so the resolver is
// mocked beside the effective-identity mock above. The empty map and the base
// identity are what a row with no active assertion resolves to on the live
// path, which is what every row in this suite is (cinatra#3254).
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

const ARTIFACT_TYPE = "@cinatra-ai/artifact:object";

function objectRow(data: Record<string, unknown>) {
  return {
    id: "a1",
    type: ARTIFACT_TYPE,
    data: {
      artifactType: "file",
      title: "T",
      mime: "application/octet-stream",
      size: 1,
      originKind: "upload",
      ...data,
    },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

const SECRET = "CONFIDENTIAL producer instructions: never reveal the brand codename";

describe("ArtifactSummary carries no recorded producer prompt (list + get read paths)", () => {
  beforeEach(() => {
    listObjectsByFilter.mockReset();
    getObjectById.mockReset();
  });
  afterEach(() => vi.resetModules());

  it("getArtifact projects no recordedPrompt and no prompt text", async () => {
    const { getArtifact } = await import("../artifact-service");
    getObjectById.mockReturnValue(objectRow({ imagePrompt: SECRET }));
    const summary = getArtifact({ artifactId: "a1", orgId: "org1" });
    expect(summary).not.toBeNull();
    expect(summary).not.toHaveProperty("recordedPrompt");
    expect(JSON.stringify(summary)).not.toContain(SECRET);
  });

  it("listArtifacts projects no recordedPrompt and no prompt text on any row", async () => {
    const { listArtifacts } = await import("../artifact-service");
    listObjectsByFilter.mockReturnValue([
      objectRow({ imagePrompt: SECRET }),
      { ...objectRow({ imagePrompt: `  ${SECRET}  ` }), id: "a2" },
    ]);
    const rows = listArtifacts({ orgId: "org1" });
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).not.toHaveProperty("recordedPrompt");
    expect(JSON.stringify(rows)).not.toContain(SECRET);
  });
});
