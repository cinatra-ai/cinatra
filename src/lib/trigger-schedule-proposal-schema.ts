// Bootstrap DDL for the conversational schedule PROPOSAL tables (cinatra#2569,
// epic #2564 S5) — a pure string builder with ZERO imports (a synchronous leaf,
// safe for `drizzle-store.ts`'s synchronous composition).
//
// BORN HERE, not moved here. All three tables are NET-NEW, so this leaf is purely
// additive to the bootstrap text — the same pattern as
// `assistant-thread-schema.ts` and `extension-grant-schema.ts`, and the reason
// matters: the schema-migration gate reads the executed DDL out of
// `buildCreateStoreSchemaQueries` in drizzle-store.ts alone, so RELOCATING a
// deployed table's CREATE text out of that file reads to it (correctly, from
// where it stands) as a dropped column. New tables can be born in a leaf; old
// ones cannot move into one without the gate learning about spread-in leaves.
//
// Additive under migrations/README.md ("a new table" needs no numbered
// artifact): the fresh-install shape is born here and the idempotent bootstrap
// carries it onto existing deployments at the next boot. The Drizzle twins live
// in `packages/agents/src/schema.ts`.
//
//   trigger_schedule_proposal_consumes — the SINGLE-USE edge. The proposal token
//     is stateless and replayable by construction; SPENDING it is not.
//     `consume_key` is the PRIMARY KEY, so a second Confirm carrying the same
//     proposal loses the insert and its whole transaction — including the run it
//     was about to create — rolls back.
//
//   trigger_schedule_proposal_lineage — the LINEAGE-LATEST RATCHET (cinatra#2837).
//     An expired ref is readable forever, so Adjust off a transcript is a
//     re-proposal capability that never dies. One row per lineage records the
//     replacement it is currently holding open; while that replacement is
//     un-expired, Adjust HANDS IT BACK instead of minting another. One live
//     token per lineage at any moment, and the confirmation window rolls by at
//     most one TTL per real expiry. Swept once expired (see below). Full
//     argument on `reproposeExpiredScheduleProposal`.
//
//   trigger_schedule_install_outbox — the install INTENT. A trigger has two
//     halves in two systems (the durable row and the BullMQ scheduler), so
//     Confirm commits an intent and a drain installs it in a PINNED ORDER: ARM
//     the run, THEN expose the schedule. Exposing first lets a release fire on a
//     not-armed run, where the `armed → queued` CAS logs and skips and a
//     one-shot fire is lost. Full argument in
//     `packages/agents/src/trigger-schedule-proposal-store.ts`.
//
// THE CONSUME EDGE AND THE INSTALL OUTBOX cascade from `agent_runs(id)` and are
// keyed one row per run, so deleting a run collects them and neither grows
// independently of the run population.
//
// THE RATCHET CANNOT, and that is a property of what it is for rather than an
// oversight: the ratchet row exists precisely BEFORE any run does — a lineage
// that is re-proposed and never confirmed has no run to hang from, and the row
// whose whole job is to bound minting cannot be keyed on the thing minting has
// not produced. Its own shape bounds it only in COUNT: ONE row per lineage,
// UPSERTED and never appended, so the table is the set of lineages a person has
// ever adjusted — live or expired. Nothing about that shape bounds any row in
// TIME, so the row is SWEPT: every row is worthless the moment `expires_at`
// passes, and `sweepExpiredLineage` in
// `packages/agents/src/trigger-schedule-proposal-store.ts` deletes the expired
// ones, called once per daily cycle by the `audit-retention-enforce` background
// job (cinatra#2908). The pass needs no coordination and costs no correctness,
// because the only consequence of losing a row is that the next Adjust mints a
// fresh replacement — exactly what it would have done anyway.
// `..._expires_idx` is the index that pass deletes through.

