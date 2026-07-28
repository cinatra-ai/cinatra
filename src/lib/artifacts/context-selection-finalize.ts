import "server-only";
import { randomUUID, createHash } from "node:crypto";

import { runPostgresQueriesSync } from "@/lib/postgres-sync";
// Sync-leaf connection/schema primitives (the artifact-refs-store /
// binding-write-path contract): never import `@/lib/database` from a sync
// store leaf — database.ts is an ASYNC module in Turbopack dev.
import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";

import { objectTypeRegistry } from "@cinatra-ai/objects/registry";

import type { RunContextSelectionRow } from "./run-context-selections-store";
import type { ReferrerKind } from "./artifact-refs-store";
import { computeClaimDispositionFingerprint } from "./object-content-snapshot";
import { artifactWriterWitnessExistsSql } from "./artifact-writer-witness";
// NOTE the RAW `postgresSchema` at every call site: this builder escapes its own
// identifier (the binding-write-path convention), and the local `schema` const is
// ALREADY escaped — passing it would double-escape an embedded quote.
import { bindingIsCurrentWinnerSql } from "@/lib/objects/binding-write-path";

// ---------------------------------------------------------------------------
// Context-selection FINALIZATION (cinatra#1430, epic #1424).
//
// Finalization commits a resolved context candidate as durable, replay-safe
// state in ONE transaction:
//   1. re-validates the (artifactId, representationRevisionId,
//      semanticAssertionId) triple's coherence IN SQL under the lock (the row
//      is live, the representation belongs to the artifact, the assertion
//      belongs to the artifact and its extension matches, and the object is a
//      generic artifact, an UNCLAIMED pack-typed row, or a CLAIMED row pinned at
//      one of the exactly two things a claimed row may expose — its policy-keyed
//      content snapshot, or a host-authored representation carrying the
//      writer-provenance witness);
//   2. appends the `run_context_selections` audit row (append-only);
//   3. writes a REAL `artifact_refs` retention pin.
//
// GROUNDED RACE it closes (AC-2): the resource GC serializes destructive
// reclaim on `pg_advisory_xact_lock(hashtext(resource.id))` and rechecks
// `NOT EXISTS artifact_refs` under that lock — but the historical pin writers
// took only a REFERRER-level lock, so a pin could commit between the GC's
// snapshot and its commit, leaving a pin at orphaned bytes. This finalizer
// takes the SAME resource-level advisory lock the GC uses, as the FIRST
// statement of the transaction, so the pin and the GC fully serialize on the
// resource:
//   - finalizer-first  → GC blocks, then its recheck sees the pin → the
//     resource survives; a PINNED resource is never deleted.
//   - GC-first         → the finalizer blocks, then its under-lock `res_alive`
//     gate finds the resource gone → the WHOLE finalization rejects
//     (SelectionCoherenceError) — never an audit row without its pin, and
//     never a pin at reclaimed bytes; the caller re-resolves (a fresh
//     snapshot remints).
//
// Writes ONLY `run_context_selections` + `artifact_refs`; `objects` is read
// (SELECT) for the coherence gate, never mutated.
// ---------------------------------------------------------------------------

const conn = (): string => getPostgresConnectionString();
const q = (): string => postgresSchema.replaceAll('"', '""');

export class SelectionCoherenceError extends Error {
  constructor(reason: string) {
    super(`[context-selection-finalize] ${reason}`);
    this.name = "SelectionCoherenceError";
  }
}

export class MissingRepresentationError extends Error {
  constructor(representationRevisionId: string) {
    super(
      `[context-selection-finalize] representation ${representationRevisionId} not found — cannot finalize a pin without its resource`,
    );
    this.name = "MissingRepresentationError";
  }
}

export interface FinalizeContextSelectionInput {
  selection: Omit<RunContextSelectionRow, "id">;
  /** Retention-pin referrer (which run/thread/envelope pins this candidate). */
  referrerKind: ReferrerKind;
  referrerId: string;
  /** Pin display metadata (decorative in the pin row). When omitted, derived
   * from the backing resource (mime; digest from the blob substance key) so
   * route callers holding only the assertion triple can finalize. */
  digest?: string;
  mime?: string;
  originKind?: string;
  createdBy?: string | null;
}

