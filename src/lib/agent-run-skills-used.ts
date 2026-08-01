/**
 * agent_run_skills_used ledger access.
 *
 * Per-run snapshot of which skills were resolved, exposed, and invoked during a
 * run — the persistence layer for the S10 efficacy loop (cinatra#1368).
 *
 * Write paths:
 *   - Snapshot at run start: snapshotSkillsAtRunStart() inserts the resolved
 *     org/shared skill set (from getAssignedSkillIdsForAgent) with
 *     invocation_count=0 and delivery_mode/invocation_attributable left NULL
 *     (mode is not yet known at the sessionless run-start seam — it resolves at
 *     the per-step llm-bridge boundary). Idempotent on (run_id, skill_id).
 *     Called once per dispatch by the agent-execution worker
 *     (packages/agents/src/execution.ts).
 *   - Exposure at the delivery boundary: recordSkillExposure() upserts one row
 *     per skill the model was actually exposed to on an LLM step — INCLUDING
 *     personal deltas (which the run-start snapshot intentionally omits, having
 *     no verified owner) — stamping the delivery_mode + invocation_attributable
 *     the provider adapter reported (llm-bridge, cinatra#1368). Never resets
 *     invocation_count.
 *   - Increment on invocation: incrementSkillInvocation() upserts +
 *     increments invocation_count at the attributable skill-use boundary (an
 *     OpenAI shell read of a named /skills/<slug> file — the only delivery mode
 *     that surfaces a per-skill signal). Non-attributable modes (Gemini inline,
 *     Anthropic container, personal inline) never call it; their counts stay 0,
 *     which is why they can never become deprecation candidates.
 *
 * Read paths:
 *   - listSkillsUsedForRun() — Skills tab in the agent run detail page.
 *   - readSkillExposureAggregates() — per-skill exposure/invocation rollup for
 *     the skills-admin efficacy view + deprecation-candidate computation.
 */
import "server-only";

import type { SkillDeliveryMode } from "@cinatra-ai/llm";
import type { TurnSkillDeliveryRow } from "@/lib/assistant-runtime/skill-delivery-record";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { getPooledDb } from "@/lib/db/pooled";
import { getPostgresConnectionString, postgresSchema } from "@/lib/database";

export type { SkillDeliveryMode };

// SkillKind mirrors the agent_run_skills_used CHECK constraint. GitHub-installed
// skills are emitted as kind=installed.
export type SkillKind = "custom" | "installed" | "builtin";

export type AgentRunSkillUsed = {
  id: string;
  runId: string;
  skillId: string;
  skillKind: SkillKind;
  firstInvokedAt: string;
  invocationCount: number;
};

export function snapshotSkillsAtRunStart(input: {
  runId: string;
  skills: Array<{ skillId: string; skillKind: SkillKind }>;
}): void {
  if (input.skills.length === 0) return;
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  // Build a single multi-row insert with ON CONFLICT DO NOTHING so re-running
  // the snapshot is idempotent (e.g. on resume after pending_input).
  const valuesSql: string[] = [];
  const params: unknown[] = [];
  let p = 1;
  for (const s of input.skills) {
    valuesSql.push(`($${p++}, $${p++}, $${p++}, 0)`);
    params.push(input.runId, s.skillId, s.skillKind);
  }
  runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `INSERT INTO "${schema.replaceAll('"', '""')}"."agent_run_skills_used"
                 (run_id, skill_id, skill_kind, invocation_count)
               VALUES ${valuesSql.join(", ")}
               ON CONFLICT (run_id, skill_id) DO NOTHING`,
        values: params,
      },
    ],
  });
}

export function incrementSkillInvocation(input: {
  runId: string;
  skillId: string;
  skillKind: SkillKind;
  /**
   * The mode the invocation was observed through. Attributable invocations come
   * only from the OpenAI shell path today, so this defaults to "openai_shell".
   * Stamped on both the insert and the conflicting row so an invoked skill's
   * mode is always recorded.
   */
  deliveryMode?: SkillDeliveryMode;
}): void {
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  const table = `"${schema.replaceAll('"', '""')}"."agent_run_skills_used"`;
  const deliveryMode = input.deliveryMode ?? "openai_shell";
  runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        // An invocation is, by construction, an attributable event —
        // invocation_attributable=true on both insert and update.
        text: `INSERT INTO ${table}
                 (run_id, skill_id, skill_kind, invocation_count, delivery_mode, invocation_attributable)
               VALUES ($1, $2, $3, 1, $4, true)
               ON CONFLICT (run_id, skill_id)
               DO UPDATE SET
                 invocation_count = ${table}.invocation_count + 1,
                 delivery_mode = COALESCE(${table}.delivery_mode, EXCLUDED.delivery_mode),
                 invocation_attributable = true`,
        values: [input.runId, input.skillId, input.skillKind, deliveryMode],
      },
    ],
  });
}

