/**
 * run_selected_skill_revisions store — the AUTHORITATIVE per-run selected
 * skill-revision set (cinatra#2041, epic #2037 S3, Point R).
 *
 * S0 (cinatra#2038) landed the immutable table + the `SelectedSkillRevision`
 * contract; this is its access layer. The set is the ONE authoritative per-run
 * selection every delivery path consumes:
 *   - the execution-start snapshot materializes the run's skill ledger from it;
 *   - the llm-bridge delivers from it instead of recomputing when a set exists.
 * A confirmed/auto-applied set therefore changes what BOTH deliver; with NO set,
 * behavior is unchanged (each consumer falls back to today's computed
 * assignment). Distinct from the telemetry-only `agent_run_skills_used` ledger
 * (untouched — that stays exposure/invocation telemetry).
 *
 * IMMUTABILITY: a selection is written once per (run_id, skill_id) — the insert
 * is `ON CONFLICT (run_id, skill_id) DO NOTHING`, so a re-emit on resume can
 * never overwrite the pinned revision a run already committed to. The `id` PK is
 * generated here (S0's table carries `id text PRIMARY KEY`).
 *
 * Mirrors the sync-store shape of `agent-run-skills-used.ts` (server-only,
 * `runPostgresQueriesSync`) so the same run-scoped call sites (execution worker,
 * llm-bridge route) consume it with one import surface.
 */
import "server-only";

import { randomUUID } from "node:crypto";

import { SELECTION_SOURCES } from "@cinatra-ai/skills/recommendation";
import { PRE_START_RUN_STATUSES_WITHOUT_A_START_STAMP } from "@cinatra-ai/agents/run-status";

import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { runPostgresQueriesAsync } from "@/lib/postgres-async";
import { RUN_RECOMMENDATION_OFFERED_SET_TABLE } from "@/lib/artifacts/artifact-review-gate-schema";
import { getPostgresConnectionString, postgresSchema } from "@/lib/database";
import type { SelectionSource } from "@cinatra-ai/skills/recommendation";

export type { SelectionSource };

/** One persisted per-run selection row (mirrors `SelectedSkillRevision` from
 * `@/lib/lifecycle`, with the source narrowed to the S3 enum). */
export type RunSelectedSkillRevision = {
  id: string;
  runId: string;
  skillId: string;
  skillRevisionId: string;
  selectionSource: string;
  selectedAt: string;
};

/**
 * Persist the immutable per-run selection set. Idempotent on (run_id, skill_id):
 * a re-run (resume) never overwrites an existing pinned revision — first write
 * wins. No-op on an empty set. Best-effort by contract at the call site (a
 * selection-store write must never fail a run); this function itself throws only
 * on a genuine DB error, which the caller wraps.
 */
export function writeRunSelectedSkillRevisions(input: {
  runId: string;
  selections: Array<{
    skillId: string;
    skillRevisionId: string;
    selectionSource: SelectionSource | string;
  }>;
}): void {
  if (input.selections.length === 0) return;
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  const table = `"${schema.replaceAll('"', '""')}"."run_selected_skill_revisions"`;
  const valuesSql: string[] = [];
  const params: unknown[] = [];
  let p = 1;
  for (const s of input.selections) {
    valuesSql.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
    params.push(
      randomUUID(),
      input.runId,
      s.skillId,
      s.skillRevisionId,
      s.selectionSource,
    );
  }
  runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `INSERT INTO ${table}
                 (id, run_id, skill_id, skill_revision_id, selection_source)
               VALUES ${valuesSql.join(", ")}
               ON CONFLICT (run_id, skill_id) DO NOTHING`,
        values: params,
      },
    ],
  });
}

/**
 * Read the authoritative per-run selection set. Ordered by skill_id for a
 * stable, reproducible delivery order. Empty array ⇒ no set exists (the
 * consumer falls back to its computed assignment).
 */
export function readRunSelectedSkillRevisions(
  runId: string,
): RunSelectedSkillRevision[] {
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  const [result] = runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `SELECT id, run_id, skill_id, skill_revision_id, selection_source, selected_at
               FROM "${schema.replaceAll('"', '""')}"."run_selected_skill_revisions"
               WHERE run_id = $1
               ORDER BY skill_id ASC`,
        values: [runId],
      },
    ],
  });
  const rows = (result?.rows ?? []) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    runId: String(r.run_id),
    skillId: String(r.skill_id),
    skillRevisionId: String(r.skill_revision_id),
    selectionSource: String(r.selection_source),
    selectedAt: String(r.selected_at),
  }));
}