export interface FinalizeContextSelectionResult {
  selectionId: string;
  /** True when the selection audit row was newly written (idempotent replays
   * of the same deterministic id no-op). */
  selectionWritten: boolean;
  /** True when the retention pin was newly written (ON CONFLICT idempotent). */
  pinWritten: boolean;
}

/** Resolve the resource backing a representation revision — the lock target —
 * plus the pin-metadata derivation inputs (resource mime + blob substance
 * sha). The ALIVE re-check happens again INSIDE the locked transaction; this
 * pre-lock read only picks the lock key and the display metadata. */
function resolveResourceForPin(
  orgId: string,
  artifactId: string,
  representationRevisionId: string,
): { resourceId: string; mime: string; substanceSha: string | null } | null {
  const schema = q();
  const [res] = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `SELECT rep.resource_id, r.mime, r.substance_key
FROM "${schema}"."representation" rep
JOIN "${schema}"."resource" r
  ON r.id = rep.resource_id AND r.org_id = rep.org_id
WHERE rep.org_id = $1 AND rep.artifact_id = $2 AND rep.id = $3 LIMIT 1`,
        values: [orgId, artifactId, representationRevisionId],
      },
    ],
  });
  const row = res?.rows?.[0] as
    | { resource_id?: string; mime?: string; substance_key?: string }
    | undefined;
  if (!row?.resource_id) return null;
  const key = typeof row.substance_key === "string" ? row.substance_key : "";
  return {
    resourceId: String(row.resource_id),
    mime: String(row.mime ?? "application/octet-stream"),
    substanceSha: key.startsWith("blob:") ? key.slice("blob:".length) : null,
  };
}

const GENERIC_ARTIFACT_OBJECT_TYPE = "@cinatra-ai/artifact:object";

/** The registered isArtifact PACK type ids (NOT the generic base). The coherence
 * gate admits a NON-CLAIMED pack row of one of these types; a CLAIMED pack row
 * routes through either the binding-SNAPSHOT branch (cinatra#1430) or the
 * binding-plus-WITNESS branch (cinatra#2139) — never through the bare type. Read
 * at CALL time (never a frozen module-load snapshot). */
function registeredPackArtifactTypes(): string[] {
  return objectTypeRegistry.listArtifacts().map((d) => d.type);
}

/**
 * The CLAIMED + HOST-AUTHORED admission branch (cinatra#2139), emitted into BOTH
 * coherence statements — `buildFinalizeQuery`'s `coherent` CTE and
 * `buildProbeQuery`'s read-only probe — from this ONE definition, so the two can
 * never disagree about what finalizes. Assumes the surrounding statement's
 * aliases: `o` (the objects row), `rep` (the pinned representation) and `sa` (the
 * selection's assertion, already constrained to the selection's extension and to
 * `eligibility = 'eligible'`). `packTypesPh` is that statement's own positional
 * placeholder for the registered isArtifact PACK type ids — the two statements
 * number their parameters differently, which is exactly why it is an argument.
 *
 * WHAT IT ADMITS. A claimed row of a registered isArtifact PACK type, selected AS
 * its BINDING, whose winning claim's dispositions permit pinning, pinned at a
 * representation carrying the shared writer-provenance witness. Those bytes are
 * AUTHORED CONTENT, not a rendering of the mutable object row, so there is no
 * snapshot policy to bypass and no claimant boundary to cross — the same argument
 * the serve arm makes for the same rows (cinatra#2047 OBS-1). `snapshotPolicy` is
 * deliberately NOT consulted: it governs serializing `objects.data`, and this arm
 * serializes nothing.
 *
 * THE CLAIMANT GUARD, without a fingerprint. The snapshot branch pins its
 * representation to the capture-time claim/disposition fingerprint because a
 * snapshot is a rendering OF a claimant's view. An authored representation is
 * not, so the guard here is IDENTITY, not content: the selection must name the
 * binding ITSELF (`b.id = sa.id`), that binding must still be eligible, and it
 * must be the CANONICAL WINNER for the object's current type — re-derived through
 * the same builder the reconcile write path uses.
 *
 * Eligibility alone is not enough (codex round-2 finding): activating a claim,
 * retiring one, or changing the object's type moves the winner IMMEDIATELY while
 * the binding follows only when the reconcile queue drains, and because claim
 * uniqueness is PER SCOPE an org claim can win over a platform claim with both
 * rows still 'active'. A plain `status` check therefore neither sees that case
 * nor admits a RETIRING claim that is still legitimately the winner. Winner
 * identity answers both. The gate is deliberately NOT added to the snapshot
 * branch below, whose predicate is the shipped, ratified one — the same queue-lag
 * window is part of that branch's contract, and narrowing it is a change to
 * claimed-row pinning as a whole, not a detail of this branch.
 */
