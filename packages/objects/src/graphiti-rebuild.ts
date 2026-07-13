import "server-only";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { getPostgresConnectionString, postgresSchema } from "@/lib/database";
import { clearGraph, getEpisodes } from "./graphiti-client";
import { parseClaimDispositions, resolveClaimWinner, type ArbitrableClaim } from "./claims";
import {
  deriveProjectionGroupId,
  orgIdFromProjectionGroupId,
  readProjectionEpochs,
  REBUILD_JOURNAL_PHASES,
  type RebuildJournalPhase,
} from "./graphiti-projection-policy";
import { objectSyncAdapterRegistry } from "./sync-adapters/registry";
import { processProjectionOutbox } from "./graphiti-projector";

// ---------------------------------------------------------------------------
// Projection-policy epoch bumps + the durable, epoch-fenced group rebuild
// (cinatra#1427 ACs 4-5, epic #1424 projection decision).
//
// THE MECHANISM. Claim-set changes (winner transitions in the claim registry)
// already enqueue durable 're-projection' rows into
// `artifact_binding_reconcile_queue` in the SAME transaction as the
// transition (#1425). `bumpProjectionPolicyEpochsFromClaimChanges` is that
// queue's consumer: one atomic statement drains a batch of pending
// re-projection rows, derives the AFFECTED org-groups (groups actually
// holding rows of the changed types — a claim change over a type with no
// rows needs no rebuild: future rows always project under the live policy),
// bumps each group's epoch, and opens (or folds into) the group's single
// open rebuild-journal row. Batching is the statement itself: N pending
// changes over one group fold into ONE bump.
//
// `driveGraphitiRebuild` advances open journals through the phase machine:
//
//   clearing   — wait for in-flight ('processing') outbox work on the group
//                to settle, terminally settle superseded pending items,
//                clear the WHOLE Graphiti group, reset the group's per-row
//                projection bookkeeping (graphiti_projected_version /
//                episode uuid — the S1 equal-version dedup guard suppresses
//                same-version re-projection BY DESIGN, so a rebuild must
//                reset it).
//   replaying  — enumerate the group's qualifying rows from Postgres in id
//                order and enqueue epoch-STAMPED outbox items; the replay
//                cursor (`checkpoint.lastObjectId`) moves atomically WITH
//                each batch INSERT (one data-modifying CTE), so a killed
//                driver resumes exactly where it stopped and never
//                double-advances (AC-4). A duplicate enqueue after a
//                mid-batch kill is settled by the projector's equal-version
//                dedup — zero duplicate episodes either way.
//   verifying  — the ordinary outbox worker drains the stamped items; once
//                nothing is pending, verification compares qualifying-row vs
//                projected-row vs episode counts and spot-checks recall
//                (sampled object ids present in the group's episodes), then
//                closes the journal (phase 'done') with the stats recorded.
//   done       — terminal.
//
// FENCING. Every phase transition and checkpoint move is CAS-guarded on
// (id, phase, to_epoch): a second claim change FOLDING into the open journal
// resets it to 'clearing' at a HIGHER to_epoch, which strands any concurrent
// stale driver's writes (0-row CAS). Outbox items stamped with an older
// epoch are discarded by the worker (graphiti-projector.ts). Epochs are
// MONOTONIC — `openRollbackRebuild` (AC-5) reverts the PROJECTION, not the
// number: after the claim-side state is reverted (retirement /
// reactivation — themselves enqueueing re-projection rows), an explicit
// rollback opens a new fenced rebuild whose full replay from Postgres (the
// canonical record) restores the prior epoch's projection. Per-episode purge
// is explicitly NOT the mechanism (append-before-success, no episode UUID
// control, capped enumeration — issue #1427).
//
// Exposed via tsconfig sub-path alias `@cinatra-ai/objects/graphiti-rebuild`
// (NOT re-exported from index.ts) for the same barrel-trap reason as the
// projector.
// ---------------------------------------------------------------------------

type QueryInput = { text: string; values?: unknown[] };

const s = (): string => postgresSchema.replaceAll('"', '""');

function run(queries: QueryInput[], transaction = false) {
  return runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    transaction,
    queries,
  });
}

/** SQL fragment: the projector's source gate (agent | ui | route | NULL). */
const SOURCE_GATE_SQL = `(o.source IS NULL OR o.source IN ('agent','ui','route'))`;

/** SQL fragment: rows belonging to journal alias j's group. */
const GROUP_MATCH_SQL = `((j.org_id IS NULL AND o.org_id IS NULL) OR o.org_id = j.org_id)`;