/**
 * CLEAR the run's selection rows for the named skills — BUT ONLY WHILE THE RUN
 * HAS NOT STARTED (cinatra#3047).
 *
 * WHY IMMUTABILITY IS NOT WEAKENED BY THIS. The rule this module opens with is
 * "a re-emit on resume can never overwrite the pinned revision a run already
 * committed to", and the commitment it protects is an EXECUTING run's: the
 * execution-start snapshot materializes the run's skill ledger from this set, so
 * from the moment the run is dispatched the set is history and may not move. A
 * run that has not been dispatched has materialized nothing and has committed to
 * nothing — its selection is still the reader's answer to a question, and the
 * Skills step lets them change that answer until the run starts.
 *
 * THE BOUNDARY IS IN THE STATEMENT, NOT IN THE CALLER. The test is a join
 * inside the DELETE, against the run's OWN `started_at` — stamped once, at the
 * `queued->running` dispatch CAS — together with
 * `PRE_START_RUN_STATUSES_WITHOUT_A_START_STAMP`, the platform's set of the
 * statuses a run can hold while it has not executed. So a caller that asks to
 * clear a started run's rows deletes NOTHING, whatever it believed about the run
 * when it asked, and there is no window between a status read and the write for
 * the run to be dispatched in.
 *
 * THE STAMP, NOT THE STATUS ALONE (cinatra#3062). The test used to be the status
 * set by itself, which left `pending_approval` out — and that is the status the
 * skills hold's own park puts a NOT-YET-EXECUTED run into. A returning reader was
 * therefore offered a live box on a run that had not started and had their change
 * refused by this statement when they used it. The stamp tells the hold's park
 * apart from an interrupt raised mid-flight, which the status cannot.
 *
 * SCOPED TO THE NAMED SKILLS, never to the run. The caller names the skills its
 * own decision is authoritative for — the hold's offered set — so a selection
 * written by another path for a skill this decision never asked about is
 * untouched.
 *
 * Returns the number of rows actually removed, so a caller can state what it
 * did rather than assume it.
 */
export function clearRunSelectedSkillRevisionsBeforeStart(input: {
  runId: string;
  skillIds: readonly string[];
}): number {
  if (input.skillIds.length === 0) return 0;
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema.replaceAll('"', '""');
  const [result] = runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `DELETE FROM "${schema}"."run_selected_skill_revisions" s
               USING "${schema}"."agent_runs" r
               WHERE s.run_id = $1
                 AND r.id = s.run_id
                 AND s.skill_id = ANY($2::text[])
                 AND r.started_at IS NULL
                 AND r.status = ANY($3::text[])`,
        values: [
          input.runId,
          [...input.skillIds],
          [...PRE_START_RUN_STATUSES_WITHOUT_A_START_STAMP],
        ],
      },
    ],
  });
  return result?.rowCount ?? 0;
}

/**
 * REPLACE the run's recommendation-sourced selection for one hold's offer, in
 * ONE transaction, and ONLY while the run has not started (cinatra#3047,
 * convergence finding 3).
 *
 * WHY A REPLACE AND NOT A CLEAR FOLLOWED BY A WRITE. The two statements were
 * separately guarded at first: the DELETE tested the run's status, the INSERT
 * did not, and nothing held them together. A dispatch landing between them left
 * two ways to be wrong — execution could materialize its ledger from a
 * half-deleted set, and the INSERT could then add rows to a run that had already
 * started. Both statements now test the SAME status inside ONE transaction, so
 * the write either lands whole on a pre-start run or does not land at all.
 *
 * THE STATUS TEST IS IN THE STATEMENTS, NOT IN THE CALLER. A caller that asks to
 * replace a started run's set writes NOTHING, whatever it believed about the run
 * when it asked, and it is TOLD so — the answer is `false`, not silence, so the
 * decision path can refuse rather than report a write that did not happen.
 *
 * SCOPED TO THE HOLD'S OWN OFFER. `scopeSkillIds` is the set this decision is
 * authoritative for; a selection written by another path for a skill this hold
 * never offered is untouched. Retained ids keep their existing row, which is
 * what pins them to the revision the reader was shown.
 */
