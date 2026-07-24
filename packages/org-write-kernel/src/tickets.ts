/**
 * Completion tickets — cinatra#1938 (archive epic S2).
 *
 * A ticket is a single-use, expiring, epoch-bound authorization to land one
 * run output after its organization archived. Tickets are ROWS (atomic
 * consume + replay control + audit), unique on idempotency_key:
 *   - same idempotencyKey + same outputRef  → idempotent no-op success;
 *   - same idempotencyKey + different output → refuse (never overwrite);
 *   - expired, or archive_epoch ≠ the org's current epoch → refuse
 *     (unarchive/re-archive invalidates every outstanding ticket).
 *
 * `redeemCompletionTicket` is the SEPARATE kernel entry point for the redeem
 * path: it acquires epoch→write (BOTH locks, global order) BEFORE its
 * callback — guardOrgMutation deliberately cannot be upgraded into this.
 */
import { sql } from "drizzle-orm";
import { acquireOrgLocks, type OrgWriteDb, type OrgWriteTx } from "./locks";
import { readOrgWriteState, rowsOf, assertSafeSchemaName } from "./org-state";
import { OrgWriteRefusedError, type OrgWriteAuthority } from "./guard";
import { mintPermit, revokePermit, type OrgWritePermit } from "./permit";

export const ORG_WRITE_COMPLETION_TICKET_TABLE = "org_write_completion_ticket";

export interface RedeemTicketRequest {
  readonly schema: string;
  readonly orgId: string;
  readonly authority: OrgWriteAuthority;
  readonly idempotencyKey: string;
  readonly outputRef: string;
}

export type RedeemOutcome<R> =
  | { alreadyApplied: true }
  | { alreadyApplied: false; result: R };

export async function redeemCompletionTicket<TTx extends OrgWriteTx, R>(
  db: OrgWriteDb<TTx>,
  request: RedeemTicketRequest,
  fn: (tx: TTx, permit: OrgWritePermit) => Promise<R>,
): Promise<RedeemOutcome<R>> {
  const { schema, orgId, authority, idempotencyKey, outputRef } = request;
  assertSafeSchemaName(schema);
  if (authority.orgId !== orgId) {
    throw new OrgWriteRefusedError("authority-org-mismatch");
  }
  if (!authority.can("run.complete")) {
    throw new OrgWriteRefusedError("authority-lacks-capability", "run.complete");
  }

  return db.transaction(async (tx) => {
    await acquireOrgLocks(tx, { orgId, epoch: true });

    const state = await readOrgWriteState(tx, orgId);
    if (state === null) {
      throw new OrgWriteRefusedError("organization-not-found", orgId);
    }

    const ticketRows = rowsOf(
      await tx.execute(
        sql`SELECT archive_epoch, run_id, execution_attempt_id, output_ref, consumed_at, (expires_at IS NULL OR expires_at > now()) AS unexpired FROM ${sql.raw(`"${schema}"."${ORG_WRITE_COMPLETION_TICKET_TABLE}"`)} WHERE org_id = ${orgId} AND idempotency_key = ${idempotencyKey} FOR UPDATE`,
      ),
    );
    if (ticketRows.length !== 1) {
      throw new OrgWriteRefusedError("ticket-invalid", "no such ticket");
    }
    const ticket = ticketRows[0];

    if (Number(ticket.archive_epoch) !== state.archiveEpoch) {
      throw new OrgWriteRefusedError("ticket-invalid", "archive epoch changed");
    }
    if (ticket.unexpired !== true) {
      // DB clock rules (consistent with the lease expiry checks).
      throw new OrgWriteRefusedError("ticket-invalid", "expired");
    }
    if (
      authority.runId !== ticket.run_id ||
      authority.executionAttemptId !== ticket.execution_attempt_id
    ) {
      throw new OrgWriteRefusedError("ticket-invalid", "run identity mismatch");
    }
    if (ticket.consumed_at !== null) {
      if (ticket.output_ref === outputRef) {
        return { alreadyApplied: true } as RedeemOutcome<R>;
      }
      throw new OrgWriteRefusedError(
        "ticket-invalid",
        "idempotency key replayed with a different output",
      );
    }
    if (ticket.output_ref !== outputRef) {
      throw new OrgWriteRefusedError("ticket-invalid", "output mismatch");
    }

    await tx.execute(
      sql`UPDATE ${sql.raw(`"${schema}"."${ORG_WRITE_COMPLETION_TICKET_TABLE}"`)} SET consumed_at = now() WHERE org_id = ${orgId} AND idempotency_key = ${idempotencyKey}`,
    );

    const permit = mintPermit({
      txIdentity: tx,
      orgId,
      capability: "run.complete",
      archiveEpoch: state.archiveEpoch,
    });
    try {
      const result = await fn(tx, permit);
      return { alreadyApplied: false, result };
    } finally {
      revokePermit(permit);
    }
  });
}
