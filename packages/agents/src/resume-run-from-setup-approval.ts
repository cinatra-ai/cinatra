import "server-only";
import { and, eq, type SQL } from "drizzle-orm";
import type {
  OrgWriteAuthority,
  OrgWriteDb,
  OrgWriteTx,
} from "@cinatra-ai/org-write-kernel";
import { db } from "./db";
import { agentRuns } from "./schema";
import { RunTransitionError } from "./run-status";
import {
  guardedRunWrite,
  AgentRunOrgWriteAuthorityError,
} from "./org-write-run-seam";

// ---------------------------------------------------------------------------
// cinatra#1939 wave 2 (§7.1) — the guarded HITL setup-resume writer.
// ---------------------------------------------------------------------------
//
// approveReviewTaskInternal's `setup-{runId}` path used to run its
// compare-and-swap DIRECTLY on the module `db`: merge the approved setup-field
// value(s) into agent_runs.inputParams AND flip pending_approval -> queued in
// ONE statement (#76 single-statement atomicity). That was the last registered-
// surface agent_runs status write that bypassed transitionRunStatus AND the
// org-write kernel (it is inline drizzle, invisible to the boundary gate).
// Owner ruling eng#562 (groganz, 2026-07-26, ruling 1: "now") routes it through
// the SAME guard as transitionRunStatus in wave 2.
//
// pending_approval -> queued is a NON-terminal dispatch edge, so the capability
// is run.execute (never run.complete). The org axis is the authority's org and
// the CAS is ORG-SCOPED (`AND org_id = orgId`), mirroring
// updateAgentRunStatusConditional (§1d): a mismatched-org runId matches 0 rows
// and fails closed as stale_from_status rather than mutating another org's row
// under this org's lock + permit.
//
// `inputParamsMerge` is the SQL fragment the caller already builds (single-field
// or grouped variant — with the no-double-wrap fix, the inputSchema allowlist
// check, and the size limits). It is passed in verbatim so the merge semantics
// are BYTE-IDENTICAL to the pre-guard inline CAS for the member path; `null`
// means "status flip only" (an envelope-only / no-values approval). The
// post-commit re-enqueue (a separate Redis system that must fire only AFTER the
// DB commit) stays in the caller.

/**
 * Run the setup-approval CAS (inputParams merge + pending_approval -> queued)
 * inside the org-write kernel guard on the guarded transaction.
 *
 * @throws {AgentRunOrgWriteAuthorityError} when `authority` is missing / for
 *   another org (the seam fail-closes before any transaction is opened).
 * @throws {OrgWriteRefusedError} when the kernel refuses run.execute (e.g. the
 *   org is archived).
 * @throws {RunTransitionError} code="stale_from_status" when the org-scoped CAS
 *   matches 0 rows (the run left pending_approval, or the runId belongs to
 *   another org) — rolls the guarded transaction back.
 */
export async function resumeRunFromSetupApproval(
  runId: string,
  inputParamsMerge: SQL | null,
  authority: OrgWriteAuthority | undefined,
  opts?: { db?: OrgWriteDb<OrgWriteTx> },
): Promise<void> {
  // Fail-closed, mirroring transitionRunStatus: the org (lock + CAS scope) is
  // the authority's org; a missing authority refuses at the seam before any tx.
  if (!authority) throw new AgentRunOrgWriteAuthorityError("missing");
  const orgId = authority.orgId;
  await guardedRunWrite(
    authority,
    { orgId, runId, capability: "run.execute", db: opts?.db },
    async (guardedTx) => {
      const dtx = guardedTx as unknown as typeof db;
      // ONE atomic CAS (#76): merge the approved value(s) into inputParams (when
      // present) AND flip the status back to "queued", so the re-enqueued run is
      // not skipped. Postgres evaluates the self-referential JSONB merge against
      // the pre-update row, so mixing it with the plain status assignment is safe.
      // The `status = 'pending_approval'` + `org_id = orgId` guards make it
      // compare-and-swap-shaped (mirroring updateAgentRunStatusConditional): a
      // concurrent reject/stop/fail — or a runId in another org — updates 0 rows.
      const casResult = await dtx
        .update(agentRuns)
        .set({
          ...(inputParamsMerge !== null ? { inputParams: inputParamsMerge } : {}),
          status: "queued",
        })
        .where(
          and(
            eq(agentRuns.id, runId),
            eq(agentRuns.status, "pending_approval"),
            eq(agentRuns.orgId, orgId),
          ),
        )
        .returning({ id: agentRuns.id });
      if (casResult.length !== 1) {
        // Rolls back the guarded tx (fail-closed: stale `from` or mismatched
        // org). The caller never enqueues the resume job.
        throw new RunTransitionError({
          code: "stale_from_status",
          runId,
          from: "pending_approval",
          to: "queued",
        });
      }
    },
  );
}