export function replaceRunSelectedSkillRevisionsBeforeStart(input: {
  runId: string;
  scopeSkillIds: readonly string[];
  selections: Array<{
    skillId: string;
    skillRevisionId: string;
    selectionSource: SelectionSource | string;
  }>;
}): boolean {
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema.replaceAll('"', '""');
  const table = `"${schema}"."run_selected_skill_revisions"`;
  const runs = `"${schema}"."agent_runs"`;
  const preStart = [...PRE_START_RUN_STATUSES_WITHOUT_A_START_STAMP];
  const kept = new Set(input.selections.map((s) => s.skillId));
  const dropped = input.scopeSkillIds.filter((skillId) => !kept.has(skillId));

  const queries: Array<{ text: string; values: unknown[] }> = [
    // 1. THE ANSWER THE CALLER GETS. Read inside the same transaction as the two
    //    writes, so "it applied" is the transaction's own view and not a probe
    //    taken a moment earlier.
    {
      text: `SELECT 1 FROM ${runs} WHERE id = $1 AND started_at IS NULL AND status = ANY($2::text[])`,
      values: [input.runId, preStart],
    },
  ];
  if (dropped.length > 0) {
    queries.push({
      text: `DELETE FROM ${table} s
             USING ${runs} r
             WHERE s.run_id = $1
               AND r.id = s.run_id
               AND s.skill_id = ANY($2::text[])
               AND r.started_at IS NULL
               AND r.status = ANY($3::text[])`,
      values: [input.runId, dropped, preStart],
    });
  }
  if (input.selections.length > 0) {
    const rows: string[] = [];
    const values: unknown[] = [];
    let p = 1;
    for (const s of input.selections) {
      rows.push(`($${p++}::text, $${p++}::text, $${p++}::text, $${p++}::text, $${p++}::text)`);
      values.push(randomUUID(), input.runId, s.skillId, s.skillRevisionId, s.selectionSource);
    }
    const runIdParam = `$${p++}`;
    const statusParam = `$${p++}`;
    values.push(input.runId, preStart);
    queries.push({
      text: `INSERT INTO ${table} (id, run_id, skill_id, skill_revision_id, selection_source)
             SELECT v.id, v.run_id, v.skill_id, v.skill_revision_id, v.selection_source
             FROM (VALUES ${rows.join(", ")})
               AS v(id, run_id, skill_id, skill_revision_id, selection_source)
             WHERE EXISTS (
               SELECT 1 FROM ${runs} r
               WHERE r.id = ${runIdParam}
                 AND r.started_at IS NULL
                 AND r.status = ANY(${statusParam}::text[])
             )
             ON CONFLICT (run_id, skill_id) DO NOTHING`,
      values,
    });
  }
  const [probe] = runPostgresQueriesSync({ connectionString, transaction: true, queries });
  return (probe?.rows?.length ?? 0) > 0;
}

/**
 * Whether an authoritative selection set exists for a run — the guard every
 * delivery path checks before choosing set-vs-computed. A single EXISTS probe
 * (cheaper than reading the full set when the consumer only needs the boolean).
 */
