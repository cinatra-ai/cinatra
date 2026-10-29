import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { OrgWriteAuthority, OrgWriteDb, OrgWriteTx } from "@cinatra-ai/org-write-kernel";
import { db } from "./db";
import { agentRuns } from "./schema";
import { guardedRunWrite } from "./org-write-run-seam";
import { PAUSE_CLAIM_LEASE_SECONDS, PAUSE_SEND_LEASE_SECONDS } from "./run-status";

// ---------------------------------------------------------------------------
// THE PAUSE CLAIM (cinatra#4245): one generation-stamped lease per pause.
// ---------------------------------------------------------------------------
//
// A run paused at `pending_approval` can be resumed by several roads (the MCP
// resume, the review page's Continue, the resume delivery worker), stopped, or
// ended by a change request. They must exclude each other on ONE pause, and a
// resume must never act on a later pause than the one it read. Every one of
// them serializes on the run row: the columns of core__0116 hold the pause's
// generation (`pause_generation`, raised on every entry into
// `pending_approval` and at every fence) and its holder (`pause_claim_token`,
// `pause_claim_phase` `claimed` | `sending` | `changes_requested`,
// `pause_claim_expires_at`, compared with the database clock).
//
// This module writes only those non-status columns, each in one guarded
// statement. The status edges and their claim rules are in the status seam
// (run-transition.ts, rules 1-5). The order every claimer follows:
//   1. read the run (status, generation, the pause's task);
//   2. claimPause at the generation read; a refusal answers the caller;
//   3. the pre-send bookkeeping; on any failure, releasePauseClaim, then
//      rethrow (or throw PauseClaimReleaseError when the release fails);
//   4. the fence: the status seam's `pauseFence` (`pending_approval → running`)
//      or fencePauseInPlace (the delivery worker, whose run stays
//      `pending_approval`); a lost fence sends nothing;
//   5. the send; 6. its handling; 7. settlePauseSend in a `finally`.
//
// Recovery of a dead claimer is lazy: an expired `claimed` or `sending` lease
// is free to the next claimer, which takes it over in the same single UPDATE
// that claims it. Two takers race on the row lock, and the loser's WHERE is
// re-checked on the new row version (READ COMMITTED), so exactly one wins. No
// sweeper is needed. The change request's end mark (`changes_requested`) never
// expires: only a status change clears it.
//
// A database error is never an answer: every function here throws it.

export { PAUSE_CLAIM_LEASE_SECONDS, PAUSE_SEND_LEASE_SECONDS };

/** One pause: the run and the generation its claimer read. */
export type PauseRef = { readonly runId: string; readonly orgId: string; readonly generation: number };

export type PauseClaimRefusalReason =
  /** The run is not `pending_approval` (or there is no such run in this org). */
  | "not-pending"
  /** `pending_approval`, but at another generation than the one read. */
  | "moved-on"
  /** A live `claimed` or `sending` lease of another claimer. */
  | "held"
  /** The pause ended by a change request (the end mark). */
  | "changes-requested";

export type PauseClaim =
  | { readonly kind: "claimed"; readonly token: string; readonly generation: number; readonly expiresAt: Date }
  | {
      readonly kind: "refused";
      readonly reason: PauseClaimRefusalReason;
      /** The status read after the refusal; "absent" when no row matched. */
      readonly status: string;
      /** The generation read after the refusal; null when no row matched. */
      readonly generation: number | null;
    };

export type PauseClaimWriteOptions = {
  /** TEST-ONLY database override (production always uses the package db). */
  readonly db?: OrgWriteDb<OrgWriteTx>;
  /** TEST-ONLY token override (production mints a fresh randomUUID()). */
  readonly token?: string;
};

function assertPauseRef(ref: PauseRef): void {
  if (!Number.isSafeInteger(ref.generation) || ref.generation < 0) {
    throw new Error(`run-pause-claim: malformed generation for run ${ref.runId}`);
  }
}

function assertToken(runId: string, token: string): void {
  if (typeof token !== "string" || token.length === 0) {
    throw new Error(`run-pause-claim: empty claim token for run ${runId}`);
  }
}

const leaseFromNow = (seconds: number) => sql`now() + make_interval(secs => ${sql.raw(String(seconds))})`;