export interface RebuildJournalRow {
  id: string;
  groupId: string;
  orgId: string | null;
  fromEpoch: number;
  toEpoch: number;
  phase: RebuildJournalPhase;
  checkpoint: { lastObjectId?: string | null; enqueued?: number } | null;
  stats: Record<string, unknown> | null;
  reason: Record<string, unknown>;
  attempts: number;
  lastError: string | null;
}

function mapJournalRow(r: Record<string, unknown>): RebuildJournalRow {
  return {
    id: String(r.id),
    groupId: String(r.group_id),
    orgId: r.org_id == null ? null : String(r.org_id),
    fromEpoch: Number(r.from_epoch),
    toEpoch: Number(r.to_epoch),
    phase: String(r.phase) as RebuildJournalPhase,
    checkpoint: (r.checkpoint as RebuildJournalRow["checkpoint"]) ?? null,
    stats: (r.stats as Record<string, unknown> | null) ?? null,
    reason: (r.reason as Record<string, unknown>) ?? {},
    attempts: Number(r.attempts ?? 0),
    lastError: r.last_error == null ? null : String(r.last_error),
  };
}

const JOURNAL_COLUMNS =
  "id, group_id, org_id, from_epoch, to_epoch, phase, checkpoint, stats, reason, attempts, last_error";

export function readOpenRebuildJournals(limit = 5): RebuildJournalRow[] {
  const [result] = run([
    {
      text: `SELECT ${JOURNAL_COLUMNS} FROM "${s()}"."graphiti_rebuild_journal"
             WHERE phase <> 'done' ORDER BY created_at ASC LIMIT $1`,
      values: [limit],
    },
  ]);
  return (result?.rows ?? []).map(mapJournalRow);
}

export function readRebuildJournalById(id: string): RebuildJournalRow | null {
  const [result] = run([
    {
      text: `SELECT ${JOURNAL_COLUMNS} FROM "${s()}"."graphiti_rebuild_journal" WHERE id = $1`,
      values: [id],
    },
  ]);
  const row = result?.rows[0];
  return row ? mapJournalRow(row) : null;
}

// ---------------------------------------------------------------------------
// Epoch bump consumer — claim-set changes batch into an epoch bump.
// ---------------------------------------------------------------------------

/** One atomic statement: drain pending 're-projection' queue rows, derive the
 * affected org-groups, bump each group's epoch, open-or-fold the group's
 * rebuild journal. Exported for the SQL-shape unit test. */
export function buildEpochBumpQuery(schemaName: string, limit: number): QueryInput {
  const q = schemaName.replaceAll('"', '""');
  return {
    text: `WITH claimed AS (
        UPDATE "${q}"."artifact_binding_reconcile_queue" queue
        SET status = 'done', processed_at = now()
        WHERE queue.id IN (
          SELECT id FROM "${q}"."artifact_binding_reconcile_queue"
          WHERE kind = 're-projection' AND status = 'pending'
          ORDER BY created_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING queue.id, queue.scope, queue.object_type_id
      ),
      affected AS (
        SELECT DISTINCT
          CASE WHEN o.org_id IS NULL THEN 'cinatra-default' ELSE 'cinatra-org-' || o.org_id END AS group_id,
          o.org_id
        FROM claimed c
        JOIN "${q}"."objects" o
          ON o.type = c.object_type_id AND o.deleted_at IS NULL
        WHERE c.scope = 'platform'
           OR (c.scope LIKE 'org:%' AND o.org_id = substring(c.scope from 5))
      ),
      bumped AS (
        INSERT INTO "${q}"."graphiti_projection_policy" (group_id, epoch, updated_at)
        SELECT a.group_id, 2, now() FROM affected a
        ON CONFLICT (group_id) DO UPDATE
          SET epoch = "graphiti_projection_policy".epoch + 1, updated_at = now()
        RETURNING "graphiti_projection_policy".group_id, "graphiti_projection_policy".epoch
      ),
      journaled AS (
        INSERT INTO "${q}"."graphiti_rebuild_journal"
          (group_id, org_id, from_epoch, to_epoch, phase, checkpoint, reason)
        SELECT b.group_id, a.org_id, b.epoch - 1, b.epoch, 'clearing', NULL,
               jsonb_build_object(
                 'kind', 'claim-change',
                 'queueRowIds', (SELECT COALESCE(jsonb_agg(c2.id), '[]'::jsonb) FROM claimed c2),
                 'objectTypeIds', (SELECT COALESCE(jsonb_agg(DISTINCT c3.object_type_id), '[]'::jsonb) FROM claimed c3))
        FROM bumped b
        JOIN affected a ON a.group_id = b.group_id
        ON CONFLICT (group_id) WHERE phase <> 'done'
        DO UPDATE SET
          to_epoch = EXCLUDED.to_epoch,
          phase = 'clearing',
          checkpoint = NULL,
          stats = NULL,
          attempts = 0,
          last_error = NULL,
          updated_at = now(),
          reason = "graphiti_rebuild_journal".reason
            || jsonb_build_object('foldCount', COALESCE(("graphiti_rebuild_journal".reason->>'foldCount')::int, 0) + 1)
        RETURNING group_id, to_epoch
      )
      SELECT
        (SELECT count(*) FROM claimed)::int AS consumed,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('groupId', group_id, 'toEpoch', to_epoch)) FROM journaled), '[]'::jsonb) AS bumps`,
    values: [limit],
  };
}