export function hasRunSelectedSkillRevisions(runId: string): boolean {
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  const [result] = runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `SELECT 1
               FROM "${schema.replaceAll('"', '""')}"."run_selected_skill_revisions"
               WHERE run_id = $1
               LIMIT 1`,
        values: [runId],
      },
    ],
  });
  return (result?.rows?.length ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// The REJECTED half of the efficacy split (cinatra#2040 S2, routed from S3 AC-6).
//
// S3 computed accepted vs rejected in `summarizeRecommendationEfficacy` but only
// persisted the ACCEPTED selections (above); the REJECTED recommendations were
// dropped. S2 owns the durable rejected row (`run_rejected_recommendations`, the
// schema sibling of the batch-disposition table). It lives HERE — beside the
// accepted-half writer, both sync-pg — so the confirm path writes both halves
// through the SAME already-reachable module (no new first-party route-graph node,
// no coupling to the heavier repair store).
// ---------------------------------------------------------------------------

export type RunRejectedRecommendation = {
  skillId: string;
  skillRevisionId: string | null;
  recommendationSource: string;
  recommendedRank: number | null;
};

export type RunRejectedRecommendationInput = {
  skillId: string;
  skillRevisionId?: string | null;
  recommendationSource: string;
  recommendedRank?: number | null;
};

/**
 * The ONE rejected-rows INSERT, as a statement rather than as a call. Shared by
 * the standalone writer below and by the transactional skip write further down,
 * so both halves of the efficacy split speak exactly the same SQL and neither
 * can drift into a different conflict rule.
 */
function buildRejectedRecommendationsInsert(
  schema: string,
  runId: string,
  rejected: readonly RunRejectedRecommendationInput[],
): { text: string; values: unknown[] } {
  const table = `"${schema.replaceAll('"', '""')}"."run_rejected_recommendations"`;
  const valuesSql: string[] = [];
  const params: unknown[] = [];
  let p = 1;
  for (const r of rejected) {
    valuesSql.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
    params.push(
      randomUUID(),
      runId,
      r.skillId,
      r.skillRevisionId ?? null,
      r.recommendationSource,
      r.recommendedRank ?? null,
    );
  }
  return {
    text: `INSERT INTO ${table}
             (id, run_id, skill_id, skill_revision_id, recommendation_source, recommended_rank)
           VALUES ${valuesSql.join(", ")}
           ON CONFLICT (run_id, skill_id) DO NOTHING`,
    values: params,
  };
}

/**
 * Persist the REJECTED half of the recommendation efficacy split (the accepted
 * half rode `writeRunSelectedSkillRevisions`). Idempotent on (run_id, skill_id) —
 * first write wins. No-op on an empty set; best-effort at the call site (a
 * telemetry write must never fail a run).
 *
 * NOT the SKIP path. A skip's rejected rows are `user_skipped`, which the state
 * reader treats as skip evidence, so they may never commit on their own — they
 * ride `writeRunRecommendationSkip`'s transaction instead. This writer stays for
 * the CONFIRM path, whose `recommended_not_kept` rows settle nothing by
 * themselves.
 */
export function writeRunRejectedRecommendations(input: {
  runId: string;
  rejected: Array<RunRejectedRecommendationInput>;
}): void {
  if (input.rejected.length === 0) return;
  const connectionString = getPostgresConnectionString();
  runPostgresQueriesSync({
    connectionString,
    queries: [buildRejectedRecommendationsInsert(postgresSchema, input.runId, input.rejected)],
  });
}

/**
 * The recommendation_source stamp a DURABLE SKIP writes (cinatra#2067 item 4).
 * A human who SKIPS the run-start chip-row makes an explicit decision — "use the
 * computed default set" — that must be distinguishable from "no decision" (no
 * rows) AND from a confirm (which writes selection rows + `recommended_not_kept`
 * rejected rows). A skip writes NO selection row (the run falls back to the
 * computed default) and one `user_skipped` rejected row per recommended
 * candidate — the durable, queryable skip evidence.
 */
export const SKIP_RECOMMENDATION_SOURCE = "user_skipped" as const;

// ---------------------------------------------------------------------------
// THE RUN-LEVEL SKIP RECORD (cinatra#2794 S9b) — its own table, keyed by run.
//
// A skip is a decision about the RUN, and the run's card settles only when that
// decision is on record. The rejected table above is keyed (run_id, skill_id),
// so a skip that names no skill — every offered candidate drifted away while the
// run sat parked, or the template reads back with no package — had no row to
// occupy. The stop-gap was a RESERVED skill id, `__run_level_skip__`, written
// into that table as though it were a skill.
//
// That stop-gap is GONE, because it was only safe while nobody typed a
// particular string: skill ids are caller-provided text (`createOrUpdateSkill`
// takes `input.skillId` verbatim) and no constraint excluded the reserved value.
// One collision produced two failures — the efficacy reader filtered the id out,
// silently dropping a genuine rejected skill from the accepted/rejected split,
// and a genuine rejection could be misread as a run-level marker.
//
// `run_recommendation_skips` is that record: PK `run_id`, so the write is
// idempotent per run and the marker needs no skill to name. See the bootstrap
// leaf in `@/lib/artifacts/artifact-review-gate-schema` and its migration twin
// core__0095 for the shape rationale.
// ---------------------------------------------------------------------------

/**
 * Persist a skip's DURABLE EVIDENCE — the run-level marker and, optionally, the
 * per-skill `user_skipped` rows that accompany it — AND VERIFY THE MARKER
 * LANDED. Returns whether the marker is READABLE afterwards; the caller releases
 * the run's park only on `true`.
 *
 * ONE TRANSACTION, BECAUSE A HALF-COMMITTED SKIP SETTLES THE CARD ON A REFUSED
 * DECISION (cinatra#2794 round-8 finding 2). The two halves used to be two
 * separate autocommitted writes: the per-skill rows first, the marker second. A
 * marker that failed after those rows committed refused the skip and left the
 * park LIVE — while `hasRunRecommendationSkip` below answered `skipped` from its
 * legacy `recommendation_source` arm, settling the card for a decision the
 * action had just refused, on a run still parked. That arm cannot be narrowed
 * out of the failure path: nothing distinguishes a pre-core__0095 row from a row
 * orphaned this way. So the halves commit together or not at all: the rows can
 * no longer outlive the marker they belong to.
 *
 * WHY A VERIFIED WRITE, AND NOT JUST A WRITE. The marker insert is `ON CONFLICT
 * (run_id) DO NOTHING` so a retried skip converges instead of duplicating — but
 * that also means the statement reports success both when it inserted and when
 * it silently did nothing. "The write did not throw" is therefore NOT the same
 * fact as "the marker is on record", and the release must turn on the latter:
 * releasing a run while losing the record of its decision is exactly the
 * vanishing card this whole path exists to remove.
 *
 * WHAT `true` MEANS UNDER THE TRANSACTION, AND WHAT A REFUSAL DOES NOT MEAN.
 * The read-back now runs INSIDE the transaction, so it sees this statement's own
 * row rather than a committed one — the durability it used to assert comes from
 * the COMMIT instead. The worker publishes its result only AFTER `COMMIT`
 * resolves, so `true` still means "the marker is durably on record".
 *
 * A refusal is the weaker direction, and the weakness is the sync bridge's, not
 * this write's. A statement error rolls the whole transaction back, so the
 * ordinary failure leaves nothing. But the worker can also lose the COMMIT'S
 * RESULT after Postgres accepted it — the 30s timeout expires, the connection
 * drops mid-response, the response file cannot be written — and the caller then
 * refuses over a transaction that DID commit. That window is the one
 * `postgres-sync.ts` names in its timeout note, and it is why this site now
 * passes `transaction: true`: it moves the write out of the UNBOUNDED
 * autocommitted class and into the BOUNDED transactional one. What the window
 * can no longer produce is a HALF — an ambiguous ending leaves both halves or
 * neither, so the marker is always there to name the decision the rows describe,
 * and the retry converges on the same row instead of writing a second decision.
 *
 * Throws on a genuine DB error; the caller wraps both outcomes into the one
 * typed refusal.
 *
 * IDEMPOTENCE IS FIRST-WRITE-WINS ON BOTH HALVES, unchanged: the marker is
 * `ON CONFLICT (run_id) DO NOTHING` and the rows are `ON CONFLICT
 * (run_id, skill_id) DO NOTHING`. A retry whose offered set drifted can
 * therefore add a row the first attempt did not carry while `candidate_count`
 * keeps the first attempt's number. That is the pre-existing behaviour of both
 * tables, and the count is read as "how many rows this DECISION named", not as a
 * live row count.
 */
export function writeRunRecommendationSkip(input: {
  runId: string;
  /** The principal whose decision this was — the fail-closed owner guard has
   * already proved it is the run's `runBy`. */
  skippedBy: string;
  /** How many per-skill efficacy rows rode with this skip (0 = drift left
   * nothing to name; the marker still stands). */
  candidateCount: number;
  /** The per-skill efficacy half, committed IN THE SAME TRANSACTION as the
   * marker. Empty or absent under drift — a legitimate state, and still a skip. */
  rejected?: ReadonlyArray<RunRejectedRecommendationInput>;
}): boolean {
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  const table = `"${schema.replaceAll('"', '""')}"."run_recommendation_skips"`;
  const rejected = input.rejected ?? [];
  const queries = [
    ...(rejected.length > 0
      ? [buildRejectedRecommendationsInsert(schema, input.runId, rejected)]
      : []),
    {
      text: `INSERT INTO ${table} (run_id, skipped_by, candidate_count)
             VALUES ($1, $2, $3)
             ON CONFLICT (run_id) DO NOTHING`,
      values: [input.runId, input.skippedBy, input.candidateCount],
    },
    {
      text: `SELECT 1 FROM ${table} WHERE run_id = $1 LIMIT 1`,
      values: [input.runId],
    },
  ];
  const results = runPostgresQueriesSync({ connectionString, queries, transaction: true });
  const verified = results[results.length - 1];
  return (verified?.rows?.length ?? 0) > 0;
}

/**
 * Whether a run carries durable SKIP evidence. Distinguishes an explicit skip
 * from a no-decision run (issue #2067 AC-3 store evidence) — the fact the state
 * reader turns into a settled `skipped` card.
 *
 * TWO SOURCES, ON PURPOSE. The run-level record is the authority for every skip
 * taken since cinatra#2794. Runs skipped BEFORE it carry their evidence only as
 * `user_skipped` rows in the rejected table, and core__0095 deliberately ships
 * no backfill (it would have to invent a `skipped_by` those rows never
 * recorded), so the legacy arm keeps an already-skipped run's card settling
 * instead of regressing it to `none`. The legacy arm keys on the SOURCE column,
 * never on a reserved skill id, so a real skill named `__run_level_skip__` is
 * irrelevant to it.
 */
export function hasRunRecommendationSkip(runId: string): boolean {
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  const q = schema.replaceAll('"', '""');
  const [runLevel, legacy] = runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `SELECT 1 FROM "${q}"."run_recommendation_skips" WHERE run_id = $1 LIMIT 1`,
        values: [runId],
      },
      {
        text: `SELECT 1
               FROM "${q}"."run_rejected_recommendations"
               WHERE run_id = $1 AND recommendation_source = $2
               LIMIT 1`,
        values: [runId, SKIP_RECOMMENDATION_SOURCE],
      },
    ],
  });
  return (runLevel?.rows?.length ?? 0) > 0 || (legacy?.rows?.length ?? 0) > 0;
}

