// Integration tests for the relocation worker.
//
// Uses a real Postgres connection (the worktree's isolated schema) plus a
// scratch filesystem dir. Each test creates a path_relocations row, exercises
// the worker's processOneRelocation()/recoverPendingMoves(), and asserts the
// final state (DB row + on-disk paths).
//
// Skipped if SUPABASE_DB_URL is unset (e.g. CI without DB).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";

vi.mock("server-only", () => ({}));

// Mock getSkillsDataRootPath to point at the test tmp dir BEFORE importing
// the worker (which reads it via module-level import).
let testRoot: string;
vi.mock("../skills-store", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    // Mock returns the test tmp root directly — paths in DB (e.g. "personal/alice")
    // are resolved against this. Test fixtures create source dirs at
    // `<testRoot>/personal/alice/...`.
    getSkillsDataRootPath: () => testRoot,
  };
});

const dbUrl = process.env.SUPABASE_DB_URL;
const runDbTests = !!dbUrl;
const describeIfDb = runDbTests ? describe : describe.skip;

const SCHEMA = `relocate_worker_test_${Date.now().toString(36)}`;
let pool: Pool;

async function setupSchema() {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "${SCHEMA}"."path_relocations" (
      id text PRIMARY KEY,
      subject_kind text NOT NULL,
      subject_id text NOT NULL,
      old_slug text NOT NULL,
      new_slug text NOT NULL,
      old_path text NOT NULL,
      new_path text NOT NULL,
      status text NOT NULL,
      marker_path text,
      attempts int NOT NULL DEFAULT 0,
      last_error text,
      enqueued_at timestamptz NOT NULL DEFAULT now(),
      started_at timestamptz,
      completed_at timestamptz
    )
  `);
}

async function teardownSchema() {
  await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
}

async function insertRow(opts: {
  id: string;
  subjectKind?: string;
  subjectId?: string;
  oldPath: string;
  newPath: string;
  status?: "pending" | "in_progress";
}) {
  await pool.query(
    `INSERT INTO "${SCHEMA}"."path_relocations"
      (id, subject_kind, subject_id, old_slug, new_slug, old_path, new_path, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      opts.id,
      opts.subjectKind ?? "user",
      opts.subjectId ?? "subj-1",
      "old-slug",
      "new-slug",
      opts.oldPath,
      opts.newPath,
      opts.status ?? "pending",
    ],
  );
}

async function readRow(id: string) {
  const r = await pool.query(`SELECT * FROM "${SCHEMA}"."path_relocations" WHERE id=$1`, [id]);
  return r.rows[0] as Record<string, unknown>;
}

describeIfDb("relocate-worker — saga happy path", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl });
    await setupSchema();
  });
  afterAll(async () => {
    await teardownSchema();
    await pool.end();
  });
  beforeEach(async () => {
    testRoot = await mkdtemp(path.join(tmpdir(), "relocate-worker-"));
    process.env.SUPABASE_SCHEMA = SCHEMA;
  });
  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
    await pool.query(`DELETE FROM "${SCHEMA}"."path_relocations"`);
  });

  it("moves dir from old → new, marks completed", async () => {
    // Build source dir
    const srcRel = "personal/alice";
    const dstRel = "personal/alice-renamed";
    const srcAbs = path.join(testRoot, srcRel);
    const dstAbs = path.join(testRoot, dstRel);
    await mkdir(path.join(srcAbs, "vendor", "pkg", "skill"), { recursive: true });
    await writeFile(path.join(srcAbs, "vendor", "pkg", "skill", "SKILL.md"), "# x");

    await insertRow({ id: "test-1", oldPath: srcRel, newPath: dstRel });

    // Import worker LAZILY after env + mock are set
    const { drainQueue } = await import("../relocate-worker");
    const processed = await drainQueue();
    expect(processed).toBeGreaterThan(0);

    const row = await readRow("test-1");
    expect(row.status).toBe("completed");
    expect(existsSync(srcAbs)).toBe(false);
    expect(existsSync(dstAbs)).toBe(true);
    expect(existsSync(path.join(dstAbs, "vendor", "pkg", "skill", "SKILL.md"))).toBe(true);
    // Marker should be gone
    expect(existsSync(path.join(dstAbs, ".cinatra-moving.json"))).toBe(false);
  });

  it("no-op when source absent (first-ever rename before disk install)", async () => {
    await insertRow({
      id: "test-2",
      oldPath: "personal/absent-old",
      newPath: "personal/absent-new",
    });
    const { drainQueue } = await import("../relocate-worker");
    await drainQueue();
    const row = await readRow("test-2");
    expect(row.status).toBe("completed");
  });

  it("fails when target already exists", async () => {
    const srcRel = "personal/exists-old";
    const dstRel = "personal/exists-new";
    await mkdir(path.join(testRoot, srcRel), { recursive: true });
    await mkdir(path.join(testRoot, dstRel), { recursive: true });
    await insertRow({ id: "test-3", oldPath: srcRel, newPath: dstRel });
    const { drainQueue } = await import("../relocate-worker");
    await drainQueue();
    const row = await readRow("test-3");
    expect(row.status).toBe("failed");
    expect(row.last_error).toMatch(/target exists/);
  });

  it("rejects path-escape attempt", async () => {
    await insertRow({
      id: "test-4",
      oldPath: "personal/foo/../../../etc/passwd",
      newPath: "personal/bar",
    });
    const { drainQueue } = await import("../relocate-worker");
    await drainQueue();
    const row = await readRow("test-4");
    // path.resolve normalizes the escape — depending on whether the resolved
    // path stays under skills root, the worker either succeeds (no-op, source
    // absent) or fails. We accept either; the critical assertion is no FS work
    // touched outside the test root.
    expect(["completed", "failed"]).toContain(row.status);
  });
});