function claimedWitnessedBranchSql(schema: string, packTypesPh: string): string {
  return `OR (
        o.type = ANY(${packTypesPh}::text[])
        AND sa.assertion_basis = 'binding'
        AND EXISTS (
          SELECT 1 FROM "${schema}"."semantic_assertion" b
          JOIN "${schema}"."artifact_type_claims" c ON c.id = b.binding_claim_id
          WHERE b.org_id = o.org_id AND b.artifact_id = o.id AND b.id = sa.id
            AND b.assertion_basis = 'binding' AND b.eligibility = 'eligible'
            AND c.dispositions->>'pinnable' = 'true'
            AND ${bindingIsCurrentWinnerSql(postgresSchema, {
              orgId: "o.org_id",
              objectId: "o.id",
              objectType: "o.type",
              binding: "b",
            })}
        )
        AND ${artifactWriterWitnessExistsSql(schema, {
          orgId: "rep.org_id",
          artifactId: "rep.artifact_id",
          representationRevisionId: "rep.id",
        })}
      )`;
}

type FinalizeArgs = {
  selectionId: string;
  s: Omit<RunContextSelectionRow, "id">;
  pinId: string;
  pinMeta: { digest: string; mime: string; originKind: string };
  referrerKind: ReferrerKind;
  referrerId: string;
  createdBy: string | null;
  resourceId: string;
  /** The CURRENT eligible binding's claim/disposition fingerprint for the
   * artifact (codex round-3): a claimed row's pinned representation must be
   * the snapshot captured under the CURRENT claimant — a binding transition
   * between capture and finalize rejects instead of pinning an old
   * claimant's snapshot under the new identity. Sentinel when no eligible
   * binding exists (the generic-type branch then decides admission). */
  currentBindingFingerprint: string;
  /** epic #1785 wave A4: the registered isArtifact PACK type ids. The coherence
   * gate admits a NON-CLAIMED row of one of these types (its producer-CLASSIC
   * assertion supplies the NOT-NULL selection triple); a CLAIMED pack row still
   * routes through the binding-snapshot branch (cinatra#1430). The generic base
   * stays a separate UNCONDITIONAL branch. Read at prepare (query-build) time. */
  packArtifactTypes: string[];
};

/**
 * The one finalize statement: coherence gate (live object + triple ownership +
 * eligible matching assertion + admissible substrate + ALIVE resource +
 * claim-disposition policy for binding rows) -> audit-row insert -> pin
 * insert, all gated on `coherent`.
 *
 * `withAbortGuard` (the ATOMIC-BATCH mode): the final SELECT raises
 * division-by-zero when the ref is incoherent OR when the pin insert no-oped
 * without a pre-existing pin -- aborting the WHOLE surrounding transaction so
 * a multi-ref finalization is all-or-nothing (append-only audit rows cannot
 * be compensated after a partial commit).
 */