/**
 * Read the durable rejected-recommendation rows for a run (ordered by skill_id).
 *
 * NO ROW IS EXCLUDED. Every row here means "this skill was offered and not
 * kept", and that is now true of every row without exception: the run-level skip
 * marker has its own table, so this reader no longer has to filter a reserved
 * skill id out — which is what used to make a legitimate skill id
 * `__run_level_skip__` unreadable in the efficacy split.
 */
export function readRunRejectedRecommendations(runId: string): RunRejectedRecommendation[] {
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  const [result] = runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `SELECT skill_id, skill_revision_id, recommendation_source, recommended_rank
               FROM "${schema.replaceAll('"', '""')}"."run_rejected_recommendations"
               WHERE run_id = $1
               ORDER BY skill_id ASC`,
        values: [runId],
      },
    ],
  });
  const rows = (result?.rows ?? []) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    skillId: String(r.skill_id),
    skillRevisionId: r.skill_revision_id == null ? null : String(r.skill_revision_id),
    recommendationSource: String(r.recommendation_source),
    recommendedRank: r.recommended_rank == null ? null : Number(r.recommended_rank),
  }));
}

/**
 * What ONE chip recorded, for the SETTLED reading the ratified drawing fixes
 * (design `specs/app-lifecycle-cards.html` §V at 60b27dfbb8a2: "one chip per
 * skill, each showing what it recorded"). Derived from the run's OWN durable
 * evidence — nothing new is written to represent it:
 *
 *   confirmed — a selection row whose source is `recommended_confirmed`
 *               (the reader took the skill as scored);
 *   adjusted  — a selection row whose source is `user_adjusted` (the reader
 *               opened ADJUST on a scored skill and settled it there) or
 *               `user_forced` (the reader put a skill the scorer did NOT
 *               recommend onto the run). Both are "the reader shaped this one";
 *               the two sources are kept apart in the store because only the
 *               second contradicts the scorer.
 *   skipped   — a rejected-recommendation row (`recommended_not_kept` from a
 *               confirm that left it out, or `user_skipped` from a skip).
 *
 * `name` is the skill's DISPLAY NAME — what §V's chips print, held and settled
 * alike ("Enrich contacts", never `@vendor/pkg:enrich` and never the slug
 * `enrich-contacts`). It is the OWNING EXTENSION'S MANIFEST `cinatra.displayName`,
 * resolved server-side beside the rest of the skill's metadata; the evidence
 * rows carry ids only, so the name is joined in by the caller that can resolve
 * it and falls back to the id when nothing can: a settled chip prints the best
 * true name available, never an invented one.
 */
