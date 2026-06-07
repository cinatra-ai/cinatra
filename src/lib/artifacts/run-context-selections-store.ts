import "server-only";
import { randomUUID } from "node:crypto";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import {
  getPostgresConnectionString,
  ensurePostgresSchema,
  postgresSchema,
} from "@/lib/database";

// ---------------------------------------------------------------------------
// run_context_selections audit store.
//
// Append-only audit log written by the context-agent at every selection.
// Pins the replay-safe triple at the SELECTION boundary so the parent
// agent's replay resolves to the exact artifact version + the exact
// extension classification that was active at run-time. Any future
// reclassification of the same artifact (new semantic_assertion row) or
// new representation revision DOES NOT change historical replays — they
// continue to resolve via the pinned triple.
//
// Append-only invariant: corrections are a NEW row, never a mutation.
// The DDL trigger enforces this; this helper exposes ONLY insert + read.
// ---------------------------------------------------------------------------

const conn = (): string => getPostgresConnectionString();
const q = (): string => postgresSchema.replaceAll('"', '""');

export type RunContextSelectionRow = {
  id: string;
  orgId: string;
  parentRunId: string;
  parentPackageName: string;
  slotId: string;
  artifactId: string;
  representationRevisionId: string;
  semanticAssertionId: string;
  extension: string;
  sourceScope: "user" | "team" | "organization" | "workspace" | "project";
  /** Who chose this ref:
   *   - "user"       — human picked via interactive HITL renderer
   *   - "agent"      — the parent agent invoked the resolver and the
   *                    context-agent picked (autonomous + override)
   *   - "autonomous" — the resolver-only path (no parent-agent layer
   *                    making a deterministic pick) */
  selectedBy: "user" | "agent" | "autonomous";
  selectionMode: "interactive" | "autonomous";
};

// Triple-coherence validation runs BEFORE insert. The DDL alone admits
// arbitrary (artifact_id, representationRevisionId, semanticAssertionId,
// extension) combinations. A caller could write an audit row pinning
// representation R from artifact A but the assertion from artifact B —
// silently breaking replay-safety. This pre-flight read verifies all
// three foreign rows point at the same (org_id, artifact_id) and that
// the assertion's extension matches the audit row's claimed extension.
//
// Returns null on validity OR a human-readable rejection message.
// Throwing is the caller's job (writeRunContextSelection / batch wrap).
const SEMANTIC_ARTIFACT_OBJECT_TYPE = "@cinatra-ai/artifact:object";

function validateTripleCoherence(
  schema: string,
  input: Omit<RunContextSelectionRow, "id">,
): string | null {
  // Also verify the artifact OBJECT is live (not tombstoned, correct
  // semantic-artifact type). Mirrors the resolver's pre-flight
  // (objects.type = SEMANTIC_ARTIFACT_OBJECT_TYPE AND
  // objects.deleted_at IS NULL). Without this, a coherent triple could
  // still pin a tombstoned-but-retained artifact OR a wrong-typed
  // object (e.g. a generic objects.id whose type doesn't match the
  // semantic-artifact substrate) — neither would replay cleanly.
  const [obj] = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `SELECT 1 FROM "${schema}"."objects"
WHERE id = $1 AND org_id = $2
  AND type = $3 AND deleted_at IS NULL
LIMIT 1`,
        values: [input.artifactId, input.orgId, SEMANTIC_ARTIFACT_OBJECT_TYPE],
      },
    ],
  });
  if ((obj?.rows ?? []).length === 0) {
    return `artifact ${input.artifactId} is not a live semantic artifact in org ${input.orgId} (tombstoned, wrong type, or missing)`;
  }
  const [rep] = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `SELECT artifact_id FROM "${schema}"."representation"
WHERE id = $1 AND org_id = $2 LIMIT 1`,
        values: [input.representationRevisionId, input.orgId],
      },
    ],
  });
  const repRow = (rep?.rows?.[0] as { artifact_id?: string } | undefined) ?? null;
  if (!repRow) {
    return `representation ${input.representationRevisionId} not found in org ${input.orgId}`;
  }
  if (repRow.artifact_id !== input.artifactId) {
    return `representation ${input.representationRevisionId} belongs to artifact ${repRow.artifact_id}, not ${input.artifactId}`;
  }
  const [sa] = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `SELECT artifact_id, extension FROM "${schema}"."semantic_assertion"
WHERE id = $1 AND org_id = $2 LIMIT 1`,
        values: [input.semanticAssertionId, input.orgId],
      },
    ],
  });
  const saRow =
    (sa?.rows?.[0] as
      | { artifact_id?: string; extension?: string }
      | undefined) ?? null;
  if (!saRow) {
    return `semantic_assertion ${input.semanticAssertionId} not found in org ${input.orgId}`;
  }
  if (saRow.artifact_id !== input.artifactId) {
    return `semantic_assertion ${input.semanticAssertionId} belongs to artifact ${saRow.artifact_id}, not ${input.artifactId}`;
  }
  if (saRow.extension !== input.extension) {
    return `semantic_assertion ${input.semanticAssertionId} has extension '${saRow.extension}', not '${input.extension}'`;
  }
  return null;
}

