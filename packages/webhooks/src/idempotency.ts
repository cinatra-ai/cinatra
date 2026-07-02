// Leased idempotency state machine for the inbound webhook facility (cinatra#340).
//
// One row per (scope, site_id, message_id) in `webhook_idempotency`. The route
// CLAIMS a row before dispatching to a handler and FINALIZES it after. The
// claim is a SINGLE atomic UPSERT — never a read-modify-write across round
// trips — so two concurrent deliveries of the same message cannot both dispatch.
//
// State machine:
//   - processing : a holder has the lease (lease_until in the future) and is
//                  dispatching. A second arrival sees live-lease → 409 (the
//                  sender retries; we do NOT double-process).
//   - done       : terminal success/refusal — a replay returns deduped (200).
//   - failed     : the handler signalled retryable / threw — the NEXT arrival
//                  re-claims and retries.
//
// Crash safety: a holder that dies mid-dispatch leaves a `processing` row whose
// lease expires; a later arrival re-claims it (the WHERE on the UPSERT admits a
// stale-lease processing row). attempt_count is the FINALIZE FENCE — finalize
// updates WHERE attempt_count = <claimed attempt>, so a crashed holder that
// wakes up late cannot overwrite a newer attempt's verdict.
//
// DB-agnostic: the caller injects an async `query(text, params)` returning
// `{ rows }`; the host wires its pg pool, tests wire a thin fake/real pool.

export type WebhookLedgerQuery = (
  text: string,
  params: readonly unknown[],
) => Promise<{ rows: Array<Record<string, unknown>> }>;

export interface IdempotencyLedgerOptions {
  /** The async DB query function (host-injected). */
  readonly query: WebhookLedgerQuery;
  /** Schema-qualified, already-quoted table name, e.g. `"cinatra"."webhook_idempotency"`. */
  readonly table: string;
  /** Lease duration in seconds (how long a holder owns an in-flight claim). */
  readonly leaseSeconds: number;
}

/** The disposition of a claim attempt. */
export type ClaimDisposition =
  /** Fresh or reclaimable — the caller OWNS the lease and must dispatch+finalize. */
  | { kind: "claimed"; attemptCount: number }
  /** Already terminal-success — a replay; respond deduped, do NOT dispatch. */
  | { kind: "deduped" }
  /** A live lease is held by another holder — respond 409, the sender retries. */
  | { kind: "in-progress" };

export type FinalizeStatus = "done" | "failed";

export class IdempotencyLedger {
  private readonly query: WebhookLedgerQuery;
  private readonly table: string;
  private readonly leaseSeconds: number;

  constructor(opts: IdempotencyLedgerOptions) {
    this.query = opts.query;
    this.table = opts.table;
    this.leaseSeconds = opts.leaseSeconds;
  }

  /**
   * Atomically claim the (scope, siteId, messageId) row.
   *
   * The single UPSERT:
   *   - INSERTs a fresh `processing` row with attempt_count=1 (the common path);
   *   - on conflict, re-claims ONLY when the existing row is `failed` OR a
   *     `processing` row whose lease has expired (a crashed holder), bumping
   *     attempt_count and resetting the lease;
   *   - a `done` row or a live-lease `processing` row does NOT match the
   *     conflict WHERE, so the UPDATE affects 0 rows and RETURNING is empty.
   *
   * When the UPSERT returns no row (a `done` or live-lease row blocked it) we
   * read the row back to disambiguate deduped (done) from in-progress
   * (live-lease processing).
   */
  async claim(scope: string, siteId: string, messageId: string): Promise<ClaimDisposition> {
    const t = this.tableAlias();
    const upsert = await this.query(
      `INSERT INTO ${this.table} (scope, site_id, message_id, status, lease_until, attempt_count, received_at)
       VALUES ($1, $2, $3, 'processing', now() + ($4 || ' seconds')::interval, 1, now())
       ON CONFLICT (scope, site_id, message_id) DO UPDATE
         SET status = 'processing',
             lease_until = now() + ($4 || ' seconds')::interval,
             attempt_count = ${t}.attempt_count + 1,
             received_at = now(),
             finalized_at = NULL
         WHERE ${t}.status = 'failed'
            OR (${t}.status = 'processing' AND ${t}.lease_until < now())
       RETURNING attempt_count`,
      [scope, siteId, messageId, String(this.leaseSeconds)],
    );
    if (upsert.rows.length > 0) {
      return { kind: "claimed", attemptCount: Number(upsert.rows[0].attempt_count) };
    }
    // The conflict target existed and the WHERE rejected the update (done OR
    // live-lease processing). Read back to disambiguate.
    const existing = await this.query(
      `SELECT status, lease_until FROM ${this.table}
        WHERE scope = $1 AND site_id = $2 AND message_id = $3`,
      [scope, siteId, messageId],
    );
    const row = existing.rows[0];
    if (row && row.status === "done") return { kind: "deduped" };
    // A processing row with a live lease (or any other non-done blocker).
    return { kind: "in-progress" };
  }

  /**
   * Finalize the row this holder claimed — attempt-fenced so a stale holder
   * cannot overwrite a newer attempt's verdict.
   *
   * @returns true when THIS holder's finalize won (attempt fence matched), false
   *   when a newer attempt has already superseded it (the late finalize is a
   *   no-op; the newer holder owns the row).
   */
  async finalize(
    scope: string,
    siteId: string,
    messageId: string,
    claimedAttempt: number,
    status: FinalizeStatus,
  ): Promise<boolean> {
    const res = await this.query(
      `UPDATE ${this.table}
          SET status = $5,
              finalized_at = now(),
              lease_until = NULL
        WHERE scope = $1 AND site_id = $2 AND message_id = $3 AND attempt_count = $4
        RETURNING id`,
      [scope, siteId, messageId, claimedAttempt, status],
    );
    return res.rows.length > 0;
  }

  // The unquoted table alias Postgres uses in the ON CONFLICT ... WHERE clause
  // (the target table name, without schema/quotes). e.g.
  // `"cinatra"."webhook_idempotency"` → `webhook_idempotency`.
  private tableAlias(): string {
    return this.table.split(".").pop()!.replace(/"/g, "");
  }
}