export type RunRecommendationDecidedSkill = {
  skillId: string;
  name: string;
  mark: "confirmed" | "adjusted" | "skipped";
};

/**
 * Build §V's settled per-chip reading out of the two durable halves the run
 * already writes. A selection row wins over a rejected row for the same skill
 * (a skill that is IN the run's authoritative set was kept, whatever else was
 * recorded on the way), and the order is by skill id so the settled row is
 * stable across reads.
 *
 * `nameBySkillId` is the display-name join (cinatra#2841). The evidence rows are
 * ids; §V's chips are names. An id with no resolved name keeps the id as its
 * name — the settled row prints the truest label it has rather than dropping the
 * chip or inventing a title.
 */
export function decidedSkillsFromEvidence(
  selected: Pick<RunSelectedSkillRevision, "skillId" | "selectionSource">[],
  rejected: Pick<RunRejectedRecommendation, "skillId">[],
  nameBySkillId?: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
): RunRecommendationDecidedSkill[] {
  const nameOf = (skillId: string): string => {
    const resolved =
      nameBySkillId instanceof Map
        ? nameBySkillId.get(skillId)
        : (nameBySkillId as Record<string, string> | undefined)?.[skillId];
    return resolved != null && resolved !== "" ? resolved : skillId;
  };
  const marks = new Map<string, RunRecommendationDecidedSkill["mark"]>();
  for (const row of selected) {
    // BOTH human-edit sources read as §V's `adjusted` mark: `user_adjusted` (an
    // in-set skill settled through ADJUST) and `user_forced` (a skill the scorer
    // did not recommend, put on by the reader). Anything else — a plain confirm
    // or a headless auto-apply — is `confirmed`.
    marks.set(
      row.skillId,
      row.selectionSource === SELECTION_SOURCES.userForced ||
        row.selectionSource === SELECTION_SOURCES.userAdjusted
        ? "adjusted"
        : "confirmed",
    );
  }
  for (const row of rejected) {
    if (!marks.has(row.skillId)) marks.set(row.skillId, "skipped");
  }
  return [...marks.entries()]
    .map(([skillId, mark]) => ({ skillId, name: nameOf(skillId), mark }))
    .sort((a, b) => (a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0));
}