/** Insert one selection-audit row. Returns the row's id. Validates
 *  triple coherence before insert. */
export function writeRunContextSelection(
  input: Omit<RunContextSelectionRow, "id">,
): string {
  ensurePostgresSchema();
  const schema = q();
  const coherenceErr = validateTripleCoherence(schema, input);
  if (coherenceErr) {
    throw new Error(`[run_context_selections] ${coherenceErr}`);
  }
  const id = randomUUID();
  runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `INSERT INTO "${schema}"."run_context_selections" (
  id, org_id, parent_run_id, parent_package_name, slot_id,
  artifact_id, representation_revision_id, semantic_assertion_id,
  extension, source_scope, selected_by, selection_mode
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        values: [
          id,
          input.orgId,
          input.parentRunId,
          input.parentPackageName,
          input.slotId,
          input.artifactId,
          input.representationRevisionId,
          input.semanticAssertionId,
          input.extension,
          input.sourceScope,
          input.selectedBy,
          input.selectionMode,
        ],
      },
    ],
  });
  return id;
}

/** Batch insert. Each ref produces one audit row. Validates ALL
 *  triples first, then issues ONE transaction so the audit log never
 *  lands a partial-write on accumulate-mode failure. Returns the row
 *  ids in input order. */
export function writeRunContextSelectionsBatch(
  rows: ReadonlyArray<Omit<RunContextSelectionRow, "id">>,
): string[] {
  if (rows.length === 0) return [];
  ensurePostgresSchema();
  const schema = q();
  // 1. Pre-flight validate every row's coherence — fail-fast BEFORE
  //    we open the insert transaction.
  for (const r of rows) {
    const err = validateTripleCoherence(schema, r);
    if (err) {
      throw new Error(`[run_context_selections batch] ${err}`);
    }
  }
  // 2. Issue all inserts in a single transaction so a downstream
  //    constraint check (e.g. enum violation, NULL field — both
  //    already rejected by validateTripleCoherence + DDL CHECKs)
  //    never leaves a partial audit.
  const ids = rows.map(() => randomUUID());
  runPostgresQueriesSync({
    connectionString: conn(),
    transaction: true,
    queries: rows.map((input, idx) => ({
      text: `INSERT INTO "${schema}"."run_context_selections" (
  id, org_id, parent_run_id, parent_package_name, slot_id,
  artifact_id, representation_revision_id, semantic_assertion_id,
  extension, source_scope, selected_by, selection_mode
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      values: [
        ids[idx],
        input.orgId,
        input.parentRunId,
        input.parentPackageName,
        input.slotId,
        input.artifactId,
        input.representationRevisionId,
        input.semanticAssertionId,
        input.extension,
        input.sourceScope,
        input.selectedBy,
        input.selectionMode,
      ],
    })),
  });
  return ids;
}

/** Read all selection rows for a parent run, oldest→newest. */
/**
 * Count audit rows already written for a content-addressed selection key.
 *
 * The idempotent writer encodes a deterministic `selectionKey` as the row-id
 * prefix (`id = "<selectionKey>:<i>"`). An exact replay of the same selection
 * therefore produces the same ids; this count lets the writer no-op without
 * appending duplicate audit rows. `selectionKey` is a hex digest (no LIKE
 * wildcards), and the LIKE value is parameterized regardless.
 */
export function countRunContextSelectionsBySelectionKey(input: {
  orgId: string;
  parentRunId: string;
  parentPackageName: string;
  slotId: string;
  selectionKey: string;
}): number {
  ensurePostgresSchema();
  const schema = q();
  const [res] = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `SELECT count(*)::int AS n
FROM "${schema}"."run_context_selections"
WHERE org_id = $1 AND parent_run_id = $2 AND parent_package_name = $3
  AND slot_id = $4 AND id LIKE $5`,
        values: [
          input.orgId,
          input.parentRunId,
          input.parentPackageName,
          input.slotId,
          `${input.selectionKey}:%`,
        ],
      },
    ],
  });
  const n = (res?.rows?.[0] as { n?: number } | undefined)?.n;
  return typeof n === "number" ? n : 0;
}

