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
vi.mock("@/lib/postgres-async", () => ({
  runPostgresQueriesAsync: async (input: { queries: Query[] }) => {
    asyncCalls.push(input.queries);
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

beforeEach(() => {
  asyncCalls.length = 0;
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
    expect(mint).toMatch(/\}\)\[2 \+ runLockOps\.length\];/);
  });
});
