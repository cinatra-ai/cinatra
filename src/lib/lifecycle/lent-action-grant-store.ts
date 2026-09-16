// ---------------------------------------------------------------------------
// The LENT-ACTION GRANT's single-use ledger (cinatra#2932, lifecycle-b W5a).
//
// The codec (`lent-action-grant.ts`) says what a grant ALLOWS. This module says
// whether it has already been SPENT — which is a fact about the world and
// therefore a row, not a property of a string.
//
// TWO OPERATIONS, AND DELIBERATELY NO THIRD:
//
//   recordLentActionGrant — the send-time mint's row. Written once, beside the
//                           minted grant, before the grant can reach a model.
//   consumeLentActionGrant — the call-time spend. ONE atomic statement, so a
//                           replay finds a spent row rather than racing a flag,
//                           and two concurrent calls of the same grant cannot
//                           both win.
//
// There is no "peek". A caller that could ask "is this grant still good?"
// without spending it would have a way to probe the ledger, and every honest
// caller wants to spend it anyway.
//
// THE SPEND IS BOUND TO THE PERSON, NOT ONLY TO THE `jti`. The statement names
// (jti, user_id, org_id): a grant's identity alone must not be enough to spend
// it, because the identity travels on a header and the person does not.
//
// A QUERY SEAM, LIKE THE DURABLE HITL GATE STORE next door, so the idioms are
// unit-testable without a database and the DB tier proves them once for real.
// ---------------------------------------------------------------------------

import "server-only";

import { agentBuilderPool } from "@cinatra-ai/agents/db";

import { LENT_ACTION_GRANT_TABLE } from "@/lib/lent-action-grant-schema";
import type { LentActionGrantClaims } from "./lent-action-grant";

/** Minimal parameterized-query seam; tests inject a double. */
export type LentActionGrantQuery = <T>(
  text: string,
  values: readonly unknown[],
) => Promise<T[]>;

export type LentActionGrantStoreDeps = {
  readonly query?: LentActionGrantQuery;
};

/** The app schema, resolved per call so a test can retarget it. */
function grantTable(): string {
  const schemaName = process.env.SUPABASE_SCHEMA?.trim() || "cinatra";
  return `"${schemaName.replaceAll('"', '""')}"."${LENT_ACTION_GRANT_TABLE}"`;
}

const defaultQuery: LentActionGrantQuery = async <T>(
  text: string,
  values: readonly unknown[],
): Promise<T[]> => {
  const result = await agentBuilderPool.query(text, values as unknown[]);
  return result.rows as T[];
};

/**
 * Record the row for a freshly minted grant.
 *
 * IDEMPOTENT ON THE MESSAGE, not on the `jti`. `ON CONFLICT DO NOTHING` over the
 * unique (user_id, message_id) index means a second mint for the same message —
 * a retried send, a double-submitting client — adds NO second spendable row.
 * Returns whether THIS call is the one that created the row, so a mint whose row
 * lost the race can discard its grant rather than hand out an authority the
 * ledger will refuse.
 */
export async function recordLentActionGrant(
  claims: LentActionGrantClaims,
  /**
   * THE PERSON'S OWN WORDS (convergence round 1, finding 2) — the message they typed,
   * captured here and read back at the spend so the comment that lands on the
   * card is theirs and not the model's tool argument.
   *
   * STORED WHOLE OR NOT AT ALL. It is NOT truncated here (convergence round 2): a
   * silently shortened message would turn "word for word" into "the first ten
   * thousand characters", which the decision route itself never does — it
   * REFUSES an over-long comment. The caller refuses to mint instead, so an
   * over-long message lends nothing and the person uses the card's own button.
   */
  messageText: string | null,
  deps: LentActionGrantStoreDeps = {},
): Promise<boolean> {
  const query = deps.query ?? defaultQuery;
  const rows = await query<{ jti: string }>(
    `INSERT INTO ${grantTable()}
       (jti, org_id, user_id, message_id, card_ref_fp, control, message_text, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8))
     ON CONFLICT DO NOTHING
     RETURNING jti`,
    [
      claims.jti,
      claims.orgId,
      claims.userId,
      claims.messageId,
      claims.cardRefFingerprint,
      claims.control,
      messageText,
      claims.expiresAt,
    ],
  );
  return rows.length === 1;
}

/** What a spend attempt answers. Three outcomes, one of them not a refusal. */
export type LentActionGrantSpend =
  /**
   * The grant was unspent and is now spent. This call may act, and it acts with
   * `messageText` — the person's OWN words, read out of the row the spend just
   * tombstoned, never a tool argument (convergence round 1, finding 2).
   */
  | { readonly outcome: "consumed"; readonly messageText: string | null }
  /**
   * Nothing was there to spend: already used, never minted here, minted for
   * somebody else, or swept after expiry. ONE outcome for all four, because a
   * caller learning which would learn about a grant they do not hold.
   */
  | { readonly outcome: "refused" };