function buildFinalizeQuery(schema: string, a: FinalizeArgs, withAbortGuard: boolean) {
  // NOTE: never write a literal \`1/0\` here — PostgreSQL CONSTANT-FOLDS it at
  // plan time and raises even inside a CASE branch that would not execute.
  // Both guards divide by a SUBQUERY-derived value instead (not foldable):
  // the division errors exactly when the guarded condition holds.
  const guardCols = withAbortGuard
    ? `,
  (1 / (SELECT count(*)::int FROM coherent)) AS incoherent_abort,
  (1 / (CASE WHEN EXISTS (SELECT 1 FROM coherent)
              AND (SELECT count(*) FROM pin) = 0
              AND NOT EXISTS (SELECT 1 FROM pre_pin)
            THEN 0 ELSE 1 END)) AS pin_invariant_abort`
    : "";
  return {
    text: `WITH res_alive AS (
  SELECT 1 FROM "${schema}"."representation" rep
  JOIN "${schema}"."resource" res
    ON res.id = rep.resource_id AND res.org_id = rep.org_id
  WHERE rep.org_id = $2 AND rep.artifact_id = $6 AND rep.id = $7
),
pre_pin AS (
  SELECT 1 FROM "${schema}"."artifact_refs"
  WHERE org_id = $2 AND artifact_id = $6 AND representation_revision_id = $7
    AND referrer_kind = $17 AND referrer_id = $18
),
coherent AS (
  SELECT 1
  FROM "${schema}"."objects" o
  JOIN "${schema}"."representation" rep
    ON rep.org_id = o.org_id AND rep.artifact_id = o.id AND rep.id = $7
  JOIN "${schema}"."semantic_assertion" sa
    ON sa.org_id = o.org_id AND sa.artifact_id = o.id AND sa.id = $8
  WHERE o.id = $6 AND o.org_id = $2 AND o.deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM res_alive)
    AND sa.extension = $9 AND sa.eligibility = 'eligible'
    AND (
      -- Generic base: admitted UNCONDITIONALLY (legacy rows, until the #1785 A6
      -- purge) — unchanged behavior.
      o.type = $19
      -- epic #1785 wave A4: a registered isArtifact PACK type — admitted only
      -- when NOT CLAIMED. Its producer-CLASSIC assertion ($8) supplies the
      -- selection triple and its latest representation is the pinned rep (no
      -- content snapshot required). A CLAIMED pack row (like any claimed row)
      -- must route through the binding-snapshot branch below, NEVER this bare
      -- type branch (cinatra#1430 claimant-isolation preserved).
      OR (
        o.type = ANY($22::text[])
        AND NOT EXISTS (
          SELECT 1 FROM "${schema}"."semantic_assertion" bnd
          WHERE bnd.org_id = o.org_id AND bnd.artifact_id = o.id
            AND bnd.assertion_basis = 'binding' AND bnd.eligibility = 'eligible'
        )
      )
      OR (
        EXISTS (
          -- Claimed-row path: the binding must be eligible AND its claim's
          -- dispositions must still permit pinning (policy re-check at
          -- finalization -- codex round-2 finding; SQL string comparisons
          -- align with the zod fail-closed defaults).
          SELECT 1 FROM "${schema}"."semantic_assertion" b
          JOIN "${schema}"."artifact_type_claims" c ON c.id = b.binding_claim_id
          WHERE b.org_id = o.org_id AND b.artifact_id = o.id
            AND b.assertion_basis = 'binding' AND b.eligibility = 'eligible'
            AND c.dispositions->>'pinnable' = 'true'
            AND c.dispositions->>'snapshotPolicy' = 'content'
        )
        -- ... AND the pinned representation is the snapshot captured under
        -- the CURRENT claimant (codex round-3: a binding transition between
        -- capture and finalize rejects; never an old claimant's snapshot
        -- pinned under the new identity).
        AND EXISTS (
          SELECT 1 FROM "${schema}"."object_content_snapshots" snap
          WHERE snap.org_id = $2 AND snap.object_id = $6
            AND snap.representation_revision_id = $7
            AND snap.claim_disposition_fingerprint = $21
        )
      )
      ${claimedWitnessedBranchSql(schema, "$22")}
    )
),
sel AS (
  INSERT INTO "${schema}"."run_context_selections" (
    id, org_id, parent_run_id, parent_package_name, slot_id,
    artifact_id, representation_revision_id, semantic_assertion_id,
    extension, source_scope, selected_by, selection_mode
  )
  SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12 FROM coherent
  ON CONFLICT (id) DO NOTHING
  RETURNING id
),
pin AS (
  INSERT INTO "${schema}"."artifact_refs"
    (id, org_id, artifact_id, representation_revision_id, digest, mime,
     origin_kind, referrer_kind, referrer_id, metadata, created_by)
  SELECT $13, $2, $6, $7, $14, $15, $16, $17, $18, '{}'::jsonb, $20
  WHERE EXISTS (SELECT 1 FROM coherent)
  ON CONFLICT (org_id, artifact_id, representation_revision_id, referrer_kind, referrer_id) DO NOTHING
  RETURNING id
)
SELECT
  EXISTS (SELECT 1 FROM coherent) AS coherent,
  EXISTS (SELECT 1 FROM res_alive) AS resource_alive,
  EXISTS (SELECT 1 FROM pre_pin) AS pre_pin,
  (SELECT count(*)::int FROM sel) AS selection_written,
  (SELECT count(*)::int FROM pin) AS pin_written${guardCols}`,
    values: [
      a.selectionId, // $1
      a.s.orgId, // $2
      a.s.parentRunId, // $3
      a.s.parentPackageName, // $4
      a.s.slotId, // $5
      a.s.artifactId, // $6
      a.s.representationRevisionId, // $7
      a.s.semanticAssertionId, // $8
      a.s.extension, // $9
      a.s.sourceScope, // $10
      a.s.selectedBy, // $11
      a.s.selectionMode, // $12
      a.pinId, // $13
      a.pinMeta.digest, // $14
      a.pinMeta.mime, // $15
      a.pinMeta.originKind, // $16
      a.referrerKind, // $17
      a.referrerId, // $18
      GENERIC_ARTIFACT_OBJECT_TYPE, // $19
      a.createdBy, // $20
      a.currentBindingFingerprint, // $21
      a.packArtifactTypes, // $22
    ],
  };
}

