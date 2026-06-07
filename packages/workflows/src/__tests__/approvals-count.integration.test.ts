// Store-level coverage for countPendingWorkflowApprovalsForOrg — the badge count
// behind the workflow approvals inbox. The query is org-scoped and only counts
// approvals that are pending, NOT invalidated, and have actually been solicited
// (notification_state.solicitedAt set by the reconciler). Each predicate gets a
// negative case so a regression in any one of them is caught.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Client } from "pg";
import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";
import { createWorkflowFromSpec, countPendingWorkflowApprovalsForOrg } from "../store";
import { approvalFixture } from "./fixtures";

const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra";
const ORG = "test-org-apr-count-a";
const ORG2 = "test-org-apr-count-b";

async function pg() {
  const c = new Client({ connectionString: process.env.SUPABASE_DB_URL });
  await c.connect();
  return c;
}

beforeAll(async () => {
  const c = await pg();
  for (const q of buildCreateStoreSchemaQueries(SCHEMA)) await c.query(q.text);
  await c.query(`DROP INDEX IF EXISTS "${SCHEMA}"."workflow_template_key_version_uniq"`);
  await c.end();
}, 60_000);

beforeEach(async () => {
  const c = await pg();
  await c.query(`DELETE FROM "${SCHEMA}"."workflow" WHERE org_id = ANY($1)`, [[ORG, ORG2]]);
  await c.end();
});

// Seeds one approval workflow in `org`, then applies the requested overrides via
// raw SQL (solicitedAt is normally stamped by the reconciler, not at create).
async function seedApproval(
  org: string,
  opts: {
    solicited?: boolean;
    notifiedWithoutSolicit?: boolean;
    status?: string;
    invalidated?: boolean;
  } = {},
): Promise<void> {
  const { workflowId } = await createWorkflowFromSpec({
    spec: approvalFixture,
    name: approvalFixture.name,
    orgId: org,
  });
  const sets: string[] = [];
  const params: unknown[] = [workflowId];
  if (opts.solicited) {
    params.push(JSON.stringify({ solicitedAt: new Date().toISOString() }));
    sets.push(`notification_state = $${params.length}::jsonb`);
  }
  if (opts.notifiedWithoutSolicit) {
    // A non-null notification_state that lacks the solicitedAt key — guards
    // against the query regressing from `->>'solicitedAt' IS NOT NULL` to a
    // blunt `notification_state IS NOT NULL`.
    params.push(JSON.stringify({ deliveredAt: new Date().toISOString() }));
    sets.push(`notification_state = $${params.length}::jsonb`);
  }
  if (opts.status) {
    params.push(opts.status);
    sets.push(`status = $${params.length}`);
  }
  if (opts.invalidated) {
    params.push(new Date().toISOString());
    sets.push(`invalidated_at = $${params.length}::timestamptz`);
  }
  if (sets.length > 0) {
    const c = await pg();
    await c.query(
      `UPDATE "${SCHEMA}"."workflow_approval" SET ${sets.join(", ")} WHERE workflow_id = $1`,
      params,
    );
    await c.end();
  }
}

describe("countPendingWorkflowApprovalsForOrg", () => {
  it("counts a pending, solicited, non-invalidated approval in the org", async () => {
    await seedApproval(ORG, { solicited: true });
    expect(await countPendingWorkflowApprovalsForOrg(ORG)).toBe(1);
  });

  it("excludes a pending approval that has not been solicited yet (null notification_state)", async () => {
    await seedApproval(ORG, { solicited: false });
    expect(await countPendingWorkflowApprovalsForOrg(ORG)).toBe(0);
  });

  it("excludes a pending approval whose notification_state lacks the solicitedAt key", async () => {
    await seedApproval(ORG, { notifiedWithoutSolicit: true });
    expect(await countPendingWorkflowApprovalsForOrg(ORG)).toBe(0);
  });

  it("excludes a solicited approval that is no longer pending", async () => {
    await seedApproval(ORG, { solicited: true, status: "granted" });
    expect(await countPendingWorkflowApprovalsForOrg(ORG)).toBe(0);
  });

  it("excludes a solicited, pending approval that has been invalidated", async () => {
    await seedApproval(ORG, { solicited: true, invalidated: true });
    expect(await countPendingWorkflowApprovalsForOrg(ORG)).toBe(0);
  });

  it("is org-scoped — never counts another org's approvals", async () => {
    await seedApproval(ORG, { solicited: true });
    await seedApproval(ORG2, { solicited: true });
    expect(await countPendingWorkflowApprovalsForOrg(ORG)).toBe(1);
    expect(await countPendingWorkflowApprovalsForOrg(ORG2)).toBe(1);
  });
});
