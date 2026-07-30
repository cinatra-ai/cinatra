/**
 * cinatra#1943 A2 (manifest row 9) — "pre-archive parent spawning post-archive
 * child denied", the TIMING-RACE variant against the REAL production entry
 * point `createAgentRun`.
 *
 * #1940 P3's own suite (run-creation-guard.test.ts) proves the ALREADY-
 * archived sequential case with a fake kernel: call `createAgentRun` when the
 * org is already archived, get refused. It does not prove the genuine RACE —
 * a child-run creation that STARTS while the org is still active (the parent
 * run already exists and is dispatching a child) but whose guarded INSERT is
 * still blocked on the write lock when the archive commits underneath it.
 *
 * This file closes that gap with the SAME live-Postgres harness
 * (`holdOrgLocks` / real advisory locks, no timing sleeps driving correctness)
 * already proven generically by
 * `src/lib/__tests__/integration/org-write-archive-race.integration.test.ts`'s
 * "two-connection post-check archive race" test (cinatra#1939) — here
 * exercised through the REAL `createAgentRun` writer (capability
 * `run.execute`, ruled "deny" under archived — same simple-deny ruling as
 * `content.write`) instead of a generic `guardOrgMutation` callback, so the
 * actual `agent_runs` INSERT (not just the kernel primitive) is proven to
 * never land a post-archive child row.
 *
 * Runs only under CINATRA_DB_INTEGRATION_TESTS-provisioned CI (packages/agents
 * `agents-integration-db` job — wholesale `*.integration.test.ts` include, no
 * new CI wiring needed); requires SUPABASE_DB_URL like every sibling
 * *.integration.test.ts in this package (trigger-store.integration.test.ts
 * convention — throws a helpful message rather than skipping silently if
 * absent). NOT run on the operator box (no DB there) — CI is the authority.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { Client } from "pg";
import { holdOrgLocks } from "@cinatra-ai/org-write-kernel/testing";
import { createAgentRun, createAgentTemplate } from "../store";
import { db, agentBuilderPool } from "../db";
import { agentRuns, agentTemplates } from "../schema";

const createdRunIds: string[] = [];
const createdTemplateIds: string[] = [];
const createdOrgIds: string[] = [];

async function freshOrg(): Promise<string> {
  const orgId = `org_race_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await db.execute(sql`
    INSERT INTO public."organization" (id, name, slug, "createdAt")
    VALUES (${orgId}, ${"Run Creation Race"}, ${orgId}, now())
  `);
  createdOrgIds.push(orgId);
  return orgId;
}

async function fixtureTemplate(orgId: string): Promise<string> {
  const templateId = `tmpl-${randomUUID()}`;
  await createAgentTemplate({
    id: templateId,
    name: "run-creation-race test fixture",
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

describe("createAgentRun — pre-archive parent spawning post-archive child (cinatra#1943 A2, row 9)", () => {
  beforeAll(async () => {
    if (!process.env.SUPABASE_DB_URL) {
      throw new Error(
        "run-creation-race.integration.test.ts requires SUPABASE_DB_URL — run `cinatra setup branch` first.",
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

  it("a child-run creation blocked behind an in-progress archive LOSES the race: refused, and no child row ever lands", async () => {
    const orgId = await freshOrg();
    const templateId = await fixtureTemplate(orgId);
    const AUTH = { orgId, can: () => true };

    // The parent run exists and is active BEFORE the race begins — the
    // scenario is a real parent dispatching a child, not a bare create call.
    const parent = await createAgentRun(
      { id: `parent-${randomUUID()}`, templateId, inputParams: {}, orgId },
      AUTH,
    );
    createdRunIds.push(parent.id);

    const blocker = new Client({ connectionString: process.env.SUPABASE_DB_URL });
    await blocker.connect();
    const childId = `child-${randomUUID()}`;
    // Teardown safety net (cinatra#1943 A5 fold-in, #2250 review thread): the
    // assertion below expects the child creation to be refused and no row to
    // land, but if a regression ever let it through, this run must still be
    // cleaned up by afterAll rather than orphaned.
    createdRunIds.push(childId);
    try {
      // An in-progress archive holds BOTH lifecycle locks (the harness — real
      // advisory locks, no timing sleep drives the ordering below).
      const hold = await holdOrgLocks(blocker, { orgId, epoch: true });

      // The parent's dispatch of a child run starts while the org is STILL
      // active — the guarded INSERT blocks on the write lock the archive
      // holds, exactly like the two-connection race's generic write.
      let childRan = false;
      const childPromise = createAgentRun(
        { id: childId, templateId, inputParams: {}, orgId, parentRunId: parent.id },
        AUTH,
      ).then((row) => {
        childRan = true;
        return row;
      });

      // Bounded confirmation the child creation is genuinely blocked, not
      // merely slow.
      const raced = await Promise.race([
        childPromise.then(() => "child-settled", () => "child-settled"),
        new Promise<string>((r) => setTimeout(() => r("child-blocked"), 300)),
      ]);
      expect(raced).toBe("child-blocked");

      // The archive commits WITHIN the held transaction — epoch bumped, state
      // flipped, under both locks — then releases.
      await blocker.query(
        `UPDATE public."organization" SET "archivedAt" = now(), "archiveEpoch" = COALESCE("archiveEpoch", 0) + 1 WHERE id = $1`,
        [orgId],
      );
      await hold.release();

      // The child's guarded write now acquires the lock; its locked state
      // re-read sees ARCHIVED (read committed) → run.execute is denied.
      // Deterministic loss — no row landed regardless of when the child's
      // OWN dispatch decision was made.
      await expect(childPromise).rejects.toMatchObject({ reason: "capability-denied" });
      expect(childRan).toBe(false);

      const landed = await db.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.id, childId));
      expect(landed).toHaveLength(0);
    } finally {
      await blocker.end();
    }
  });

  it("positive control: a child run created BEFORE any archive succeeds normally (the guard isn't vacuously refusing everything)", async () => {
    const orgId = await freshOrg();
    const templateId = await fixtureTemplate(orgId);
    const AUTH = { orgId, can: () => true };

    const parent = await createAgentRun(
      { id: `parent-${randomUUID()}`, templateId, inputParams: {}, orgId },
      AUTH,
    );
    createdRunIds.push(parent.id);

    const child = await createAgentRun(
      { id: `child-${randomUUID()}`, templateId, inputParams: {}, orgId, parentRunId: parent.id },
      AUTH,
    );
    createdRunIds.push(child.id);

    expect(child.parentRunId).toBe(parent.id);
    const landed = await db.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.id, child.id));
    expect(landed).toHaveLength(1);
  });
});
