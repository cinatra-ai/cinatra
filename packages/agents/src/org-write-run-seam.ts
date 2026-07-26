import "server-only";
/**
 * The agent-run org-write seam — cinatra#1939 (archive epic S3, wave 2).
 *
 * ONE front door through which the agent-run status writer acquires its write
 * authority from the org-write kernel. `guardOrgMutation` opens the
 * transaction itself and takes the ORGANIZATION locks before the callback
 * runs, so the CAS + delegated meta write land as ONE guarded transaction with
 * the org-first lock order for free (mirrors the dashboards seam).
 *
 * DARK in this commit (per-writer ratchet, org-write-seam.ts precedent): no
 * production writer calls it yet. `transitionRunStatus` converts onto this seam
 * — together with all 43 callers threading their minted authority — as ONE
 * atomic commit, because the required-authority param would fail-closed every
 * call the instant the writer converts.
 *
 * Fail-closed by construction: no authority, an authority minted for a
 * DIFFERENT organization, or a run/OBO authority bound to a DIFFERENT run than
 * the one being transitioned, refuses before any transaction is opened.
 * Authorities are minted HOST-side only (the src/lib/org-write resolvers); this
 * package never mints.
 */
import {
  guardOrgMutation,
  type OrgWriteAuthority,
  type OrgWriteCapability,
  type OrgWriteDb,
  type OrgWriteTx,
} from "@cinatra-ai/org-write-kernel";
import { orgWriteLeaseSchemaName } from "@/lib/org-write/schema-name";
import { db } from "./db";

export class AgentRunOrgWriteAuthorityError extends Error {
  constructor(public readonly reason: "missing" | "org-mismatch" | "run-mismatch") {
    super(
      reason === "missing"
        ? "agent-run org-write seam: the transition carries no org-write authority — " +
          "every agent-run status write requires one minted host-side (cinatra#1939)."
        : reason === "org-mismatch"
          ? "agent-run org-write seam: the org-write authority was minted for a " +
            "different organization than the run's."
          : "agent-run org-write seam: a run-scoped authority may only transition " +
            "its OWN run, never another run (even in the same organization).",
    );
    this.name = "AgentRunOrgWriteAuthorityError";
  }
}

/** The transaction shape the kernel guard hands back: the drizzle tx the
 *  writer body already uses, seen through the kernel's minimal contract. */
export type GuardedRunTx = OrgWriteTx;

export interface GuardedRunWriteOptions {
  readonly orgId: string;
  readonly runId: string;
  readonly capability: OrgWriteCapability;
  /** TEST-ONLY database override (production always uses the package db). */
  readonly db?: OrgWriteDb<OrgWriteTx>;
}

/**
 * Run one agent-run status write under the kernel guard: org locks → lifecycle
 * ruling for the per-transition capability → permit for exactly this
 * transaction. The callback receives the SAME drizzle transaction the writer
 * body uses.
 *
 * Fail-closed, in order:
 *   - no authority                      → `missing`
 *   - authority.orgId ≠ opts.orgId      → `org-mismatch`
 *   - authority.runId set and ≠ runId   → `run-mismatch` (codex #1: a
 *       VerifiedRunRef / agent-run OBO authority is BOUND to its own run and
 *       may never transition another same-org run; session / system /
 *       run-management authorities carry no runId and are unaffected — they are
 *       gated by `can()` + the caller's upstream authz).
 */
export async function guardedRunWrite<R>(
  authority: OrgWriteAuthority | undefined,
  opts: GuardedRunWriteOptions,
  fn: (tx: GuardedRunTx) => Promise<R>,
): Promise<R> {
  if (!authority) throw new AgentRunOrgWriteAuthorityError("missing");
  if (authority.orgId !== opts.orgId) {
    throw new AgentRunOrgWriteAuthorityError("org-mismatch");
  }
  if (authority.runId !== undefined && authority.runId !== opts.runId) {
    throw new AgentRunOrgWriteAuthorityError("run-mismatch");
  }
  const database = opts.db ?? (db as unknown as OrgWriteDb<OrgWriteTx>);
  return guardOrgMutation(
    database,
    {
      orgId: opts.orgId,
      capability: opts.capability,
      authority,
      schema: orgWriteLeaseSchemaName(),
    },
    (tx) => fn(tx),
  );
}