export function triggerScheduleProposalSchemaQueries(
  schemaName: string,
): { text: string }[] {
  const s = schemaName.replaceAll('"', '""');
  return [
    // trigger_schedule_proposal_consumes: the SINGLE-USE consume edge for a
    // conversational schedule proposal (cinatra#2569, epic #2564 S5). The
    // proposal token is stateless and replayable by construction; spending it is
    // not. consume_key is the PK, so a second Confirm carrying the same proposal
    // loses the insert and its whole transaction — including the run it was about
    // to create — rolls back; the loser then reads this row and answers with the
    // ORIGINAL run_id. run_id is NOT NULL because it is written in the SAME
    // transaction as the run it names.
    { text: `CREATE TABLE IF NOT EXISTS "${s}"."trigger_schedule_proposal_consumes" (
      consume_key text PRIMARY KEY,
      run_id text NOT NULL REFERENCES "${s}"."agent_runs"(id) ON DELETE CASCADE,
      org_id text NOT NULL,
      template_id text NOT NULL,
      consumed_by text NOT NULL,
      consumed_at timestamptz NOT NULL DEFAULT now()
    )` },
    { text: `CREATE INDEX IF NOT EXISTS trigger_schedule_proposal_consumes_run_idx ON "${s}"."trigger_schedule_proposal_consumes" (run_id)` },
    // trigger_schedule_proposal_lineage: the LINEAGE-LATEST RATCHET for
    // re-proposing an EXPIRED proposal (cinatra#2837). A proposal token stays
    // readable long past its own `exp` — that is what makes the expired card
    // possible — so the ref sitting in a transcript is an Adjust capability with
    // no end date, and the consume edge above caps RUNS at one while capping
    // minting at nothing. This row is the cap: `consume_key` is the PK, so the
    // lineage has exactly one, and it names the replacement currently holding
    // the window open. Adjust returns that token while `expires_at` is in the
    // future and only mints past it, which is what makes the act IDEMPOTENT
    // WHILE LIVE. `latest_token` is the REPLACEMENT's ciphertext — authenticated,
    // reader-bound and org-bound like any proposal token, but NOT the bytes the
    // transcript holds: a replacement inherits only the nonce, and "everything
    // else about the replacement is fresh: a fresh IV, a fresh ciphertext, a
    // fresh `iat`/`exp`" (`trigger-schedule-proposal-token.ts`, `mint`). The
    // transcript keeps the ORIGINAL ref; after a live Adjust the replacement's
    // ref is React-local, so this column is the only durable copy of it — which
    // is why it is swept rather than kept (see the header).
    // NO run reference: the row exists before any run does, which is the point.
    { text: `CREATE TABLE IF NOT EXISTS "${s}"."trigger_schedule_proposal_lineage" (
      consume_key text PRIMARY KEY,
      latest_token text NOT NULL,
      expires_at timestamptz NOT NULL,
      org_id text NOT NULL,
      template_id text NOT NULL,
      reproposed_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )` },
    // Non-unique, for the retention pass described in the header
    // (`sweepExpiredLineage`, run by `audit-retention-enforce`): every row is
    // discardable the moment its replacement expires, and the pass finds the
    // discardable ones oldest-first through this index.
    { text: `CREATE INDEX IF NOT EXISTS trigger_schedule_proposal_lineage_expires_idx ON "${s}"."trigger_schedule_proposal_lineage" (expires_at)` },
    // trigger_schedule_install_outbox: the schedule-INSTALL intent (cinatra#2569).
    // A trigger has two halves in two systems — the durable row and the BullMQ
    // scheduler — so Confirm commits an INTENT and a drain installs in a PINNED
    // ORDER: ARM the run, THEN expose the schedule. Exposing first would let a
    // release fire on a not-armed run, where the armed→queued CAS logs and skips
    // and a one-shot fire is lost. run_id is the PK: one install per run.
    { text: `CREATE TABLE IF NOT EXISTS "${s}"."trigger_schedule_install_outbox" (
      run_id text PRIMARY KEY REFERENCES "${s}"."agent_runs"(id) ON DELETE CASCADE,
      org_id text NOT NULL,
      requested_by text NOT NULL,
      trigger_type text NOT NULL,
      scheduled_at timestamptz,
      cron_expression text,
      timezone text NOT NULL DEFAULT 'UTC',
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','installing','done','failed')),
      attempts integer NOT NULL DEFAULT 0,
      max_attempts integer NOT NULL DEFAULT 20,
      lease_token text,
      lease_expires_at timestamptz,
      last_error text,
      armed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )` },
    { text: `CREATE INDEX IF NOT EXISTS trigger_schedule_install_outbox_status_idx ON "${s}"."trigger_schedule_install_outbox" (status, created_at)` },
  ];
}
