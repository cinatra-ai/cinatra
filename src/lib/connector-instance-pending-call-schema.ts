// Bootstrap DDL for connector_instance_pending_call (cinatra#2020 S5 / design
// §3 / D2). The host-owned durable record of a destructive connector-instance
// tool call that has been PARKED pending the requester's explicit confirmation
// (invoker step 3 → the destructive hook parks; the resume executor consumes).
// One row per parked call, host-minted `cipc_` id.
//
// PURELY ADDITIVE new table → it ships in the idempotent bootstrap DDL
// (buildCreateStoreSchemaQueries / createStoreTables, src/lib/drizzle-store.ts),
// NOT a numbered core migration. Per migrations/README.md the bootstrap owns
// ADDITIVE evolution (`CREATE TABLE IF NOT EXISTS`, re-run every boot/setup);
// node-pg-migrate is only for TRANSFORMATIONAL change to tables that already
// hold user data. This mirrors connector_instance_tool_policy (cinatra#2017 S2),
// connector_instance_server (cinatra#2018 S3) and widget_stream_tokens
// (cinatra#220) — new tables added via the bootstrap with no migration. The DDL
// is pure and deterministic; row POPULATION is the destructive hook's
// `parkPendingCall` + the resume executor's CAS writers in
// connector-instance-pending-call-store.ts, never in-DDL enumeration.
//
// A pure string builder with ZERO imports — a synchronous leaf, safe for
// drizzle-store.ts's synchronous require() composition (same contract as
// connector-instance-server-schema.ts; the postgres-sync-leaf-imports test
// walks this edge from the drizzle-store entrypoint and fails closed if this
// leaf ever reaches an async-root import).
//
// INVARIANTS ENFORCED IN THE DDL (design §3 / codex r0 #10 / r1 M4):
//   - args CAP: `args_bytes <= 262144` (256 KB canonical JSON) — an
//     uninspectable blob must never be one-click-approved.
//   - status↔args COUPLING: `((status IN ('pending','executing')) = (args IS
//     NOT NULL))` — the full args exist ONLY while the call is actionable and
//     are NULLED at every terminal transition; the redacted `args_preview`
//     survives for card history. Structural, not merely app-enforced.
//   - status ENUM: the seven-state machine
//     `pending → executing → executed|failed` ∪ `denied|cancelled|expired`.
//
// KEYS + INDEXES:
//   - PRIMARY KEY (id) — the host-minted `cipc_` id; every CAS is `WHERE id=$1`.
//   - viewer read index (org_id, user_id, status, created_at DESC) — the
//     `(org,user)`-scoped card list (NOT thread-scoped: a park from any
//     require-surface is visible in the user's cinatra chat panel).
//   - expires_at index — the on-write lazy-expiry sweep (the widget-tables
//     precedent: no external cron).
//   - the DB-ENFORCED park-dedup arbiter (codex r0 #1): a PARTIAL UNIQUE index
//     over (org_id, connector_key, instance_id, server_id, user_id, surface,
//     tool_name, args_hash) WHERE status = 'pending'. Concurrency-proof (two
//     racing parks cannot both insert) and scoped so identical tool/args on
//     DIFFERENT servers/surfaces/orgs never collapse. `parkPendingCall`'s
//     INSERT … ON CONFLICT names this exact predicate.
export function connectorInstancePendingCallSchemaQueries(
  schemaName: string,
): { text: string }[] {
  const q = schemaName.replaceAll('"', '""');
  return [
    {
      text: `CREATE TABLE IF NOT EXISTS "${q}"."connector_instance_pending_call" (
      id text NOT NULL,
      connector_key text NOT NULL,
      instance_id text NOT NULL,
      server_id text NOT NULL,
      tool_name text NOT NULL,
      args jsonb,
      args_hash text NOT NULL,
      args_bytes integer NOT NULL CHECK (args_bytes <= 262144),
      args_preview text NOT NULL,
      tool_fingerprint text NOT NULL,
      target_fingerprint text NOT NULL,
      derived_class text NOT NULL,
      surface text NOT NULL,
      user_id text NOT NULL,
      org_id text NOT NULL,
      primitive_name text,
      intent text,
      causation text,
      context jsonb,
      status text NOT NULL CHECK (status IN ('pending','executing','executed','failed','denied','cancelled','expired')),
      failure_code text,
      result_summary jsonb,
      decided_by text,
      decided_at timestamptz,
      consumed_at timestamptz,
      executing_deadline timestamptz,
      executed_at timestamptz,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      CONSTRAINT connector_instance_pending_call_args_status_chk
        CHECK ((status IN ('pending','executing')) = (args IS NOT NULL))
    )`,
    },
    {
      text: `CREATE INDEX IF NOT EXISTS connector_instance_pending_call_viewer_idx
      ON "${q}"."connector_instance_pending_call" (org_id, user_id, status, created_at DESC)`,
    },
    {
      text: `CREATE INDEX IF NOT EXISTS connector_instance_pending_call_expires_idx
      ON "${q}"."connector_instance_pending_call" (expires_at)`,
    },
    {
      text: `CREATE UNIQUE INDEX IF NOT EXISTS connector_instance_pending_call_dedup_idx
      ON "${q}"."connector_instance_pending_call"
         (org_id, connector_key, instance_id, server_id, user_id, surface, tool_name, args_hash)
      WHERE status = 'pending'`,
    },
  ];
}
