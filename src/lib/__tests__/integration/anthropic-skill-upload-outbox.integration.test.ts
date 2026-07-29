/**
 * cinatra#2092 (epic #2086 S5) — REAL-STORE proof of the transactional outbox,
 * the derived `allowAnthropicUpload` projection, and the delayed uninstall GC.
 * No mocked DB anywhere on the path under test: the schema is provisioned FRESH
 * per file from the CANONICAL `buildCreateStoreSchemaQueries` DDL, and every
 * assertion reads the real rows back through `pg`.
 *
 * The S5 acceptance criterion this file exists for is the CRASH WINDOW:
 *
 *   "Crash between catalog commit and worker run loses no trigger (outbox
 *    replay proves it); duplicate drains are idempotent."
 *
 * A mock cannot prove that, because the whole claim is about what SURVIVES in
 * Postgres when the process dies between COMMIT and the drain. So the suite
 * drives the REAL statements the production catalog transaction runs, then
 * simulates the crash by never running a drain — and shows the request row is
 * still there, still `pending`, still claimable. It also proves the negative:
 * a transaction that ROLLS BACK leaves NO phantom request (the other half of
 * "the outbox is in the same transactional batch").
 *
 * CI runs this file in the extension-lifecycle-db-tests job (Postgres service
 * container); locally: point SUPABASE_DB_URL at a dev Postgres and run with
 * CINATRA_DB_INTEGRATION_TESTS=1.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Client } from "pg";

import {
  ANTHROPIC_SKILL_STALE_GRACE_MS,
  buildGrantSkillUploadConsentQuery,
  buildRevokeSkillUploadConsentQuery,
  buildBulkSkillUploadConsentQuery,
  buildSelectSkillUploadConsentQuery,
  buildSkillUploadConsentLockQuery,
  buildSkillUploadProjectionQuery,
  buildInsertReconcileOutboxQuery,
  buildInsertUploadGcOutboxQuery,
} from "@/lib/skill-lifecycle-store";
import { skillUploadConsentSchemaQueries } from "@/lib/skill-lifecycle-schema";

const dbUrl = process.env.SUPABASE_DB_URL;
const hasDb =
  typeof dbUrl === "string" &&
  dbUrl.length > 0 &&
  !dbUrl.includes("unused:unused@") &&
  !dbUrl.includes("build:build@127.0.0.1:5432/build");

const SCHEMA = "cinatra_test_s5_upload_outbox_2092";
let client: Client;

async function sql(text: string, values: unknown[] = []) {
  return client.query(text, values as never[]);
}

/** Minimal real DDL for the tables under test. The `skills` table is created
 *  with the SAME column contract the canonical store DDL uses
 *  (`id text PRIMARY KEY, payload text NOT NULL`) so the projection's
 *  `payload::jsonb` round-trip is exercised exactly as in production. */
