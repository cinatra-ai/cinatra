/**
 * cinatra#1943 A3 (manifest row 10) — "lease expiry mid-completion →
 * cancel-then-settle" against a REAL Postgres database, closing what the
 * existing #1940 P4 suites cannot: `finalize-expired-lease-run.test.ts` and
 * `lease-expiry-finalizer.test.ts` mock `../db` entirely (a fake
 * `wrapTxWithOrgWriteKernel` recorder — see those files' own headers), so
 * neither can prove the REAL SQL predicates (the org-scoped run lookup, the
 * `expires_at`/`archive_epoch` lease matching) actually behave this way
 * end-to-end, nor exercise a genuine two-connection race against the real
 * production `transitionRunStatus` writer.
 *
 * NAMING NOTE (deviation from the design doc's proposed path, disclosed):
 * DESIGN.md names this file `src/lib/__tests__/integration/
 * lease-expiry-finalizer-adversarial.integration.test.ts`. It lives here
 * instead because `packages/agents/src/schema.ts` binds `agentRuns` to
 * `SUPABASE_SCHEMA` at MODULE IMPORT time, and `finalizeExpiredLeaseRun` /
 * `transitionRunStatus` are packages/agents' own writers — putting this file
 * in packages/agents/src/__tests__/ means it is picked up WHOLESALE by the
 * already-existing `agents-integration-db` CI job (vitest.integration.config.ts's
 * `src/**\/*.integration.test.ts` include — no new CI wiring needed, same
 * "no .github/** edit" bar every other A1-A3 file in this suite holds to),
 * with the schema already bootstrapped by that job's own provisioning steps
 * (`apply-store-schema.mjs`, which includes `orgWriteSchemaQueries` —
 * `org_archive_lease` — via `buildCreateStoreSchemaQueries`). Placing it under
 * src/lib/__tests__/integration/ would have required re-provisioning a schema
 * packages/agents' OWN modules cannot be pointed at dynamically per-test.
 * The manifest's ciDependency is set to `agents-integration-db` to match.
 *
 * Requires SUPABASE_DB_URL, same convention as every sibling
 * *.integration.test.ts in this package (trigger-store.integration.test.ts's
 * "throw a helpful message" convention — not a `describe.skipIf`). NOT run on
 * the operator box (no DB there) — CI is the authority.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { Client } from "pg";
import { holdOrgLocks } from "@cinatra-ai/org-write-kernel/testing";
import type { OrgWriteAuthority } from "@cinatra-ai/org-write-kernel";
import { orgWriteLeaseSchemaName } from "@/lib/org-write/schema-name";
import { createAgentRun, createAgentTemplate, transitionRunStatus } from "../store";
import { finalizeExpiredLeaseRun } from "../run-transition";
import { db, agentBuilderPool } from "../db";
import { agentRuns, agentTemplates } from "../schema";

const schema = orgWriteLeaseSchemaName();
const createdRunIds: string[] = [];
const createdTemplateIds: string[] = [];
const createdOrgIds: string[] = [];

async function freshOrg(): Promise<string> {
  const orgId = `org_lease_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await db.execute(sql`
    INSERT INTO public."organization" (id, name, slug, "createdAt")
    VALUES (${orgId}, ${"Lease Finalizer Adversarial"}, ${orgId}, now())
  `);
  createdOrgIds.push(orgId);
  return orgId;
}

async function archiveOrg(orgId: string, epoch: number): Promise<void> {
  await db.execute(sql`
    UPDATE public."organization" SET "archivedAt" = now(), "archiveEpoch" = ${epoch} WHERE id = ${orgId}
  `);
}

async function fixtureTemplate(orgId: string): Promise<string> {
  const templateId = `tmpl-${randomUUID()}`;
  await createAgentTemplate({
    id: templateId,
    name: "lease-expiry-finalizer-adversarial test fixture",
    sourceNl: "test",
    compiledPlan: [],
    inputSchema: {},
    approvalPolicy: { steps: [] },
    packageName: `@test/${templateId}`,
    orgId,
  });
  createdTemplateIds.push(templateId);
  return templateId;
}

async function insertLease(params: {
  orgId: string;
  archiveEpoch: number;
  runId: string;
  executionAttemptId: string;
  expiresAt: "past" | "future";
}): Promise<void> {
  const interval = params.expiresAt === "past" ? sql`now() - interval '1 minute'` : sql`now() + interval '1 hour'`;
  await db.execute(sql`
    INSERT INTO ${sql.raw(`"${schema}"."org_archive_lease"`)}
      (org_id, archive_epoch, run_id, execution_attempt_id, acquired_at, expires_at)
    VALUES (${params.orgId}, ${params.archiveEpoch}, ${params.runId}, ${params.executionAttemptId}, now(), ${interval})
  `);
}

async function runStatus(runId: string): Promise<string | undefined> {
  const rows = await db.select({ status: agentRuns.status }).from(agentRuns).where(eq(agentRuns.id, runId));
  return rows[0]?.status;
}

async function leaseCount(orgId: string, runId: string): Promise<number> {
  const result = await db.execute(
    sql`SELECT 1 FROM ${sql.raw(`"${schema}"."org_archive_lease"`)} WHERE org_id = ${orgId} AND run_id = ${runId}`,
  );
  return (result.rows ?? []).length;
}

describe("lease-expiry finalizer adversarial (cinatra#1943 A3, row 10) — real Postgres", () => {
  beforeAll(async () => {
    if (!process.env.SUPABASE_DB_URL) {
      throw new Error(
        "lease-expiry-finalizer-adversarial.integration.test.ts requires SUPABASE_DB_URL — run `cinatra setup branch` first.",
      );
    }
  });

  afterAll(async () => {
    for (const id of createdRunIds) {
      try {
        await db.delete(agentRuns).where(eq(agentRuns.id, id));
      } catch {
        // best-effort
      }
    }
    for (const id of createdTemplateIds) {
      try {
        await db.delete(agentTemplates).where(eq(agentTemplates.id, id));
      } catch {
        // best-effort
      }
    }
    for (const id of createdOrgIds) {
      try {
        await db.execute(sql`DELETE FROM public."organization" WHERE id = ${id}`);
      } catch {
        // best-effort
      }
    }
    await agentBuilderPool.end().catch(() => {
      // pool may already be closed by another integration file; ignore
    });
  });

  it("a genuinely expired lease on a non-terminal run settles to a typed FAILURE, never a bare denial — real CAS + real lease DELETE", async () => {
    const orgId = await freshOrg();
    const templateId = await fixtureTemplate(orgId);
    const run = await createAgentRun(
      { id: `run-${randomUUID()}`, templateId, inputParams: {}, orgId },
      { orgId, can: () => true },
    );
    createdRunIds.push(run.id);
    const attemptId = `att-${randomUUID()}`;

    await archiveOrg(orgId, 1);
    await insertLease({ orgId, archiveEpoch: 1, runId: run.id, executionAttemptId: attemptId, expiresAt: "past" });

    const outcome = await finalizeExpiredLeaseRun(orgId, run.id);
    expect(outcome).toMatchObject({ outcome: "settled", mode: "run-and-lease", from: "queued", won: true });

    // Cancel-then-SETTLE, never a bare denial: the run lands a real, typed
    // terminal FAILURE (not left dangling, not an opaque refusal).
    expect(await runStatus(run.id)).toBe("failed");
    expect(await leaseCount(orgId, run.id)).toBe(0);
  });

  it("a concurrent completion attempt racing the finalizer's exclusive settle loses cleanly (lease-required-but-not-held), never a torn double-write", async () => {
    const orgId = await freshOrg();
    const templateId = await fixtureTemplate(orgId);
    const run = await createAgentRun(
      { id: `run-${randomUUID()}`, templateId, inputParams: {}, orgId },
      { orgId, can: () => true },
    );
    createdRunIds.push(run.id);
    const attemptId = `att-${randomUUID()}`;

    // Fixture-only status bump (direct write, not the CAS under test — same
    // convention as unbound-output-outbox.integration.test.ts): the racing
    // completion attempt below transitions running->completed, the ONLY
    // to="completed" edge LEGAL_TRANSITIONS actually contains (queued->completed
    // is not an edge — a run must be dispatched first). Without this, the
    // completion attempt would reject on the pre-guard's illegal_transition
    // check BEFORE ever reaching the org-write lock, never blocking at all.
    await db.update(agentRuns).set({ status: "running" }).where(eq(agentRuns.id, run.id));

    await archiveOrg(orgId, 1);
    // A currently-VALID (unexpired) in-window lease — what the archive
    // snapshot mints for a genuinely in-flight run; the completion attempt's
    // own lease-gated check would otherwise succeed absent the race.
    await insertLease({ orgId, archiveEpoch: 1, runId: run.id, executionAttemptId: attemptId, expiresAt: "future" });

    const runAuthority: OrgWriteAuthority = {
      orgId,
      runId: run.id,
      executionAttemptId: attemptId,
      can: (c) => c === "run.complete",
    };

    const blocker = new Client({ connectionString: process.env.SUPABASE_DB_URL });
    await blocker.connect();
    try {
      // The blocker holds BOTH lifecycle locks — the exact fence
      // `finalizeExpiredLeaseRun` itself acquires via
      // `guardOrgLifecycleMutation` — standing in for "the finalizer's
      // settle is in flight" (same harness convention as the sibling
      // delete-vs-completion race in org-write-archive-race.integration.test.ts).
      const hold = await holdOrgLocks(blocker, { orgId, epoch: true });

      // The real production completion path. It BLOCKS on the write lock
      // the fence holds and cannot even reach its own locked state read.
      let completed = false;
      const completePromise = transitionRunStatus(run.id, "running", "completed", undefined, runAuthority).then(
        (r) => {
          completed = true;
          return r;
        },
      );
      const raced = await Promise.race([
        completePromise.then(() => "settled", () => "settled"),
        new Promise<string>((r) => setTimeout(() => r("blocked"), 300)),
      ]);
      expect(raced).toBe("blocked");

      // WITHIN the held fence, do exactly what `finalizeExpiredLeaseRun`'s
      // own guarded settle does: CAS the run to `failed` and delete its
      // lease, atomically, then release — the real function's own SQL
      // shape is separately proven by the sibling test above; this proves
      // the CONCURRENT completion attempt's behavior against an equivalent
      // committed settle.
      await blocker.query(`UPDATE "${schema}".agent_runs SET status = 'failed' WHERE id = $1`, [run.id]);
      await blocker.query(
        `DELETE FROM "${schema}".org_archive_lease WHERE org_id = $1 AND run_id = $2 AND execution_attempt_id = $3`,
        [orgId, run.id, attemptId],
      );
      await hold.release();

      // The completion attempt now acquires the lock; its own in-tx
      // lease-gated re-check finds the lease GENUINELY GONE (the finalizer's
      // settle consumed it) — a clean, typed refusal reflecting reality,
      // never a hang and never a torn "completed" landing on a run the
      // finalizer already failed.
      await expect(completePromise).rejects.toMatchObject({
        name: "OrgWriteRefusedError",
        reason: "lease-required-but-not-held",
      });
      expect(completed).toBe(false);
      expect(await runStatus(run.id)).toBe("failed");
    } finally {
      await blocker.end();
    }
  });

  it("a forged/stale org id planted directly in the lease table is refused a wrongful settle — the fence's org-scoped in-tx re-read, not the sweep's payload, grounds the decision (Decision 2 item 5)", async () => {
    const realOrgId = await freshOrg();
    const forgedOrgId = await freshOrg(); // a real, separate, unrelated org — the "forged" context
    const templateId = await fixtureTemplate(realOrgId);
    const run = await createAgentRun(
      { id: `run-${randomUUID()}`, templateId, inputParams: {}, orgId: realOrgId },
      { orgId: realOrgId, can: () => true },
    );
    createdRunIds.push(run.id);
    const attemptId = `att-${randomUUID()}`;

    // Both orgs archived (the fence's own ruling requires it); the lease row
    // is planted DIRECTLY under the FORGED org id, bypassing the normal
    // snapshot path entirely (the snapshot only ever mints under a run's own
    // real org) — simulating a forged/stale sweep row.
    await archiveOrg(realOrgId, 1);
    await archiveOrg(forgedOrgId, 1);
    await insertLease({
      orgId: forgedOrgId,
      archiveEpoch: 1,
      runId: run.id,
      executionAttemptId: attemptId,
      expiresAt: "past",
    });

    // The sweep would read `row.org_id = forgedOrgId` and pass it straight
    // through — exactly this call.
    const outcome = await finalizeExpiredLeaseRun(forgedOrgId, run.id);

    // The fence's OWN org-scoped run lookup (WHERE id = runId AND org_id =
    // forgedOrgId) finds NOTHING — the run's real org differs — so this is
    // indistinguishable, from inside the fence, from "the run is gone":
    // settle-orphan, lease-only. The forged lease row (itself illegitimate)
    // is cleaned up; the run's REAL status is untouched.
    expect(outcome).toEqual({ outcome: "settled", mode: "lease-only" });
    expect(await leaseCount(forgedOrgId, run.id)).toBe(0);

    // The run — read under its ACTUAL org — never moved. A forged org id in
    // the lease row cannot force-fail a real run outside the fenced org.
    expect(await runStatus(run.id)).toBe("queued");
  });
});
