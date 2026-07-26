/**
 * cinatra#1939 wave 2 (§7.1) — the guarded HITL setup-resume writer.
 *
 * resumeRunFromSetupApproval runs the setup-{runId} approval CAS (inputParams
 * merge + pending_approval->queued) INSIDE the org-write kernel guard. These
 * tests pin the guarded-CAS semantics with the kernel test fakes injected via
 * the seam's TEST-ONLY `db` option (no module mock, no live Postgres):
 *   - a missing authority refuses at the seam before any CAS;
 *   - a member/active-org call flips the status AND merges inputParams on the
 *     guarded tx, with the CAS WHERE org-scoped (status + id + org_id);
 *   - a null merge is a status-flip-only write (no inputParams key);
 *   - a 0-row CAS (stale pending_approval OR a runId in another org) throws
 *     stale_from_status and writes nothing else;
 *   - an archived org refuses run.execute (capability-denied).
 */
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import {
  wrapTxWithOrgWriteKernel,
  type KernelQueryAnswers,
} from "@cinatra-ai/org-write-kernel/testing";
import type { OrgWriteDb, OrgWriteTx } from "@cinatra-ai/org-write-kernel";
import { resumeRunFromSetupApproval } from "../resume-run-from-setup-approval";

const ORG = "org-1";
const RUN = "run-1";
// A member session authority: grants every capability, carries no runId.
const SESSION = { orgId: ORG, can: () => true };

type Recorded = {
  setPayloads: Array<Record<string, unknown>>;
  whereConds: unknown[];
  updateCalls: number;
  /** Queue of CAS `.returning()` results; empty → a 1-row win ([{ id }]). */
  returningRows: Array<Array<{ id: string }>>;
};

/** A guarded fake db: the kernel's own queries answer from `answers`, the
 *  writer's CAS records its .set()/.where() and answers .returning() from the
 *  queue. Mirrors the transition-run-status harness, injected via the db option. */
function guardedFakeDb(answers: KernelQueryAnswers): {
  db: OrgWriteDb<OrgWriteTx>;
  rec: Recorded;
} {
  const rec: Recorded = { setPayloads: [], whereConds: [], updateCalls: 0, returningRows: [] };
  const update = () => {
    rec.updateCalls += 1;
    return {
      set: (payload: Record<string, unknown>) => {
        rec.setPayloads.push(payload);
        return {
          where: (cond: unknown) => {
            rec.whereConds.push(cond);
            return {
              returning: async () =>
                rec.returningRows.length > 0 ? rec.returningRows.shift()! : [{ id: RUN }],
            };
          },
        };
      },
    };
  };
  const tx = wrapTxWithOrgWriteKernel({ update, execute: async () => ({ rows: [] }) }, answers);
  const db = {
    transaction: async <R>(fn: (t: typeof tx) => Promise<R>): Promise<R> => fn(tx),
  } as unknown as OrgWriteDb<OrgWriteTx>;
  return { db, rec };
}

function activeDb() {
  return guardedFakeDb({ organization: { archivedAt: null, archiveEpoch: 0 } });
}

/** Circular-safe stringify for inspecting a drizzle SQL condition/merge tree. */
function sqlToString(node: unknown): string {
  const seen = new Set<object>();
  return (
    JSON.stringify(node, (_k, v) => {
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[circular]";
        seen.add(v);
      }
      return v;
    }) ?? ""
  );
}

describe("resumeRunFromSetupApproval — guarded setup-resume CAS (#1939 §7.1)", () => {
  it("refuses AgentRunOrgWriteAuthorityError('missing') with no authority; no CAS runs", async () => {
    const { db, rec } = activeDb();
    await expect(
      resumeRunFromSetupApproval(RUN, null, undefined, { db }),
    ).rejects.toMatchObject({ name: "AgentRunOrgWriteAuthorityError", reason: "missing" });
    expect(rec.updateCalls).toBe(0);
  });

  it("member/active org: flips pending_approval->queued and merges inputParams on the guarded tx", async () => {
    const { db, rec } = activeDb();
    const merge = sql`COALESCE('{}'::jsonb, '{}'::jsonb) || '{"name":"Alice"}'::jsonb`;
    await resumeRunFromSetupApproval(RUN, merge, SESSION, { db });
    expect(rec.updateCalls).toBe(1);
    expect(rec.setPayloads).toHaveLength(1);
    expect(rec.setPayloads[0].status).toBe("queued");
    expect(rec.setPayloads[0].inputParams).toBe(merge);
  });

  it("null merge: status-flip-only write, no inputParams key in the CAS payload", async () => {
    const { db, rec } = activeDb();
    await resumeRunFromSetupApproval(RUN, null, SESSION, { db });
    expect(rec.setPayloads).toHaveLength(1);
    expect(rec.setPayloads[0].status).toBe("queued");
    expect("inputParams" in rec.setPayloads[0]).toBe(false);
  });

  it("the CAS WHERE is ORG-SCOPED: pins id, status = 'pending_approval', AND org_id", async () => {
    const { db, rec } = activeDb();
    await resumeRunFromSetupApproval(RUN, null, SESSION, { db });
    expect(rec.whereConds).toHaveLength(1);
    const where = sqlToString(rec.whereConds[0]);
    // The org column is the wave-2 security add — a mismatched-org runId matches
    // 0 rows instead of mutating another org's row under this org's lock.
    expect(where).toContain("org_id");
    expect(where).toContain("status");
    expect(where).toContain("pending_approval");
  });

  it("stale pending_approval (0-row CAS): throws stale_from_status, writes nothing else", async () => {
    const { db, rec } = activeDb();
    rec.returningRows = [[]]; // the CAS matched 0 rows (concurrent reject/stop/fail)
    await expect(
      resumeRunFromSetupApproval(RUN, null, SESSION, { db }),
    ).rejects.toMatchObject({ name: "RunTransitionError", code: "stale_from_status" });
  });

  it("org-scope fail-closed (0-row for a runId in another org): stale_from_status", async () => {
    // The org-scoped CAS (AND org_id = authority.orgId) matches 0 rows when the
    // runId belongs to a different org — fail-closed, same as a stale status.
    const { db, rec } = activeDb();
    rec.returningRows = [[]];
    await expect(
      resumeRunFromSetupApproval(RUN, null, SESSION, { db }),
    ).rejects.toMatchObject({ name: "RunTransitionError", code: "stale_from_status" });
  });

  it("archived org: refuses run.execute (capability-denied) before any CAS", async () => {
    const { db, rec } = guardedFakeDb({
      organization: { archivedAt: "2026-07-01T00:00:00Z", archiveEpoch: 1 },
    });
    await expect(
      resumeRunFromSetupApproval(RUN, null, SESSION, { db }),
    ).rejects.toMatchObject({ name: "OrgWriteRefusedError", reason: "capability-denied" });
    expect(rec.updateCalls).toBe(0);
  });
});