/**
 * Content-addressed, idempotent batch writer.
 *
 * Each row id is deterministic: `"<selectionKey>:<i>"`. An exact replay (same
 * `selectionKey`) is a no-op — `count(*)` for the key is checked first, and a
 * concurrent racer that loses the primary-key insert is re-checked and treated
 * as idempotent success (the rows it wanted now exist). A *changed* selection
 * produces a different `selectionKey` and appends a NEW batch, preserving the
 * append-only history.
 *
 * `selectionKey` MUST be derived by the caller from the canonical
 * (parentRunId, parentPackageName, slotId, selectionMode, sorted+deduped
 * ref-triples) so replay-equality is content-addressed.
 */
export function writeRunContextSelectionsBatchIdempotent(
  rows: ReadonlyArray<Omit<RunContextSelectionRow, "id">>,
  selectionKey: string,
): { ids: string[]; wrote: boolean } {
  if (rows.length === 0) return { ids: [], wrote: false };
  if (!selectionKey) {
    throw new Error("[run_context_selections] selectionKey is required");
  }
  // All rows of a selection share the same org/run/package/slot — read the
  // identity off the first row for the existence check.
  const first = rows[0];
  const keyArgs = {
    orgId: first.orgId,
    parentRunId: first.parentRunId,
    parentPackageName: first.parentPackageName,
    slotId: first.slotId,
    selectionKey,
  };
  const existing = countRunContextSelectionsBySelectionKey(keyArgs);
  if (existing > 0) {
    return {
      ids: rows.map((_, i) => `${selectionKey}:${i}`),
      wrote: false,
    };
  }
  // Validate every row's triple coherence BEFORE opening the transaction.
  ensurePostgresSchema();
  const schema = q();
  for (const r of rows) {
    const err = validateTripleCoherence(schema, r);
    if (err) {
      throw new Error(`[run_context_selections idempotent] ${err}`);
    }
  }
  const ids = rows.map((_, i) => `${selectionKey}:${i}`);
  try {
    runPostgresQueriesSync({
      connectionString: conn(),
      transaction: true,
      queries: rows.map((input, idx) => ({
        text: `INSERT INTO "${schema}"."run_context_selections" (
  id, org_id, parent_run_id, parent_package_name, slot_id,
  artifact_id, representation_revision_id, semantic_assertion_id,
  extension, source_scope, selected_by, selection_mode
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        values: [
          ids[idx],
          input.orgId,
          input.parentRunId,
          input.parentPackageName,
          input.slotId,
          input.artifactId,
          input.representationRevisionId,
          input.semanticAssertionId,
          input.extension,
          input.sourceScope,
          input.selectedBy,
          input.selectionMode,
        ],
      })),
    });
    return { ids, wrote: true };
  } catch (err) {
    // A concurrent racer may have inserted the same deterministic ids first
    // (primary-key unique violation). Re-check: if the rows for this key now
    // exist, this is idempotent success; otherwise the error is real.
    if (countRunContextSelectionsBySelectionKey(keyArgs) > 0) {
      return { ids, wrote: false };
    }
    throw err;
  }
}

export function readRunContextSelectionsForRun(input: {
  orgId: string;
  parentRunId: string;
}): RunContextSelectionRow[] {
  ensurePostgresSchema();
  const schema = q();
  const [res] = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `SELECT
  id, org_id, parent_run_id, parent_package_name, slot_id,
  artifact_id, representation_revision_id, semantic_assertion_id,
  extension, source_scope, selected_by, selection_mode
FROM "${schema}"."run_context_selections"
WHERE org_id = $1 AND parent_run_id = $2
ORDER BY selected_at ASC, id ASC`,
        values: [input.orgId, input.parentRunId],
      },
    ],
  });
  type Row = {
    id: string;
    org_id: string;
    parent_run_id: string;
    parent_package_name: string;
    slot_id: string;
    artifact_id: string;
    representation_revision_id: string;
    semantic_assertion_id: string;
    extension: string;
    source_scope: RunContextSelectionRow["sourceScope"];
    selected_by: RunContextSelectionRow["selectedBy"];
    selection_mode: RunContextSelectionRow["selectionMode"];
  };
  return (res?.rows ?? []).map((r) => {
    const row = r as Row;
    return {
      id: row.id,
      orgId: row.org_id,
      parentRunId: row.parent_run_id,
      parentPackageName: row.parent_package_name,
      slotId: row.slot_id,
      artifactId: row.artifact_id,
      representationRevisionId: row.representation_revision_id,
      semanticAssertionId: row.semantic_assertion_id,
      extension: row.extension,
      sourceScope: row.source_scope,
      selectedBy: row.selected_by,
      selectionMode: row.selection_mode,
    };
  });
}