const NO_BINDING_FINGERPRINT_SENTINEL = "__no-eligible-binding__";

/** The CURRENT eligible binding's fingerprint for an artifact (or the
 * never-matching sentinel). */
function readCurrentBindingFingerprint(orgId: string, artifactId: string): string {
  const schema = q();
  const [res] = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `SELECT b.binding_claim_id, b.binding_generation, b.extension, c.dispositions
FROM "${schema}"."semantic_assertion" b
LEFT JOIN "${schema}"."artifact_type_claims" c ON c.id = b.binding_claim_id
WHERE b.org_id = $1 AND b.artifact_id = $2
  AND b.assertion_basis = 'binding' AND b.eligibility = 'eligible'
LIMIT 1`,
        values: [orgId, artifactId],
      },
    ],
  });
  const row = res?.rows?.[0] as
    | { binding_claim_id?: string; binding_generation?: number | string; extension?: string; dispositions?: unknown }
    | undefined;
  if (!row?.binding_claim_id) return NO_BINDING_FINGERPRINT_SENTINEL;
  return computeClaimDispositionFingerprint({
    bindingClaimId: String(row.binding_claim_id),
    bindingGeneration: row.binding_generation == null ? null : Number(row.binding_generation),
    extension: row.extension ?? null,
    dispositions: row.dispositions ?? null,
  });
}

/** Resolve one input's lock target + ids + derived pin metadata (readable
 * errors before any transaction opens). */
function prepareFinalizeArgs(input: FinalizeContextSelectionInput): FinalizeArgs {
  const s = input.selection;
  const backing = resolveResourceForPin(s.orgId, s.artifactId, s.representationRevisionId);
  if (!backing) throw new MissingRepresentationError(s.representationRevisionId);
  // Deterministic selection id (content-addressed) so a retry of the exact
  // same finalization does not append a duplicate audit row. IDENTITY-COMPLETE
  // over every immutable audit-row field (codex finding): two finalizations
  // differing in scope/selector/mode must never collide into one row.
  const selectionId = `sel:${sha(
    [
      s.orgId,
      s.parentRunId,
      s.parentPackageName,
      s.slotId,
      s.artifactId,
      s.representationRevisionId,
      s.semanticAssertionId,
      s.extension,
      s.sourceScope,
      s.selectedBy,
      s.selectionMode,
      input.referrerKind,
      input.referrerId,
    ].join("\u0000"),
  )}`;
  return {
    selectionId,
    s,
    pinId: randomUUID(),
    pinMeta: {
      digest: input.digest ?? backing.substanceSha ?? backing.resourceId,
      mime: input.mime ?? backing.mime,
      originKind: input.originKind ?? "context",
    },
    referrerKind: input.referrerKind,
    referrerId: input.referrerId,
    createdBy: input.createdBy ?? null,
    resourceId: backing.resourceId,
    currentBindingFingerprint: readCurrentBindingFingerprint(s.orgId, s.artifactId),
    packArtifactTypes: registeredPackArtifactTypes(),
  };
}

