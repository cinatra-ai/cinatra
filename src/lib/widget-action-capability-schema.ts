// Bootstrap DDL for `widget_action_capabilities` (cinatra#2575, epic #2564 S8b)
// — the durable record behind the widget DECISION path's fresh action
// capability.
//
// ONE ROW, TWO SINGLE-USE EDGES, and that is the whole point of persisting it:
//
//   requested  — the widget iframe asks, presenting its `cwu_`. The row records
//                the binding the confirmation will be ABOUT (principal, widget
//                session, site, gate, act, and the digest of the representation
//                revisions the gate had pinned at that moment). Nothing is
//                authorized yet.
//   confirmed  — the person presses Confirm in a cinatra-origin window the site
//                cannot script. `confirmed_at IS NULL` is the CAS: exactly one
//                confirmation can ever seal a capability for this row, and the
//                same statement re-bases `expires_at` onto the SPEND window.
//   consumed   — the sealed capability is redeemed at the broker decision
//                endpoint. `consumed_at IS NULL` is the CAS: a capability spends
//                exactly once, whatever the decision then does.
//
// WHY A DURABLE ROW AND NOT A STATELESS TOKEN. A sealed token can carry every
// binding and still be replayed, because a signature says nothing about how many
// times it has been presented. The epic's gate CAS makes the DECISION EFFECT
// idempotent — a second identical submit is a success, a different one a
// conflict — but that is a statement about the decision, not about the
// CREDENTIAL. A stolen capability replayed against a gate that has since been
// re-opened for repair would be a second decision the person never took. So the
// credential gets its own consume edge, and the two mechanisms answer two
// different questions.
//
// PURELY ADDITIVE new table -> it ships in the idempotent bootstrap DDL
// (buildCreateStoreSchemaQueries / createStoreTables, src/lib/drizzle-store.ts),
// NOT a numbered core migration. Per migrations/README.md the bootstrap owns
// ADDITIVE evolution (`CREATE TABLE IF NOT EXISTS`, re-run every boot/setup);
// node-pg-migrate is only for TRANSFORMATIONAL change to tables that already
// hold user data. This mirrors connector_instance_pending_call (cinatra#2020),
// connector_instance_server (cinatra#2018) and widget_stream_tokens
// (cinatra#220) — new tables added via the bootstrap with no migration.
//
// A pure string builder with ZERO imports — a synchronous leaf, safe for
// drizzle-store.ts's synchronous require() composition (the same contract as
// connector-instance-server-schema.ts).
//
// INVARIANTS ENFORCED IN THE DDL, not merely in the application:
//   - `consumed_at IS NULL OR confirmed_at IS NOT NULL` — a capability can never
//     be spent without having been confirmed by a person. If the confirm CAS is
//     ever refactored out of the path, the database refuses the write.
//   - `disposition IN ('approve','reject','comment')` — the review floor. A row
//     naming an act this product does not have cannot exist to be sealed.
//   - `decision_digest` is NOT NULL — a request that could not say WHAT would be
//     submitted cannot be recorded, so there is no row shape whose confirmation
//     would authorize an unspecified body. `comment_text` holds the WHOLE
//     rationale (bounded at the endpoint), because the confirmation screen shows
//     all of it: an excerpt would let a benign opening hide a consequential
//     ending behind a click (codex round 1, finding 1). It lives here for the
//     five minutes a request is confirmable and dies with the row.
//   - `subject_label` is NOT NULL — WHAT is under review, in the person's own
//     words, derived server-side at request time from the artifacts the
//     requester had already cleared read access to. A confirmation window that
//     could not name its subject would let whoever opened it substitute a
//     different review behind the same sentence, so a row that cannot say what
//     it is about cannot exist.
//   - the RETENTION index on `expires_at` — the on-write lazy sweep (the
//     widget-tables precedent: no external cron).
//   - the REVOCATION index on `widget_jti` — signing out kills a widget session,
//     and the outstanding capabilities minted inside it are found by this index.
export function widgetActionCapabilitySchemaQueries(
  schemaName: string,
): { text: string }[] {
  const q = schemaName.replaceAll('"', '""');
  return [
    {
      text: `CREATE TABLE IF NOT EXISTS "${q}"."widget_action_capabilities" (
      capability_id   text PRIMARY KEY,
      purpose         text NOT NULL,
      audience        text NOT NULL,
      org_id          text NOT NULL,
      user_id         text NOT NULL,
      widget_jti      text NOT NULL,
      site_id         text NOT NULL,
      client          text NOT NULL,
      instance_id     text NOT NULL,
      agent_slug      text NOT NULL,
      run_id          text NOT NULL,
      review_task_id  text NOT NULL,
      disposition     text NOT NULL CHECK (disposition IN ('approve','reject','comment')),
      targets_digest  text NOT NULL,
      decision_digest text NOT NULL,
      subject_label   text NOT NULL,
      comment_text    text,
      created_at      timestamptz NOT NULL DEFAULT now(),
      expires_at      timestamptz NOT NULL,
      confirmed_at    timestamptz,
      consumed_at     timestamptz,
      CONSTRAINT widget_action_capabilities_spend_needs_confirm
        CHECK (consumed_at IS NULL OR confirmed_at IS NOT NULL)
    )`,
    },
    {
      text: `CREATE INDEX IF NOT EXISTS widget_action_capabilities_expiry_idx ON "${q}"."widget_action_capabilities" (expires_at)`,
    },
    {
      text: `CREATE INDEX IF NOT EXISTS widget_action_capabilities_session_idx ON "${q}"."widget_action_capabilities" (widget_jti)`,
    },
  ];
}
