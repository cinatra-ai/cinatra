import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// cinatra#4762: a writer of a run's output holds the run row FOR KEY SHARE from its FIRST write to its commit, so a
// Publish's locked fence read (FOR UPDATE) never runs while the output's rows are written but its produced event, the
// transaction's last statement, is not. The asynchronous Postgres client is a spy that answers by position; no
// database is used.

type Query = { text: string; values: unknown[] };
const asyncCalls: Query[][] = [];

vi.mock("@/lib/database", () => ({
  ensurePostgresSchema: () => {},
  getPostgresConnectionString: () => "postgres://unit-test",
  postgresSchema: "cinatra",
}));
vi.mock("@/lib/postgres-sync", () => ({ runPostgresQueriesSync: vi.fn() }));
// The state a test sets: a publishing call of the run in flight, or a transaction Postgres aborts with `abort`.
const db: { publishCallInFlight: boolean; abort: unknown } = { publishCallInFlight: false, abort: null };
vi.mock("@/lib/postgres-async", () => ({
  runPostgresQueriesAsync: async (input: { transaction?: boolean; queries: Query[] }) => {
    asyncCalls.push(input.queries);
    if (!input.transaction) {
      // One read or write of the append API before its transaction: the artifact, its base revision, the
      // content-addressed resource. Any other statement (a claim's release) finds nothing.
      const text = input.queries[0]?.text ?? "";
      const row = text.includes('FROM "cinatra"."objects"') ? { type: "post" }
        : text.includes('SELECT revision FROM "cinatra"."representation"') ? { revision: 1 }
          : text.includes("resource_op") ? { resource_id: "res-1", is_new: false, storage_key: "blob-key" }
            : null;
      return [{ rows: row ? [row] : [], rowCount: row ? 1 : 0 }];
    }
    if (db.abort) throw db.abort;
    if (db.publishCallInFlight) {
      // What Postgres raises while a claim is counted: the produced event's cast of the in-flight fence's sentinel.
      const fence = input.queries.map((q) => /THEN '([^']+)' ELSE '1' END\)::integer = 1/.exec(q.text)).find(Boolean);
      if (fence) throw Object.assign(new Error(`invalid input syntax for type integer: "${fence[1]}"`), { code: "22P02" });
    }
    // Only the revision insert returns a row; a reader at any other position finds none.
    return input.queries.map((q) => ({
      rows: q.text.includes('INSERT INTO "cinatra"."representation"')
        ? [{ id: "rev-new", org_id: "org-1", artifact_id: "art-1", resource_id: "res-1", revision: 2, form: "file",
            created_by: null, created_by_run_id: "run-1", created_at: "2026-11-24" }]
        : [],
      rowCount: 0,
    }));
  },
}));

const RUN_LOCK = { text: `SELECT 1 FROM "cinatra"."agent_runs" WHERE id = $1::text FOR KEY SHARE`, values: ["run-1"] };
const kind = (q: Query) =>
  q.text.includes("pg_advisory_xact_lock") ? "advisory"
    : q.text.includes("FOR KEY SHARE") ? "run-lock"
      : q.text.includes("base_present") ? "base"
        : q.text.includes('INSERT INTO "cinatra"."representation"') ? "insert"
          : "follow-on";

// The append API's own collaborators: no type declares accepts, the bytes land nowhere, the ledger claims fresh.
vi.mock("@/lib/register-all-object-types", () => ({ registerAllObjectTypes: () => {} }));
vi.mock("@cinatra-ai/objects/registry", () => ({ objectTypeRegistry: { resolve: () => undefined } }));
vi.mock("../local-disk-blob-store", () => ({
  createLocalDiskBlobStore: () => ({
    put: async () => ({ storageKey: "blob-key", sha256: "a".repeat(64), mimeDetected: "text/markdown", sizeBytes: 5, blobId: "blob-1" }),
    deleteByStorageKey: async () => undefined,
  }),
}));
vi.mock("../materialization-ledger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../materialization-ledger")>()),
  claimMaterialization: async () => ({ kind: "claimed", ledgerId: "ledger-1" }),
}));

beforeEach(() => {
  asyncCalls.length = 0;
  db.publishCallInFlight = false;
  db.abort = null;
});