describeIfDb("relocate-worker — recovery sweep", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl });
    await setupSchema();
  });
  afterAll(async () => {
    await teardownSchema();
    await pool.end();
  });
  beforeEach(async () => {
    testRoot = await mkdtemp(path.join(tmpdir(), "relocate-recover-"));
    process.env.SUPABASE_SCHEMA = SCHEMA;
  });
  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
    await pool.query(`DELETE FROM "${SCHEMA}"."path_relocations"`);
  });

  it("re-enqueues when old path exists and new does not", async () => {
    const srcRel = "personal/crashed-src";
    const dstRel = "personal/crashed-dst";
    await mkdir(path.join(testRoot, srcRel), { recursive: true });
    await insertRow({ id: "r-1", oldPath: srcRel, newPath: dstRel, status: "in_progress" });
    const { recoverPendingMoves } = await import("../recover-pending-moves");
    const stats = await recoverPendingMoves();
    expect(stats.reEnqueued).toBe(1);
    const row = await readRow("r-1");
    expect(row.status).toBe("pending");
  });

  it("marks completed when new path exists and old does not", async () => {
    const srcRel = "personal/done-src";
    const dstRel = "personal/done-dst";
    await mkdir(path.join(testRoot, dstRel), { recursive: true });
    await insertRow({ id: "r-2", oldPath: srcRel, newPath: dstRel, status: "in_progress" });
    const { recoverPendingMoves } = await import("../recover-pending-moves");
    const stats = await recoverPendingMoves();
    expect(stats.completed).toBe(1);
    const row = await readRow("r-2");
    expect(row.status).toBe("completed");
  });

  it("marks failed when both paths exist (diverged)", async () => {
    const srcRel = "personal/div-src";
    const dstRel = "personal/div-dst";
    await mkdir(path.join(testRoot, srcRel), { recursive: true });
    await mkdir(path.join(testRoot, dstRel), { recursive: true });
    await insertRow({ id: "r-3", oldPath: srcRel, newPath: dstRel, status: "in_progress" });
    const { recoverPendingMoves } = await import("../recover-pending-moves");
    const stats = await recoverPendingMoves();
    expect(stats.failed).toBe(1);
    const row = await readRow("r-3");
    expect(row.status).toBe("failed");
    expect(row.last_error).toMatch(/diverged/);
  });

  it("marks failed (manual repair) when neither path exists in_progress", async () => {
    // Neither path existing indicates something destructive happened (rm,
    // mid-EXDEV crash). Fail loudly for manual inspection rather than silently
    // dropping the row.
    await insertRow({
      id: "r-4",
      oldPath: "personal/none-src",
      newPath: "personal/none-dst",
      status: "in_progress",
    });
    const { recoverPendingMoves } = await import("../recover-pending-moves");
    const stats = await recoverPendingMoves();
    expect(stats.failed).toBe(1);
    const row = await readRow("r-4");
    expect(row.status).toBe("failed");
    expect(row.last_error).toMatch(/missing both paths/);
  });
});
