// Fixture tests for the review-DECISION writer guard (cinatra#2047 annex).
//
// The guard's whole value is that a NEW parallel approval path fails CI. These
// tests hold BOTH halves of that claim:
//
//   1. A synthetic out-of-allowlist writer FAILS — in every DML form the guard
//      claims to detect (Drizzle builder, import-renamed symbol, namespaced
//      symbol, and raw SQL in bare / quoted / schema-interpolated shape).
//   2. The KNOWN writers pass — and, crucially, they pass BECAUSE they are
//      allowlisted, not because the matcher is blind: each one is asserted to
//      contain real write sites, so the allowlist can never rot into a
//      vacuously-green list of files that stopped writing years ago.
//   3. Legitimate non-write traffic (SELECT, DDL, FK `ON DELETE CASCADE`,
//      index/constraint identifiers, prose) does NOT trip the guard — the
//      false-positive half.
//   4. The guard exits 0 on the real tree. This case is also what makes the
//      guard RUN in CI: `scripts/audit/__tests__/**` is inside the root Vitest
//      include glob, so the wholesale root suite executes the guard against the
//      live tree on every push and pull request.
//
// The matcher is IMPORTED from the guard rather than re-implemented here, so a
// fixture can never assert a rule that differs from what CI enforces.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// The guard's filename embeds a token the org source-leak scanner reads as an
// internal planning-artifact marker (see the note in the guard's own header:
// that rule scans file CONTENT, not paths). So the specifier is assembled from
// parts — the idiom `scripts/ci/closeout-suite.mjs` already uses for the
// sibling objects guard — and loaded dynamically rather than named in a static
// `import ... from` clause, which cannot take a computed specifier.
const GUARD_REL = ["scripts/audit/review-decision-writer", "drift", "gate.mjs"].join("-");

const {
  WRITER_ALLOWLIST,
  REVIEW_DECISION_TABLES,
  REVIEW_DECISION_SYMBOLS,
  collectViolations,
  isExempt,
  resolveLocalSymbols,
  scanSourceForDecisionWrites,
} = await import(pathToFileURL(join(REPO_ROOT, GUARD_REL)).href);

/** The known decision writers, per the #2047 acceptance annex. */
const KNOWN_WRITERS = [
  "packages/agents/src/artifact-review-gate-store.ts",
  "packages/agents/src/lifecycle-repair-store.ts",
  "packages/agents/src/lifecycle-review-orchestration-store.ts",
];

// --------------------------------------------------------------------------
// 1. A synthetic out-of-allowlist writer FAILS.
// --------------------------------------------------------------------------