/** A lease that no claimer holds any more: no claim, or an expired one. The end
 *  mark (`changes_requested`, no expiry) is never free. */
const pauseIsFree = sql`(${agentRuns.pauseClaimToken} IS NULL OR (${agentRuns.pauseClaimPhase} IN ('claimed', 'sending') AND ${agentRuns.pauseClaimExpiresAt} <= now()))`;

/**
 * Claim the pause at the generation the caller read, for PAUSE_CLAIM_LEASE_SECONDS.
 *
 * One statement. It succeeds only while the run is `pending_approval` at that
 * generation and no live claim holds it; an expired lease is taken over. On a
 * refusal the row is read once, in the same transaction, to name the reason.
 * Nothing returns `claimed` unless the UPDATE returned its row.
 */
export async function claimPause(
  ref: PauseRef,
  authority: OrgWriteAuthority | undefined,
  opts?: PauseClaimWriteOptions,
): Promise<PauseClaim> {
  assertPauseRef(ref);
  const token = opts?.token ?? randomUUID();
  assertToken(ref.runId, token);
  return guardedRunWrite(
    authority,
    { orgId: ref.orgId, runId: ref.runId, capability: "run.execute", db: opts?.db },
    async (tx): Promise<PauseClaim> => {
      const dtx = tx as unknown as typeof db;
      const won = await dtx
        .update(agentRuns)
        .set({
          pauseClaimToken: token,
          pauseClaimPhase: "claimed",
          pauseClaimExpiresAt: leaseFromNow(PAUSE_CLAIM_LEASE_SECONDS),
        })
        .where(
          and(
            eq(agentRuns.id, ref.runId),
            eq(agentRuns.orgId, ref.orgId),
            eq(agentRuns.status, "pending_approval"),
            eq(agentRuns.pauseGeneration, ref.generation),
            pauseIsFree,
          ),
        )
        .returning({ expiresAt: agentRuns.pauseClaimExpiresAt });
      const expiresAt = won[0]?.expiresAt;
      if (won.length === 1 && expiresAt instanceof Date) {
        return { kind: "claimed", token, generation: ref.generation, expiresAt };
      }
      if (won.length !== 0) {
        // One row by primary key, or none; anything else is not a claim.
        throw new Error(`run-pause-claim: claimPause read an unexpected result for run ${ref.runId}`);
      }
      const rows = await dtx
        .select({
          status: agentRuns.status,
          generation: agentRuns.pauseGeneration,
          phase: agentRuns.pauseClaimPhase,
        })
        .from(agentRuns)
        .where(and(eq(agentRuns.id, ref.runId), eq(agentRuns.orgId, ref.orgId)))
        .limit(1);
      const row = rows[0];
      if (!row) return { kind: "refused", reason: "not-pending", status: "absent", generation: null };
      const generation = typeof row.generation === "number" ? row.generation : Number(row.generation);
      const reason: PauseClaimRefusalReason =
        row.status !== "pending_approval"
          ? "not-pending"
          : generation !== ref.generation
            ? "moved-on"
            : row.phase === "changes_requested"
              ? "changes-requested"
              : "held";
      return { kind: "refused", reason, status: row.status, generation: Number.isSafeInteger(generation) ? generation : null };
    },
  );
}

/**
 * The delivery worker's fence: its run stays `pending_approval` while it sends,
 * so the fence is in place. Under the live `claimed` lease of this token at this
 * generation it sets the phase `sending`, raises the generation by 1 and sets
 * the send lease; the token stays. `lost` when the lease is gone (expired and
 * taken, cleared by a status change, or never held).
 */