// ---------------------------------------------------------------------------
// THE OFFERED SET (cinatra#2906) — what a recommendation card actually showed.
//
// The accepted half above records what a run RESOLVED. This records what the
// reader was ASKED, at the moment the card was drawn, so the confirm can resolve
// against the set on screen instead of asking for the list again and recording
// against a different answer.
//
// KEYED BY THE HOLD, not the run: one run can be parked, decided, and parked
// again, and each of those holds offered its own set. The hold id is exactly
// what the row already hands back on confirm.
//
// THE OFFER IS IMMUTABLE FOR THE LIFE OF THE HOLD. The FIRST draw claims it and
// every later draw reads the claim back; nothing replaces it. A replace-on-redraw
// store would move the offer under a reader who is still looking at the first
// card — a second tab, or the same tab in another window — and their confirm
// would then be resolved against revisions they were never shown, which is the
// very substitution this table exists to prevent. So the claim is atomic: the
// insert is conditional on the hold owning no rows yet, in one transaction, and
// two concurrent first draws cannot interleave into a set that is half of each.
//
// A reader whose card can no longer be honoured is not stranded by the
// immutability: the offer's own chips stay operable, so they can leave the
// unhonourable one out, or skip.
//
// ASYNC by construction. Both call sites — the card draw and the confirm — are
// already `async`, so this store uses `runPostgresQueriesAsync` rather than the
// synchronous bridge, which would park the whole event loop for a query neither
// caller needs synchronously.
// ---------------------------------------------------------------------------

/** One entry of the set a card offered: the four fields that decide an outcome. */
export type RunRecommendationOfferedSkill = {
  skillId: string;
  /** The EXACT revision the chip was drawn at — the pin the confirm honours. */
  skillRevisionId: string;
  /** Whether the scorer recommended it AT DRAW TIME. */
  recommended: boolean;
  /** Its 1-based rank in the offered ordering at draw time. */
  rank: number;
};

function offeredSetTable(): string {
  return `"${postgresSchema.replaceAll('"', '""')}"."${RUN_RECOMMENDATION_OFFERED_SET_TABLE}"`;
}

