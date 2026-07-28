/**
 * guardOrgMutation — cinatra#1938 (archive epic S2).
 *
 * The one callback-scoped gate every org-scoped drizzle-world write flows
 * through: locks (write-only — this entry point deliberately has NO way to add
 * the epoch lock later; epoch transitions and ticket redemption are separate
 * entry points that take epoch→write up front) → locked org-state read →
 * authority binding (actor authorization is checked INDEPENDENTLY of the
 * lifecycle table — both must pass) → capability ruling → fail-closed lease
 * check for "lease-gated" → permit minted for exactly this transaction and
 * revoked in `finally` when the callback exits.
 *
 * `guardOrgLifecycleMutation` (cinatra#1939 wave 3) is the SECOND callback-
 * scoped entry point: byte-identical contract, but it acquires BOTH org locks
 * in the global epoch→write order up front (`redeemCompletionTicket`
 * precedent). It is the EXCLUSIVE org fence the archive epic demands for
 * organization delete — no epoch transition, no ticket redemption, and no
 * write-only guarded write can interleave with a lifecycle mutation running
 * under it. S6's real archive transaction is the second consumer of this same
 * entry point (designed once here, reused there). The two entry points stay
 * distinct public functions; a caller can never upgrade the write-only guard
 * into the epoch fence, only pick the entry point up front.
 */
import {
  lifecycleStateOf,
  ruleFor,
  type OrgWriteCapability,
} from "./capabilities";
import { acquireOrgLocks, type OrgWriteDb, type OrgWriteTx } from "./locks";
import { readOrgWriteState, rowsOf } from "./org-state";
import { leaseHeldStatement } from "./leases";
import { mintPermit, revokePermit, type OrgWritePermit } from "./permit";

/** Minted host-side by the org-write resolvers (session / verified-run / OBO /
 *  system purpose); the kernel checks it INDEPENDENTLY of the lifecycle table. */
export interface OrgWriteAuthority {
  readonly orgId: string;
  can(capability: OrgWriteCapability): boolean;
  /** Present on run authorities; required whenever a ruling is lease-gated. */
  readonly runId?: string;
  readonly executionAttemptId?: string;
}

export type OrgWriteRefusalReason =
  | "organization-not-found"
  | "authority-org-mismatch"
  | "authority-lacks-capability"
  | "capability-denied"
  | "lease-required-but-not-held"
  | "not-a-guarded-batch"
  | "ticket-invalid";

export class OrgWriteRefusedError extends Error {
  constructor(
    public readonly reason: OrgWriteRefusalReason,
    detail?: string,
  ) {
    super(
      `org-write-kernel: refused (${reason})${detail ? ` — ${detail}` : ""}`,
    );
    this.name = "OrgWriteRefusedError";
  }
}

export interface GuardOrgMutationRequest {
  readonly orgId: string;
  readonly capability: OrgWriteCapability;
  readonly authority: OrgWriteAuthority;
  /** App schema holding the lease table; required to evaluate "lease-gated"
   *  rulings (the kernel cannot import host config). */
  readonly schema?: string;
}

export async function guardOrgMutation<TTx extends OrgWriteTx, R>(
  db: OrgWriteDb<TTx>,
  request: GuardOrgMutationRequest,
  fn: (tx: TTx, permit: OrgWritePermit) => Promise<R>,
): Promise<R> {
  return guardWithLocks(db, request, false, fn);
}

/**
 * The lifecycle (epoch→write, BOTH locks) entry point — cinatra#1939 wave 3.
 *
 * Identical contract to `guardOrgMutation`, but `acquireOrgLocks({ epoch:
 * true })` takes the archive-epoch lock BEFORE the write lock in the global
 * order (`redeemCompletionTicket` precedent). Use it for organization delete
 * (and, from S6, the archive/unarchive transition) — the exclusive fence that
 * excludes every write-only guarded write AND every ticket redemption for the
 * whole transaction.
 */
export async function guardOrgLifecycleMutation<TTx extends OrgWriteTx, R>(
  db: OrgWriteDb<TTx>,
  request: GuardOrgMutationRequest,
  fn: (tx: TTx, permit: OrgWritePermit) => Promise<R>,
): Promise<R> {
  return guardWithLocks(db, request, true, fn);
}

/** Shared guard body for both entry points; `epoch` fixes the lock set (the
 *  ONLY difference between them) and is passed literally by each public
 *  wrapper — never threaded from a caller, so neither entry point can be
 *  upgraded into the other. */
async function guardWithLocks<TTx extends OrgWriteTx, R>(
  db: OrgWriteDb<TTx>,
  request: GuardOrgMutationRequest,
  epoch: boolean,
  fn: (tx: TTx, permit: OrgWritePermit) => Promise<R>,
): Promise<R> {
  const { orgId, capability, authority } = request;
  return db.transaction(async (tx) => {
    await acquireOrgLocks(tx, { orgId, epoch });

    const state = await readOrgWriteState(tx, orgId);
    if (state === null) {
      throw new OrgWriteRefusedError("organization-not-found", orgId);
    }

    if (authority.orgId !== orgId) {
      throw new OrgWriteRefusedError("authority-org-mismatch");
    }
    if (!authority.can(capability)) {
      throw new OrgWriteRefusedError("authority-lacks-capability", capability);
    }

    const ruling = ruleFor(lifecycleStateOf(state), capability);
    if (ruling === "deny") {
      throw new OrgWriteRefusedError(
        "capability-denied",
        `${capability} while ${lifecycleStateOf(state)}`,
      );
    }
    if (ruling === "lease-gated") {
      await assertLeaseHeld(tx, request, state.archiveEpoch);
    }

    const permit = mintPermit({
      txIdentity: tx,
      orgId,
      capability,
      archiveEpoch: state.archiveEpoch,
    });
    try {
      return await fn(tx, permit);
    } finally {
      revokePermit(permit);
    }
  });
}

/** Fail-closed: no schema, no run identity, no matching unexpired lease row —
 *  each refuses. Evaluated inside the SAME transaction as the write. */
async function assertLeaseHeld(
  tx: OrgWriteTx,
  request: GuardOrgMutationRequest,
  archiveEpoch: number,
): Promise<void> {
  const { authority, schema, orgId } = request;
  if (
    schema === undefined ||
    authority.runId === undefined ||
    authority.executionAttemptId === undefined
  ) {
    throw new OrgWriteRefusedError(
      "lease-required-but-not-held",
      "lease-gated ruling without schema/run identity",
    );
  }
  const result = await tx.execute(
    leaseHeldStatement({
      schema,
      orgId,
      archiveEpoch,
      runId: authority.runId,
      executionAttemptId: authority.executionAttemptId,
    }),
  );
  if (rowsOf(result).length === 0) {
    throw new OrgWriteRefusedError(
      "lease-required-but-not-held",
      "no unexpired lease for this run/attempt/epoch",
    );
  }
}