/**
 * Spend a grant, atomically, once.
 *
 * A TOMBSTONE, NOT A DELETE (convergence round 3). The spend marks the row spent and
 * clears the person's words; it does NOT remove the row. The distinction is the
 * whole of "the action fires at most once per MESSAGE": the row is also the
 * (user_id, message_id) uniqueness witness, so deleting it would let a RESEND of
 * the same durable message mint a second grant and press the control again. The
 * tombstone keeps the witness until the sweep collects it after expiry, by which
 * time the message is long past.
 *
 * IT IS STILL ONE ATOMIC STATEMENT. `UPDATE … WHERE spent_at IS NULL … RETURNING`
 * has exactly the property the DELETE had: whichever of two concurrent calls the
 * database serializes first returns a row and may act; the other returns none
 * and is refused. There is no read-then-write and therefore no window.
 *
 * THE WORDS ARE CLEARED IN THE SAME STATEMENT that returns them, so a spent
 * row's tombstone carries no message text — the retention the schema leaf
 * describes applies to UNSPENT rows only.
 *
 * AND THEY ARE READ FROM THE PRE-STATEMENT SNAPSHOT, WHICH IS WHY THE SPEND IS A
 * CTE (cinatra#2988). `RETURNING` evaluates against the tuple the UPDATE has
 * just WRITTEN, so a plain `UPDATE ... SET message_text = NULL ... RETURNING
 * message_text` hands back the NULL it wrote and the person's words are
 * destroyed by the very statement that was supposed to deliver them. A
 * data-modifying `WITH` fixes it without giving up atomicity: the sub-statement
 * tombstones the row, and the outer SELECT reads the table under the snapshot
 * taken BEFORE the statement ran — a data-modifying CTE and the query around it
 * cannot see one another's effects — so the outer scan still holds the words.
 *
 * PORTABLE ON PURPOSE. Postgres 18 can say `RETURNING OLD.message_text`, which
 * would read better; this deployment's supported majors start at 15
 * (config/upgrade/upgrade-matrix.json), so the statement uses the idiom every
 * one of them has.
 *
 * STILL EXACTLY ONE STATEMENT, so the concurrency property is unchanged: the
 * UPDATE inside the CTE is what serializes, whichever of two concurrent spends
 * the database orders first returns the single `spent` row, and the other
 * matches nothing, joins nothing and is refused. Neither the words nor a second
 * spend can escape through a gap, because there is still no gap.
 *
 * A STORE FAILURE IS A REFUSAL. If the ledger cannot be reached, the grant is
 * not proven unspent, so the action does not fire. Failing open here would let
 * an outage turn a single-use authority into an unlimited one.
 */
export async function consumeLentActionGrant(
  input: {
    readonly jti: string;
    readonly userId: string;
    readonly orgId: string;
    /** The card the CALL names — the row must agree. */
    readonly cardRefFingerprint: string;
    /** The control the CALL asks for — the row must agree. */
    readonly control: string;
  },
  deps: LentActionGrantStoreDeps = {},
): Promise<LentActionGrantSpend> {
  const query = deps.query ?? defaultQuery;
  try {
    // The statement also names the CARD and the CONTROL, so the row itself
    // refuses a grant spent for anything other than what it was minted for —
    // defence in depth beneath the signature check, not a substitute for it.
    const table = grantTable();
    const rows = await query<{ jti: string; message_text: string | null }>(
      `WITH spent AS (
         UPDATE ${table}
            SET spent_at = now(), message_text = NULL
          WHERE jti = $1 AND user_id = $2 AND org_id = $3
            AND card_ref_fp = $4 AND control = $5
            AND spent_at IS NULL
            AND expires_at > now()
          RETURNING jti
       )
       SELECT spent.jti, prior.message_text
         FROM spent
         JOIN ${table} AS prior ON prior.jti = spent.jti`,
      [input.jti, input.userId, input.orgId, input.cardRefFingerprint, input.control],
    );
    const row = rows[0];
    return row
      ? { outcome: "consumed", messageText: row.message_text ?? null }
      : { outcome: "refused" };
  } catch {
    return { outcome: "refused" };
  }
}

/**
 * Sweep rows whose life has run out — unspent grants AND spent tombstones alike.
 *
 * Run by the mint BEFORE it inserts, so the collection is paid on the path that
 * creates the debt. Best-effort: a failed sweep costs rows, never correctness —
 * the spend already refuses an expired or already-spent grant by predicate, and
 * a tombstone that outlives its expiry only holds a jti and a message id.
 */
export async function sweepExpiredLentActionGrants(
  deps: LentActionGrantStoreDeps = {},
): Promise<void> {
  const query = deps.query ?? defaultQuery;
  try {
    await query(`DELETE FROM ${grantTable()} WHERE expires_at <= now()`, []);
  } catch {
    // Housekeeping only.
  }
}
