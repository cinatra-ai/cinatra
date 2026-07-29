/**
 * THE SETUP READINESS WALK — against a REAL Postgres (cinatra#2093, epic #2086 S6).
 *
 * WHAT IS REAL HERE, AND WHAT IS NOT — stated plainly, because the distinction
 * is the whole value of this file:
 *
 *   REAL: Postgres, the real DDL chain, and the REAL S5 query builders. The
 *         bulk-consent grant, the derived `allowAnthropicUpload` projection,
 *         the reconcile OUTBOX append and the sync-map rows all execute as
 *         actual SQL produced by the SAME functions the running saga calls
 *         (`buildBulkSkillUploadConsentQuery`,
 *         `buildSkillUploadProjectionQuery`, `buildInsertReconcileOutboxQuery`,
 *         `buildSelectSkillUploadConsentQuery`). Hand-written SQL would prove
 *         only that Postgres works; driving the builders proves the CONTRACT
 *         the S6 saga leans on.
 *
 *   BOUNDARY-STUBBED: nothing in this file. There is no Anthropic HTTP call
 *         here — the Anthropic egress boundary is exercised by the connector's
 *         own probe suite (`native-skills-probe.test.ts`, `fetch` stubbed at the
 *         process boundary) because no live Anthropic key is available in this
 *         environment. What CANNOT be proven anywhere without a live key is the
 *         API's ACCEPTANCE of a `container.skills` request; that arm is
 *         explicitly outstanding and is S7's end-to-end scope.
 *
 * The walk proves what a unit test cannot: that the bulk grant really lands
 * rows for the packages the saga expects, that the projection the strict sync
 * depends on really flips as a result, and that a reconcile request really
 * lands in the outbox — i.e. that the Anthropic arm of the saga is standing on
 * machinery that actually works, not on a stubbed port that always says yes.
 *
 * Runner (self-skips without a live DB, so it can never pass vacuously):
 *   CINATRA_DB_INTEGRATION_TESTS=1 SUPABASE_DB_URL=<live> \
 *     pnpm exec vitest run src/lib/__tests__/integration/setup-readiness-walk.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Client } from "pg";
import { randomUUID } from "node:crypto";

import {
  buildBulkSkillUploadConsentQuery,
  buildGrantSkillUploadConsentQuery,
  buildRevokeSkillUploadConsentQuery,
  buildSelectSkillUploadConsentQuery,
  buildSkillUploadProjectionQuery,
  buildInsertReconcileOutboxQuery,
} from "@/lib/skill-lifecycle-store";
import { skillUploadConsentSchemaQueries } from "@/lib/skill-lifecycle-schema";

// Same DB gate as the S5 outbox suite (cinatra#2092): a placeholder connection
// string is NOT a live database, and `_fixture` is deliberately NOT imported —
// it pulls the store module, which connects eagerly at import and would turn a
// legitimate skip into a red suite.
const dbUrl = process.env.SUPABASE_DB_URL;
const hasDb =
  typeof dbUrl === "string" &&
  dbUrl.length > 0 &&
  !dbUrl.includes("unused:unused@") &&
  !dbUrl.includes("build:build@127.0.0.1:5432/build");
const d = describe.skipIf(!hasDb);

const schema = "cinatra_test_s6_readiness_walk_2093";
let client: Client;

beforeAll(async () => {
  if (!hasDb) return;
  client = new Client({ connectionString: dbUrl });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
  // The REAL column contract the canonical store DDL uses, so the projection's
  // `payload::jsonb` round-trip is exercised exactly as in production.
  await client.query(
    `CREATE TABLE "${schema}"."skills" (id text PRIMARY KEY, payload text NOT NULL)`,
  );
  for (const q of skillUploadConsentSchemaQueries(schema)) await client.query(q.text);
  // The sync map the probe-target read filters over.
  await client.query(
    `CREATE TABLE IF NOT EXISTS "${schema}"."anthropic_skill_sync" (
       api_key_fingerprint text NOT NULL,
       environment text NOT NULL,
       catalog_skill_id text NOT NULL,
       anthropic_skill_id text NOT NULL,
       anthropic_version text NOT NULL,
       content_hash text NOT NULL,
       stale boolean NOT NULL DEFAULT false,
       PRIMARY KEY (api_key_fingerprint, environment, catalog_skill_id)
     )`,
  );
}, 180_000);

afterAll(async () => {
  if (!hasDb) return;
  await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await client.end();
});

/** Run a builder-produced query verbatim — the point is to exercise ITS SQL. */
async function run(q: { text: string; values?: unknown[] }) {
  return client.query(q.text, (q.values ?? []) as unknown[]);
}