/**
 * CLAIM the set a hold's card offers. FIRST DRAW WINS: a hold that already owns
 * an offer keeps it, byte for byte, so what a reader was shown cannot be moved
 * under them by a later draw.
 *
 * ATOMIC, AND THE LOCK IS WHAT MAKES IT SO. The claim runs in one transaction
 * that FIRST takes a per-hold `pg_advisory_xact_lock` (the `member-actions.ts` /
 * `agent-assigned-skills-store.ts` precedent), then inserts under its own
 * `WHERE NOT EXISTS` on the hold.
 *
 * Neither guard is sufficient alone, and the reason is worth stating because the
 * first attempt at this got it wrong. Under READ COMMITTED two concurrent
 * statements can BOTH see no rows at `WHERE NOT EXISTS`, and because their skill
 * ids are disjoint the `(hold_id, skill_id)` conflict rule fires for neither —
 * so both insert and the hold ends up owning a union nobody drew. The advisory
 * lock serializes the two draws on the hold, so the loser evaluates its
 * predicate AFTER the winner has committed and inserts nothing. It is released
 * with the transaction, so a crashed writer never wedges a hold.
 *
 * Throws only on a genuine DB error; the draw wraps it, because an offer that
 * could not be claimed must cost the FIX, never the card.
 */
export async function writeRunRecommendationOfferedSet(input: {
  runId: string;
  holdId: string;
  offered: ReadonlyArray<RunRecommendationOfferedSkill>;
}): Promise<void> {
  if (!input.holdId) return;
  if (input.offered.length === 0) return;
  const connectionString = getPostgresConnectionString();
  const table = offeredSetTable();
  const rowsSql: string[] = [];
  const params: unknown[] = [input.holdId];
  let n = 2;
  for (const o of input.offered) {
    rowsSql.push(
      `($${n++}::text, $${n++}::text, $${n++}::text, $${n++}::text, $${n++}::text, $${n++}::boolean, $${n++}::integer)`,
    );
    params.push(
      randomUUID(),
      input.runId,
      input.holdId,
      o.skillId,
      o.skillRevisionId,
      o.recommended,
      o.rank,
    );
  }
  await runPostgresQueriesAsync({
    connectionString,
    transaction: true,
    queries: [
      {
        // Serialize the claim on the HOLD — see the atomicity note above.
        text: `SELECT pg_advisory_xact_lock(hashtext('cinatra-recommendation-offer'), hashtext($1))`,
        values: [input.holdId],
      },
      {
        text: `INSERT INTO ${table}
                 (id, run_id, hold_id, skill_id, skill_revision_id, recommended, offered_rank)
               SELECT * FROM (VALUES ${rowsSql.join(", ")}) AS claim(
                 id, run_id, hold_id, skill_id, skill_revision_id, recommended, offered_rank
               )
               WHERE NOT EXISTS (SELECT 1 FROM ${table} WHERE hold_id = $1)
               ON CONFLICT (hold_id, skill_id) DO NOTHING`,
        values: params,
      },
    ],
  });
}

/**
 * Read back the set a hold offered, in the order it was drawn (offered rank,
 * then skill id for a stable tie-break).
 *
 * An EMPTY answer means the hold OWNS no offer — one parked before this table
 * existed, or one whose draw could not claim it — and the confirm keeps its
 * pre-#2906 behaviour rather than refusing every in-flight hold. A FAILED read
 * is a different fact and this function does not flatten the two: it throws, so
 * the confirm can refuse rather than mistake "the database did not answer" for
 * "this hold offered nothing".
 */
export async function readRunRecommendationOfferedSet(
  holdId: string,
): Promise<RunRecommendationOfferedSkill[]> {
  if (!holdId) return [];
  const connectionString = getPostgresConnectionString();
  const [result] = await runPostgresQueriesAsync({
    connectionString,
    queries: [
      {
        text: `SELECT skill_id, skill_revision_id, recommended, offered_rank
               FROM ${offeredSetTable()}
               WHERE hold_id = $1
               ORDER BY offered_rank ASC, skill_id ASC`,
        values: [holdId],
      },
    ],
  });
  const rows = (result?.rows ?? []) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    skillId: String(r.skill_id),
    skillRevisionId: String(r.skill_revision_id),
    recommended: r.recommended === true || r.recommended === "t" || r.recommended === "true",
    rank: Number(r.offered_rank),
  }));
}
