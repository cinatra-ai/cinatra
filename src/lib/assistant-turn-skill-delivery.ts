import "server-only";

/**
 * `assistant_turn_skill_delivery` store — the durable per-chat-turn skill
 * DELIVERY record (cinatra#2240, finding F8 of the #2094 S7 acceptance E2E).
 *
 * WHAT IT ANSWERS, from the store rather than the wire: "which skills did this
 * chat run actually get, via which vehicle, and what happened to the ones it
 * did not get?" Before this the answer existed only in an egress capture, so
 * the S7 acceptance's own "assert delivery from the run's records" wording was
 * unsatisfiable on chat.
 *
 * WRITE PATH — exactly one, at the TRUE dispatch boundary: the assistant
 * runtime (`src/lib/assistant-runtime/runtime.ts`) commits the record
 *   (a) immediately before the provider `stream()` call, so a turn that returns
 *       between delivery preparation and dispatch (an unreachable public MCP
 *       URL, the explicit-dispatch short circuit) never leaves a record
 *       claiming skills reached a model they never reached; or
 *   (b) on the loud no-vehicle REFUSAL (cinatra#2094 F11), where the record IS
 *       the point — it names every skill the operator's assistant lost.
 *
 * IDEMPOTENCE — `INSERT … ON CONFLICT (turn_id, skill_id) DO NOTHING`. A
 * delivery fact is an audit fact: a second write for the same key is never
 * allowed to REWRITE the first (that would launder an accidental double
 * execution). A user retry mints a fresh turn id and therefore a fresh record.
 *
 * ASYNC BY DESIGN — this is a request-time store on an already-async path, so
 * it uses the pooled `pg` layer (`@/lib/db/pooled`), not the ratcheted
 * synchronous bridge (`runPostgresQueriesSync`; see
 * `src/lib/postgres-sync-inventory.ts` — the sync bridge is the exceptional
 * escape hatch and a new sync call site needs a justification this path does
 * not have).
 *
 * The write is AWAITED and its failure is LOUD (a structured `console.error`)
 * but never fails the user's turn — the same posture as the agent-run ledger.
 * DB access mirrors `connector-instance-tool-policy-store.ts`: an INJECTED
 * query fn (unit-testable without a database) over a lazy pooled connection and
 * a schema-qualified table. The backing table is the ADDITIVE bootstrap DDL in
 * `assistant-turn-skill-delivery-schema.ts` (no numbered migration —
 * migrations/README.md).
 */

import { getPooledDb } from "@/lib/db/pooled";
import type { TurnSkillDeliveryRow } from "@/lib/assistant-runtime/skill-delivery-record";

export type { TurnSkillDeliveryRow };

const schemaName = process.env.SUPABASE_SCHEMA?.trim() || "cinatra";
const TABLE = "assistant_turn_skill_delivery";

export type TurnSkillDeliveryQuery = <T = unknown>(
  text: string,
  values?: readonly unknown[],
) => Promise<T[]>;

export type TurnSkillDeliveryDeps = {
  /** Injected query fn (tests pass a mock). Default = the pooled connection. */
  query?: TurnSkillDeliveryQuery;
  /** Injected schema (tests may override). Default = SUPABASE_SCHEMA / "cinatra". */
  schema?: string;
};

async function defaultQuery<T = unknown>(
  text: string,
  values?: readonly unknown[],
): Promise<T[]> {
  const pool = getPooledDb({ name: "assistant-turn-skill-delivery" });
  const result = await pool.query(text, values ? [...values] : undefined);
  return result.rows as T[];
}

function resolveDeps(deps?: TurnSkillDeliveryDeps): {
  query: TurnSkillDeliveryQuery;
  table: string;
} {
  const schema = deps?.schema ?? schemaName;
  // schemaName / SUPABASE_SCHEMA is operator config, never user input; quoted
  // defensively all the same (mirrors the store's `"schema"."table"` form).
  return {
    query: deps?.query ?? defaultQuery,
    table: `"${schema.replaceAll('"', '""')}"."${TABLE}"`,
  };
}

/** One persisted row, read back. */
export type PersistedTurnSkillDelivery = TurnSkillDeliveryRow & {
  turnId: string;
  createdAt: string;
};

/** Bind parameters emitted per row — the insert's column count. */
const COLUMNS = 10;
/**
 * Rows per INSERT statement. Postgres caps a statement at 65,535 bind
 * parameters, so at `COLUMNS` params/row a record of 6,554+ rows would fail the
 * WHOLE write and lose every row rather than the excess.
 *
 * Every realistic record is orders of magnitude smaller — the injection
 * contract caps a turn at `INJECTED_SKILL_CAP` (8) members — so this ceiling is
 * unreachable through the shipped ports and the single-statement path is what
 * actually runs. The chunk exists so the pathological case (an operator bundle
 * far beyond the cap, reaching a future port) degrades into several atomic
 * statements instead of failing entirely; it deliberately does NOT rewrite the
 * insert into `UNNEST`, which would change the shipped statement shape for a
 * case no live database has ever seen.
 *
 * MULTI-CHUNK ATOMICITY, stated plainly: chunks are separate statements, so a
 * failure part-way through a multi-chunk write leaves the earlier chunks
 * committed and the record partial. That is accepted, not overlooked — the path
 * is unreachable through every shipped port (the cap is 8), each chunk is
 * individually atomic, and because the insert is idempotent on
 * `(turn_id, skill_id)` a re-run for the same turn backfills the missing rows
 * without rewriting any existing fact. Making it transactional would mean
 * checking out a dedicated client and reshaping the injected-query seam this
 * store is tested through, for a case no port can produce.
 */
