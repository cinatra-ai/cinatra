// Binding-assertion write path (cinatra#1429, epic #1424) — the reconcile that
// gives a claimed typed object row its BINDING semantic assertion.
//
// DESIGN (the epic's binding write protocol). A binding is a `semantic_assertion`
// row with assertion_basis='binding', anchored to the exact claim ROW +
// activation generation it was written under (binding_claim_id /
// binding_generation) and asserted_by='system' (the service principal driving
// reconciliation, admitted by the core__0040 CHECK widening). Reconciliation is
// the ONLY writer of binding rows; it runs under the SAME per-artifact advisory
// transaction lock the assertion service + floor rebalancer take
// (`pg_advisory_xact_lock(hashtext(artifactId))`), acquired as the FIRST
// statement, so binding writes, floor rebalances, and classic assertions on one
// artifact fully serialize (AC-1: no deadlock, exactly one active binding —
// also DB-guarded by sa_one_active_binding_idx).
//
// The reconcile resolves the ACTIVE claim from LIVE DB state IN SQL — never a
// precomputed in-memory id (AC-2). The winner is the top-precedence DEDICATED
// claim in the org's scope chain (dedicated-org over dedicated-platform, then
// generation DESC, id ASC — mirrors resolveClaimWinner's dedicated branch in
// @cinatra-ai/objects/claims). A DEFAULT winner (or no winner) means NO binding:
// the row's identity is the default-artifact floor / a plain object, resolved by
// the effective-identity service. A QUARANTINED object never receives a binding.
//
// Two idempotent statements under the lock:
//   1. ARCHIVE every active binding that is NOT the current winner's exact
//      (claim id, generation, extension) — stale claim/generation/extension,
//      superseded by a higher-precedence dedicated claim, retired/uninstalled
//      winner, or a quarantined object. Archiving is an UPDATE to
//      eligibility='archived' (the frozen trigger's one legal eligibility
//      transition; append-only doctrine preserved — a binding is never mutated
//      in place, a new one is INSERTed).
//   2. INSERT the winner's binding IFF a winner exists and no active binding
//      already matches it (idempotent: a matching binding ⇒ zero inserts).
//
// The reconcile writes ONLY semantic_assertion (+ reads objects /
// artifact_type_claims / object_binding_quarantine) — it never mutates
// `objects`. Re-projection after an identity change is driven separately (the
// winner transition enqueues a 're-projection' queue row alongside
// 'binding-reconcile'; the write-path's own object write already bumps version
// + outbox; the browse-stage backfill re-projects via the #1427 epoch rebuild).
// The only reads of the objects table here are existence guards inside
// INSERT INTO semantic_assertion ... WHERE EXISTS subqueries — this module
// never mutates object rows themselves.

import "server-only";
import { randomUUID } from "node:crypto";

import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";

/** The principal a binding assertion is written under — the service/worker that
 * drives claim reconciliation (admitted by sa_assertedby_chk since core__0040).
 * Bindings are machine-derived identity, never a human/agent/skill
 * classification. */
export const BINDING_ASSERTED_BY = "system" as const;

type Query = { text: string; values: unknown[] };

const conn = (): string => getPostgresConnectionString();
const q = (): string => postgresSchema.replaceAll('"', '""');

/** The dedicated-winner CTE for (orgId=$1, artifactId=$2): the top-precedence
 * live DEDICATED claim over the row's CURRENT `objects.type`, resolved in SQL —
 * org scope beats platform, then generation DESC, id ASC (resolveClaimWinner's
 * dedicated branch). Empty when the object is quarantined, its type has no live
 * dedicated claim, or the object row is absent/cross-tenant. */
function winnerCte(schema: string): string {
  return `winner AS (
    SELECT c.id AS claim_id, c.extension_package AS ext, c.generation AS gen
    FROM "${schema}"."objects" o
    JOIN "${schema}"."artifact_type_claims" c
      ON c.object_type_id = o.type
     AND c.claim_kind = 'dedicated'
     AND c.status IN ('active','retiring')
     AND (c.scope = 'platform' OR c.scope = 'org:' || $1)
    WHERE o.id = $2 AND o.org_id = $1
      AND NOT EXISTS (
        SELECT 1 FROM "${schema}"."object_binding_quarantine" qz
        WHERE qz.org_id = $1 AND qz.object_id = $2)
    ORDER BY (CASE WHEN c.scope = 'org:' || $1 THEN 0 ELSE 1 END) ASC,
             c.generation DESC, c.id ASC
    LIMIT 1
  )`;
}

/**
 * Build the two binding-reconcile statements (archive-stale, insert-winner) for
 * one artifact. PURE — does not execute. Compose into an outer transaction that
 * ALREADY holds `pg_advisory_xact_lock(hashtext(artifactId))` (the write-path's
 * upsert tx, or reconcileArtifactBinding's own tx). `$1`=orgId, `$2`=artifactId;
 * the INSERT's new id is bound per-statement so the two queries carry only the
 * params their SQL references (the split-values contract the assertion store
 * documents).
 */
