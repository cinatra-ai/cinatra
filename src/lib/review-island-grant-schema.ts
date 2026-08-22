// Bootstrap DDL for the review-island credential's SINGLE-USE ledger
// (cinatra#2754, the maintainer's 2026-08-21 hardening ruling) — a pure string
// builder with ZERO imports, so `drizzle-store.ts` can compose it synchronously.
//
// BORN HERE, not moved here. The table is NET-NEW, so this leaf is purely
// additive to the bootstrap text — the same pattern as
// `trigger-schedule-proposal-schema.ts`. A new table needs no numbered
// migration (migrations/README.md): the fresh-install shape is born here and
// the idempotent bootstrap carries it onto existing deployments at their next
// boot.
//
// WHAT THE ROW IS. One row is one GRANT: permission for the credential whose
// SHA-256 this row is keyed by to paint its island exactly once. The mint
// writes it; the serving path spends it with a single atomic
// `DELETE ... RETURNING`, which is the same idiom `redeemUserAuthCode` uses on
// `widget_auth_codes` next door, and for the same reason — a replay must find
// nothing rather than race a flag.
//
// KEYED BY THE CREDENTIAL HASH, NEVER BY `jti`. One transcript can frame
// several review cards at once, and every one of them mints off the SAME `cwu_`
// token, so a per-token slot would let the second card's mint overwrite (and
// the second card's paint spend) the first card's grant. The hash is the only
// key that is one-per-address.
//
// THE PLAINTEXT IS NEVER STORED, exactly as it is never stored for a `cwu_`
// token or an auth code: the browser holds the credential, this table holds
// only sha256(credential), so a dump of it yields nothing that opens an island.
//
// SELF-COLLECTING. `expires_at` is the credential's OWN sealed expiry (60s), so
// an unspent grant is swept by the next mint rather than accumulating; the row
// population is bounded by the mint rate over one minute.

/** The single-use ledger's table name — one definition, shared by the DDL and the store. */
export const REVIEW_ISLAND_GRANT_TABLE = "review_island_grants";

export function reviewIslandGrantSchemaQueries(schemaName: string): { text: string }[] {
  const s = schemaName.replaceAll('"', '""');
  return [
    { text: `CREATE TABLE IF NOT EXISTS "${s}"."${REVIEW_ISLAND_GRANT_TABLE}" (
      credential_hash text PRIMARY KEY,
      org_id          text NOT NULL,
      user_id         text NOT NULL,
      jti             text NOT NULL,
      run_id          text NOT NULL,
      review_task_id  text NOT NULL,
      created_at      timestamptz NOT NULL DEFAULT now(),
      expires_at      timestamptz NOT NULL
    )` },
    { text: `CREATE INDEX IF NOT EXISTS review_island_grants_expiry_idx ON "${s}"."${REVIEW_ISLAND_GRANT_TABLE}" (expires_at)` },
  ];
}