export interface EpochBumpResult {
  /** Pending 're-projection' queue rows consumed (marked done). */
  consumed: number;
  /** Groups whose epoch was bumped (journal opened or folded). */
  bumps: Array<{ groupId: string; toEpoch: number }>;
}

/**
 * Consume pending claim-change 're-projection' work into per-group epoch
 * bumps + open rebuild journals. Atomic: a crash consumes nothing.
 */
export function bumpProjectionPolicyEpochsFromClaimChanges(options?: { limit?: number }): EpochBumpResult {
  const [result] = run([buildEpochBumpQuery(postgresSchema, options?.limit ?? 200)]);
  const row = result?.rows[0] as { consumed?: number; bumps?: unknown } | undefined;
  const rawBumps = Array.isArray(row?.bumps) ? (row?.bumps as Array<Record<string, unknown>>) : [];
  return {
    consumed: Number(row?.consumed ?? 0),
    bumps: rawBumps.map((b) => ({ groupId: String(b.groupId), toEpoch: Number(b.toEpoch) })),
  };
}

/**
 * AC-5 rollback entry point: after the claim-side state has been reverted
 * (the registry transitions themselves enqueue re-projection rows — reverting
 * via the registry needs no explicit call here), an EXPLICIT rollback opens a
 * new fenced rebuild for one group at a new epoch. The full replay from
 * Postgres under the reverted policy restores the prior projection; the epoch
 * number stays monotonic (fencing depends on it).
 */
/** The rollback bump + fenced-rebuild open, as one atomic statement. Exported
 * for the SQL-shape / real-DB test. Monotonic: the epoch only moves FORWARD (a
 * rollback restores the prior PROJECTION via a full replay, never by
 * decrementing the number). */
export function buildOpenRollbackRebuildQuery(
  schemaName: string,
  input: { groupId: string; orgId: string | null; rolledBackJournalId?: string | null },
): QueryInput {
  const q = schemaName.replaceAll('"', '""');
  return {
    text: `WITH bumped AS (
        INSERT INTO "${q}"."graphiti_projection_policy" (group_id, epoch, updated_at)
        VALUES ($1, 2, now())
        ON CONFLICT (group_id) DO UPDATE
          SET epoch = "graphiti_projection_policy".epoch + 1, updated_at = now()
        RETURNING group_id, epoch
      )
      INSERT INTO "${q}"."graphiti_rebuild_journal"
        (group_id, org_id, from_epoch, to_epoch, phase, checkpoint, reason)
      SELECT b.group_id, $2, b.epoch - 1, b.epoch, 'clearing', NULL,
             jsonb_build_object('kind', 'rollback', 'rolledBackJournalId', $3::text)
      FROM bumped b
      ON CONFLICT (group_id) WHERE phase <> 'done'
      DO UPDATE SET
        to_epoch = EXCLUDED.to_epoch,
        phase = 'clearing',
        checkpoint = NULL,
        stats = NULL,
        attempts = 0,
        last_error = NULL,
        updated_at = now(),
        reason = EXCLUDED.reason
      RETURNING group_id, to_epoch`,
    values: [input.groupId, input.orgId, input.rolledBackJournalId ?? null],
  };
}