type FinalizeRow = {
  coherent: boolean;
  resource_alive: boolean;
  pre_pin: boolean;
  selection_written: number;
  pin_written: number;
};

function toResult(a: FinalizeArgs, out: FinalizeRow | undefined): FinalizeContextSelectionResult {
  if (!out || out.coherent !== true) {
    throw new SelectionCoherenceError(
      out && out.resource_alive === false
        ? `resource backing representation ${a.s.representationRevisionId} was reclaimed by GC -- the candidate is gone; re-resolve (a fresh snapshot will remint)`
        : `incoherent triple for artifact ${a.s.artifactId} (rep ${a.s.representationRevisionId}, assertion ${a.s.semanticAssertionId}, extension ${a.s.extension}) -- not a live pinnable generic-or-claimed artifact, or the representation/assertion do not belong to it`,
    );
  }
  const pinWritten = (out.pin_written ?? 0) > 0;
  if (!pinWritten && out.pre_pin !== true) {
    // Defensive: with coherent gating both writes (and res_alive inside it),
    // the pin INSERT can only no-op via ON CONFLICT (pre_pin). Anything else
    // is a broken invariant -- fail loud, never a selection without its
    // retention pin.
    throw new SelectionCoherenceError(
      `pin write no-oped without a pre-existing pin for artifact ${a.s.artifactId} rep ${a.s.representationRevisionId} -- invariant broken`,
    );
  }
  return {
    selectionId: a.selectionId,
    selectionWritten: (out.selection_written ?? 0) > 0,
    pinWritten,
  };
}

/**
 * Finalize ONE resolved context candidate: coherence re-validation +
 * `run_context_selections` row + a REAL `artifact_refs` retention pin, all in
 * ONE transaction serialized against the resource GC on the backing resource.
 * The selection id is content-addressed on the full immutable field set so an
 * exact replay is idempotent.
 */
export function finalizeContextSelectionPin(
  input: FinalizeContextSelectionInput,
): FinalizeContextSelectionResult {
  ensurePostgresSchema();
  const schema = q();
  const a = prepareFinalizeArgs(input);
  const stmt = buildFinalizeQuery(schema, a, false);
  const [, capRes] = runPostgresQueriesSync({
    connectionString: conn(),
    transaction: true,
    queries: [
      // SAME resource-level lock the GC takes (hashtext(resource.id)) -- FIRST.
      { text: `SELECT pg_advisory_xact_lock(hashtext($1))`, values: [a.resourceId] },
      stmt,
    ],
  });
  return toResult(a, capRes?.rows?.[0] as FinalizeRow | undefined);
}

/**
 * Finalize a MULTI-REF selection ATOMICALLY (codex round-2 finding): the
 * append-only audit table cannot be compensated after a partial commit, so an
 * accumulate-mode selection must land all-or-nothing. One transaction takes
 * EVERY backing resource's GC lock in DETERMINISTIC (sorted, deduped) order --
 * no lock-order deadlock between concurrent batches -- then runs each ref's
 * finalize statement WITH the abort guard: any incoherent ref (or a broken
 * pin invariant) aborts the whole transaction. On abort, each ref is
 * re-probed individually (non-transactionally) to surface a READABLE
 * SelectionCoherenceError naming the offending ref.
 */
