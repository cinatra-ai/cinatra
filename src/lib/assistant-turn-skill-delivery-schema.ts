// Bootstrap DDL for `assistant_turn_skill_delivery` — the durable per-chat-turn
// skill-DELIVERY record (cinatra#2240, finding F8 of the #2094 S7 acceptance
// E2E).
//
// A pure string builder with ZERO imports (a synchronous leaf, safe for
// `drizzle-store.ts`'s synchronous `require()` composition; see the
// postgres-sync-leaf-imports test), spread into `buildCreateStoreSchemaQueries`
// AFTER `assistantThreadSchemaQueries` so the FK target (`assistant_turns`)
// exists. The table is NET-NEW and purely ADDITIVE, so the idempotent bootstrap
// is the whole story on both fresh installs and the operator upgrade path (it
// re-runs at every boot) — no numbered migration, exactly like the
// `connector_instance_*` bootstrap leaves (migrations/README.md, "The idempotent
// bootstrap … covers additive evolution").
//
// WHY A CHILD OF `assistant_turns` AND NOT `agent_run_skills_used`:
// `agent_run_skills_used.run_id` is `NOT NULL REFERENCES agent_runs(id)`. A chat
// turn has no `agent_runs` row, so the agent ledger cannot key it without
// dropping that FK (losing the cascade guarantee for the agent path) or
// inventing a synthetic agent run. This table is the chat-side SOURCE; the
// efficacy ROLLUP stays single (`readSkillExposureAggregates` unions both
// sources), so there is one exposure/efficacy ledger, not two.
//
// SHAPE NOTES:
//  - `(turn_id, skill_id)` IS the primary key — a turn records each resolved
//    skill exactly once, which is also the no-double-write property on a retry
//    (the writer inserts `ON CONFLICT DO NOTHING`; a delivery fact is never
//    rewritten).
//  - `outcome` separates WHAT HAPPENED from HOW it travelled: only a
//    `delivered` row carries a `vehicle` + `delivery_mode`; `dropped` and
//    `refused` rows carry a `non_delivery_reason` instead. `refused` is the
//    loud no-vehicle path (cinatra#2094 F11) — the assistant's skills existed
//    and NOTHING could carry them, so the turn was refused. `dropped` is an
//    ORDINARY loss (injection cap, inline byte budget, Anthropic
//    rank-and-truncate, an unmountable OpenAI skill) and is never conflated
//    with a refusal.
//  - `vehicle = 'unknown'` is the FAIL-HONEST value for a delivery a future or
//    connector-supplied adapter reports under a `delivery_mode` this build
//    cannot classify. The delivery happened; only its transport name is
//    unresolvable, and `delivery_mode` still holds the raw value.
//  - `provider_skill_id` / `skill_version` are the Anthropic container
//    reference actually named on the wire (`container.skills`). Other vehicles
//    carry no version at this seam and leave them NULL.
//  - NO `run_id` column: it would duplicate `assistant_turns.run_id` and could
//    disagree with it. Read it through the parent (that column is indexed).
//  - NO `skill_kind` column: the delivery ABI (`SkillExposureEntry`) carries no
//    authoritative kind, and guessing one would put a fabricated value in an
//    audit record.

/** Bootstrap DDL for the per-turn skill-delivery record. MUST be spread AFTER
 *  `assistantThreadSchemaQueries` (the FK references `assistant_turns`). */
export function assistantTurnSkillDeliverySchemaQueries(
  schemaName: string,
): { text: string }[] {
  const s = schemaName.replaceAll('"', '""');
  return [
    {
      text: `CREATE TABLE IF NOT EXISTS "${s}"."assistant_turn_skill_delivery" (
      turn_id text NOT NULL REFERENCES "${s}"."assistant_turns" (id) ON DELETE CASCADE,
      skill_id text NOT NULL,
      outcome text NOT NULL CHECK (outcome IN ('delivered', 'dropped', 'refused')),
      provider text NOT NULL,
      vehicle text CHECK (vehicle IS NULL OR vehicle IN ('container-skills', 'tool-mount', 'inline', 'unknown')),
      delivery_mode text,
      invocation_attributable boolean,
      provider_skill_id text,
      skill_version text,
      non_delivery_reason text,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (turn_id, skill_id),
      -- Three BICONDITIONALS, so an untruthful row is unrepresentable in BOTH
      -- directions: a delivered row must name its transport and must NOT carry
      -- a non-delivery reason; a dropped/refused row must carry a reason and
      -- must NOT name a transport. A one-way implication would still admit
      -- e.g. a 'dropped' row with a vehicle, or a 'delivered' row with an
      -- excuse attached.
      CONSTRAINT assistant_turn_skill_delivery_vehicle_shape_check CHECK (
        (outcome = 'delivered') = (vehicle IS NOT NULL)
      ),
      CONSTRAINT assistant_turn_skill_delivery_mode_shape_check CHECK (
        (outcome = 'delivered') = (delivery_mode IS NOT NULL)
      ),
      CONSTRAINT assistant_turn_skill_delivery_reason_shape_check CHECK (
        (outcome = 'delivered') = (non_delivery_reason IS NULL)
      )
    )`,
    },
    // Per-skill rollup index — the axis the efficacy aggregate groups on.
    {
      text: `CREATE INDEX IF NOT EXISTS assistant_turn_skill_delivery_skill_idx ON "${s}"."assistant_turn_skill_delivery" (skill_id)`,
    },
  ];
}