export function openRollbackRebuild(input: { groupId: string; rolledBackJournalId?: string | null }): {
  groupId: string;
  toEpoch: number;
} {
  const orgId = orgIdFromProjectionGroupId(input.groupId);
  const [result] = run([
    buildOpenRollbackRebuildQuery(postgresSchema, {
      groupId: input.groupId,
      orgId,
      rolledBackJournalId: input.rolledBackJournalId ?? null,
    }),
  ]);
  const row = result?.rows[0] as { group_id?: string; to_epoch?: number } | undefined;
  if (!row) throw new Error(`openRollbackRebuild: no journal row returned for ${input.groupId}`);
  return { groupId: String(row.group_id), toEpoch: Number(row.to_epoch) };
}

// ---------------------------------------------------------------------------
// The rebuild driver.
// ---------------------------------------------------------------------------

export interface DriveRebuildOptions {
  /** Open journals advanced per call (oldest first). */
  maxJournals?: number;
  /** Rows enqueued per replay batch statement. */
  replayBatchSize?: number;
  /** Replay batch statements per journal per call (bounds one cycle's work). */
  maxReplayBatches?: number;
  /** Episode fetch cap for verification (Graphiti get_episodes ceiling: 2000). */
  episodeFetchCap?: number;
}

export interface DriveRebuildResult {
  /** Journals that made phase progress (incl. reaching 'done'). */
  advanced: number;
  /** Journals still open after this call. */
  open: number;
  /** Journals that recorded an error this call. */
  errored: number;
}

/** Advance every open rebuild journal as far as one call's bounded work
 * allows. Safe to call every worker cycle; a journal blocked on in-flight
 * outbox work or a pending drain simply stays where it is. */
export async function driveGraphitiRebuild(options?: DriveRebuildOptions): Promise<DriveRebuildResult> {
  const maxJournals = options?.maxJournals ?? 3;
  const journals = readOpenRebuildJournals(maxJournals);
  let advanced = 0;
  let errored = 0;
  for (const journal of journals) {
    try {
      const didAdvance = await advanceJournal(journal, options);
      if (didAdvance) advanced += 1;
    } catch (err) {
      errored += 1;
      const message = err instanceof Error ? err.message : String(err);
      run([
        {
          text: `UPDATE "${s()}"."graphiti_rebuild_journal"
                 SET last_error = $1, attempts = attempts + 1, updated_at = now()
                 WHERE id = $2 AND phase <> 'done'`,
          values: [message.slice(0, 1000), journal.id],
        },
      ]);
    }
  }
  const [openResult] = run([
    { text: `SELECT count(*)::int AS open FROM "${s()}"."graphiti_rebuild_journal" WHERE phase <> 'done'` },
  ]);
  return { advanced, errored, open: Number((openResult?.rows[0] as { open?: number } | undefined)?.open ?? 0) };
}

/** Returns true when the journal made phase progress. */
async function advanceJournal(initial: RebuildJournalRow, options?: DriveRebuildOptions): Promise<boolean> {
  let journal: RebuildJournalRow | null = initial;
  let progressed = false;
  // Walk forward through phases within one call; each step re-reads and is
  // CAS-fenced, so a concurrent fold (new to_epoch, phase reset) strands us
  // with 0-row updates and we simply stop.
  for (let step = 0; step < 3 && journal && journal.phase !== "done"; step += 1) {
    const before = `${journal.phase}:${journal.toEpoch}`;
    if (journal.phase === "clearing") {
      const ok = await runClearingPhase(journal);
      if (!ok) break;
    } else if (journal.phase === "replaying") {
      const ok = runReplayingPhase(journal, options);
      if (!ok) break;
    } else if (journal.phase === "verifying") {
      const ok = await runVerifyingPhase(journal, options);
      if (!ok) break;
    }
    journal = readRebuildJournalById(journal.id);
    if (journal && `${journal.phase}:${journal.toEpoch}` !== before) progressed = true;
  }
  return progressed;
}

/**
 * CLEARING: settle superseded outbox items, clear the Graphiti group, reset
 * the group's projection bookkeeping, CAS to 'replaying'. Idempotent — a
 * kill anywhere re-runs the whole phase (replay has not started).
 * Returns false when blocked (in-flight outbox work) or fenced out.
 */
