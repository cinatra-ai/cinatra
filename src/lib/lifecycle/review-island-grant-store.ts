import "server-only";

// ---------------------------------------------------------------------------
// THE SINGLE-USE LEDGER for a review-island credential (cinatra#2754, the
// maintainer's 2026-08-21 hardening ruling).
//
// WHAT IT BUYS. The credential rides in the island's address — that is the
// ratified position (plan §12), and an address is copyable by construction: it
// lands in a browser history entry, a HAR, a proxy access log, the DOM of the
// card that framed it. Shortening its life bounds the damage; SPENDING it ends
// it. After the first paint every copy of that address opens nothing, and the
// reader who owns it is unaffected, because the card re-resolves — and
// re-mints — on mount, on focus and on reload.
//
// THE IDIOM IS THE HOUSE ONE. `redeemUserAuthCode` in `widget-user-auth.ts`
// spends an auth code with ONE atomic `DELETE ... RETURNING`, keyed by the
// SHA-256 of the string the browser holds, so a replay finds nothing rather
// than racing a flag. This is that, for this credential: same hash-at-rest
// posture (the plaintext is never stored, so a dump of this table opens no
// island), same single statement, same "the row is the permission" semantics.
//
// KEYED BY THE CREDENTIAL HASH, NEVER BY `jti`. One transcript can frame
// several review cards at once and every one of them mints off the SAME `cwu_`
// token. A per-token slot would let the second card's mint evict the first
// card's grant, and the reader would watch one of two perfectly legitimate
// islands go blank. One address, one row, one paint.
//
// A REFUSAL NEVER BURNS A GRANT; A SUCCESS ALWAYS DOES. The consume is the LAST
// rung of `resolveIslandCredentialReader`: every other check — the ref binding,
// the live principal, the sealed bindings, the live standing — has already
// passed when this runs, so a credential turned away by any of them is still
// worth its one paint on the retry the card is about to issue.
//
// NAMED TRADE-OFF, ACCEPTED WITH THE RULING. A manual frame reload after the
// paint presents a spent address and draws the ordinary empty island, until the
// card's next resolve mints a fresh one.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";
import { quotePostgresIdentifier, runPostgresQueriesSync } from "@/lib/postgres-sync";
import { REVIEW_ISLAND_GRANT_TABLE } from "@/lib/review-island-grant-schema";

/**
 * The ledger key: sha256 → lowercase hex of the credential the BROWSER holds,
 * matching `widget-user-auth.ts`'s `sha256Hex` for the same class of input (a
 * high-entropy sealed string, never a low-entropy human secret, so a fast hash
 * is the correct one here).
 */
export function islandCredentialHash(credential: string): string {
  return createHash("sha256").update(credential, "utf8").digest("hex");
}

/** `"<schema>"."review_island_grants"`, quoted. Shared by the statements below. */
export function reviewIslandGrantTableRef(schema: string = postgresSchema): string {
  return `${quotePostgresIdentifier(schema)}.${quotePostgresIdentifier(REVIEW_ISLAND_GRANT_TABLE)}`;
}

/** Collect grants whose credential has expired anyway. Rides the mint, so the
 *  table's population is bounded by the mint rate over one credential life. */
export function reviewIslandGrantSweepSql(table: string): string {
  return `DELETE FROM ${table} WHERE expires_at < now()`;
}

/**
 * Record one grant. `ON CONFLICT DO NOTHING` so a hash collision with a live
 * row (in practice: the same credential minted twice, which cannot happen — the
 * seal carries a random IV) is a refusal to hand out a second address rather
 * than a silent overwrite of somebody's grant.
 */
export function reviewIslandGrantRecordSql(table: string): string {
  return (
    `INSERT INTO ${table} ` +
    `(credential_hash, org_id, user_id, jti, run_id, review_task_id, expires_at) ` +
    `VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7)) ` +
    `ON CONFLICT (credential_hash) DO NOTHING RETURNING credential_hash`
  );
}

/**
 * SPEND one grant, atomically. The single statement is the whole mechanism: the
 * row either comes back to exactly one caller or the credential was already
 * spent, is unknown, or has outlived its sealed expiry against the DATABASE
 * clock (which is why the 60-second life is honoured HERE as well as at the
 * seal — a paused clock on the reading node cannot revive a dead address).
 *
 * The gate and the token are in the WHERE beside the hash. They were already
 * proven equal to the sealed values before this runs, so this is defence in
 * depth, not the check: it means a row can only ever be spent by the exact
 * gate + principal it was minted for.
 */
export function reviewIslandGrantConsumeSql(table: string): string {
  return (
    `DELETE FROM ${table} WHERE credential_hash = $1 AND jti = $2 AND run_id = $3 ` +
    `AND review_task_id = $4 AND expires_at > now() RETURNING credential_hash`
  );
}

/** Everything one grant binds. Mirrors the credential's own sealed fields. */
export type ReviewIslandGrant = {
  /** The credential the browser will hold — hashed here, never stored. */
  credential: string;
  orgId: string;
  userId: string;
  jti: string;
  runId: string;
  reviewTaskId: string;
  /** The credential's OWN sealed expiry, in unix seconds. Never a second clock. */
  expiresAtSeconds: number;
};

/**
 * Record the grant for a freshly minted credential.
 *
 * `false` for anything that did not land — a store failure, a malformed
 * expiry, a hash already present. The mint site turns that into NO ADDRESS AT
 * ALL: handing out a credential whose single use cannot be enforced would be
 * handing out the old, replayable one.
 */
export function recordIslandCredentialGrant(grant: ReviewIslandGrant): boolean {
  if (typeof grant.credential !== "string" || grant.credential.length === 0) return false;
  const expiresAt = Math.floor(grant.expiresAtSeconds);
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return false;
  try {
    ensurePostgresSchema();
    const table = reviewIslandGrantTableRef();
    const [, recorded] = runPostgresQueriesSync({
      connectionString: getPostgresConnectionString(),
      queries: [
        { text: reviewIslandGrantSweepSql(table) },
        {
          text: reviewIslandGrantRecordSql(table),
          values: [
            islandCredentialHash(grant.credential),
            grant.orgId,
            grant.userId,
            grant.jti,
            grant.runId,
            grant.reviewTaskId,
            expiresAt,
          ],
        },
      ],
    });
    return (recorded?.rows?.length ?? 0) === 1;
  } catch {
    return false;
  }
}

/**
 * Spend the grant for a presented credential. `true` exactly once per minted
 * address; `false` for a replay, an unknown credential, an expired grant and
 * every store failure — a failure is never an admission, the same posture the
 * rest of the serving path takes.
 */
export function consumeIslandCredentialGrant(input: {
  credential: string;
  jti: string;
  runId: string;
  reviewTaskId: string;
}): boolean {
  if (typeof input.credential !== "string" || input.credential.length === 0) return false;
  try {
    ensurePostgresSchema();
    const [spent] = runPostgresQueriesSync({
      connectionString: getPostgresConnectionString(),
      queries: [
        {
          text: reviewIslandGrantConsumeSql(reviewIslandGrantTableRef()),
          values: [
            islandCredentialHash(input.credential),
            input.jti,
            input.runId,
            input.reviewTaskId,
          ],
        },
      ],
    });
    return (spent?.rows?.length ?? 0) === 1;
  } catch {
    return false;
  }
}
