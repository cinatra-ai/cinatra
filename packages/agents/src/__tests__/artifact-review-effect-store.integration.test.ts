/**
 * cinatra#3978 — REAL-store proof of the effect record writer and its table.
 *
 *   BINDINGS   every binding is read from stored state: the operation's
 *              snapshot, the gate's org, run, status, disposition and pinned
 *              set, and the gate's verification of that snapshot.
 *   FIRST WRITE WINS   identical retry, conflicting retry, concurrent writers.
 *   TABLE      the CHECKs (writer, source, the 8192-byte JSON object), the gate
 *              cascade, and the migration twin (idempotent up; down refuses a
 *              non-empty table and drops an empty one).
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";
import {
  artifactReviewEffectRecordsDdlSql,
  down as migrationDown,
} from "../../../../migrations/core/core__0129_artifact-review-effect-records.mjs";

const TEST_SCHEMA = "cinatra_test_review_effect_3978";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
const q = (s: string) => s.replaceAll('"', '""');
const T = (name: string) => `"${q(TEST_SCHEMA)}"."${name}"`;
const ORG = "org-3978";
const FP = "a".repeat(64);
const RESULT = { remoteId: "42", remoteStatus: "published", remotePublishedAt: "2026-11-03T09:20:00.000Z" };

let store: typeof import("../artifact-review-effect-store");
let client: Client;

async function sql(text: string, values: unknown[] = []) {
  return client.query(text, values);
}

interface Seed {
  gateId: string;
  runId: string;
  operationId: string;
  artifactId: string;
  revisionId: string;
}

/** A gate, a captured snapshot target, and (by default) its verified read-back. */
async function seed(over: {
  status?: "pending" | "resolved";
  disposition?: "approve" | "reject" | "changes_requested";
  pinned?: unknown;
  outcome?: "verified" | "drifted" | "unmet" | null;
  verifyOther?: boolean;
  orgId?: string;
} = {}): Promise<Seed> {
  const s: Seed = {
    gateId: `gate-${randomUUID()}`,
    runId: `run-${randomUUID()}`,
    operationId: `op-${randomUUID()}`,
    artifactId: `art-${randomUUID()}`,
    revisionId: `rev-${randomUUID()}`,
  };
  const status = over.status ?? "resolved";
  const pinned = over.pinned ?? [{ artifactId: s.artifactId, representationRevisionId: s.revisionId }];
  await sql(
    `INSERT INTO ${T("artifact_review_gates")}
       (id, run_id, org_id, review_task_id, status, pinned_targets, disposition, fingerprint, resolved_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
    [
      s.gateId, s.runId, over.orgId ?? ORG, `task-${randomUUID()}`, status, JSON.stringify(pinned),
      status === "resolved" ? (over.disposition ?? "approve") : null,
      status === "resolved" ? FP : null,
      status === "resolved" ? new Date() : null,
    ],
  );
  await sql(
    `INSERT INTO ${T("cms_snapshot_targets")}
       (id, artifact_id, snapshot_revision_id, scope_manifest, connector_instance, resource_type, resource_id, operation_id)
     VALUES ($1, $2, $3, '{"paths":["title"]}'::jsonb, 'site-connector:inst-1', 'post', '42', $4)`,
    [randomUUID(), s.artifactId, s.revisionId, s.operationId],
  );
  const outcome = over.outcome === undefined ? "verified" : over.outcome;
  if (outcome !== null) {
    await sql(
      `INSERT INTO ${T("artifact_verification_records")}
         (id, gate_id, reviewed_artifact_id, reviewed_representation_revision_id,
          repaired_artifact_id, repaired_representation_revision_id, outcome)
       VALUES ($1, $2, $3, $4, $3, $5, $6)`,
      [
        `verify:${s.gateId}`, s.gateId, over.verifyOther ? `art-other-${randomUUID()}` : s.artifactId,
        s.revisionId, `${s.revisionId}:post-apply`, outcome,
      ],
    );
  }
  return s;
}

function write(s: Seed, over: Partial<{ orgId: string; runId: string; gateId: string; operationId: string; result: unknown }> = {}) {
  return store.recordCmsApplyEffect({
    orgId: ORG,
    runId: s.runId,
    gateId: s.gateId,
    operationId: s.operationId,
    result: RESULT,
    ...over,
  });
}

async function rowsFor(gateId: string) {
  const r = await sql(
    `SELECT id, gate_id, org_id, run_id, reviewed_artifact_id, reviewed_representation_revision_id,
            writer, source_ref, record_json, recorded_at
       FROM ${T("artifact_review_effect_records")} WHERE gate_id = $1`,
    [gateId],
  );
  return r.rows;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`);
  await admin.query(`CREATE SCHEMA "${q(TEST_SCHEMA)}"`);
  const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
  const { replayStoreSchema } = await import("@/lib/test-support/store-schema-replay");
  await replayStoreSchema(admin, buildCreateStoreSchemaQueries(TEST_SCHEMA));
  await admin.end();
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;
  store = await import("../artifact-review-effect-store");
  client = new Client({ connectionString: DB_URL });
  await client.connect();
}, 90_000);