async function runClearingPhase(journal: RebuildJournalRow): Promise<boolean> {
  const q = s();
  // In-flight items must settle first: an item mid-projection could append
  // an episode AFTER our group clear (the addEpisode network call is not
  // fenced). Wait for the worker to finish the batch; the recovery sweep in
  // processProjectionOutbox unsticks crashed 'processing' rows after 5 min.
  const [inflight] = run([
    {
      text: `SELECT count(*)::int AS n FROM "${q}"."graphiti_projection_outbox" o
             JOIN (SELECT $1::text AS org_id) j ON TRUE
             WHERE ((j.org_id IS NULL AND o.org_id IS NULL) OR o.org_id = j.org_id)
               AND o.status = 'processing'`,
      values: [journal.orgId],
    },
  ]);
  if (Number((inflight?.rows[0] as { n?: number } | undefined)?.n ?? 0) > 0) return false;

  // Re-validate ownership immediately before the DESTRUCTIVE clear (clearGraph
  // + the projected-version reset are both idempotent but WHOLE-GROUP): a fold
  // (epoch bump) may have advanced this journal to a HIGHER epoch — under whose
  // clearing/replay a newer driver could already be running — while we were
  // checking in-flight work. A stale clearer at the old epoch must not wipe the
  // newer epoch's group clear / bookkeeping. If the journal is no longer at our
  // (phase, to_epoch), bail: the current-epoch driver owns the clear. (The
  // residual sub-read window before clearGraph is self-healing — the newer
  // epoch re-clears idempotently on its next cycle.)
  const owned = readRebuildJournalById(journal.id);
  if (!owned || owned.phase !== "clearing" || owned.toEpoch !== journal.toEpoch) return false;

  // Terminally settle superseded pending/failed items for the group: the full
  // replay below delivers every row's CURRENT state, so pre-bump items (both
  // ordinary NULL-epoch items and older-epoch replay leftovers) are obsolete.
  run([
    {
      text: `UPDATE "${q}"."graphiti_projection_outbox" o
             SET status = 'done', processed_at = now(),
                 last_error = 'superseded by projection-epoch ' || $2 || ' rebuild'
             FROM (SELECT $1::text AS org_id) j
             WHERE ((j.org_id IS NULL AND o.org_id IS NULL) OR o.org_id = j.org_id)
               AND o.status IN ('pending', 'failed')
               AND (o.projection_epoch IS NULL OR o.projection_epoch < $3)`,
      values: [journal.orgId, String(journal.toEpoch), journal.toEpoch],
    },
  ]);

  // Whole-group clear in Graphiti (the issue's mechanism: never per-episode
  // purge). Throws propagate: the driver records last_error and the phase
  // re-runs next cycle.
  await clearGraph({ group_ids: [journal.groupId] });

  // Reset per-row bookkeeping: the S1 equal-version dedup guard suppresses
  // same-version re-projection by design, so the replay only lands if the
  // projected-version watermark is cleared.
  run([
    {
      text: `UPDATE "${q}"."objects" o
             SET graphiti_projected_version = NULL,
                 graphiti_episode_uuid = NULL,
                 graphiti_sync_status = 'pending',
                 graphiti_projected_at = NULL,
                 graphiti_projection_error = NULL
             FROM (SELECT $1::text AS org_id) j
             WHERE ((j.org_id IS NULL AND o.org_id IS NULL) OR o.org_id = j.org_id)
               AND o.deleted_at IS NULL
               AND (o.graphiti_projected_version IS NOT NULL
                    OR o.graphiti_episode_uuid IS NOT NULL
                    OR o.graphiti_sync_status <> 'pending')`,
      values: [journal.orgId],
    },
  ]);

  const [cas] = run([
    {
      text: `UPDATE "${q}"."graphiti_rebuild_journal"
             SET phase = 'replaying',
                 checkpoint = jsonb_build_object('lastObjectId', NULL, 'enqueued', 0),
                 updated_at = now()
             WHERE id = $1 AND phase = 'clearing' AND to_epoch = $2`,
      values: [journal.id, journal.toEpoch],
    },
  ]);
  return (cas?.rowCount ?? 0) > 0;
}

/** One atomic replay batch: select the next id-window of qualifying rows,
 * enqueue epoch-stamped outbox items, move the checkpoint — all in ONE
 * data-modifying CTE statement (kill-safe: the cursor moves iff the items
 * landed). Exported for the SQL-shape unit test. */