/**
 * Record one exposure event per skill the model was actually delivered on an
 * LLM step — INCLUDING personal deltas (which the run-start snapshot omits).
 * Upserts on (run_id, skill_id): a fresh exposure inserts with
 * invocation_count=0; an existing row (e.g. the run-start snapshot, or a prior
 * step) keeps its invocation_count and is stamped with the resolved
 * delivery_mode + invocation_attributable. Best-effort, idempotent, and must
 * never fail a run (the caller wraps it).
 */
export function recordSkillExposure(input: {
  runId: string;
  exposures: Array<{
    skillId: string;
    skillKind: SkillKind;
    deliveryMode: SkillDeliveryMode;
    invocationAttributable: boolean;
  }>;
}): void {
  if (input.exposures.length === 0) return;
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  const table = `"${schema.replaceAll('"', '""')}"."agent_run_skills_used"`;
  const valuesSql: string[] = [];
  const params: unknown[] = [];
  let p = 1;
  for (const e of input.exposures) {
    valuesSql.push(`($${p++}, $${p++}, $${p++}, 0, $${p++}, $${p++})`);
    params.push(
      input.runId,
      e.skillId,
      e.skillKind,
      e.deliveryMode,
      e.invocationAttributable,
    );
  }
  runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `INSERT INTO ${table}
                 (run_id, skill_id, skill_kind, invocation_count, delivery_mode, invocation_attributable)
               VALUES ${valuesSql.join(", ")}
               ON CONFLICT (run_id, skill_id)
               DO UPDATE SET
                 delivery_mode = EXCLUDED.delivery_mode,
                 -- invocation_attributable is MONOTONIC (sticky-true): once a
                 -- skill has been exposed via an attributable mode in a run, a
                 -- later non-attributable exposure of the same (run, skill) —
                 -- e.g. a mixed-provider run, or an exposure landing after
                 -- incrementSkillInvocation already set it true — must NOT flip
                 -- it back to false, which would undercount the attributable
                 -- sample and hide a legitimate candidate. NULL (snapshot) reads
                 -- as false for the OR.
                 invocation_attributable =
                   COALESCE(${table}.invocation_attributable, false)
                   OR EXCLUDED.invocation_attributable,
                 -- cinatra#2091 S4: a real exposure supersedes any earlier
                 -- injection DROP marker for the same (run, skill) — the skill
                 -- did reach the model on this step.
                 injection_drop_reason = NULL`,
        values: params,
      },
    ],
  });
}

/**
 * Record skills the typed injection contract RESOLVED but did NOT deliver
 * (cinatra#2091, epic #2086 S4) — cap truncation and inline-budget overflow.
 *
 * A dropped skill never reached the model, so it gets NO delivery mode and NO
 * attributability; it is stamped with `injection_drop_reason` on the same
 * ledger row so the efficacy surface can distinguish "never delivered" from
 * "delivered and never invoked". `DO UPDATE` deliberately does NOT overwrite a
 * row that already carries a delivery mode: within one run a skill may be
 * dropped on one step and delivered on another, and the delivery is the
 * stronger fact.
 *
 * Best-effort and idempotent, exactly like the exposure writer — the caller
 * wraps it and a ledger write must never fail a run.
 */
export function recordSkillInjectionDrops(input: {
  runId: string;
  drops: Array<{ skillId: string; skillKind: SkillKind; reason: string }>;
}): void {
  if (input.drops.length === 0) return;
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  const table = `"${schema.replaceAll('"', '""')}"."agent_run_skills_used"`;
  const valuesSql: string[] = [];
  const params: unknown[] = [];
  let p = 1;
  for (const d of input.drops) {
    valuesSql.push(`($${p++}, $${p++}, $${p++}, 0, $${p++})`);
    params.push(input.runId, d.skillId, d.skillKind, d.reason);
  }
  runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `INSERT INTO ${table}
                 (run_id, skill_id, skill_kind, invocation_count, injection_drop_reason)
               VALUES ${valuesSql.join(", ")}
               ON CONFLICT (run_id, skill_id)
               DO UPDATE SET
                 injection_drop_reason =
                   CASE WHEN ${table}.delivery_mode IS NULL
                        THEN EXCLUDED.injection_drop_reason
                        ELSE ${table}.injection_drop_reason
                   END`,
        values: params,
      },
    ],
  });
}