afterAll(async () => {
  if (!HAS_DB) return;
  await client?.end().catch(() => {});
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized;
});

describe.skipIf(!HAS_DB)("cinatra#3978 — the CMS apply effect writer binds to stored state", () => {
  it("records a verified, approved, pinned apply once, with every binding from the stored gate", async () => {
    const s = await seed();
    const res = await write(s);
    expect(res).toEqual({ ok: true, status: "recorded", effectId: store.reviewEffectId(s.gateId, s.artifactId, s.revisionId) });
    const rows = await rowsFor(s.gateId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      org_id: ORG,
      run_id: s.runId,
      reviewed_artifact_id: s.artifactId,
      reviewed_representation_revision_id: s.revisionId,
      writer: "cms_apply",
      source_ref: s.operationId,
      record_json: JSON.stringify(RESULT),
    });
    expect(rows[0].recorded_at).toBeInstanceOf(Date);
  });

  it("stores the closed result rebuilt in its fixed order, whatever order the caller used", async () => {
    const s = await seed();
    await write(s, { result: { remotePublishedAt: null, remoteStatus: "draft", remoteId: "7" } });
    expect((await rowsFor(s.gateId))[0].record_json).toBe('{"remoteId":"7","remoteStatus":"draft","remotePublishedAt":null}');
  });

  it.each([
    ["a secret field", { ...RESULT, token: "sk-live-123" }],
    ["an unknown status", { ...RESULT, remoteStatus: "live" }],
    ["an array", [RESULT]],
    ["an oversized id", { ...RESULT, remoteId: "a".repeat(200) }],
  ])("refuses %s as invalid-result and stores nothing", async (_n, result) => {
    const s = await seed();
    expect(await write(s, { result })).toEqual({ ok: false, code: "invalid-result" });
    expect(await rowsFor(s.gateId)).toHaveLength(0);
  });

  it.each([
    ["an unknown operation", async (s: Seed) => write(s, { operationId: `op-${randomUUID()}` }), "target-not-found"],
    ["an absent gate", async (s: Seed) => write(s, { gateId: `gate-${randomUUID()}` }), "gate-not-found"],
    ["another org (the frame's org is not the gate's)", async (s: Seed) => write(s, { orgId: "org-other" }), "gate-org-mismatch"],
    ["another run", async (s: Seed) => write(s, { runId: `run-${randomUUID()}` }), "gate-run-mismatch"],
  ])("refuses %s", async (_n, act, code) => {
    const s = await seed();
    expect(await act(s)).toEqual({ ok: false, code });
    expect(await rowsFor(s.gateId)).toHaveLength(0);
  });

  it.each([
    ["a pending gate", { status: "pending" as const }],
    ["a rejected gate", { disposition: "reject" as const }],
    ["a changes-requested gate", { disposition: "changes_requested" as const }],
  ])("refuses %s as gate-not-approved", async (_n, over) => {
    const s = await seed(over);
    expect(await write(s)).toEqual({ ok: false, code: "gate-not-approved" });
    expect(await rowsFor(s.gateId)).toHaveLength(0);
  });

  it.each([
    ["an object", { artifactId: "a", representationRevisionId: "r" }],
    ["a malformed element", [{ artifactId: 7 }]],
    ["a null element", [null]],
  ])("refuses a stored pinned set that is %s as pinned-targets-malformed", async (_n, pinned) => {
    const s = await seed({ pinned });
    expect(await write(s)).toEqual({ ok: false, code: "pinned-targets-malformed" });
  });

  it("refuses an operation whose snapshot the gate does not pin", async () => {
    const s = await seed({ pinned: [{ artifactId: "art-x", representationRevisionId: "rev-x" }] });
    expect(await write(s)).toEqual({ ok: false, code: "target-not-pinned" });
  });

  it("refuses another gate's operation (the CMS result from a different operation)", async () => {
    const a = await seed();
    const b = await seed();
    expect(await write(a, { operationId: b.operationId })).toEqual({ ok: false, code: "target-not-pinned" });
    expect(await rowsFor(a.gateId)).toHaveLength(0);
  });

  it.each([
    ["a drifted read-back", { outcome: "drifted" as const }],
    ["an unmet read-back", { outcome: "unmet" as const }],
    ["no read-back at all", { outcome: null }],
    ["a verification of another target", { verifyOther: true }],
  ])("records nothing for %s (not-verified)", async (_n, over) => {
    const s = await seed(over);
    expect(await write(s)).toEqual({ ok: false, code: "not-verified" });
    expect(await rowsFor(s.gateId)).toHaveLength(0);
  });

  it("propagates a database failure as a throw and stores nothing", async () => {
    const s = await seed();
    await sql(`ALTER TABLE ${T("artifact_review_effect_records")} RENAME TO artifact_review_effect_records_away`);
    try {
      await expect(write(s)).rejects.toThrow();
    } finally {
      await sql(`ALTER TABLE ${T("artifact_review_effect_records_away")} RENAME TO artifact_review_effect_records`);
    }
    expect(await rowsFor(s.gateId)).toHaveLength(0);
  });
});