export function buildReplayBatchQuery(schemaName: string, input: { journalId: string; toEpoch: number; batchSize: number }): QueryInput {
  const q = schemaName.replaceAll('"', '""');
  return {
    text: `WITH j AS (
        SELECT id, org_id, to_epoch,
               checkpoint->>'lastObjectId' AS last_id,
               COALESCE((checkpoint->>'enqueued')::int, 0) AS enq
        FROM "${q}"."graphiti_rebuild_journal"
        WHERE id = $1 AND phase = 'replaying' AND to_epoch = $2
        FOR UPDATE
      ),
      batch AS (
        SELECT o.id, o.version, o.org_id
        FROM "${q}"."objects" o, j
        WHERE ${GROUP_MATCH_SQL}
          AND o.deleted_at IS NULL
          AND ${SOURCE_GATE_SQL}
          AND (j.last_id IS NULL OR o.id > j.last_id)
        ORDER BY o.id
        LIMIT $3
      ),
      ins AS (
        INSERT INTO "${q}"."graphiti_projection_outbox"
          (object_id, object_version, org_id, operation, status, projection_epoch)
        SELECT b.id, b.version, b.org_id, 'upsert', 'pending', $2 FROM batch b
        RETURNING object_id
      )
      UPDATE "${q}"."graphiti_rebuild_journal" g
      SET checkpoint = jsonb_build_object(
            'lastObjectId', (SELECT max(object_id) FROM ins),
            'enqueued', j.enq + (SELECT count(*) FROM ins)),
          updated_at = now()
      FROM j
      WHERE g.id = j.id AND (SELECT count(*) FROM ins) > 0`,
    values: [input.journalId, input.toEpoch, input.batchSize],
  };
}

/** REPLAYING: run bounded replay batches; when the enumeration is exhausted,
 * CAS to 'verifying'. Returns false when fenced out mid-way. */
function runReplayingPhase(journal: RebuildJournalRow, options?: DriveRebuildOptions): boolean {
  const q = s();
  const batchSize = options?.replayBatchSize ?? 200;
  const maxBatches = options?.maxReplayBatches ?? 20;
  for (let i = 0; i < maxBatches; i += 1) {
    const [batchResult] = run([
      buildReplayBatchQuery(postgresSchema, { journalId: journal.id, toEpoch: journal.toEpoch, batchSize }),
    ]);
    if ((batchResult?.rowCount ?? 0) > 0) continue; // batch landed, cursor moved
    // 0 rows: either the enumeration is exhausted or we were fenced out
    // (fold reset the phase/epoch). The exhaustion CAS below distinguishes:
    // it only fires while (phase, to_epoch) still match AND nothing remains
    // past the cursor.
    const [cas] = run([
      {
        text: `UPDATE "${q}"."graphiti_rebuild_journal" g
               SET phase = 'verifying', updated_at = now()
               FROM (
                 SELECT id, org_id, checkpoint->>'lastObjectId' AS last_id
                 FROM "${q}"."graphiti_rebuild_journal"
                 WHERE id = $1 AND phase = 'replaying' AND to_epoch = $2
               ) j
               WHERE g.id = j.id
                 AND NOT EXISTS (
                   SELECT 1 FROM "${q}"."objects" o
                   WHERE ${GROUP_MATCH_SQL}
                     AND o.deleted_at IS NULL
                     AND ${SOURCE_GATE_SQL}
                     AND (j.last_id IS NULL OR o.id > j.last_id)
                 )`,
        values: [journal.id, journal.toEpoch],
      },
    ]);
    return (cas?.rowCount ?? 0) > 0;
  }
  return true; // bounded work done for this cycle; more batches next cycle
}

/** Types whose winning claim carries `projection: 'none'` for this org —
 * their rows are policy-skipped by the projector (never projected, never
 * counted). Read directly (this module already has PG access); winner
 * arbitration + dispositions parsing via the pure claims leaf. */
function readPolicyExcludedTypes(orgId: string | null): string[] {
  if (orgId == null) return [];
  const [result] = run([
    {
      text: `SELECT id, scope, object_type_id, claim_kind, status, extension_package, extension_version, generation, dispositions
             FROM "${s()}"."artifact_type_claims"
             WHERE scope = 'platform' OR scope = $1`,
      values: [`org:${orgId}`],
    },
  ]);
  const claims: ArbitrableClaim[] = ((result?.rows ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    scope: String(r.scope),
    objectTypeId: String(r.object_type_id),
    claimKind: String(r.claim_kind) as ArbitrableClaim["claimKind"],
    status: String(r.status) as ArbitrableClaim["status"],
    extensionPackage: String(r.extension_package),
    extensionVersion: String(r.extension_version),
    generation: Number(r.generation),
    dispositions: r.dispositions ?? null,
  }));
  const excluded: string[] = [];
  for (const typeId of new Set(claims.map((c) => c.objectTypeId))) {
    const winner = resolveClaimWinner(claims, { orgId, objectTypeId: typeId });
    if (!winner || winner.dispositions == null) continue;
    const parsed = parseClaimDispositions(winner.dispositions);
    if (parsed.ok && parsed.dispositions.projection === "none") excluded.push(typeId);
  }
  return excluded;
}

