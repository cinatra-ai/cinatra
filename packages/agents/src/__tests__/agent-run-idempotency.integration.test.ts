/**
 * Race-safe idempotent createAgentRun.
 *
 * A dispatcher may dispatch child work at-least-once (BullMQ retries + crash
 * recovery). createAgentRun accepts a run-scoped idempotencyKey; a redispatch of
 * the SAME attempt must resolve to the SAME child run (via the partial-unique
 * index agent_runs_idempotency_key_uniq), while a retry (new key) spawns a fresh
 * run. A key reused with mismatched provenance (org / template) fails closed.
 *
 * DB-gated: skips when SUPABASE_DB_URL is unset (matches store-org-required).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra";
const dbUrl = process.env.SUPABASE_DB_URL;
const hasDb =
  typeof dbUrl === "string" &&
  dbUrl.length > 0 &&
  !dbUrl.includes("unused:unused@localhost:5432/unused");
const q = (s: string) => s.replaceAll('"', '""');

// cinatra#1939 wave 2 / #1940 P3: createAgentRun now runs under guardOrgMutation
// and REQUIRES a host-minted authority; the guard also reads the org's
// lifecycle from `public."organization"`. These three orgIds are unique to
// this file (not shared with any sibling integration suite), so they are
// seeded + cleaned up here rather than left as a permanent shared fixture.
const ORG_IDS = ["org-idem", "org-A", "org-B"];
const AUTH_IDEM = { orgId: "org-idem", can: () => true };
const AUTH_A = { orgId: "org-A", can: () => true };
const AUTH_B = { orgId: "org-B", can: () => true };

beforeAll(async () => {
  if (!hasDb) return;
  // Defensive: ensure the idempotency column + partial unique index exist
  // (mirrors src/lib/drizzle-store.ts; idempotent — safe on an already-migrated schema).
  const c = new Client({ connectionString: dbUrl });
  await c.connect();
  await c.query(`ALTER TABLE "${q(SCHEMA)}"."agent_runs" ADD COLUMN IF NOT EXISTS idempotency_key text`);
  await c.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_idempotency_key_uniq ON "${q(SCHEMA)}"."agent_runs" (idempotency_key) WHERE idempotency_key IS NOT NULL`,
  );
  for (const orgId of ORG_IDS) {
    await c.query(
      `INSERT INTO public."organization" (id, name, slug, "createdAt") VALUES ($1, $2, $3, now()) ON CONFLICT (id) DO NOTHING`,
      [orgId, orgId, orgId],
    );
  }
  await c.end();
}, 30_000);

afterAll(async () => {
  if (!hasDb) return;
  const c = new Client({ connectionString: dbUrl });
  await c.connect();
  for (const orgId of ORG_IDS) {
    await c.query(`DELETE FROM public."organization" WHERE id = $1`, [orgId]);
  }
  await c.end();
});

// cinatra#2485 C — the template's INSTALL SCOPE is what authorizes a run, so a
// fixture agent must be installed in the org whose runs will target it.
// `createAgentTemplate` stamps `owner_level='organization'` / `owner_id=orgId`
// from this anchor; an org-less fixture template has no determinate scope and
// every run against it is refused.
async function makeTemplate(orgId: string): Promise<string> {
  const { createAgentTemplate } = await import("../store");
  const templateId = `t_${randomUUID()}`;
  await createAgentTemplate({
    id: templateId,
    name: `idem-${randomUUID().slice(0, 8)}`,
    sourceNl: "test",
    compiledPlan: [],
    inputSchema: {},
    approvalPolicy: { steps: [] },
    orgId,
  });
  return templateId;
}

describe.skipIf(!hasDb)("createAgentRun — idempotent dispatch", () => {
  it("same idempotency key resolves to the SAME child run (at-least-once redispatch)", async () => {
    const { createAgentRun } = await import("../store");
    const templateId = await makeTemplate("org-idem");
    const key = `dispatch:${randomUUID()}:1`;
    const first = await createAgentRun({
      id: `r_${randomUUID()}`, templateId, inputParams: {}, orgId: "org-idem",
      idempotencyKey: key,
    }, AUTH_IDEM);
    const second = await createAgentRun({
      id: `r_${randomUUID()}`, templateId, inputParams: {}, orgId: "org-idem",
      idempotencyKey: key,
    }, AUTH_IDEM);
    expect(second.id).toBe(first.id); // idempotent hit — one run, not a duplicate
    expect(second.idempotencyKey).toBe(key);
  });

  it("rejects a key reuse with mismatched provenance (fail-closed)", async () => {
    const { createAgentRun } = await import("../store");
    // cinatra#2485 C — an agent's install scope is its run authority, so ONE
    // template can never be runnable from two tenants. The cross-tenant
    // key-reuse hazard this test pins is therefore expressed the only way it
    // can now occur in production: each org runs its OWN installed agent, and
    // the same key arrives against both.
    const templateA = await makeTemplate("org-A");
    const templateB = await makeTemplate("org-B");
    const key = `dispatch:${randomUUID()}:1`;
    await createAgentRun({
      id: `r_${randomUUID()}`, templateId: templateA, inputParams: {}, orgId: "org-A",
      idempotencyKey: key,
    }, AUTH_A);
    let thrown: unknown = null;
    try {
      // Same key, DIFFERENT org → provenance mismatch → fail closed.
      await createAgentRun({
        id: `r_${randomUUID()}`, templateId: templateB, inputParams: {}, orgId: "org-B",
        idempotencyKey: key,
      }, AUTH_B);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).not.toBeNull();
    expect((thrown as Error).message).toMatch(/provenance/i);
  });

  it("rejects a key reuse across DIFFERENT templates in the SAME org (template axis, fail-closed)", async () => {
    const { createAgentRun } = await import("../store");
    // The provenance guard is `existing.orgId !== input.orgId || existing.templateId
    // !== input.templateId`. The cross-tenant case above differs on BOTH axes
    // (post-#2485 C one template can never be runnable from two orgs), so it
    // cannot pin either disjunct alone. This case isolates the TEMPLATE axis:
    // same org, same key, two agents. The ORG axis is isolated by the test
    // below.
    const templateOne = await makeTemplate("org-idem");
    const templateTwo = await makeTemplate("org-idem");
    const key = `dispatch:${randomUUID()}:1`;
    await createAgentRun({
      id: `r_${randomUUID()}`, templateId: templateOne, inputParams: {}, orgId: "org-idem",
      idempotencyKey: key,
    }, AUTH_IDEM);
    let thrown: unknown = null;
    try {
      await createAgentRun({
        id: `r_${randomUUID()}`, templateId: templateTwo, inputParams: {}, orgId: "org-idem",
        idempotencyKey: key,
      }, AUTH_IDEM);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).not.toBeNull();
    expect((thrown as Error).message).toMatch(/provenance/i);
  });

  it("rejects a key reuse whose existing row belongs to ANOTHER org under the SAME template (org axis, fail-closed)", async () => {
    const { createAgentRun } = await import("../store");
    // Isolates the `existing.orgId !== input.orgId` disjunct: the colliding row
    // shares the template, so ONLY the org comparison can refuse. #2485 C makes
    // this pair unreachable through two `createAgentRun` calls (the install-scope
    // gate refuses the second before the insert), so the foreign-tenant row is
    // seeded RAW — which is exactly the shape the provenance check is
    // defense-in-depth against: a key colliding with a row from another tenant
    // that the creation perimeter never vetted.
    const templateId = await makeTemplate("org-B");
    const key = `dispatch:${randomUUID()}:1`;
    const c = new Client({ connectionString: dbUrl });
    await c.connect();
    try {
      await c.query(
        `INSERT INTO "${q(SCHEMA)}"."agent_runs" (id, template_id, input_params, org_id, idempotency_key)
         VALUES ($1, $2, '{}', $3, $4)`,
        [`r_${randomUUID()}`, templateId, "org-A", key],
      );
    } finally {
      await c.end();
    }
    let thrown: unknown = null;
    try {
      await createAgentRun({
        id: `r_${randomUUID()}`, templateId, inputParams: {}, orgId: "org-B",
        idempotencyKey: key,
      }, AUTH_B);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).not.toBeNull();
    expect((thrown as Error).message).toMatch(/provenance/i);
  });

  it("distinct keys (a retry) create distinct runs", async () => {
    const { createAgentRun } = await import("../store");
    const templateId = await makeTemplate("org-idem");
    const base = `dispatch:${randomUUID()}`;
    const a1 = await createAgentRun({
      id: `r_${randomUUID()}`, templateId, inputParams: {}, orgId: "org-idem",
      idempotencyKey: `${base}:1`,
    }, AUTH_IDEM);
    const a2 = await createAgentRun({
      id: `r_${randomUUID()}`, templateId, inputParams: {}, orgId: "org-idem",
      idempotencyKey: `${base}:2`,
    }, AUTH_IDEM);
    expect(a2.id).not.toBe(a1.id);
  });

  it("no idempotency key → plain insert, no collision", async () => {
    const { createAgentRun } = await import("../store");
    const templateId = await makeTemplate("org-idem");
    const r1 = await createAgentRun({ id: `r_${randomUUID()}`, templateId, inputParams: {}, orgId: "org-idem" }, AUTH_IDEM);
    const r2 = await createAgentRun({ id: `r_${randomUUID()}`, templateId, inputParams: {}, orgId: "org-idem" }, AUTH_IDEM);
    expect(r1.id).not.toBe(r2.id);
    expect(r1.idempotencyKey).toBeNull();
  });
});
