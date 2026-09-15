// Bootstrap DDL for the memory row-promotion request ledger (cinatra#1381,
// epic #1373) — a pure string builder with ZERO imports, so `drizzle-store.ts`
// can compose it synchronously (the same leaf shape as
// `lent-action-grant-schema.ts` / `review-island-grant-schema.ts`).
//
// BORN HERE, not moved here. The table is NET-NEW, so this leaf is purely
// additive to the bootstrap text and needs no numbered migration
// (migrations/README.md): the fresh-install shape is born here and the
// idempotent bootstrap carries it onto existing deployments at their next boot.
// The leaf exists rather than an inline block because `drizzle-store.ts` sits
// at its file-size ceiling, which may only ever shrink — its import and its
// spread both RIDE existing lines there.
//
// WHAT ONE ROW IS. One row is one request to WIDEN one memory row's scope
// through review: `user/private -> team/team`, `user/private ->
// organization/organization`, or `team/team -> organization/organization`. The
// memory OBJECT is untouched while the request is pending; the widen happens
// only inside the ONE transaction an approve runs
// (`memory-row-promotion.ts#decideMemoryPromotion`).
//
// MUTABLE LIFECYCLE STATE, matching `artifact_promotion_request`:
// pending -> approved | rejected | superseded (all terminal). The append-only
// record of what an approve DID lives in `object_change_event`, written by the
// canonical writer in that same transaction — never here.
//
// `row_version` is the `objects.version` captured at request time. It is the
// CAS anchor: an edit after the request moves the live row past it, so the
// approve supersedes instead of widening content nobody reviewed.
//
// THE SOURCE TUPLE IS RECORDED, not just the source visibility. The transition
// matrix is a rule about the whole `(owner_level, visibility)` tuple —
// `user/private` and a user-owned `team`-visible row are different states — so
// the request stores both axes of where it started and both axes of where it
// is going.

/** The request ledger's table name — one definition, shared by DDL and store. */
export const MEMORY_PROMOTION_REQUEST_TABLE = "memory_promotion_request";

export function memoryPromotionRequestSchemaQueries(schemaName: string): { text: string }[] {
  const s = schemaName.replaceAll('"', '""');
  return [
    { text: `CREATE TABLE IF NOT EXISTS "${s}"."${MEMORY_PROMOTION_REQUEST_TABLE}" (
      id                 text PRIMARY KEY,
      org_id             text NOT NULL,
      object_id          text NOT NULL,
      -- Human title snapshotted at request time, so a review row never re-reads
      -- the memory object just to render a label.
      object_title       text NOT NULL,
      requested_by       text NOT NULL,
      -- The SOURCE tuple (both axes), so the transition matrix is checked
      -- against the state the request was opened from.
      from_owner_level   text NOT NULL,
      from_owner_id      text NOT NULL,
      from_visibility    text NOT NULL,
      to_visibility      text NOT NULL,
      to_owner_level     text NOT NULL,
      to_owner_id        text NOT NULL,
      -- DISPLAY-ONLY snapshot of the widen target's human label (the team
      -- name). Never used for authorization; null for organization targets.
      to_owner_label     text,
      -- objects.version captured at request time (the CAS anchor).
      row_version        integer NOT NULL,
      status             text NOT NULL DEFAULT 'pending',
      decided_by         text,
      decided_at         timestamptz,
      decision_note      text,
      created_at         timestamptz NOT NULL DEFAULT now(),
      updated_at         timestamptz NOT NULL DEFAULT now(),
      -- AT MOST ONE PENDING REQUEST PER MEMORY ROW, expressed as a generated
      -- column plus a table UNIQUE constraint rather than a partial unique
      -- INDEX. A CREATE UNIQUE INDEX issued as its own statement is —
      -- correctly — classified by scripts/audit/schema-migration-gate.mjs as a
      -- unique index on an EXISTING table, a change that can fail on existing
      -- duplicates and needs a migration artifact. Here there is no existing
      -- table and there are no existing rows, so the constraint is born with
      -- the table on a fresh install and with the table on an upgrade.
      --
      -- HOW IT ENFORCES THE RULE: the generated column carries object_id only
      -- while the row is pending and NULL otherwise, and a UNIQUE constraint
      -- does not conflict NULLs. So a second in-flight request for the same row
      -- is a duplicate-key refusal, while any number of decided requests for
      -- that row coexist. Postgres recomputes a STORED generated column on
      -- every UPDATE, so a decision frees the slot in the same statement that
      -- decides.
      pending_object_id  text GENERATED ALWAYS AS (CASE WHEN status = 'pending' THEN object_id END) STORED,
      CONSTRAINT mpr_status_chk CHECK (status IN ('pending','approved','rejected','superseded')),
      CONSTRAINT mpr_to_visibility_chk CHECK (to_visibility IN ('team','organization')),
      CONSTRAINT mpr_one_pending UNIQUE (pending_object_id)
    )` },
    { text: `CREATE INDEX IF NOT EXISTS memory_promotion_request_org_status_idx ON "${s}"."${MEMORY_PROMOTION_REQUEST_TABLE}" (org_id, status)` },
    { text: `CREATE INDEX IF NOT EXISTS memory_promotion_request_requester_idx ON "${s}"."${MEMORY_PROMOTION_REQUEST_TABLE}" (requested_by, status)` },
    { text: `CREATE INDEX IF NOT EXISTS memory_promotion_request_object_idx ON "${s}"."${MEMORY_PROMOTION_REQUEST_TABLE}" (object_id)` },
  ];
}