/**
 * Per-skill exposure/invocation rollup across all runs, for the skills-admin
 * efficacy view and deprecation-candidate computation.
 *   - exposureRunCount: distinct runs the skill was exposed in (any mode).
 *   - attributableExposureRunCount: distinct runs the skill was exposed in via
 *     an INVOCATION-ATTRIBUTABLE mode (invocation_attributable=true) ON A PATH
 *     WHERE AN INVOCATION WOULD ACTUALLY HAVE BEEN OBSERVED. Only these count
 *     toward the minimum sample — a skill exposed only via non-attributable
 *     modes can never be a candidate.
 *   - invocationCount: total invocations across all runs.
 *   - lastExposedAt: most recent exposure (first_invoked_at proxy).
 *   - deliveryModes: distinct non-null modes observed, ascending.
 *
 * TWO SOURCES, ONE ROLLUP (cinatra#2240). The agent-run path writes
 * `agent_run_skills_used`; the CHAT path writes its per-turn delivery record to
 * `assistant_turn_skill_delivery` — it cannot share this table, whose `run_id`
 * is `NOT NULL REFERENCES agent_runs(id)` while a chat turn has no agent run.
 * This reader UNIONS them, so there is exactly one exposure/efficacy ledger and
 * no parallel bookkeeping downstream: `skill-efficacy.ts` and
 * `/configuration/skills` consume the same aggregate shape unchanged.
 *
 * WHY CHAT ROWS ARE NOT CANDIDATE-ELIGIBLE. `isDeprecationCandidate`
 * (skill-efficacy.ts) flags an ACTIVE skill exposed attributably at least
 * SKILL_DEPRECATION_MIN_EXPOSURE_SAMPLE times and NEVER invoked. That rule is
 * sound only where an invocation would have been OBSERVED. Chat mounts OpenAI
 * skills with `invocation_attributable = true` — truthfully; that is what the
 * adapter reports — but the chat path does not wire the `onSkillRead`
 * invocation signal, so a chat-delivered skill's invocation count can only ever
 * be 0. Counting those exposures toward the sample would manufacture false
 * deprecation candidates for healthy skills after ~20 chat turns. The chat arm
 * therefore contributes exposures, delivery modes and recency but NEVER the
 * candidate-eligible attributable count. Wiring chat invocation accounting (and
 * only then promoting the arm) is follow-up work, not a licence to corrupt the
 * signal now.
 *
 * Distinct-source counting is NAMESPACED (`agent:<run_id>` / `chat:<turn_id>`):
 * the two id spaces are unrelated, and counting raw ids across them could
 * collide. The AGENT arm's semantics are byte-unchanged.
 */
export type SkillExposureAggregate = {
  skillId: string;
  exposureRunCount: number;
  attributableExposureRunCount: number;
  invocationCount: number;
  lastExposedAt: string | null;
  deliveryModes: string[];
};

export function readSkillExposureAggregates(): SkillExposureAggregate[] {
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  const table = `"${schema.replaceAll('"', '""')}"."agent_run_skills_used"`;
  const chatTable = `"${schema.replaceAll('"', '""')}"."assistant_turn_skill_delivery"`;
  const [result] = runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `WITH exposures AS (
                 SELECT skill_id,
                        'agent:' || run_id AS source_key,
                        invocation_attributable,
                        invocation_count,
                        first_invoked_at AS observed_at,
                        delivery_mode,
                        TRUE AS candidate_eligible
                   FROM ${table}
                 UNION ALL
                 -- cinatra#2240 chat arm: DELIVERED rows only (a drop or a
                 -- refusal never reached the model, so it is not an exposure).
                 -- candidate_eligible=FALSE — see this function's doc comment.
                 SELECT skill_id,
                        'chat:' || turn_id AS source_key,
                        invocation_attributable,
                        0 AS invocation_count,
                        created_at AS observed_at,
                        delivery_mode,
                        FALSE AS candidate_eligible
                   FROM ${chatTable}
                  WHERE outcome = 'delivered'
               )
               SELECT
                 skill_id,
                 COUNT(DISTINCT source_key) AS exposure_run_count,
                 COUNT(DISTINCT source_key) FILTER (
                   WHERE candidate_eligible AND invocation_attributable IS TRUE
                 ) AS attributable_exposure_run_count,
                 COALESCE(SUM(invocation_count), 0) AS invocation_count,
                 MAX(observed_at) AS last_exposed_at,
                 COALESCE(
                   ARRAY_AGG(DISTINCT delivery_mode) FILTER (WHERE delivery_mode IS NOT NULL),
                   '{}'
                 ) AS delivery_modes
               FROM exposures
               GROUP BY skill_id`,
        values: [],
      },
    ],
  });
  const rows = (result?.rows ?? []) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    skillId: String(r.skill_id),
    exposureRunCount: Number(r.exposure_run_count ?? 0),
    attributableExposureRunCount: Number(r.attributable_exposure_run_count ?? 0),
    invocationCount: Number(r.invocation_count ?? 0),
    lastExposedAt: r.last_exposed_at == null ? null : String(r.last_exposed_at),
    deliveryModes: Array.isArray(r.delivery_modes)
      ? (r.delivery_modes as unknown[]).map((m) => String(m))
      : [],
  }));
}