export function finalizeContextSelectionPinsAtomic(
  inputs: ReadonlyArray<FinalizeContextSelectionInput>,
): FinalizeContextSelectionResult[] {
  if (inputs.length === 0) return [];
  ensurePostgresSchema();
  const schema = q();
  const args = inputs.map((i) => prepareFinalizeArgs(i));
  const lockIds = [...new Set(args.map((a) => a.resourceId))].sort();
  const queries: Array<{ text: string; values: unknown[] }> = lockIds.map((rid) => ({
    text: `SELECT pg_advisory_xact_lock(hashtext($1))`,
    values: [rid],
  }));
  for (const a of args) queries.push(buildFinalizeQuery(schema, a, true));
  let results: Array<{ rows?: unknown[] } | undefined>;
  try {
    results = runPostgresQueriesSync({
      connectionString: conn(),
      transaction: true,
      queries,
    });
  } catch (err) {
    // The abort guard fired (division_by_zero) -- or the DB failed outright.
    // Re-probe each ref individually for a readable error; when every probe
    // passes (a transient race resolved), surface the raw error instead.
    for (const a of args) {
      const probe = runPostgresQueriesSync({
        connectionString: conn(),
        queries: [buildProbeQuery(schema, a)],
      })[0];
      const row = probe?.rows?.[0] as { coherent?: boolean; resource_alive?: boolean } | undefined;
      if (!row || row.coherent !== true) {
        throw new SelectionCoherenceError(
          row && row.resource_alive === false
            ? `batch aborted: resource backing representation ${a.s.representationRevisionId} was reclaimed by GC -- re-resolve`
            : `batch aborted: incoherent triple for artifact ${a.s.artifactId} (rep ${a.s.representationRevisionId}, assertion ${a.s.semanticAssertionId}, extension ${a.s.extension})`,
        );
      }
    }
    throw err;
  }
  return args.map((a, i) =>
    toResult(a, results[lockIds.length + i]?.rows?.[0] as FinalizeRow | undefined),
  );
}

/** Read-only coherence probe (the batch error path's readable diagnosis). */
function buildProbeQuery(schema: string, a: FinalizeArgs) {
  return {
    text: `SELECT
  EXISTS (
    SELECT 1
    FROM "${schema}"."objects" o
    JOIN "${schema}"."representation" rep
      ON rep.org_id = o.org_id AND rep.artifact_id = o.id AND rep.id = $3
    JOIN "${schema}"."semantic_assertion" sa
      ON sa.org_id = o.org_id AND sa.artifact_id = o.id AND sa.id = $4
    WHERE o.id = $2 AND o.org_id = $1 AND o.deleted_at IS NULL
      AND sa.extension = $5 AND sa.eligibility = 'eligible'
      AND EXISTS (
        SELECT 1 FROM "${schema}"."representation" rep2
        JOIN "${schema}"."resource" res ON res.id = rep2.resource_id AND res.org_id = rep2.org_id
        WHERE rep2.org_id = $1 AND rep2.artifact_id = $2 AND rep2.id = $3
      )
      AND (
        o.type = $6
        OR (
          o.type = ANY($8::text[])
          AND NOT EXISTS (
            SELECT 1 FROM "${schema}"."semantic_assertion" bnd
            WHERE bnd.org_id = o.org_id AND bnd.artifact_id = o.id
              AND bnd.assertion_basis = 'binding' AND bnd.eligibility = 'eligible'
          )
        )
        OR (
          EXISTS (
            SELECT 1 FROM "${schema}"."semantic_assertion" b
            JOIN "${schema}"."artifact_type_claims" c ON c.id = b.binding_claim_id
            WHERE b.org_id = o.org_id AND b.artifact_id = o.id
              AND b.assertion_basis = 'binding' AND b.eligibility = 'eligible'
              AND c.dispositions->>'pinnable' = 'true'
              AND c.dispositions->>'snapshotPolicy' = 'content'
          )
          AND EXISTS (
            SELECT 1 FROM "${schema}"."object_content_snapshots" snap
            WHERE snap.org_id = $1 AND snap.object_id = $2
              AND snap.representation_revision_id = $3
              AND snap.claim_disposition_fingerprint = $7
          )
        )
        ${claimedWitnessedBranchSql(schema, "$8")}
      )
  ) AS coherent,
  EXISTS (
    SELECT 1 FROM "${schema}"."representation" rep
    JOIN "${schema}"."resource" res ON res.id = rep.resource_id AND res.org_id = rep.org_id
    WHERE rep.org_id = $1 AND rep.artifact_id = $2 AND rep.id = $3
  ) AS resource_alive`,
    values: [
      a.s.orgId,
      a.s.artifactId,
      a.s.representationRevisionId,
      a.s.semanticAssertionId,
      a.s.extension,
      GENERIC_ARTIFACT_OBJECT_TYPE,
      a.currentBindingFingerprint,
      a.packArtifactTypes,
    ],
  };
}

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