/**
 * VERIFYING: outbox drained → row/episode counts + spot recall → close the
 * journal. Any shortfall records the state and leaves the journal open for
 * the next cycle (counts converge as the drain finishes; genuinely failed
 * replay items keep the journal open with the failure recorded — honest).
 */
async function runVerifyingPhase(journal: RebuildJournalRow, options?: DriveRebuildOptions): Promise<boolean> {
  const q = s();

  // Settle failed replay items whose canonical row is gone (deleted while
  // the rebuild ran — the replay-enqueued upsert can never succeed and the
  // recomputed expected-count below no longer includes the row).
  run([
    {
      text: `UPDATE "${q}"."graphiti_projection_outbox" o
             SET status = 'done', processed_at = now(), last_error = 'row deleted during rebuild'
             FROM (SELECT $1::text AS org_id) j
             WHERE ((j.org_id IS NULL AND o.org_id IS NULL) OR o.org_id = j.org_id)
               AND o.projection_epoch = $2 AND o.status = 'failed'
               AND NOT EXISTS (
                 SELECT 1 FROM "${q}"."objects" c WHERE c.id = o.object_id AND c.deleted_at IS NULL
               )`,
      values: [journal.orgId, journal.toEpoch],
    },
  ]);

  const [drain] = run([
    {
      text: `SELECT
               count(*) FILTER (WHERE o.status IN ('pending','processing'))::int AS in_flight,
               count(*) FILTER (WHERE o.status = 'failed')::int AS failed
             FROM "${q}"."graphiti_projection_outbox" o
             JOIN (SELECT $1::text AS org_id) j ON TRUE
             WHERE ((j.org_id IS NULL AND o.org_id IS NULL) OR o.org_id = j.org_id)
               AND o.projection_epoch = $2`,
      values: [journal.orgId, journal.toEpoch],
    },
  ]);
  const drainRow = (drain?.rows[0] ?? {}) as { in_flight?: number; failed?: number };
  if (Number(drainRow.in_flight ?? 0) > 0) return false; // drain in progress
  if (Number(drainRow.failed ?? 0) > 0) {
    recordVerifyState(journal, { error: `${Number(drainRow.failed)} failed replay outbox item(s)` });
    return false;
  }

  const excludedTypes = readPolicyExcludedTypes(journal.orgId);
  const [counts] = run([
    {
      text: `SELECT
               count(*) FILTER (WHERE o.type <> ALL($2::text[]))::int AS expected,
               count(*) FILTER (WHERE o.type <> ALL($2::text[]) AND o.graphiti_projected_version IS NOT NULL)::int AS projected
             FROM "${q}"."objects" o
             JOIN (SELECT $1::text AS org_id) j ON TRUE
             WHERE ((j.org_id IS NULL AND o.org_id IS NULL) OR o.org_id = j.org_id)
               AND o.deleted_at IS NULL
               AND ${SOURCE_GATE_SQL}`,
      values: [journal.orgId, excludedTypes],
    },
  ]);
  const countsRow = (counts?.rows[0] ?? {}) as { expected?: number; projected?: number };
  const expected = Number(countsRow.expected ?? 0);
  const projected = Number(countsRow.projected ?? 0);
  if (projected < expected) {
    recordVerifyState(journal, { error: `projected ${projected} < expected ${expected} (drain settling?)` });
    return false;
  }

  // Episode count + spot recall against Graphiti. Fail-closed: a journal
  // never closes without the verification read.
  const cap = Math.min(options?.episodeFetchCap ?? 2000, 2000);
  const episodes = (await getEpisodes({ group_ids: [journal.groupId], max_episodes: cap })).episodes;
  const countExact = projected <= cap;
  if (countExact && episodes.length !== projected) {
    recordVerifyState(journal, {
      error: `episode count ${episodes.length} != projected rows ${projected}`,
      episodeCount: episodes.length,
    });
    return false;
  }

  // Spot recall: sampled projected rows must be findable by object id in the
  // group's episodes ([oid:] name tag / cinatra_object_id body field).
  // Adapter-owned types compose their own episodes — sample only rows the
  // generic projector wrote.
  const adapterTypes = objectSyncAdapterRegistry
    .listAll()
    .filter((a) => a.targetSystem === "graphiti")
    .flatMap((a) => a.supportedTypes);
  const [sample] = run([
    {
      text: `SELECT o.id FROM "${q}"."objects" o
             JOIN (SELECT $1::text AS org_id) j ON TRUE
             WHERE ((j.org_id IS NULL AND o.org_id IS NULL) OR o.org_id = j.org_id)
               AND o.deleted_at IS NULL
               AND ${SOURCE_GATE_SQL}
               AND o.graphiti_projected_version IS NOT NULL
               AND o.type <> ALL($2::text[])
             ORDER BY o.id LIMIT 3`,
      values: [journal.orgId, [...excludedTypes, ...adapterTypes]],
    },
  ]);
  const sampleIds = ((sample?.rows ?? []) as Array<{ id: string }>).map((r) => String(r.id));
  const misses = sampleIds.filter(
    (id) => !episodes.some((e) => e.name.includes(`[oid:${id}]`) || e.content.includes(id)),
  );
  if (misses.length > 0) {
    recordVerifyState(journal, { error: `spot recall missed object id(s): ${misses.join(", ")}` });
    return false;
  }

  const [cas] = run([
    {
      text: `UPDATE "${q}"."graphiti_rebuild_journal"
             SET phase = 'done', last_error = NULL, updated_at = now(),
                 stats = jsonb_build_object(
                   'expectedRows', $3::int, 'projectedRows', $4::int,
                   'episodeCount', $5::int, 'episodeCountExact', $6::boolean,
                   'spotRecallSampled', $7::int)
             WHERE id = $1 AND phase = 'verifying' AND to_epoch = $2
               -- Close the drain-check → done window: a late same-epoch replay
               -- item committed after the count read must keep the journal open.
               AND NOT EXISTS (
                 SELECT 1 FROM "${q}"."graphiti_projection_outbox" o
                 JOIN (SELECT $8::text AS org_id) jj ON TRUE
                 WHERE ((jj.org_id IS NULL AND o.org_id IS NULL) OR o.org_id = jj.org_id)
                   AND o.projection_epoch = $2
                   AND o.status IN ('pending', 'processing', 'failed')
               )`,
      values: [journal.id, journal.toEpoch, expected, projected, episodes.length, countExact, sampleIds.length, journal.orgId],
    },
  ]);
  return (cas?.rowCount ?? 0) > 0;
}