async function provisionSchema() {
  await sql(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await sql(`CREATE SCHEMA "${SCHEMA}"`);
  await sql(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
  await sql(
    `CREATE TABLE "${SCHEMA}"."skills" (id text PRIMARY KEY, payload text NOT NULL)`,
  );
  for (const q of skillUploadConsentSchemaQueries(SCHEMA)) {
    await sql(q.text);
  }
}

async function seedSkill(
  id: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await sql(
    `INSERT INTO "${SCHEMA}"."skills" (id, payload) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload`,
    [id, JSON.stringify({ id, ...payload })],
  );
}

async function readUploadFlag(skillId: string): Promise<unknown> {
  const r = await sql(
    `SELECT payload::jsonb ->> 'allowAnthropicUpload' AS flag FROM "${SCHEMA}"."skills" WHERE id = $1`,
    [skillId],
  );
  const raw = r.rows[0]?.flag;
  return raw == null ? null : raw === "true";
}

async function outboxRows(): Promise<
  Array<{ id: string; kind: string; reason: string; status: string; not_before: Date | null }>
> {
  const r = await sql(
    `SELECT id, kind, reason, status, not_before FROM "${SCHEMA}"."anthropic_skill_reconcile_outbox" ORDER BY created_at, id`,
  );
  return r.rows as never;
}

/** Run the production query objects as ONE transaction — the exact shape
 *  `replaceSkillCatalogInDatabase` uses (`runTransactionalBatch`). */
async function runBatch(
  queries: Array<{ text: string; values?: unknown[] }>,
  outcome: "commit" | "rollback" = "commit",
) {
  await sql("BEGIN");
  try {
    for (const q of queries) await sql(q.text, q.values ?? []);
    await sql(outcome === "commit" ? "COMMIT" : "ROLLBACK");
  } catch (err) {
    await sql("ROLLBACK");
    throw err;
  }
}

/** The catalog-transaction tail every catalog write appends (S5): recompute the
 *  derived projection, then append the reconcile request — same transaction. */
function catalogTail(reason: string, scheduleGc = false) {
  return [
    buildSkillUploadProjectionQuery(SCHEMA),
    buildInsertReconcileOutboxQuery(SCHEMA, reason),
    ...(scheduleGc ? [buildInsertUploadGcOutboxQuery(SCHEMA, reason)] : []),
  ];
}

describe.skipIf(!hasDb)("S5 upload-on-install outbox + consent projection (real store)", () => {
  beforeAll(async () => {
    client = new Client({ connectionString: dbUrl });
    await client.connect();
    await provisionSchema();
  }, 60_000);

  afterAll(async () => {
    if (client) {
      await sql(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`).catch(() => {});
      await client.end();
    }
  });

  beforeEach(async () => {
    await sql(`TRUNCATE "${SCHEMA}"."anthropic_skill_reconcile_outbox"`);
    await sql(`TRUNCATE "${SCHEMA}"."skill_upload_consent"`);
    await sql(`TRUNCATE "${SCHEMA}"."skills"`);
  });

  // -------------------------------------------------------------------------
  // AC3 — the crash window
  // -------------------------------------------------------------------------

  it("a catalog COMMIT leaves a durable pending request — a crash before the worker loses NO trigger", async () => {
    await seedSkill("github:acme/pack:alpha", { packageId: "github:acme/pack" });
    await runBatch(catalogTail("skill-extension-install"));

    // SIMULATED CRASH: no drain ever runs. The row must still be there,
    // pending, and immediately due.
    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "reconcile",
      reason: "skill-extension-install",
      status: "pending",
    });

    // ...and a worker starting fresh AFTER the crash still claims it. This is
    // the replay: the trigger survived the process, not a queue.
    const claim = await sql(
      `UPDATE "${SCHEMA}"."anthropic_skill_reconcile_outbox"
         SET status='running', lease_token=$1, lease_expires_at = now() + interval '5 minutes', attempts = attempts + 1
       WHERE (status='pending' AND (not_before IS NULL OR not_before <= now()))
          OR (status='running' AND lease_expires_at < now())
       RETURNING id, attempts`,
      ["lease-after-crash"],
    );
    expect(claim.rows).toHaveLength(1);
    expect(Number(claim.rows[0].attempts)).toBe(1);
  });

  it("a ROLLED-BACK catalog transaction leaves NO phantom request", async () => {
    await seedSkill("github:acme/pack:alpha", { packageId: "github:acme/pack" });
    await runBatch(catalogTail("skill-extension-install"), "rollback");
    expect(await outboxRows()).toHaveLength(0);
  });

  it("EVERY catalog write enqueues its own request — a write is never coalesced away", async () => {
    // The insert is deliberately unconditional. Coalescing onto an existing
    // unclaimed row is unsound: a worker can claim that row, read the catalog
    // and complete it all BEFORE the suppressed write commits, leaving the new
    // catalog state with no pending request. Duplicates are the cheap side of
    // that trade — one claim statement takes them all, and the
    // namespace+digest key collapses them into a single engine run.
    await seedSkill("github:acme/pack:alpha", { packageId: "github:acme/pack" });
    await runBatch(catalogTail("skill-extension-install"));
    await runBatch(catalogTail("skill-extension-update"));
    await runBatch(catalogTail("catalog-sync"));

    const rows = await outboxRows();
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.reason)).toEqual([
      "skill-extension-install",
      "skill-extension-update",
      "catalog-sync",
    ]);

    // A single claim statement takes all three at once — duplicate drains stay
    // one drain.
    const claim = await sql(
      `UPDATE "${SCHEMA}"."anthropic_skill_reconcile_outbox"
         SET status='running', lease_token='w1', lease_expires_at = now() + interval '5 minutes'
       WHERE status='pending' AND (not_before IS NULL OR not_before <= now())
       RETURNING id`,
    );
    expect(claim.rows).toHaveLength(3);
  });

  it("a request written while an earlier one is LEASED still enqueues", async () => {
    await seedSkill("github:acme/pack:alpha", { packageId: "github:acme/pack" });
    await runBatch(catalogTail("first-write"));
    // A drain leases the first request and is now mid-run against an older
    // catalog...
    await sql(
      `UPDATE "${SCHEMA}"."anthropic_skill_reconcile_outbox"
         SET status='running', lease_token='in-flight', lease_expires_at = now() + interval '5 minutes'`,
    );
    // ...so a catalog write that lands NOW must enqueue its own request.
    await runBatch(catalogTail("second-write"));
    const rows = await outboxRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.status).sort()).toEqual(["pending", "running"]);
  });

  it("an expired lease is reclaimable — a worker that crashed mid-run cannot strand a request", async () => {
    await runBatch(catalogTail("install"));
    await sql(
      `UPDATE "${SCHEMA}"."anthropic_skill_reconcile_outbox"
         SET status='running', lease_token='dead-worker', lease_expires_at = now() - interval '1 minute'`,
    );
    const claim = await sql(
      `UPDATE "${SCHEMA}"."anthropic_skill_reconcile_outbox"
         SET status='running', lease_token=$1, lease_expires_at = now() + interval '5 minutes', attempts = attempts + 1
       WHERE (status='pending' AND (not_before IS NULL OR not_before <= now()))
          OR (status='running' AND lease_expires_at < now())
       RETURNING id`,
      ["fresh-worker"],
    );
    expect(claim.rows).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // AC1 / AC2 — the DERIVED projection is the only acquisition path
  // -------------------------------------------------------------------------

  it("a newly-installed skill becomes eligible from the consent ledger alone — no manual toggle (AC1)", async () => {
    await seedSkill("github:acme/pack:alpha", { packageId: "github:acme/pack" });
    // Before consent: the catalog transaction's projection writes the literal
    // false — the gate's `=== true` shape stays fail-closed.
    await runBatch(catalogTail("skill-extension-install"));
    expect(await readUploadFlag("github:acme/pack:alpha")).toBe(false);

    // The install's consent act, then the next catalog write's projection.
    await runBatch([
      buildGrantSkillUploadConsentQuery(SCHEMA, {
        scopeKind: "extension",
        scopeKey: "github:acme/pack",
        grantedBy: "admin-1",
        sourceEvent: "extension-install",
      }),
      ...catalogTail("consent-grant:extension-install"),
    ]);
    expect(await readUploadFlag("github:acme/pack:alpha")).toBe(true);
  });

  it("a TARGETED single-field writer cannot restore eligibility a revoke removed", async () => {
    // `updateSkillPrefillTextInDatabase` used to round-trip a whole payload it
    // read outside its transaction. Combined with the derived flag that is a
    // fail-OPEN clobber: a payload read while consent was active would restore
    // `allowAnthropicUpload: true` after the revoke committed. The writer now
    // updates ONLY its own key and re-asserts the projection, so this sequence
    // ends upload-ineligible.
    await seedSkill("github:acme/pack:alpha", {
      packageId: "github:acme/pack",
      level: "workspace",
      allowAnthropicUpload: true, // the stale whole-payload snapshot
      prefillText: "old",
    });
    // No consent row exists — this is the post-revoke world.
    await runBatch([
      // The production statement sequence for the targeted writer.
      buildSkillUploadConsentLockQuery(SCHEMA),
      {
        text: `UPDATE "${SCHEMA}"."skills"
          SET payload = jsonb_set(payload::jsonb, '{prefillText}', to_jsonb($2::text))::text
          WHERE id = $1`,
        values: ["github:acme/pack:alpha", "fresh"],
      },
      buildSkillUploadProjectionQuery(SCHEMA),
    ]);
    expect(await readUploadFlag("github:acme/pack:alpha")).toBe(false);
    const r = await sql(
      `SELECT payload::jsonb ->> 'prefillText' AS t FROM "${SCHEMA}"."skills" WHERE id = $1`,
      ["github:acme/pack:alpha"],
    );
    expect(r.rows[0].t).toBe("fresh");
  });

  it("a payload that ARRIVES claiming eligibility is overwritten by the projection (no forged grant)", async () => {
    // The old behaviour PRESERVED whatever boolean rode along in the payload.
    // The projection must overwrite it, or a caller could grant itself upload.
    await seedSkill("github:evil/pack:x", {
      packageId: "github:evil/pack",
      allowAnthropicUpload: true,
    });
    await runBatch(catalogTail("catalog-sync"));
    expect(await readUploadFlag("github:evil/pack:x")).toBe(false);
  });

  it("consent is per PACKAGE identity and covers every skill in it, across versions", async () => {
    await seedSkill("github:acme/pack:alpha", { packageId: "github:acme/pack" });
    await seedSkill("github:acme/pack:beta", { packageId: "github:acme/pack" });
    await seedSkill("github:other/pack:gamma", { packageId: "github:other/pack" });
    await runBatch([
      buildGrantSkillUploadConsentQuery(SCHEMA, {
        scopeKind: "extension",
        scopeKey: "github:acme/pack",
        grantedBy: "admin-1",
        sourceEvent: "extension-install",
      }),
      ...catalogTail("install"),
    ]);
    expect(await readUploadFlag("github:acme/pack:alpha")).toBe(true);
    expect(await readUploadFlag("github:acme/pack:beta")).toBe(true);
    expect(await readUploadFlag("github:other/pack:gamma")).toBe(false);

    // A version update replaces the skill rows; the packageId (and so the
    // grant) is unchanged, so eligibility survives.
    await seedSkill("github:acme/pack:delta", { packageId: "github:acme/pack" });
    await runBatch(catalogTail("skill-extension-update"));
    expect(await readUploadFlag("github:acme/pack:delta")).toBe(true);
  });

  it("a PACKAGE grant never reaches a PERSONAL skill that shares the synthetic package identity", async () => {
    // Every personal skill shares ONE synthetic packageId. If the package
    // branch of the projection did not exclude `level='personal'`, a single
    // admin grant on that identity would authorize every personal skill in the
    // workspace — the over-share the per-skill personal grant exists to stop.
    await seedSkill("custom:custom-skills:mine", {
      packageId: "custom:custom-skills",
      level: "personal",
    });
    await seedSkill("custom:custom-skills:shared", {
      packageId: "custom:custom-skills",
      level: "workspace",
    });
    await runBatch([
      buildGrantSkillUploadConsentQuery(SCHEMA, {
        scopeKind: "extension",
        scopeKey: "custom:custom-skills",
        grantedBy: "admin-1",
        sourceEvent: "admin-grant",
      }),
      ...catalogTail("admin-grant"),
    ]);
    expect(await readUploadFlag("custom:custom-skills:shared")).toBe(true);
    expect(await readUploadFlag("custom:custom-skills:mine")).toBe(false);
  });

  it("a LEGACY personal row (no stored level, isCustomSkill/isPersonal only) is treated as personal", async () => {
    // `level` is optional on a stored row: normalizeStoredSkill derives
    // "personal" from the durable `isCustomSkill` flag (or the legacy
    // `isPersonal` one) when the level is missing/unrecognized. If the SQL
    // keyed on `level = 'personal'` alone, these legacy rows would fall into
    // the PACKAGE branch — and since every personal skill shares one synthetic
    // packageId, a single package grant would authorize all of them.
    await seedSkill("custom:custom-skills:legacy-a", {
      packageId: "custom:custom-skills",
      isCustomSkill: true,
    });
    await seedSkill("custom:custom-skills:legacy-b", {
      packageId: "custom:custom-skills",
      isPersonal: true,
    });
    await seedSkill("custom:custom-skills:legacy-c", {
      packageId: "custom:custom-skills",
      level: "custom", // the retired sentinel — NOT a valid SkillLevel
      isCustomSkill: true,
    });
    // The STRING "true" is not the primitive the TS normalizer requires
    // (`record.isCustomSkill === true`), so this row is NOT personal — the SQL
    // must agree, which it only does by comparing JSONB rather than `->>`.
    await seedSkill("custom:custom-skills:stringy", {
      packageId: "custom:custom-skills",
      isCustomSkill: "true",
    });
    await runBatch([
      buildGrantSkillUploadConsentQuery(SCHEMA, {
        scopeKind: "extension",
        scopeKey: "custom:custom-skills",
        grantedBy: "admin-1",
        sourceEvent: "admin-grant",
      }),
      ...catalogTail("admin-grant"),
    ]);
    expect(await readUploadFlag("custom:custom-skills:legacy-a")).toBe(false);
    expect(await readUploadFlag("custom:custom-skills:legacy-b")).toBe(false);
    expect(await readUploadFlag("custom:custom-skills:legacy-c")).toBe(false);
    // ...while the string-"true" row is non-personal in BOTH the normalizer and
    // the SQL, so the package grant reaches it.
    expect(await readUploadFlag("custom:custom-skills:stringy")).toBe(true);

    // Their OWN per-skill grant does authorize them.
    await runBatch([
      buildGrantSkillUploadConsentQuery(SCHEMA, {
        scopeKind: "personal",
        scopeKey: "custom:custom-skills:legacy-a",
        grantedBy: "user-7",
        sourceEvent: "personal-grant",
      }),
      ...catalogTail("personal-grant"),
    ]);
    expect(await readUploadFlag("custom:custom-skills:legacy-a")).toBe(true);
    expect(await readUploadFlag("custom:custom-skills:legacy-b")).toBe(false);
  });

  it("bulk consent skips a LEGACY personal row's synthetic package identity", async () => {
    await seedSkill("custom:custom-skills:legacy-a", {
      packageId: "custom:custom-skills",
      isCustomSkill: true,
    });
    await runBatch([buildBulkSkillUploadConsentQuery(SCHEMA, "admin-1")]);
    const rows = await sql(
      `SELECT count(*)::int AS n FROM "${SCHEMA}"."skill_upload_consent" WHERE revoked_at IS NULL`,
    );
    expect(rows.rows[0].n).toBe(0);
  });

  it("a PERSONAL grant never reaches a NON-personal skill of the same id", async () => {
    await seedSkill("github:acme/pack:alpha", {
      packageId: "github:acme/pack",
      level: "workspace",
    });
    await runBatch([
      buildGrantSkillUploadConsentQuery(SCHEMA, {
        scopeKind: "personal",
        scopeKey: "github:acme/pack:alpha",
        grantedBy: "user-7",
        sourceEvent: "personal-grant",
      }),
      ...catalogTail("personal-grant"),
    ]);
    expect(await readUploadFlag("github:acme/pack:alpha")).toBe(false);
  });

  it("PERSONAL consent keys on the individual skill id, never on a package", async () => {
    await seedSkill("custom:mine:s1", {
      packageId: "custom:mine",
      level: "personal",
    });
    await seedSkill("custom:mine:s2", {
      packageId: "custom:mine",
      level: "personal",
    });
    await runBatch([
      buildGrantSkillUploadConsentQuery(SCHEMA, {
        scopeKind: "personal",
        scopeKey: "custom:mine:s1",
        grantedBy: "user-7",
        sourceEvent: "personal-grant",
      }),
      ...catalogTail("personal-grant"),
    ]);
    expect(await readUploadFlag("custom:mine:s1")).toBe(true);
    expect(await readUploadFlag("custom:mine:s2")).toBe(false);
  });

  it("the setup bulk grant covers installed non-personal packages incl. the core system tier, and skips personal", async () => {
    await seedSkill("verdaccio:@cinatra-ai/core-skills:a", {
      packageId: "verdaccio:@cinatra-ai/core-skills",
      level: "system",
    });
    await seedSkill("github:acme/pack:alpha", {
      packageId: "github:acme/pack",
      level: "workspace",
    });
    await seedSkill("custom:mine:s1", { packageId: "custom:mine", level: "personal" });

    await runBatch([
      buildBulkSkillUploadConsentQuery(SCHEMA, "admin-1"),
      ...catalogTail("consent-grant:setup-bulk"),
    ]);

    expect(await readUploadFlag("verdaccio:@cinatra-ai/core-skills:a")).toBe(true);
    expect(await readUploadFlag("github:acme/pack:alpha")).toBe(true);
    expect(await readUploadFlag("custom:mine:s1")).toBe(false);

    const ledger = await sql(buildSelectSkillUploadConsentQuery(SCHEMA).text);
    const byKey = new Map(
      (ledger.rows as Array<{ scope_key: string; scope_kind: string; source_event: string }>).map(
        (r) => [r.scope_key, r],
      ),
    );
    // The system tier is recorded as `core-system`, everything else as
    // `extension` — provenance only; the projection joins both identically.
    expect(byKey.get("verdaccio:@cinatra-ai/core-skills")?.scope_kind).toBe("core-system");
    expect(byKey.get("github:acme/pack")?.scope_kind).toBe("extension");
    expect(byKey.get("github:acme/pack")?.source_event).toBe("setup-bulk");
    expect(byKey.has("custom:mine")).toBe(false);
  });

  it("the bulk grant is idempotent — a re-run adds no second active row", async () => {
    await seedSkill("github:acme/pack:alpha", {
      packageId: "github:acme/pack",
      level: "workspace",
    });
    await runBatch([buildBulkSkillUploadConsentQuery(SCHEMA, "admin-1")]);
    await runBatch([buildBulkSkillUploadConsentQuery(SCHEMA, "admin-2")]);
    const r = await sql(
      `SELECT count(*)::int AS n FROM "${SCHEMA}"."skill_upload_consent" WHERE revoked_at IS NULL`,
    );
    expect(r.rows[0].n).toBe(1);
  });

  it("a package identity can hold only ONE active consent across both provenance tiers", async () => {
    // `extension` and `core-system` address the SAME package identity. Two
    // active rows would mean one revoke leaves the package still authorized.
    await runBatch([
      buildGrantSkillUploadConsentQuery(SCHEMA, {
        scopeKind: "core-system",
        scopeKey: "verdaccio:@cinatra-ai/core-skills",
        grantedBy: "admin-1",
        sourceEvent: "setup-bulk",
      }),
    ]);
    // The second grant, under the OTHER tier, must be a no-op...
    await runBatch([
      buildGrantSkillUploadConsentQuery(SCHEMA, {
        scopeKind: "extension",
        scopeKey: "verdaccio:@cinatra-ai/core-skills",
        grantedBy: "admin-2",
        sourceEvent: "extension-install",
      }),
    ]);
    const active = await sql(
      `SELECT scope_kind FROM "${SCHEMA}"."skill_upload_consent" WHERE revoked_at IS NULL`,
    );
    expect(active.rows).toHaveLength(1);
    expect(active.rows[0].scope_kind).toBe("core-system");

    // ...and revoking through the `extension` tier clears the `core-system`
    // row, so a single revoke really does disable the package.
    await runBatch([
      buildRevokeSkillUploadConsentQuery(SCHEMA, {
        scopeKind: "extension",
        scopeKey: "verdaccio:@cinatra-ai/core-skills",
        revokedBy: "admin-3",
      }),
    ]);
    const stillActive = await sql(
      `SELECT count(*)::int AS n FROM "${SCHEMA}"."skill_upload_consent" WHERE revoked_at IS NULL`,
    );
    expect(stillActive.rows[0].n).toBe(0);
  });

  it("the index REFUSES a second active package row even if a writer bypassed the guard", async () => {
    await sql(
      `INSERT INTO "${SCHEMA}"."skill_upload_consent" (scope_kind, scope_key, source_event)
         VALUES ('extension', 'github:acme/pack', 'extension-install')`,
    );
    await expect(
      sql(
        `INSERT INTO "${SCHEMA}"."skill_upload_consent" (scope_kind, scope_key, source_event)
           VALUES ('core-system', 'github:acme/pack', 'setup-bulk')`,
      ),
    ).rejects.toThrow();
  });

  it("bulk consent emits ONE row for a package holding both system and non-system skills", async () => {
    await seedSkill("verdaccio:@acme/mixed:sys", {
      packageId: "verdaccio:@acme/mixed",
      level: "system",
    });
    await seedSkill("verdaccio:@acme/mixed:ws", {
      packageId: "verdaccio:@acme/mixed",
      level: "workspace",
    });
    await runBatch([buildBulkSkillUploadConsentQuery(SCHEMA, "admin-1")]);
    const rows = await sql(
      `SELECT scope_kind FROM "${SCHEMA}"."skill_upload_consent" WHERE revoked_at IS NULL`,
    );
    expect(rows.rows).toHaveLength(1);
    // Deterministic tier choice: the more specific `core-system` wins.
    expect(rows.rows[0].scope_kind).toBe("core-system");
  });

  it("a duplicate active grant is refused by the partial unique index", async () => {
    const grant = buildGrantSkillUploadConsentQuery(SCHEMA, {
      scopeKind: "extension",
      scopeKey: "github:acme/pack",
      grantedBy: "admin-1",
      sourceEvent: "extension-install",
    });
    await runBatch([grant]);
    await runBatch([grant]);
    const r = await sql(
      `SELECT count(*)::int AS n FROM "${SCHEMA}"."skill_upload_consent" WHERE revoked_at IS NULL`,
    );
    expect(r.rows[0].n).toBe(1);
  });

  // -------------------------------------------------------------------------
  // AC4 — revocation
  // -------------------------------------------------------------------------

  it("revocation flips the projection and preserves the grant row as the audit record (AC4)", async () => {
    await seedSkill("github:acme/pack:alpha", { packageId: "github:acme/pack" });
    await runBatch([
      buildGrantSkillUploadConsentQuery(SCHEMA, {
        scopeKind: "extension",
        scopeKey: "github:acme/pack",
        grantedBy: "admin-1",
        sourceEvent: "extension-install",
      }),
      ...catalogTail("install"),
    ]);
    expect(await readUploadFlag("github:acme/pack:alpha")).toBe(true);

    await runBatch([
      buildRevokeSkillUploadConsentQuery(SCHEMA, {
        scopeKind: "extension",
        scopeKey: "github:acme/pack",
        revokedBy: "admin-2",
      }),
      ...catalogTail("consent-revoke"),
    ]);
    // The flag is false — the sync engine's existing path then marks the remote
    // row stale and the GC reclaims it.
    expect(await readUploadFlag("github:acme/pack:alpha")).toBe(false);

    const ledger = await sql(buildSelectSkillUploadConsentQuery(SCHEMA).text);
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0].revoked_by).toBe("admin-2");
    expect(ledger.rows[0].revoked_at).not.toBeNull();

    // A revoked row does not block a fresh grant (re-consent is possible).
    await runBatch([
      buildGrantSkillUploadConsentQuery(SCHEMA, {
        scopeKind: "extension",
        scopeKey: "github:acme/pack",
        grantedBy: "admin-3",
        sourceEvent: "admin-grant",
      }),
      ...catalogTail("re-grant"),
    ]);
    expect(await readUploadFlag("github:acme/pack:alpha")).toBe(true);
    const after = await sql(buildSelectSkillUploadConsentQuery(SCHEMA).text);
    expect(after.rows).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // AC5 — uninstall reclaims after the grace window
  // -------------------------------------------------------------------------

  it("an uninstall schedules a delayed GC row due at grace-window expiry — not claimable before it (AC5)", async () => {
    await runBatch(catalogTail("skill-extension-uninstall", true));
    const rows = await outboxRows();
    expect(rows).toHaveLength(2);
    const gc = rows.find((r) => r.kind === "gc");
    expect(gc).toBeDefined();
    expect(gc!.not_before).toBeInstanceOf(Date);
    const dueInMs = gc!.not_before!.getTime() - Date.now();
    // Due at ~grace expiry (generous window for clock/roundtrip skew).
    expect(dueInMs).toBeGreaterThan(ANTHROPIC_SKILL_STALE_GRACE_MS - 120_000);
    expect(dueInMs).toBeLessThanOrEqual(ANTHROPIC_SKILL_STALE_GRACE_MS + 120_000);

    // A drain running now claims ONLY the reconcile row; the GC row waits.
    const claim = await sql(
      `UPDATE "${SCHEMA}"."anthropic_skill_reconcile_outbox"
         SET status='running', lease_token='w1', lease_expires_at = now() + interval '5 minutes'
       WHERE status='pending' AND (not_before IS NULL OR not_before <= now())
       RETURNING kind`,
    );
    expect(claim.rows.map((r) => r.kind)).toEqual(["reconcile"]);

    // At grace expiry it becomes due and is claimed WITHOUT any manual step.
    await sql(
      `UPDATE "${SCHEMA}"."anthropic_skill_reconcile_outbox" SET not_before = now() - interval '1 second' WHERE kind='gc'`,
    );
    const later = await sql(
      `UPDATE "${SCHEMA}"."anthropic_skill_reconcile_outbox"
         SET status='running', lease_token='w2', lease_expires_at = now() + interval '5 minutes'
       WHERE status='pending' AND (not_before IS NULL OR not_before <= now())
       RETURNING kind`,
    );
    expect(later.rows.map((r) => r.kind)).toEqual(["gc"]);
  });

  it("each uninstall anchors its OWN GC row (delayed GC is never coalesced)", async () => {
    await runBatch(catalogTail("uninstall-a", true));
    await runBatch(catalogTail("uninstall-b", true));
    const gcRows = (await outboxRows()).filter((r) => r.kind === "gc");
    expect(gcRows).toHaveLength(2);
    expect(gcRows.map((r) => r.reason).sort()).toEqual(["uninstall-a", "uninstall-b"]);
  });
});
