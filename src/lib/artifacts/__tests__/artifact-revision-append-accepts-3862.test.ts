import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// cinatra#3862 leg 1, a review finding on the revision door: a revision that
// is re-filed or appended onto an artifact must carry a MIME the artifact's
// own type accepts, read from the object type registry the door already uses
// for `appendArtifactRevision`. The synchronous Postgres client is a spy that
// answers by the statement it is handed; no database is used.

type Query = { text: string; values: unknown[] };
const calls: Array<{ transaction: boolean; queries: Query[] }> = [];
let sourceMime = "image/png";

const putBlob = vi.fn();

vi.mock("@/lib/database", () => ({
  ensurePostgresSchema: () => {},
  getPostgresConnectionString: () => "postgres://unit-test",
  postgresSchema: "cinatra",
}));
vi.mock("@/lib/register-all-object-types", () => ({ registerAllObjectTypes: () => {} }));
vi.mock("@cinatra-ai/objects/registry", () => ({
  objectTypeRegistry: {
    resolve: (type: string) =>
      type === "post" ? { isArtifact: { accepts: { file: { mimeTypes: ["text/markdown"] } } } } : undefined,
  },
}));
vi.mock("../local-disk-blob-store", () => ({ createLocalDiskBlobStore: () => ({ put: putBlob }) }));
vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (input: { transaction?: boolean; queries: Query[] }) => {
    calls.push({ transaction: input.transaction === true, queries: input.queries });
    if (input.transaction) {
      // Every statement of a write answers with one row, as if it landed.
      return input.queries.map(() => ({ rows: [{ id: "rev-new", revision: 2, representation_revision_id: "rev-new" }] }));
    }
    const text = input.queries[0]?.text ?? "";
    if (/FROM "cinatra"\."objects"/.test(text)) {
      return [{ rows: [{ id: "art-post", type: "post", data: { artifactType: "file" }, deleted_at: null }] }];
    }
    return [{ rows: [{ id: "rev-run", resource_id: "res-1", mime: sourceMime, size_bytes: 10, substance_key: "blob:abc" }] }];
  },
}));

beforeEach(() => {
  calls.length = 0;
  sourceMime = "image/png";
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("cinatra#3862 leg 1, the revision door refuses a MIME the target's type does not accept", () => {
  it("a re-file of a picture onto a post is refused before any write", async () => {
    const door = await import("../artifact-revision-append");
    let thrown: unknown;
    try {
      door.refileRevisionOntoArtifact({
        orgId: "org-1",
        targetArtifactId: "art-post",
        sourceArtifactId: "art-run",
        sourceRepresentationRevisionId: "rev-run",
        createdByRunId: "run-1",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(door.SemanticArtifactRevisionAppendRefusal);
    expect((thrown as { code?: string }).code).toBe("accepts-mismatch");
    expect(calls.filter((c) => c.transaction)).toHaveLength(0);
  });

  it("a re-file of an accepted MIME goes on to the write", async () => {
    sourceMime = "text/markdown";
    const door = await import("../artifact-revision-append");
    const out = door.refileRevisionOntoArtifact({
      orgId: "org-1",
      targetArtifactId: "art-post",
      sourceArtifactId: "art-run",
      sourceRepresentationRevisionId: "rev-run",
      createdByRunId: "run-1",
    });
    expect(out.artifactId).toBe("art-post");
    expect(calls.filter((c) => c.transaction)).toHaveLength(1);
  });

  it("a byte append of a picture onto a post is refused before the blob is written", async () => {
    const door = await import("../artifact-revision-append");
    async function* bytes(): AsyncIterable<Uint8Array> {
      yield new TextEncoder().encode("png");
    }
    await expect(
      door.appendSemanticArtifactRevision({
        orgId: "org-1",
        artifactId: "art-post",
        stream: bytes(),
        declaredMime: "image/png",
      }),
    ).rejects.toMatchObject({ code: "accepts-mismatch" });
    expect(putBlob).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.transaction)).toHaveLength(0);
  });
});