function recordVerifyState(journal: RebuildJournalRow, state: { error: string; episodeCount?: number }): void {
  run([
    {
      text: `UPDATE "${s()}"."graphiti_rebuild_journal"
             SET last_error = $1, attempts = attempts + 1, updated_at = now()
             WHERE id = $2 AND phase = 'verifying' AND to_epoch = $3`,
      values: [state.error.slice(0, 1000), journal.id, journal.toEpoch],
    },
  ]);
}

// ---------------------------------------------------------------------------
// The composite worker cycle — the production caller
// (background-jobs-registry.ts GRAPHITI_PROJECTION_REPAIR loop).
// ---------------------------------------------------------------------------

export interface ProjectionCycleResult {
  claimChangesConsumed: number;
  epochBumps: number;
  journalsAdvanced: number;
  journalsOpen: number;
  processed: number;
  failed: number;
}

/**
 * One full projection cycle: (1) batch pending claim-set changes into epoch
 * bumps, (2) advance open rebuild journals, (3) drain the outbox (with the
 * projector's stale-epoch fencing). Each stage is independently durable —
 * a throw in a later stage never loses an earlier stage's work.
 */
export async function processGraphitiProjectionCycle(options?: {
  batchSize?: number;
  maxAttempts?: number;
  rebuild?: DriveRebuildOptions;
}): Promise<ProjectionCycleResult> {
  const bumps = bumpProjectionPolicyEpochsFromClaimChanges();
  const drive = await driveGraphitiRebuild(options?.rebuild);
  const outbox = await processProjectionOutbox({
    batchSize: options?.batchSize,
    maxAttempts: options?.maxAttempts,
  });
  return {
    claimChangesConsumed: bumps.consumed,
    epochBumps: bumps.bumps.length,
    journalsAdvanced: drive.advanced,
    journalsOpen: drive.open,
    processed: outbox.processed,
    failed: outbox.failed,
  };
}

// Contract re-exports for consumers/tests.
export { REBUILD_JOURNAL_PHASES, deriveProjectionGroupId, readProjectionEpochs };
export type { RebuildJournalPhase };