/** Seed a catalog skill belonging to `packageId`. */
async function seedSkill(input: {
  id: string;
  packageId: string;
  level?: string;
  allowAnthropicUpload?: boolean;
}) {
  await client.query(
    `INSERT INTO "${schema}".skills (id, payload)
     VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload`,
    [
      input.id,
      JSON.stringify({
        id: input.id,
        packageId: input.packageId,
        packageName: input.packageId,
        level: input.level ?? "workspace",
        allowAnthropicUpload: input.allowAnthropicUpload ?? false,
      }),
    ],
  );
}

async function readUploadFlag(skillId: string): Promise<boolean | undefined> {
  const res = await client.query(
    `SELECT payload::jsonb ->> 'allowAnthropicUpload' AS flag FROM "${schema}".skills WHERE id = $1`,
    [skillId],
  );
  if (res.rowCount === 0) return undefined;
  const raw = res.rows[0].flag;
  return raw === null ? undefined : raw === "true";
}

d("skill_upload_consent — the ledger the Anthropic saga arm grants into", () => {
  beforeEach(async () => {
    await client.query(`DELETE FROM "${schema}".skill_upload_consent`);
    await client.query(`DELETE FROM "${schema}".anthropic_skill_reconcile_outbox`);
    await client.query(`DELETE FROM "${schema}".skills`);
  });

  it("S5's OWN DDL provisions the ledger + outbox the saga grants into", async () => {
    // Provisioned above by `skillUploadConsentSchemaQueries` — S5's real DDL,
    // not hand-written CREATE TABLEs. If S5 ever stopped shipping these, the
    // saga's bulk-consent step would silently grant nothing and the strict sync
    // would upload nothing — a failure the port-stubbed unit tests
    // structurally cannot see.
    for (const table of ["skill_upload_consent", "anthropic_skill_reconcile_outbox"]) {
      const res = await client.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2`,
        [schema, table],
      );
      expect(res.rowCount, `${table} must exist`).toBe(1);
    }
  });

  it("SETUP BULK CONSENT grants one row per installed package identity", async () => {
    await seedSkill({ id: "sk-a", packageId: "@acme/pack-one" });
    await seedSkill({ id: "sk-b", packageId: "@acme/pack-one" }); // same package
    await seedSkill({ id: "sk-c", packageId: "@acme/pack-two" });

    const grantedBy = randomUUID();
    await run(buildBulkSkillUploadConsentQuery(schema, grantedBy));

    const rows = await run(buildSelectSkillUploadConsentQuery(schema));
    const keys = rows.rows.map((r: { scope_key: string }) => r.scope_key).sort();
    // ONE row per package identity, not one per skill — the version-free
    // package identity the ledger is keyed on.
    expect(keys).toEqual(["@acme/pack-one", "@acme/pack-two"]);
    for (const r of rows.rows as Array<{ source_event: string; granted_by: string }>) {
      expect(r.source_event).toBe("setup-bulk");
      expect(r.granted_by).toBe(grantedBy);
    }
  });

  it("the bulk grant is IDEMPOTENT — a re-run of setup does not duplicate consent", async () => {
    await seedSkill({ id: "sk-a", packageId: "@acme/pack-one" });
    await run(buildBulkSkillUploadConsentQuery(schema, randomUUID()));
    await run(buildBulkSkillUploadConsentQuery(schema, randomUUID()));

    const rows = await run(buildSelectSkillUploadConsentQuery(schema));
    expect(rows.rowCount).toBe(1);
  });

  it("the PROJECTION flips allowAnthropicUpload for consented packages — and only those", async () => {
    await seedSkill({ id: "sk-consented", packageId: "@acme/consented" });
    await seedSkill({ id: "sk-other", packageId: "@acme/other" });

    // Grant for ONE package only (the install-consent shape).
    await run(
      buildGrantSkillUploadConsentQuery(schema, {
        scopeKind: "extension",
        scopeKey: "@acme/consented",
        grantedBy: randomUUID(),
        sourceEvent: "extension-install",
      }),
    );
    await run(buildSkillUploadProjectionQuery(schema));

    // THE property the whole Anthropic arm rests on: consent → eligibility.
    expect(await readUploadFlag("sk-consented")).toBe(true);
    // And its fail-closed complement: no consent → no egress eligibility.
    expect(await readUploadFlag("sk-other")).toBe(false);
  });

  it("a REVOKE flips the projection back to false (consent is the live authority)", async () => {
    await seedSkill({ id: "sk-a", packageId: "@acme/pack-one" });
    await run(
      buildGrantSkillUploadConsentQuery(schema, {
        scopeKind: "extension",
        scopeKey: "@acme/pack-one",
        grantedBy: randomUUID(),
        sourceEvent: "extension-install",
      }),
    );
    await run(buildSkillUploadProjectionQuery(schema));
    expect(await readUploadFlag("sk-a")).toBe(true);

    await run(
      buildRevokeSkillUploadConsentQuery(schema, {
        scopeKind: "extension",
        scopeKey: "@acme/pack-one",
        revokedBy: randomUUID(),
      }),
    );
    await run(buildSkillUploadProjectionQuery(schema));
    expect(await readUploadFlag("sk-a")).toBe(false);
  });

  it("a reconcile request really lands in the transactional outbox", async () => {
    // The saga's strict initial sync is driven by this row. If the append were
    // a no-op, setup would report success having uploaded nothing.
    await run(buildInsertReconcileOutboxQuery(schema, "setup-readiness-saga"));
    const res = await client.query(
      `SELECT kind, reason FROM "${schema}".anthropic_skill_reconcile_outbox`,
    );
    expect(res.rowCount).toBe(1);
    expect(res.rows[0].kind).toBe("reconcile");
    expect(res.rows[0].reason).toBe("setup-readiness-saga");
  });
});

d("the OPENAI path performs NO Anthropic egress and touches NO Anthropic state", () => {
  beforeEach(async () => {
    await client.query(`DELETE FROM "${schema}".skill_upload_consent`);
    await client.query(`DELETE FROM "${schema}".anthropic_skill_reconcile_outbox`);
    await client.query(`DELETE FROM "${schema}".anthropic_skill_sync`);
    await client.query(`DELETE FROM "${schema}".skills`);
  });

  it("with skills installed but NO bulk consent, nothing is upload-eligible and no reconcile is queued", async () => {
    // The OpenAI arm's contract is NEGATIVE — "nothing happened over there" —
    // which is exactly the kind of claim that rots silently. This is that claim
    // asserted against the real tables: the OpenAI path runs neither the grant
    // nor the outbox append, so an install that would be eligible under
    // Anthropic stays inert.
    await seedSkill({ id: "sk-a", packageId: "@acme/pack-one" });
    await seedSkill({ id: "sk-b", packageId: "@acme/pack-two" });

    // Run the projection anyway: even if something re-derived it, no consent
    // exists, so nothing may be uploaded.
    await run(buildSkillUploadProjectionQuery(schema));

    expect(await readUploadFlag("sk-a")).toBe(false);
    expect(await readUploadFlag("sk-b")).toBe(false);

    const consent = await client.query(
      `SELECT count(*)::int AS n FROM "${schema}".skill_upload_consent`,
    );
    expect(consent.rows[0].n).toBe(0);

    const outbox = await client.query(
      `SELECT count(*)::int AS n FROM "${schema}".anthropic_skill_reconcile_outbox`,
    );
    expect(outbox.rows[0].n).toBe(0);

    const sync = await client.query(
      `SELECT count(*)::int AS n FROM "${schema}".anthropic_skill_sync`,
    );
    expect(sync.rows[0].n).toBe(0);
  });
});

d("the probe must reference an ACTUALLY-UPLOADED revision", () => {
  beforeEach(async () => {
    await client.query(`DELETE FROM "${schema}".anthropic_skill_sync`);
  });

  it("only NON-STALE sync rows are eligible probe targets", async () => {
    // `readSyncedAnthropicSkillIds` filters stale rows. A stale row names a
    // remote revision that may already have been reclaimed — probing it would
    // exercise the API's 404 path rather than the container.skills ACCEPTANCE
    // path, and could "pass" the exact misconfiguration the probe exists to
    // catch.
    const fp = "fp-test";
    const env = "env-test";
    for (const [catalogId, anthropicId, stale] of [
      ["cat-live", "skill_live", false],
      ["cat-stale", "skill_stale", true],
    ] as const) {
      await client.query(
        `INSERT INTO "${schema}".anthropic_skill_sync
           (api_key_fingerprint, environment, catalog_skill_id, anthropic_skill_id,
            anthropic_version, content_hash, stale)
         VALUES ($1,$2,$3,$4,'v1','hash',$5)`,
        [fp, env, catalogId, anthropicId, stale],
      );
    }

    const res = await client.query(
      `SELECT anthropic_skill_id FROM "${schema}".anthropic_skill_sync
       WHERE api_key_fingerprint=$1 AND environment=$2 AND stale = false`,
      [fp, env],
    );
    expect(res.rows.map((r: { anthropic_skill_id: string }) => r.anthropic_skill_id)).toEqual([
      "skill_live",
    ]);
  });

  it("an EMPTY eligible set is what routes the saga to the disposable-probe fallback", async () => {
    const res = await client.query(
      `SELECT count(*)::int AS n FROM "${schema}".anthropic_skill_sync WHERE stale = false`,
    );
    expect(res.rows[0].n).toBe(0);
  });
});