describe("cinatra#4762: a write refused by the in-flight publishing-call fence says so", () => {
  const append = async () => {
    const { appendArtifactRevision } = await import("../artifact-revision-append");
    return appendArtifactRevision({
      orgId: "org-1", runId: "run-1", nodeId: "draft", artifactId: "art-1", baseRepresentationRevisionId: "rev-1",
      content: "hello", mime: "text/markdown", createdBy: null, extension: "@cinatra-ai/post",
    });
  };

  // red-first-expect: to match object { ok: false, …(1) }
  it("an append while a publishing call of its run is in flight is refused as that call, never as an unknown base", async () => {
    db.publishCallInFlight = true;
    const out = await append();
    expect(out).toMatchObject({ ok: false, reason: "publish_call_in_flight" });
    // Temporary, so it leaves nothing behind: the ledger claim is released for the retry.
    expect(asyncCalls.flat().some((q) => q.text.includes('DELETE FROM "cinatra"."artifact_materializations"'))).toBe(true);
    // Once the call has ended, the same append is taken.
    db.publishCallInFlight = false;
    expect(await append()).toMatchObject({ ok: true, representationRevisionId: "rev-new" });
  });

  it("a base the guard finds missing is still an unknown base", async () => {
    db.abort = Object.assign(new Error("division by zero"), { code: "22012" });
    expect(await append()).toMatchObject({ ok: false, reason: "unknown_base" });
  });

  // red-first-expect: expected Error: invalid input syntax for type inte
  it("the store's append rethrows the fence's abort as the typed refusal, not as unknown-base", async () => {
    const { appendRepresentationWithExpectedBase } = await import("../representation-store");
    db.publishCallInFlight = true;
    const run = () => appendRepresentationWithExpectedBase({
      orgId: "org-1", artifactId: "art-1", baseRevisionId: "rev-1", resourceId: "res-1", form: "file", createdByRunId: "run-1",
      additionalOps: () => [{ text: `SELECT (CASE WHEN true THEN 'cinatra_publish_call_in_flight' ELSE '1' END)::integer = 1`, values: [] }],
    });
    await expect(run()).rejects.toMatchObject({ name: "PublishCallInFlightError", code: "publish_call_in_flight", retryable: true });
  });
});

describe("cinatra#4762: the revision append takes its leading locks before the base guard and the insert", () => {
  // red-first-expect: expected [ 'advisory', 'base', 'insert', …(1) ] to deeply equal [ Array(5) ]
  it("runs the leading ops right after the advisory lock and still reads the record from the insert", async () => {
    const { appendRepresentationWithExpectedBase } = await import("../representation-store");
    const out = await appendRepresentationWithExpectedBase({
      orgId: "org-1",
      artifactId: "art-1",
      baseRevisionId: "rev-1",
      resourceId: "res-1",
      form: "file",
      createdByRunId: "run-1",
      leadingOps: () => [RUN_LOCK],
      additionalOps: () => [{ text: "SELECT 'follow-on'", values: [] }],
    });
    expect(asyncCalls[0].map(kind)).toEqual(["advisory", "run-lock", "base", "insert", "follow-on"]);
    expect(out).toMatchObject({ kind: "appended", record: { id: "rev-new", revision: 2 } });
  });

  it("with no leading ops the transaction is the one it was", async () => {
    const { appendRepresentationWithExpectedBase } = await import("../representation-store");
    const out = await appendRepresentationWithExpectedBase({
      orgId: "org-1", artifactId: "art-1", baseRevisionId: "rev-1", resourceId: "res-1", form: "file",
    });
    expect(asyncCalls[0].map(kind)).toEqual(["advisory", "base", "insert"]);
    expect(out).toMatchObject({ kind: "appended", record: { id: "rev-new" } });
  });
});

describe("cinatra#4762: each writer splices the run lock before its first write and keeps its parsed offsets", () => {
  const read = (rel: string) => readFileSync(path.join(__dirname, "..", rel), "utf8");
  const after = (src: string, anchor: string) => {
    const at = src.indexOf(anchor);
    expect(at).toBeGreaterThan(-1);
    return src.slice(at + anchor.length);
  };

  // red-first-expect: expected false to be true // Object.is equality
  it("the create, the run's revision append and the snapshot mint each take the lock from producerRunLockOps", () => {
    // Create: the lock directly after the advisory lock, ahead of the objects write; the producer offset counts it.
    const create = read("artifact-creation.ts");
    expect(after(create, "values: [artifactId],\n        },\n").trimStart().startsWith("...runLockOps,")).toBe(true);
    expect(create).toMatch(/const runLockOps = producerRunLockOps\(schema, persistedRunId, producedEventOp\);/);
    expect(create).toMatch(/const PRODUCER_OPS_OFFSET = 4 \+ runLockOps\.length;/);
    expect(create).toMatch(/\.\.\.\(producedEventOp \? \[producedEventOp\] : \[\]\),/);
    // The run's revision append: its leading ops are the lock of the same event it appends.
    const append = read("artifact-revision-append.ts");
    expect(append).toMatch(/leadingOps: \(representationRevisionId\) =>\s+producerRunLockOps\(schema, input\.runId, producedEventOpFor\(representationRevisionId\)\)/);
    // The snapshot mint: the lock after the advisory lock, and the capture result read past it.
    const mint = read("object-content-snapshot.ts");
    expect(after(mint, "values: [input.objectId] },\n").trimStart().startsWith("...runLockOps,")).toBe(true);
    expect(mint).toMatch(/\}\)\)\[2 \+ runLockOps\.length\];/);
  });
});