export async function fencePauseInPlace(
  ref: PauseRef & { readonly token: string },
  authority: OrgWriteAuthority | undefined,
  opts?: Pick<PauseClaimWriteOptions, "db">,
): Promise<"fenced" | "lost"> {
  assertPauseRef(ref);
  assertToken(ref.runId, ref.token);
  return guardedRunWrite(
    authority,
    { orgId: ref.orgId, runId: ref.runId, capability: "run.execute", db: opts?.db },
    async (tx) => {
      const dtx = tx as unknown as typeof db;
      const rows = await dtx
        .update(agentRuns)
        .set({
          pauseClaimPhase: "sending",
          pauseGeneration: sql`${agentRuns.pauseGeneration} + 1`,
          pauseClaimExpiresAt: leaseFromNow(PAUSE_SEND_LEASE_SECONDS),
        })
        .where(
          and(
            eq(agentRuns.id, ref.runId),
            eq(agentRuns.orgId, ref.orgId),
            eq(agentRuns.status, "pending_approval"),
            eq(agentRuns.pauseClaimToken, ref.token),
            eq(agentRuns.pauseClaimPhase, "claimed"),
            eq(agentRuns.pauseGeneration, ref.generation),
            sql`${agentRuns.pauseClaimExpiresAt} > now()`,
          ),
        )
        .returning({ id: agentRuns.id });
      return rows.length === 1 ? "fenced" : "lost";
    },
  );
}

/** Clear this token's lease in one phase. No status edge, so no wait notice is
 *  re-sent and no produced-review park is touched. */
async function clearOwnLease(
  ref: { readonly runId: string; readonly orgId: string; readonly token: string },
  phase: "claimed" | "sending",
  authority: OrgWriteAuthority | undefined,
  opts: Pick<PauseClaimWriteOptions, "db"> | undefined,
): Promise<boolean> {
  assertToken(ref.runId, ref.token);
  return guardedRunWrite(
    authority,
    { orgId: ref.orgId, runId: ref.runId, capability: "run.execute", db: opts?.db },
    async (tx) => {
      const dtx = tx as unknown as typeof db;
      const rows = await dtx
        .update(agentRuns)
        .set({ pauseClaimToken: null, pauseClaimPhase: null, pauseClaimExpiresAt: null })
        .where(
          and(
            eq(agentRuns.id, ref.runId),
            eq(agentRuns.orgId, ref.orgId),
            eq(agentRuns.pauseClaimToken, ref.token),
            eq(agentRuns.pauseClaimPhase, phase),
          ),
        )
        .returning({ id: agentRuns.id });
      return rows.length === 1;
    },
  );
}

/**
 * Give back a `claimed` lease before its fence (a pre-send step failed).
 * `released` when this token still held it; `lost` when it did not (the lease
 * expired and was taken, or a status change cleared it). A database error throws.
 */
export async function releasePauseClaim(
  ref: { readonly runId: string; readonly orgId: string; readonly token: string },
  authority: OrgWriteAuthority | undefined,
  opts?: Pick<PauseClaimWriteOptions, "db">,
): Promise<"released" | "lost"> {
  return (await clearOwnLease(ref, "claimed", authority, opts)) ? "released" : "lost";
}

/**
 * End a `sending` lease after the blocking send returned or threw.
 * `already-cleared` is the normal answer when the send's own handling already
 * moved the status (a status change clears the claim). A database error throws.
 */
export async function settlePauseSend(
  ref: { readonly runId: string; readonly orgId: string; readonly token: string },
  authority: OrgWriteAuthority | undefined,
  opts?: Pick<PauseClaimWriteOptions, "db">,
): Promise<"settled" | "already-cleared"> {
  return (await clearOwnLease(ref, "sending", authority, opts)) ? "settled" : "already-cleared";
}

/**
 * A pre-send step failed AND the claim could not be given back. Both errors are
 * kept; the lease frees itself at `expiresAt`. A caller surfaces this error; a
 * log line is never its only effect.
 */
export class PauseClaimReleaseError extends Error {
  /** The pre-send step's own failure. */
  readonly stepError: unknown;
  /** The failure of releasePauseClaim. */
  readonly releaseError: unknown;
  /** When the lease frees itself (the database clock's expiry). */
  readonly expiresAt: Date;

  constructor(args: { stepError: unknown; releaseError: unknown; expiresAt: Date }) {
    const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));
    super(
      `the step before the send failed (${describe(args.stepError)}), and the claim on this pause could not be given back ` +
        `(${describe(args.releaseError)}); it frees itself at ${args.expiresAt.toISOString()}`,
    );
    this.name = "PauseClaimReleaseError";
    this.stepError = args.stepError;
    this.releaseError = args.releaseError;
    this.expiresAt = args.expiresAt;
  }
}
