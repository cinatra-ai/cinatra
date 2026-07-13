/**
 * cinatra#1426 — semantic_assertion binding basis, REAL-DB integration test
 * (no mocks on the DDL path). AC-2 and the DB guard set:
 *
 *   1. a second ACTIVE binding insert for the same artifact — ANY extension —
 *      rejects on `sa_one_active_binding_idx` (one active binding per
 *      artifact across all extensions);
 *   2. archiving the active binding frees the slot (a reconciliation can
 *      land the successor);
 *   3. classic assertions coexist with a binding (different extensions) and
 *      keep their own ≤1-active-per-(org,artifact,extension) rule;
 *   4. existing-writer compatibility: an INSERT that never names
 *      assertion_basis lands 'classic' (the backfill DEFAULT);
 *   5. the CHECK guards: a binding without its claim-activation generation, a
 *      classic row WITH one, and a matcher binding all reject;
 *   6. the frozen trigger: flipping assertion_basis or rewriting
 *      binding_generation by UPDATE rejects (binding mutations are the
 *      defined reconciliations — new INSERTs).
 *
 * Guarded by `describe.skipIf(!HAS_REAL_DB)` like the other integration
 * suites: CI without a reachable Postgres emits zero failures and zero noise.
 * Per the integration convention the schema is created fresh per test file
 * (never the worktree's shared schema).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

import { connect, createTestSchema, dropSchema } from "./_fixture";

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_REAL_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@");

const ORG = "org-int-1426";
const DEF = "@cinatra-ai/default-artifact";
const EMAIL_EXT = "@cinatra-ai/email-artifact";
const OTHER_EXT = "@cinatra-ai/other-artifact";

describe.skipIf(!HAS_REAL_DB)("cinatra#1426 binding basis DDL (real DB)", () => {
  let client: Client;
  let schema: string;

  beforeAll(async () => {
    client = await connect();
    schema = await createTestSchema(client);
  });

  afterAll(async () => {
    if (client && schema) await dropSchema(client, schema);
    await client?.end().catch(() => {});
  });

  function insertAssertion(over: {
    artifactId: string;
    extension: string;
    assertedBy?: string;
    eligibility?: string;
    basis?: string | null; // null = omit the column (existing-writer shape)
    claimId?: string | null;
    generation?: number | null;
    id?: string;
  }): Promise<unknown> {
    const id = over.id ?? randomUUID();
    if (over.basis === null || over.basis === undefined) {
      return client.query(
        `INSERT INTO "${schema}"."semantic_assertion" (id, org_id, artifact_id, extension, asserted_by, eligibility)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, ORG, over.artifactId, over.extension, over.assertedBy ?? "user", over.eligibility ?? "eligible"],
      );
    }
    return client.query(
      `INSERT INTO "${schema}"."semantic_assertion" (id, org_id, artifact_id, extension, asserted_by, eligibility, assertion_basis, binding_claim_id, binding_generation)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id,
        ORG,
        over.artifactId,
        over.extension,
        over.assertedBy ?? "agent",
        over.eligibility ?? "eligible",
        over.basis,
        over.claimId === undefined ? (over.basis === "binding" ? "claim-int-1426" : null) : over.claimId,
        over.generation ?? null,
      ],
    );
  }

  it("existing writers land 'classic' via the DEFAULT (no column named)", async () => {
    const artifactId = randomUUID();
    await insertAssertion({ artifactId, extension: DEF, basis: null });
    const r = await client.query(
      `SELECT assertion_basis, binding_claim_id, binding_generation FROM "${schema}"."semantic_assertion" WHERE org_id=$1 AND artifact_id=$2`,
      [ORG, artifactId],
    );
    expect(r.rows[0]).toEqual({ assertion_basis: "classic", binding_claim_id: null, binding_generation: null });
  });

  it("AC-2: a second ACTIVE binding for the same artifact rejects — across extensions — on sa_one_active_binding_idx", async () => {
    const artifactId = randomUUID();
    await insertAssertion({ artifactId, extension: EMAIL_EXT, basis: "binding", generation: 1 });
    await expect(
      insertAssertion({ artifactId, extension: OTHER_EXT, basis: "binding", generation: 1 }),
    ).rejects.toThrow(/sa_one_active_binding_idx/);
  });

  it("archiving the active binding frees the slot for the successor binding", async () => {
    const artifactId = randomUUID();
    const first = randomUUID();
    await insertAssertion({ id: first, artifactId, extension: EMAIL_EXT, basis: "binding", generation: 1 });
    await client.query(
      `UPDATE "${schema}"."semantic_assertion" SET eligibility='archived', archived_at=now() WHERE id=$1`,
      [first],
    );
    await expect(
      insertAssertion({ artifactId, extension: EMAIL_EXT, basis: "binding", generation: 2 }),
    ).resolves.toBeDefined();
  });

  it("classic assertions coexist with a binding (different extensions) — classics never displace it", async () => {
    const artifactId = randomUUID();
    await insertAssertion({ artifactId, extension: EMAIL_EXT, basis: "binding", generation: 1 });
    await expect(
      insertAssertion({ artifactId, extension: OTHER_EXT, basis: "classic", assertedBy: "user" }),
    ).resolves.toBeDefined();
    // The classic per-extension active-uniqueness still holds.
    await expect(
      insertAssertion({ artifactId, extension: OTHER_EXT, basis: "classic", assertedBy: "agent" }),
    ).rejects.toThrow(/sa_active_unique_idx/);
  });

  it("CHECK guards: binding without generation / without claim row / classic with generation / matcher binding all reject", async () => {
    const artifactId = randomUUID();
    await expect(
      insertAssertion({ artifactId, extension: EMAIL_EXT, basis: "binding", generation: null }),
    ).rejects.toThrow(/sa_binding_generation_chk/);
    await expect(
      insertAssertion({ artifactId, extension: EMAIL_EXT, basis: "binding", generation: 1, claimId: null }),
    ).rejects.toThrow(/sa_binding_claim_chk/);
    await expect(
      insertAssertion({ artifactId, extension: EMAIL_EXT, basis: "classic", generation: 7 }),
    ).rejects.toThrow(/sa_binding_generation_chk/);
    await expect(
      insertAssertion({
        artifactId,
        extension: EMAIL_EXT,
        basis: "binding",
        generation: 1,
        assertedBy: "matcher",
        eligibility: "draft",
      }),
    ).rejects.toThrow(/sa_binding_never_matcher_chk/);
  });

  it("frozen trigger: assertion_basis flips and binding claim/generation rewrites by UPDATE are forbidden", async () => {
    const artifactId = randomUUID();
    const id = randomUUID();
    await insertAssertion({ id, artifactId, extension: EMAIL_EXT, basis: "binding", generation: 1 });
    await expect(
      client.query(
        `UPDATE "${schema}"."semantic_assertion" SET assertion_basis='classic', binding_claim_id=NULL, binding_generation=NULL WHERE id=$1`,
        [id],
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      client.query(
        `UPDATE "${schema}"."semantic_assertion" SET binding_generation=2 WHERE id=$1`,
        [id],
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      client.query(
        `UPDATE "${schema}"."semantic_assertion" SET binding_claim_id='claim-other' WHERE id=$1`,
        [id],
      ),
    ).rejects.toThrow(/immutable/);
  });
});
