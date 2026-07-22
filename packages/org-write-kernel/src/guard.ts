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
  const { orgId, capability, authority } = request;
  return db.transaction(async (tx) => {
    await acquireOrgLocks(tx, { orgId, epoch: false });

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