export function buildBindingReconcileQueries(
  schemaName: string,
  input: { orgId: string; artifactId: string; newBindingId?: string },
): Query[] {
  const s = schemaName.replaceAll('"', '""');
  const newId = input.newBindingId ?? randomUUID();
  return [
    // 1. Archive every active binding that is not the current winner's exact
    // (claim id, generation, extension). When there is no winner (default/none/
    // retired/uninstalled/quarantined) the CTE is empty ⇒ every active binding
    // archives.
    {
      text: `WITH ${winnerCte(s)}
UPDATE "${s}"."semantic_assertion" sa
   SET eligibility = 'archived', archived_at = now()
 WHERE sa.org_id = $1 AND sa.artifact_id = $2
   AND sa.assertion_basis = 'binding' AND sa.eligibility <> 'archived'
   AND NOT EXISTS (
     SELECT 1 FROM winner w
     WHERE w.claim_id = sa.binding_claim_id
       AND w.gen = sa.binding_generation
       AND w.ext = sa.extension)`,
      values: [input.orgId, input.artifactId],
    },
    // 2. Insert the winner's binding when one exists and no active binding
    // already matches it (idempotent). RETURNING id lets callers count inserts.
    {
      text: `WITH ${winnerCte(s)}
INSERT INTO "${s}"."semantic_assertion"
  (id, org_id, artifact_id, extension, asserted_by, eligibility, assertion_basis, binding_claim_id, binding_generation)
SELECT $3, $1, $2, w.ext, 'system', 'eligible', 'binding', w.claim_id, w.gen
FROM winner w
WHERE NOT EXISTS (
  SELECT 1 FROM "${s}"."semantic_assertion" sa2
  WHERE sa2.org_id = $1 AND sa2.artifact_id = $2
    AND sa2.assertion_basis = 'binding' AND sa2.eligibility <> 'archived'
    AND sa2.binding_claim_id = w.claim_id
    AND sa2.binding_generation = w.gen
    AND sa2.extension = w.ext)
RETURNING id`,
      values: [input.orgId, input.artifactId, newId],
    },
  ];
}

export interface ReconcileArtifactBindingResult {
  /** A binding row was archived (stale/superseded/quarantined). */
  archived: number;
  /** A new binding row was inserted for the current winner. */
  inserted: number;
  /** True when the active binding set changed (archived or inserted > 0). */
  changed: boolean;
}

/**
 * Reconcile one artifact's binding to the current DB claim state, in ONE
 * transaction opened by the per-artifact advisory lock (the FIRST statement, so
 * it serializes with the assertion service + floor rebalancer on the same
 * artifact). Idempotent: a binding already matching the winner is a no-op; a
 * quarantined object ends with no active binding. Safe to call after ANY write
 * that may have changed `objects.type` (type change across claims, undo/restore)
 * and from the reconcile-queue consumer + backfill sweep.
 */
export function reconcileArtifactBinding(input: {
  orgId: string;
  artifactId: string;
}): ReconcileArtifactBindingResult {
  ensurePostgresSchema();
  const results = runPostgresQueriesSync({
    connectionString: conn(),
    transaction: true,
    queries: [
      // REPEATABLE READ so the archive + insert statements resolve the winner
      // against ONE consistent snapshot. Without it (READ COMMITTED) a claim
      // winner change committed BETWEEN the two statements could let the archive
      // retain binding A while the insert adds binding B — two active bindings,
      // a spurious sa_one_active_binding_idx violation. The per-artifact advisory
      // lock serializes semantic_assertion writes for this artifact (so no
      // write-write serialization failure), and a concurrent winner change is
      // simply invisible to this snapshot — it enqueued its own reconcile row,
      // so a later drain converges. SET must precede any table access.
      { text: `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`, values: [] },
      { text: `SELECT pg_advisory_xact_lock(hashtext($1))`, values: [input.artifactId] },
      ...buildBindingReconcileQueries(postgresSchema, {
        orgId: input.orgId,
        artifactId: input.artifactId,
      }),
    ],
  });
  // results: [0]=SET, [1]=lock, [2]=archive UPDATE, [3]=insert RETURNING.
  const archived = results[2]?.rowCount ?? 0;
  const inserted = results[3]?.rowCount ?? 0;
  return { archived, inserted, changed: archived > 0 || inserted > 0 };
}

export interface ActiveBindingRow {
  id: string;
  extension: string;
  bindingClaimId: string;
  bindingGeneration: number;
}

/** The single active binding for an artifact (sa_one_active_binding_idx makes it
 * at most one), or null. A read helper for tests + serving diagnostics. */
export function readActiveBinding(orgId: string, artifactId: string): ActiveBindingRow | null {
  ensurePostgresSchema();
  const r = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `SELECT id, extension, binding_claim_id, binding_generation
FROM "${q()}"."semantic_assertion"
WHERE org_id = $1 AND artifact_id = $2
  AND assertion_basis = 'binding' AND eligibility <> 'archived'
LIMIT 1`,
        values: [orgId, artifactId],
      },
    ],
  });
  const row = r?.[0]?.rows?.[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: String(row.id),
    extension: String(row.extension),
    bindingClaimId: String(row.binding_claim_id),
    bindingGeneration: Number(row.binding_generation),
  };
}