const MAX_ROWS_PER_STATEMENT = 6_000;

/**
 * Persist the turn's delivery record. Idempotent on `(turn_id, skill_id)`;
 * no-op on an empty row set. Returns the number of rows this call actually
 * INSERTED — 0 on a repeat, which is the no-double-write property the caller's
 * regression test asserts.
 *
 * Throws only on a genuine DB error; the runtime call site wraps it so a
 * telemetry write can never fail a user's turn.
 */
export async function recordTurnSkillDelivery(
  input: { turnId: string; rows: readonly TurnSkillDeliveryRow[] },
  deps?: TurnSkillDeliveryDeps,
): Promise<number> {
  if (input.rows.length === 0) return 0;
  const { query, table } = resolveDeps(deps);

  let inserted = 0;
  for (let start = 0; start < input.rows.length; start += MAX_ROWS_PER_STATEMENT) {
    inserted += await insertRecordChunk(
      query,
      table,
      input.turnId,
      input.rows.slice(start, start + MAX_ROWS_PER_STATEMENT),
    );
  }
  return inserted;
}

async function insertRecordChunk(
  query: TurnSkillDeliveryQuery,
  table: string,
  turnId: string,
  rows: readonly TurnSkillDeliveryRow[],
): Promise<number> {
  const valuesSql: string[] = [];
  const params: unknown[] = [];
  rows.forEach((row, i) => {
    const base = i * COLUMNS;
    valuesSql.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, ` +
        `$${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10})`,
    );
    params.push(
      turnId,
      row.skillId,
      row.outcome,
      row.provider,
      row.vehicle,
      row.deliveryMode,
      row.invocationAttributable,
      row.providerSkillId,
      row.skillVersion,
      row.nonDeliveryReason,
    );
  });

  const inserted = await query<{ turn_id: string }>(
    `INSERT INTO ${table}
       (turn_id, skill_id, outcome, provider, vehicle, delivery_mode,
        invocation_attributable, provider_skill_id, skill_version, non_delivery_reason)
     VALUES ${valuesSql.join(", ")}
     ON CONFLICT (turn_id, skill_id) DO NOTHING
     RETURNING turn_id`,
    params,
  );
  return inserted.length;
}

function mapRow(r: Record<string, unknown>): PersistedTurnSkillDelivery {
  return {
    turnId: String(r.turn_id),
    skillId: String(r.skill_id),
    outcome: String(r.outcome) as TurnSkillDeliveryRow["outcome"],
    provider: String(r.provider) as TurnSkillDeliveryRow["provider"],
    vehicle: r.vehicle == null ? null : (String(r.vehicle) as TurnSkillDeliveryRow["vehicle"]),
    deliveryMode: r.delivery_mode == null ? null : String(r.delivery_mode),
    invocationAttributable:
      r.invocation_attributable == null ? null : Boolean(r.invocation_attributable),
    providerSkillId: r.provider_skill_id == null ? null : String(r.provider_skill_id),
    skillVersion: r.skill_version == null ? null : String(r.skill_version),
    nonDeliveryReason: r.non_delivery_reason == null ? null : String(r.non_delivery_reason),
    createdAt:
      r.created_at instanceof Date
        ? r.created_at.toISOString()
        : String(r.created_at ?? ""),
  };
}

const SELECT_COLUMNS =
  "turn_id, skill_id, outcome, provider, vehicle, delivery_mode, " +
  "invocation_attributable, provider_skill_id, skill_version, non_delivery_reason, created_at";

/** The turn's record, delivered rows first then drops/refusals, skill id asc. */
export async function listTurnSkillDelivery(
  turnId: string,
  deps?: TurnSkillDeliveryDeps,
): Promise<PersistedTurnSkillDelivery[]> {
  const { query, table } = resolveDeps(deps);
  const rows = await query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS}
       FROM ${table}
      WHERE turn_id = $1
      ORDER BY (outcome <> 'delivered'), skill_id ASC`,
    [turnId],
  );
  return rows.map(mapRow);
}

/**
 * The record for an AG-UI RUN id — the identity an operator holds when looking
 * at a chat run (`assistant_turns.run_id`, which carries its own partial
 * index). Joined through the parent rather than denormalised, so the record can
 * never disagree with the turn it belongs to.
 */
export async function listTurnSkillDeliveryByRunId(
  runId: string,
  deps?: TurnSkillDeliveryDeps,
): Promise<PersistedTurnSkillDelivery[]> {
  const { query, table } = resolveDeps(deps);
  const schema = deps?.schema ?? schemaName;
  const turnsTable = `"${schema.replaceAll('"', '""')}"."assistant_turns"`;
  const rows = await query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS.split(", ")
      .map((c) => `d.${c}`)
      .join(", ")}
       FROM ${table} d
       JOIN ${turnsTable} t ON t.id = d.turn_id
      WHERE t.run_id = $1
      ORDER BY (d.outcome <> 'delivered'), d.skill_id ASC`,
    [runId],
  );
  return rows.map(mapRow);
}