export function listSkillsUsedForRun(input: { runId: string }): AgentRunSkillUsed[] {
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  const [result] = runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `SELECT id, run_id, skill_id, skill_kind, first_invoked_at, invocation_count
               FROM "${schema.replaceAll('"', '""')}"."agent_run_skills_used"
               WHERE run_id = $1
               ORDER BY invocation_count DESC, first_invoked_at ASC`,
        values: [input.runId],
      },
    ],
  });
  const rows = (result?.rows ?? []) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    runId: String(r.run_id),
    skillId: String(r.skill_id),
    skillKind: String(r.skill_kind) as SkillKind,
    firstInvokedAt: String(r.first_invoked_at),
    invocationCount: Number(r.invocation_count ?? 0),
  }));
}

// ---------------------------------------------------------------------------
// THE CHAT ARM — `assistant_turn_skill_delivery` (cinatra#2240, finding F8 of
// the #2094 S7 acceptance E2E).
//
// Lives in THIS module, beside `readSkillExposureAggregates` above, because that
// rollup already UNIONs this very table: the writer and the reader of one arm of
// one ledger belong together. Splitting them across modules is how a table ends
// up written in one shape and read in another.
//
// WHAT IT ANSWERS, from the store rather than the wire: "which skills did this
// chat run actually get, via which vehicle, and what happened to the ones it did
// not get?" Before this the answer existed only in an egress capture, so the S7
// acceptance's own "assert delivery from the run's records" wording was
// unsatisfiable on chat.
//
// WRITE PATH — exactly one, at the OBSERVED dispatch boundary in the assistant
// runtime (`src/lib/assistant-runtime/runtime.ts`): the record is committed only
// once a provider step began AND the provider produced output, so a turn that
// failed before egress never leaves a row claiming skills reached a model they
// never reached. The loud no-vehicle REFUSAL (cinatra#2094 F11) commits its own
// record, where naming every skill the operator's assistant lost IS the point.
//
// IDEMPOTENCE — `INSERT … ON CONFLICT (turn_id, skill_id) DO NOTHING`. A delivery
// fact is an audit fact: a second write for the same key is never allowed to
// REWRITE the first (that would launder an accidental double execution). A user
// retry mints a fresh turn id and therefore a fresh record.
//
// ASYNC, UNLIKE THE AGENT ARM ABOVE — a deliberate difference, not an accident.
// The agent arm predates the pooled layer and rides the ratcheted synchronous
// bridge (inventoried in `src/lib/postgres-sync-inventory.ts`, which itself
// records those call sites as "migratable to async pooled access"). This is a
// request-time write on an already-async path, so it uses the pooled `pg` layer
// directly; the sync bridge is the exceptional escape hatch and a NEW sync call
// site would need a justification this path does not have.
//
// The write is AWAITED and its failure is LOUD (a structured `console.error`) but
// never fails the user's turn. DB access mirrors
// `connector-instance-tool-policy-store.ts`: an INJECTED query fn (unit-testable
// without a database) over a pooled connection and a schema-qualified table. The
// backing table is the ADDITIVE bootstrap DDL in `assistant-thread-schema.ts`,
// beside its FK parent (no numbered migration — migrations/README.md).
// ---------------------------------------------------------------------------

const TURN_SKILL_DELIVERY_TABLE = "assistant_turn_skill_delivery";

/** Re-exported so a consumer of this ledger needs one import, not two. */
export type { TurnSkillDeliveryRow };

export type TurnSkillDeliveryQuery = <T = unknown>(
  text: string,
  values?: readonly unknown[],
) => Promise<T[]>;

export type TurnSkillDeliveryDeps = {
  /** Injected query fn (tests pass a mock). Default = the pooled connection. */
  query?: TurnSkillDeliveryQuery;
  /** Injected schema (tests may override). Default = the app schema. */
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
  const schema = deps?.schema ?? postgresSchema;
  // postgresSchema is operator config, never user input; quoted
  // defensively all the same (mirrors the store's `"schema"."table"` form).
  return {
    query: deps?.query ?? defaultQuery,
    table: `"${schema.replaceAll('"', '""')}"."${TURN_SKILL_DELIVERY_TABLE}"`,
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
  const schema = deps?.schema ?? postgresSchema;
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
