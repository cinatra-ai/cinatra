/**
 * Real-Postgres proof for the cinatra#1238 demo-seed fix (2026-07-20 live
 * acceptance). Two defects, one suite:
 *
 *   DEFECT 1 (FK crash / adopt-not-shadow): the canonical-extension demo rows
 *   share a platform identity with the REAL bundled installs (code-reviewer-agent,
 *   chat-assistant-core-skill — owner_id='__platform__', is_default=true). The pre-fix seed
 *   claimed is_default=true, collided on installed_extension_one_default_platform_idx,
 *   was SILENTLY skipped by `ON CONFLICT DO NOTHING`, then resolved the dependency
 *   edge from an in-memory id that never landed → FK 23503 → the whole seed aborted.
 *   The fix ADOPTS the bundled install (no shadow row) and resolves the edge from
 *   the DB, so with a real collision present the seed COMPLETES and the edge points
 *   at the ADOPTED bundled install id.
 *
 *   DEFECT 2 (destructive re-claim loop): a `failed` one-shot marker used to be
 *   re-claimable, so every boot re-ran the seed's opening TRUNCATE wipe forever.
 *   `failed` is now TERMINAL (needs an explicit operator reset); `completed` still
 *   never re-claims. Proven against the real `metadata` table via the exact claim
 *   statement builder.
 *
 * DB tier: needs a live SUPABASE_DB_URL; self-skips otherwise (sibling convention).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "pg";

import { connect, createTestSchema, dropSchema } from "./_fixture";
// The extracted, schema-parameterized canonical-demo seeder (runtime .mjs — the
// same module scripts/seed.mjs imports).
import { seedV64CanonicalDemo } from "../../../../scripts/lib/seed-v64-canonical-demo.mjs";
import {
  buildDemoSeedClaimQuery,
  DEMO_SEED_STATE_KEY,
  RUNNING_RAW,
  COMPLETED_RAW,
  FAILED_RAW,
} from "@/lib/demo-seed-runner";

const dbUrl = process.env.SUPABASE_DB_URL;
const suite = dbUrl ? describe : describe.skip;

const ORG_ACME = "org-acme-group";
const CODE_REVIEWER = "@cinatra-ai/code-reviewer-agent";
const ASSISTANT_CORE_SKILL = "@cinatra-ai/chat-assistant-core-skill";

suite("cinatra#1238 demo-seed fix (real Postgres)", () => {
  let client: Client;
  let schema = "";
  /** q adapter the extracted seeder expects. */
  const makeQ = (s: string) => (sql: string, params: unknown[] = []) => client.query(sql, params);
  const installed = () => `"${schema}"."installed_extension"`;
  const edges = () => `"${schema}"."extension_dependency_edge"`;
  const metadata = () => `"${schema}"."metadata"`;

  beforeAll(async () => {
    client = await connect();
    schema = await createTestSchema(client);
  });

  afterAll(async () => {
    if (schema) await dropSchema(client, schema);
    await client.end();
  });

  beforeEach(async () => {
    // Clean slate per test (edges cascade off installed, but be explicit).
    await client.query(`DELETE FROM ${edges()}`);
    await client.query(`DELETE FROM ${installed()}`);
    await client.query(`DELETE FROM ${metadata()} WHERE key = $1`, [DEMO_SEED_STATE_KEY]);
  });

  /** Insert a REAL bundled platform install (is_default=true) that owns the
   *  platform default slot for `pkg` — exactly the row the seed collides with. */
  async function insertBundledPlatformInstall(id: string, pkg: string, kind: string) {
    await client.query(
      `INSERT INTO ${installed()}
         (id, package_name, owner_level, owner_id, organization_id, kind, status,
          source, required_in_prod, manifest_hash, version, is_default)
       VALUES ($1, $2, 'platform', '__platform__', NULL, $3, 'active',
               $4::jsonb, true, 'bundled-real-not-seed', '0.1.0', true)`,
      [id, pkg, kind, JSON.stringify({ type: "verdaccio", registryUrl: "http://localhost:4873", packageName: pkg, version: "0.1.0", integrity: "sha512-bundled-real" })],
    );
  }

  it("DEFECT 1 — with a real bundled collision present, the seed COMPLETES, ADOPTS the bundled install as the edge target, and never shadows it", async () => {
    await insertBundledPlatformInstall("iext_bundled_crv", CODE_REVIEWER, "agent");
    await insertBundledPlatformInstall("iext_bundled_skills", ASSISTANT_CORE_SKILL, "skill");

    // The pre-fix code threw FK 23503 here. Must not throw now.
    await expect(
      seedV64CanonicalDemo({ q: makeQ(schema), schema, orgAcmeId: ORG_ACME, log: () => {} }),
    ).resolves.toBeUndefined();

    // ADOPT-not-shadow: the platform shadow rows (01, 07) were NOT inserted.
    const shadow = await client.query(
      `SELECT id FROM ${installed()} WHERE id IN ('iext_seed-v64-01', 'iext_seed-v64-07')`,
    );
    expect(shadow.rows).toHaveLength(0);

    // The bundled default installs are untouched (still exactly one default each).
    const crvDefaults = await client.query(
      `SELECT id FROM ${installed()} WHERE package_name = $1 AND owner_level = 'platform' AND is_default = true`,
      [CODE_REVIEWER],
    );
    expect(crvDefaults.rows.map((r) => r.id)).toEqual(["iext_bundled_crv"]);

    // The five org-scoped demo rows DID land.
    const orgRows = await client.query(
      `SELECT id FROM ${installed()} WHERE id LIKE 'iext_seed-v64-%' ORDER BY id`,
    );
    expect(orgRows.rows.map((r) => r.id)).toEqual([
      "iext_seed-v64-02",
      "iext_seed-v64-03",
      "iext_seed-v64-04",
      "iext_seed-v64-06",
      "iext_seed-v64-08",
    ]);

    // The dependency edge (row 06 → code-reviewer-agent) resolves to the ADOPTED
    // bundled install id — NOT the never-inserted seed shadow id.
    const edge = await client.query(
      `SELECT resolved_install_id, resolution_reason FROM ${edges()}
        WHERE dependent_install_id = 'iext_seed-v64-06'`,
    );
    expect(edge.rows).toHaveLength(1);
    expect(edge.rows[0].resolved_install_id).toBe("iext_bundled_crv");
    expect(edge.rows[0].resolution_reason).toBe("seed:platform");
  });

  it("DEFECT 1 — re-running the seed is idempotent (no duplicate rows/edges, still adopted)", async () => {
    await insertBundledPlatformInstall("iext_bundled_crv", CODE_REVIEWER, "agent");
    await insertBundledPlatformInstall("iext_bundled_skills", ASSISTANT_CORE_SKILL, "skill");

    await seedV64CanonicalDemo({ q: makeQ(schema), schema, orgAcmeId: ORG_ACME, log: () => {} });
    await seedV64CanonicalDemo({ q: makeQ(schema), schema, orgAcmeId: ORG_ACME, log: () => {} });

    const orgRows = await client.query(`SELECT id FROM ${installed()} WHERE id LIKE 'iext_seed-v64-%'`);
    expect(orgRows.rows).toHaveLength(5);
    const edge = await client.query(
      `SELECT resolved_install_id FROM ${edges()} WHERE dependent_install_id = 'iext_seed-v64-06'`,
    );
    expect(edge.rows).toHaveLength(1);
    expect(edge.rows[0].resolved_install_id).toBe("iext_bundled_crv");
  });

  it("DEFECT 1 — on a FRESH schema (no bundled install) all 7 rows seed and the edge binds the seed's own platform row", async () => {
    await seedV64CanonicalDemo({ q: makeQ(schema), schema, orgAcmeId: ORG_ACME, log: () => {} });

    const all = await client.query(`SELECT id FROM ${installed()} WHERE id LIKE 'iext_seed-v64-%'`);
    expect(all.rows).toHaveLength(7); // includes platform rows 01 + 07

    const edge = await client.query(
      `SELECT resolved_install_id, resolution_reason FROM ${edges()}
        WHERE dependent_install_id = 'iext_seed-v64-06'`,
    );
    expect(edge.rows).toHaveLength(1);
    expect(edge.rows[0].resolved_install_id).toBe("iext_seed-v64-01");
    expect(edge.rows[0].resolution_reason).toBe("seed:platform");
  });

  describe("DEFECT 2 — one-shot claim: exactly-once + failed-is-terminal (real metadata table)", () => {
    const runClaim = async () => {
      const built = buildDemoSeedClaimQuery(metadata());
      const res = await client.query(built.text, built.values);
      return res.rows.length; // 1 = claim won, 0 = not claimable
    };
    const setMarker = (raw: string) =>
      client.query(
        `INSERT INTO ${metadata()} (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        [DEMO_SEED_STATE_KEY, raw],
      );

    it("absent marker → the boot WINS the claim (running latched)", async () => {
      expect(await runClaim()).toBe(1);
      const cur = await client.query(`SELECT value FROM ${metadata()} WHERE key = $1`, [DEMO_SEED_STATE_KEY]);
      expect(cur.rows[0].value).toBe(RUNNING_RAW);
    });

    it("completed marker → NEVER re-claims (exactly-once; second boot skips, no re-wipe)", async () => {
      await setMarker(COMPLETED_RAW);
      expect(await runClaim()).toBe(0);
      const cur = await client.query(`SELECT value FROM ${metadata()} WHERE key = $1`, [DEMO_SEED_STATE_KEY]);
      expect(cur.rows[0].value).toBe(COMPLETED_RAW); // untouched
    });

    it("failed marker → NOT re-claimable → the destructive wipe does NOT re-run on boot (the #1238 fix)", async () => {
      await setMarker(FAILED_RAW);
      expect(await runClaim()).toBe(0);
      const cur = await client.query(`SELECT value FROM ${metadata()} WHERE key = $1`, [DEMO_SEED_STATE_KEY]);
      expect(cur.rows[0].value).toBe(FAILED_RAW); // untouched — no re-claim
    });

    it("operator reset clears ONLY a failed marker → the next boot re-arms the one attempt", async () => {
      await setMarker(FAILED_RAW);
      // CAS reset (the exact SQL resetDemoSeedStateInDb runs): deletes only `failed`.
      const del = await client.query(
        `DELETE FROM ${metadata()} WHERE key = $1 AND value = $2 RETURNING key`,
        [DEMO_SEED_STATE_KEY, FAILED_RAW],
      );
      expect(del.rows).toHaveLength(1);
      expect(await runClaim()).toBe(1); // re-armed
    });

    it("operator reset never clears a completed marker (CAS on `failed` only)", async () => {
      await setMarker(COMPLETED_RAW);
      const del = await client.query(
        `DELETE FROM ${metadata()} WHERE key = $1 AND value = $2 RETURNING key`,
        [DEMO_SEED_STATE_KEY, FAILED_RAW],
      );
      expect(del.rows).toHaveLength(0); // completed is safe
      expect(await runClaim()).toBe(0);
    });
  });
});