describe.skipIf(!HAS_DB)("cinatra#3978 — first write wins", () => {
  it("answers an identical retry (a lost response) with already-recorded and keeps one row", async () => {
    const s = await seed();
    const first = await write(s);
    const again = await write(s, { result: { remotePublishedAt: RESULT.remotePublishedAt, remoteId: "42", remoteStatus: "published" } });
    expect(again).toEqual({ ok: true, status: "already-recorded", effectId: first.ok ? first.effectId : "" });
    expect(await rowsFor(s.gateId)).toHaveLength(1);
  });

  it("answers a conflicting retry with conflict and never overwrites", async () => {
    const s = await seed();
    await write(s);
    const before = await rowsFor(s.gateId);
    expect(await write(s, { result: { ...RESULT, remoteStatus: "draft" } })).toEqual({ ok: false, code: "conflict" });
    expect(await rowsFor(s.gateId)).toEqual(before);
  });

  it("lets exactly one of two concurrent identical writers record, the other reads already-recorded", async () => {
    const s = await seed();
    const answers = await Promise.all([write(s), write(s)]);
    expect(answers.map((a) => (a.ok ? a.status : a.code)).sort()).toEqual(["already-recorded", "recorded"]);
    expect(await rowsFor(s.gateId)).toHaveLength(1);
  });

  it("lets exactly one of two concurrent different writers record, the other reads conflict", async () => {
    const s = await seed();
    const other = { ...RESULT, remoteId: "43" };
    const answers = await Promise.all([write(s), write(s, { result: other })]);
    expect(answers.map((a) => (a.ok ? a.status : a.code)).sort()).toEqual(["conflict", "recorded"]);
    const winner = answers[0].ok && answers[0].status === "recorded" ? RESULT : other;
    const rows = await rowsFor(s.gateId);
    expect(rows).toHaveLength(1);
    expect(rows[0].record_json).toBe(JSON.stringify(winner));
  });
});

