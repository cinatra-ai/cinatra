// Bootstrap DDL for the LENT-ACTION GRANT's single-use ledger (cinatra#2932,
// lifecycle-b W5a) — a pure string builder with ZERO imports, so
// `drizzle-store.ts` can compose it synchronously (the same leaf shape as
// `review-island-grant-schema.ts`, whose single-use idiom this table copies).
//
// BORN HERE, not moved here. The table is NET-NEW, so this leaf is purely
// additive to the bootstrap text and needs no numbered migration
// (migrations/README.md): the fresh-install shape is born here and the
// idempotent bootstrap carries it onto existing deployments at their next boot.
//
// WHAT ONE ROW IS. One row is one unspent GRANT: permission for the assistant
// to press ONE named control of ONE bound card, for ONE message, on behalf of
// ONE person. The send-time mint writes it; the tool call spends it with a
// single atomic `DELETE ... RETURNING`, which is the same idiom
// `review_island_grants` uses next door and for the same reason — a replay must
// find NOTHING rather than race a flag.
//
// WHY THE LEDGER EXISTS AT ALL, GIVEN THE GRANT IS SIGNED. The signature proves
// the grant was minted here and says what it allows; it cannot say whether it
// has already been used. "The grant is consumed by its first use" is a fact
// about the world, and a row is where a fact about the world lives. It is also
// defence in depth: a grant that this server never minted has no row, so even a
// signature forgery (a leaked app secret) still spends nothing.
//
// KEYED BY `jti`. Unlike the island ledger — where several cards mint off ONE
// credential and the credential hash is the only one-per-address key — a
// lent-action grant is minted fresh per (message, card, control), so its own
// identity IS the address. A second card bound in a later message mints its own
// row and cannot displace this one.
//
// THE GRANT STRING IS NEVER STORED. The row holds the grant's `jti`, the person
// and the organization it was minted for, the control it allows and the person's
// own message text; the authority itself lives only in the header the provider
// relays. A dump of this table yields nothing that can press a button.
//
// WHY THE MESSAGE TEXT IS HERE AT ALL. It is the thing that makes "your words,
// word for word" true by construction rather than by instruction: the handler
// reads the comment it places OUT OF THE ROW IT SPENDS, so a model that calls
// the tool cannot author what lands on the card.
//
// HOW LONG IT REALLY LIVES (convergence round 2). A SPENT grant's text is gone with
// the row the spend deletes — that is the common case. An UNSPENT one is removed
// by the sweep the next mint runs, so its text lives until the next bound send
// in this deployment rather than until its own expiry. The mint sweeps BEFORE it
// inserts, so the collection is paid on the same path that creates the debt.
//
// COLLECTED BY THE NEXT MINT, and that is stated exactly rather than as
// "self-collecting" (convergence round 2). `expires_at` is the grant's own sealed
// expiry — two minutes — and it makes an expired row UNSPENDABLE immediately,
// by predicate. It does not make the row disappear: rows are removed by the
// sweep the next mint runs. So an expired row's lifetime is "until the next
// bound send in this deployment", not "two minutes", and on a deployment where
// nobody sends another bound message the last rows persist. That matters because
// the row carries the person's message text, so the honest statement is a
// retention statement, not an expiry one.

/** The single-use ledger's table name — one definition, shared by DDL and store. */
export const LENT_ACTION_GRANT_TABLE = "lifecycle_lent_action_grants";

export function lentActionGrantSchemaQueries(schemaName: string): { text: string }[] {
  const s = schemaName.replaceAll('"', '""');
  return [
    { text: `CREATE TABLE IF NOT EXISTS "${s}"."${LENT_ACTION_GRANT_TABLE}" (
      jti          text PRIMARY KEY,
      org_id       text NOT NULL,
      user_id      text NOT NULL,
      message_id   text NOT NULL,
      card_ref_fp  text NOT NULL,
      control      text NOT NULL,
      -- THE PERSON'S OWN WORDS (convergence round 1, finding 2). The message they
      -- typed, captured at MINT time and read back at spend time, so what lands
      -- on the card is what they wrote and not what the model chose to pass as
      -- an argument. "A typed reply lands as your comment word for word" is a
      -- property of this column; before it, it was only an instruction in a
      -- system prompt that a prompt-injected model could ignore.
      --
      -- NOT bounded by this column (convergence round 3 corrected an earlier comment
      -- that said it was): the BOUND lives at the mint, which declines to lend
      -- anything for a message longer than the gate-scoped decision route's own
      -- 10 000-character schema accepts, rather than storing a shortened one.
      -- Captured from the person's own message — never from a tool argument,
      -- which is the whole point — and cleared by the spend.
      message_text text,
      created_at   timestamptz NOT NULL DEFAULT now(),
      expires_at   timestamptz NOT NULL,
      -- WHEN IT WAS SPENT, and NULL while it is still spendable (convergence round 3).
      -- The spend sets it instead of deleting the row, because this row is ALSO
      -- the (user_id, message_id) uniqueness witness below: deleting it would
      -- let a RESEND of the same durable message mint a second grant and press
      -- the control a second time, which is exactly what "at most once per
      -- message" forbids. The tombstone keeps the witness until the sweep
      -- collects it after expiry, and the spend clears message_text in the same
      -- statement, so a tombstone holds no words.
      spent_at     timestamptz,
      -- ONE MESSAGE LENDS ONE CONTROL. Declared as a table constraint INSIDE the
      -- create rather than as a separate CREATE UNIQUE INDEX, and deliberately:
      -- a unique index issued as its own statement is, correctly, classified by
      -- scripts/audit/schema-migration-gate.mjs as a unique index on an
      -- EXISTING table — a change that can fail on existing duplicates and needs
      -- a migration artifact. Here there is no existing table and there are no
      -- existing rows: the constraint is born with the table on a fresh install
      -- and with the table on an upgrade, so expressing it as part of the create
      -- states what is true instead of asking the classifier to make an
      -- exception.
      --
      -- WHAT IT ENFORCES: "the action fires at most once per message" survives a
      -- send site that minted twice — a retried send, a double-submitting
      -- client — because the second mint conflicts instead of adding a second
      -- spendable row.
      UNIQUE (user_id, message_id)
    )` },
    { text: `CREATE INDEX IF NOT EXISTS lifecycle_lent_action_grants_expiry_idx ON "${s}"."${LENT_ACTION_GRANT_TABLE}" (expires_at)` },
  ];
}