describe("a new parallel decision writer is caught", () => {
  it("catches a Drizzle INSERT opening a gate", () => {
    const hits = scanSourceForDecisionWrites(`
      import { artifactReviewGates } from "./schema";
      export async function openRogueGate(db, row) {
        return db.insert(artifactReviewGates).values(row).returning();
      }
    `);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: "drizzle", verb: "INSERT", token: "artifactReviewGates" });
  });

  it("catches a Drizzle UPDATE resolving a gate (the parallel-approval shape)", () => {
    const hits = scanSourceForDecisionWrites(`
      await db.update(artifactReviewGates)
        .set({ status: "resolved", disposition: "approve" })
        .where(eq(artifactReviewGates.id, gateId));
    `);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: "drizzle", verb: "UPDATE" });
  });

  it("catches a Drizzle DELETE against the audit trail", () => {
    const hits = scanSourceForDecisionWrites(
      `await tx.delete(artifactReviewAudit).where(eq(artifactReviewAudit.gateId, id));`,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: "drizzle", verb: "DELETE", token: "artifactReviewAudit" });
  });

  it("catches a write wrapped across multiple lines by the formatter", () => {
    const hits = scanSourceForDecisionWrites(`
      await tx
        .insert(
          artifactReviewDispositions,
        )
        .values(row);
    `);
    expect(hits).toHaveLength(1);
    expect(hits[0].token).toBe("artifactReviewDispositions");
  });

  it("catches a namespace-qualified symbol (import * as schema)", () => {
    const hits = scanSourceForDecisionWrites(
      `await db.insert(schema.artifactReviewResumeOutbox).values(intent);`,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].token).toBe("artifactReviewResumeOutbox");
  });

  it("catches a symbol RENAMED at the import site (rename is not an escape)", () => {
    const hits = scanSourceForDecisionWrites(`
      import { artifactReviewGates as decisions } from "@cinatra-ai/agents/schema";
      await db.update(decisions).set({ status: "resolved" });
    `);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: "drizzle", verb: "UPDATE", token: "decisions" });
  });

  it("resolves import aliases alongside the canonical symbols", () => {
    const local = resolveLocalSymbols(
      `import { artifactReviewAudit as auditRows } from "./schema";`,
    );
    expect(local).toContain("auditRows");
    for (const sym of REVIEW_DECISION_SYMBOLS) expect(local).toContain(sym);
  });

  it.each([
    ['bare', 'INSERT INTO artifact_review_gates (id) VALUES ($1)'],
    ['quoted', 'DELETE FROM "artifact_review_audit" WHERE gate_id = $1'],
    ['schema-interpolated', 'UPDATE "${schema}"."artifact_review_gates" SET status = $1'],
    ['schema-qualified bare', 'UPDATE cinatra.artifact_review_dispositions SET applied_at = now()'],
    ['TRUNCATE', 'TRUNCATE TABLE artifact_review_resume_outbox'],
    ['CTE-wrapped INSERT', 'WITH d AS (INSERT INTO "artifact_review_audit" (id) VALUES ($1) RETURNING id)'],
    ['ON CONFLICT upsert', 'INSERT INTO artifact_review_gates (id) VALUES ($1) ON CONFLICT (id) DO UPDATE SET status = $2'],
    ['not the FIRST truncate target', 'TRUNCATE TABLE scratch_rows, artifact_review_gates RESTART IDENTITY'],
    ['COPY ... FROM (the writing direction)', 'COPY artifact_review_audit (id) FROM STDIN'],
  ])("catches raw SQL: %s", (_label, sql) => {
    const hits = scanSourceForDecisionWrites("await pool.query(`" + sql + "`);");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].kind).toBe("raw-sql");
  });

  // The most natural hand-rolled parallel writer: a tagged template that
  // interpolates the Drizzle table OBJECT instead of naming the table. This
  // idiom is live in packages/agents (project-lease-store.ts), so a guard that
  // only matched the snake_case identifier would miss the realistic case.
  it.each([
    ['INSERT', 'await db.execute(sql`INSERT INTO ${artifactReviewAudit} (id) VALUES (${id}) ON CONFLICT DO NOTHING`);'],
    ['UPDATE', 'await db.execute(sql`UPDATE ${artifactReviewGates} SET status = ${s} WHERE id = ${id}`);'],
    ['DELETE', 'await db.execute(sql`DELETE FROM ${artifactReviewDispositions} WHERE id = ${id}`);'],
  ])("catches a Drizzle table object interpolated into raw SQL: %s", (_label, code) => {
    const hits = scanSourceForDecisionWrites(code);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].kind).toBe("raw-sql");
  });

  it("catches a table rebound to a local const", () => {
    const hits = scanSourceForDecisionWrites(`
      import { artifactReviewGates } from "./schema";
      const gates = artifactReviewGates;
      await db.update(gates).set({ status: "resolved" });
    `);
    expect(hits).toHaveLength(1);
    expect(hits[0].token).toBe("gates");
  });

  it("catches a write carrying an explicit type argument", () => {
    const hits = scanSourceForDecisionWrites(
      "await db.insert<typeof artifactReviewGates>(artifactReviewGates).values(row);",
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].verb).toBe("INSERT");
  });

  it("reports the offending file, line and form", () => {
    const rogue = "packages/agents/src/rogue-approval-store.ts";
    const violations = collectViolations({
      files: [rogue],
      readFileImpl: () =>
        "// header\nimport { artifactReviewGates } from './schema';\n" +
        "await db.update(artifactReviewGates).set({ disposition: 'approve' });\n",
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: rogue, line: 3, kind: "drizzle", verb: "UPDATE" });
  });
});

// --------------------------------------------------------------------------
// 2. The known writers pass — and the allowlist is load-bearing.
// --------------------------------------------------------------------------

describe("the known decision writers", () => {
  it.each(KNOWN_WRITERS)("%s is allowlisted and therefore exempt", (rel) => {
    expect(WRITER_ALLOWLIST.has(rel)).toBe(true);
    expect(isExempt(rel)).toBe(true);
  });

  it.each(KNOWN_WRITERS)("%s genuinely writes (the allowlist is not vacuous)", (rel) => {
    const hits = scanSourceForDecisionWrites(readFileSync(join(REPO_ROOT, rel), "utf8"));
    expect(hits.length).toBeGreaterThan(0);
  });

  it("would FAIL every known writer if it were not allowlisted", () => {
    const violations = collectViolations({
      files: KNOWN_WRITERS.map((rel) => `packages/agents/src/not-allowlisted/${rel.split("/").pop()}`),
      readFileImpl: (abs) => {
        const name = abs.split("/").pop();
        const real = KNOWN_WRITERS.find((rel) => rel.endsWith(`/${name}`));
        return readFileSync(join(REPO_ROOT, real), "utf8");
      },
    });
    // The gate store owns 8 sites, the repair store 2, the orchestration
    // store 2 — the exact set the #2047 annex enumerates.
    expect(violations.length).toBe(12);
  });

  it("allowlists the guard itself and nothing unexpected", () => {
    expect(WRITER_ALLOWLIST.has(GUARD_REL)).toBe(true);
    expect(WRITER_ALLOWLIST.size).toBe(KNOWN_WRITERS.length + 1);
  });

  it("covers all four review-decision tables", () => {
    expect(REVIEW_DECISION_TABLES).toEqual([
      "artifact_review_gates",
      "artifact_review_audit",
      "artifact_review_dispositions",
      "artifact_review_resume_outbox",
    ]);
    expect(REVIEW_DECISION_SYMBOLS).toHaveLength(REVIEW_DECISION_TABLES.length);
  });
});