describe.skipIf(!HAS_DB)("cinatra#3978 — the table's own checks", () => {
  async function insertRaw(s: Seed, over: { writer?: string; sourceRef?: string; recordJson?: string; key?: string }) {
    return sql(
      `INSERT INTO ${T("artifact_review_effect_records")}
         (id, gate_id, org_id, run_id, reviewed_artifact_id, reviewed_representation_revision_id, writer, source_ref, record_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        `raw-${randomUUID()}`, s.gateId, ORG, s.runId, s.artifactId, over.key ?? s.revisionId,
        over.writer ?? "cms_apply", over.sourceRef ?? s.operationId, over.recordJson ?? "{}",
      ],
    );
  }
  /** Compact JSON text of exactly `bytes` UTF-8 bytes, made of `ch`. */
  function textOfBytes(bytes: number, ch: string): string {
    const room = bytes - Buffer.byteLength('{"k":""}', "utf8");
    const unit = Buffer.byteLength(ch, "utf8");
    const t = `{"k":"${ch.repeat(Math.floor(room / unit))}${"a".repeat(room % unit)}"}`;
    expect(Buffer.byteLength(t, "utf8")).toBe(bytes);
    return t;
  }

  it("admits exactly the two writer kinds, case included", async () => {
    const s = await seed();
    await expect(insertRaw(s, { writer: "dashboard_publish" })).resolves.toBeTruthy();
    for (const [i, writer] of ["CMS_APPLY", "Cms_Apply", "other", ""].entries()) {
      await expect(insertRaw(s, { writer, key: `k-${i}` })).rejects.toThrow(/check constraint/i);
    }
  });

  it("admits a JSON object of 8192 bytes and refuses 8193, multibyte counted in bytes", async () => {
    const s = await seed();
    await expect(insertRaw(s, { recordJson: textOfBytes(8192, "ü"), key: "k-8192" })).resolves.toBeTruthy();
    await expect(insertRaw(s, { recordJson: textOfBytes(8193, "€"), key: "k-8193" })).rejects.toThrow(/check constraint/i);
  });

  it.each([["an array", "[1]"], ["null", "null"], ["a string", '"x"'], ["a number", "1"]])(
    "refuses a record that is %s",
    async (_n, recordJson) => {
      const s = await seed();
      await expect(insertRaw(s, { recordJson })).rejects.toThrow(/check constraint/i);
    },
  );

  it("refuses text that is not JSON, and an empty source", async () => {
    const s = await seed();
    await expect(insertRaw(s, { recordJson: "{not json" })).rejects.toThrow();
    await expect(insertRaw(s, { sourceRef: "" })).rejects.toThrow(/check constraint/i);
  });

  it("holds one row per (gate, artifact, revision)", async () => {
    const s = await seed();
    await insertRaw(s, {});
    await expect(insertRaw(s, {})).rejects.toThrow(/duplicate key|unique/i);
  });

  it("goes with its gate (ON DELETE CASCADE)", async () => {
    const s = await seed();
    await write(s);
    expect(await rowsFor(s.gateId)).toHaveLength(1);
    await sql(`DELETE FROM ${T("artifact_review_gates")} WHERE id = $1`, [s.gateId]);
    expect(await rowsFor(s.gateId)).toHaveLength(0);
  });
});

describe.skipIf(!HAS_DB)("cinatra#3978 — the migration twin core__0129", () => {
  async function tableExists(): Promise<boolean> {
    const r = await sql(`SELECT to_regclass($1) AS t`, [`"${q(TEST_SCHEMA)}".artifact_review_effect_records`]);
    return r.rows[0].t !== null;
  }
  async function runDown() {
    const statements: string[] = [];
    migrationDown({ sql: (text: string) => statements.push(text) } as never);
    await sql(`SET search_path TO "${q(TEST_SCHEMA)}"`);
    try {
      for (const text of statements) await sql(text);
    } finally {
      await sql(`RESET search_path`);
    }
  }

  it("is idempotent after the bootstrap DDL and twice over", async () => {
    await sql(`SET search_path TO "${q(TEST_SCHEMA)}"`);
    try {
      await sql(artifactReviewEffectRecordsDdlSql);
      await sql(artifactReviewEffectRecordsDdlSql);
    } finally {
      await sql(`RESET search_path`);
    }
    expect(await tableExists()).toBe(true);
  });

  it("down refuses a table that holds a record, and keeps it", async () => {
    const s = await seed();
    await write(s);
    await expect(runDown()).rejects.toThrow(/not empty/);
    expect(await tableExists()).toBe(true);
    expect(await rowsFor(s.gateId)).toHaveLength(1);
  });

  it("down drops an empty table, and up makes it again", async () => {
    await sql(`DELETE FROM ${T("artifact_review_effect_records")}`);
    await runDown();
    expect(await tableExists()).toBe(false);
    await sql(`SET search_path TO "${q(TEST_SCHEMA)}"`);
    try {
      await sql(artifactReviewEffectRecordsDdlSql);
    } finally {
      await sql(`RESET search_path`);
    }
    expect(await tableExists()).toBe(true);
  });
});