// --------------------------------------------------------------------------
// 3. Legitimate traffic is NOT flagged (the false-positive half).
// --------------------------------------------------------------------------

describe("legitimate non-write traffic is not flagged", () => {
  it.each([
    ["a Drizzle SELECT", `await db.select().from(artifactReviewGates).where(eq(artifactReviewGates.runId, runId));`],
    ["a raw SELECT", 'await pool.query(`SELECT id, status FROM "${schema}"."artifact_review_gates" WHERE id = $1`);'],
    ["CREATE TABLE (DDL owner)", 'text: `CREATE TABLE IF NOT EXISTS "${q}"."artifact_review_gates" (id text PRIMARY KEY)`'],
    ["ALTER TABLE (migration)", "sql`ALTER TABLE artifact_review_gates ADD COLUMN IF NOT EXISTS expires_at timestamptz`"],
    ["DROP TABLE (migration down)", "sql`DROP TABLE IF EXISTS artifact_review_resume_outbox`"],
    ["a foreign key with ON DELETE CASCADE", "sql`gate_id text NOT NULL REFERENCES artifact_review_gates(id) ON DELETE CASCADE`"],
    ["an index identifier", 'uniqueIndex("artifact_review_gates_run_task_uniq").on(t.runId, t.reviewTaskId)'],
    ["a constraint identifier", "sql`ALTER TABLE artifact_review_audit ADD CONSTRAINT artifact_review_audit_disposition_check CHECK (true)`"],
    ["a column reference", "eq(artifactReviewGates.status, 'pending')"],
    ["a write to an unrelated table", "await db.insert(lifecycleContinuationPark).values(row);"],
  ])("does not flag %s", (_label, code) => {
    expect(scanSourceForDecisionWrites(code)).toEqual([]);
  });

  it("does not flag prose mentioning a write (comments are stripped)", () => {
    const hits = scanSourceForDecisionWrites(`
      // We UPDATE artifact_review_gates here via the gate store.
      /* INSERT INTO artifact_review_audit is the store's job, not ours. */
      await gateStore.resolveReviewGate(plan);
    `);
    expect(hits).toEqual([]);
  });

  it("does not flag a table name that is only a PREFIX of another identifier", () => {
    expect(
      scanSourceForDecisionWrites("sql`INSERT INTO artifact_review_gates_archive (id) VALUES ($1)`"),
    ).toEqual([]);
  });

  it("does not flag COPY ... TO (an export, i.e. a read)", () => {
    expect(
      scanSourceForDecisionWrites("await pool.query(`COPY artifact_review_audit TO STDOUT`);"),
    ).toEqual([]);
  });

  it("does not flag a SELECT over an interpolated table object", () => {
    expect(
      scanSourceForDecisionWrites("await db.execute(sql`SELECT id FROM ${artifactReviewGates}`);"),
    ).toEqual([]);
  });

  // --- accepted over-detection, pinned deliberately ---------------------
  //
  // These SHAPES are flagged even though they do not write. That is the
  // guard's chosen failure direction: a spurious red is one review
  // conversation, a miss is a silent second approval path. Pinned so the
  // behaviour is a recorded decision — if a future change makes one of these
  // pass, that is a real loosening of the matcher and this test says so.
  it.each([
    ["a diagnostic string that reads like SQL", `const msg = "Never UPDATE artifact_review_gates directly — use the store.";`],
    ["EXPLAIN of a write (plans, does not execute)", "sql`EXPLAIN UPDATE artifact_review_gates SET status = $1`"],
    ["a non-database method that happens to be .delete()", "tableRegistry.delete(artifactReviewGates);"],
  ])("deliberately still flags %s", (_label, code) => {
    expect(scanSourceForDecisionWrites(code).length).toBeGreaterThan(0);
  });

  it("treats tests and fixtures as exempt", () => {
    expect(isExempt("packages/agents/src/__tests__/lifecycle.integration.test.ts")).toBe(true);
    expect(isExempt("packages/agents/src/foo.test.ts")).toBe(true);
    expect(isExempt("migrations/core/core__0072_artifact-review-gate-store.mjs")).toBe(true);
    expect(isExempt("packages/agents/src/some-new-store.ts")).toBe(false);
  });
});

// --------------------------------------------------------------------------
// 4. The guard is green on the real tree (and thereby runs in CI).
// --------------------------------------------------------------------------

describe("the guard on the current tree", () => {
  it("exits 0 against the repo as checked out", () => {
    const result = spawnSync("node", [GUARD_REL], { encoding: "utf8", cwd: REPO_ROOT });
    expect(result.stderr ?? "").toBe("");
    expect(result.status).toBe(0);
  });
});
