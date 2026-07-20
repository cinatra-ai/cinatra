// Artifact-claim registry — the DB WRITE/READ PRIMITIVES (cinatra#1425, epic
// #1424 foundation). Policy (scope/kind vocabulary, dispositions validation,
// kind-over-scope arbitration, the domination rule) lives in the pure
// `@cinatra-ai/objects` claims leaf and runs BEFORE/AFTER these primitives;
// these functions only persist, fail-closed.
//
// TRANSITION MODEL. Every winner transition is ONE transaction:
//   pg_advisory_xact_lock(hashtext('cinatra-artifact-claim:<objectTypeId>'))
// serializes all transitions for a type, then each mutating statement is a
// self-contained data-modifying-CTE chain (UPDATE → event INSERTs → queue
// INSERTs `SELECT ... FROM` the update), so a CAS miss writes NOTHING and
// every winner change commits atomically with its claim event and its
// 'binding-reconcile' + 're-projection' queue rows (consumed by the binding
// write-path sub-issue).
//
// CONSTRAINT-BACKED CONFLICTS. Reserving a second DEDICATED claim for the
// same (scope, object type) hits the partial unique index
// `artifact_type_claims_one_live_dedicated` — surfaced as a typed
// ArtifactClaimConflictError (the install error the epic specifies).
// Dedicated-vs-default is NOT a conflict: activating a dedicated claim
// transitions the dominated default claims to 'dormant' (winner-change
// events), and finalizing the dedicated claim's retirement reactivates the
// no-longer-dominated defaults with a NEW generation.

import {
  isTombstonedClaimedTypeId,
  isValidClaimScope,
  parseClaimDispositions,
  tombstonedClaimedTypeMessage,
  type ArbitrableClaim,
  type ArtifactClaimKind,
  type ArtifactClaimStatus,
} from "@cinatra-ai/objects/claims";
import { randomUUID } from "node:crypto";

import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";

type QueryInput = { text: string; values?: unknown[] };

/** Constraint-backed claim conflict (a second live claimant for an occupied
 * (scope, type, kind) slot, or a same-scope active-winner race) — the install
 * path surfaces this as an install error. */
export class ArtifactClaimConflictError extends Error {
  constructor(
    public readonly scope: string,
    public readonly objectTypeId: string,
  ) {
    super(
      `artifact-type claim conflict: a live claim already occupies '${objectTypeId}' at scope '${scope}' for this claim slot`,
    );
    this.name = "ArtifactClaimConflictError";
  }
}

const DEDICATED_CONFLICT_INDEX = "artifact_type_claims_one_live_dedicated";
const DEFAULT_CONFLICT_INDEX = "artifact_type_claims_one_live_default";
const ACTIVE_WINNER_INDEX = "artifact_type_claims_one_active_per_scope_type";

function isClaimConflictMessage(message: string): boolean {
  return (
    message.includes(DEDICATED_CONFLICT_INDEX) ||
    message.includes(DEFAULT_CONFLICT_INDEX) ||
    message.includes(ACTIVE_WINNER_INDEX)
  );
}

/** A full registry row (ArbitrableClaim + provenance the resolver/installers need). */
export interface ArtifactTypeClaimRow extends ArbitrableClaim {
  installId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ReserveArtifactTypeClaimInput {
  scope: string; // 'platform' | 'org:<id>'
  objectTypeId: string;
  claimKind: ArtifactClaimKind;
  extensionPackage: string;
  extensionVersion: string;
  installId?: string | null;
  /** Claim payload; validated against the dispositions union (fail-closed). */
  dispositions?: unknown;
  /** Event actor: a user id, an agent identity, or 'system'. */
  actor: string;
}

/** The per-type transition lock — every winner transition takes it first. */
function claimLockQuery(objectTypeId: string): QueryInput {
  return {
    text: `SELECT pg_advisory_xact_lock(hashtext('cinatra-artifact-claim:' || $1::text))`,
    values: [objectTypeId],
  };
}

export function buildReserveClaimQueries(
  schemaName: string,
  input: ReserveArtifactTypeClaimInput & { claimId: string; dispositionsJson: string | null },
): QueryInput[] {
  const s = schemaName.replaceAll('"', '""');
  return [
    {
      text: `INSERT INTO "${s}"."artifact_type_claims"
        (id, scope, object_type_id, claim_kind, extension_package, extension_version, install_id, status, dispositions)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'reserved', $8::jsonb)`,
      values: [
        input.claimId,
        input.scope,
        input.objectTypeId,
        input.claimKind,
        input.extensionPackage,
        input.extensionVersion,
        input.installId ?? null,
        input.dispositionsJson,
      ],
    },
    {
      text: `INSERT INTO "${s}"."artifact_claim_events"
        (claim_id, scope, object_type_id, event, actor, extension_package, extension_version, generation, payload)
        VALUES ($1, $2, $3, 'reserve', $4, $5, $6, 1, NULL)`,
      values: [
        input.claimId,
        input.scope,
        input.objectTypeId,
        input.actor,
        input.extensionPackage,
        input.extensionVersion,
      ],
    },
  ];
}

/**
 * Reserve a claim (lifecycle entry point). Validates scope + dispositions
 * BEFORE touching the DB; the dedicated-claimant conflict is enforced by the
 * DB partial unique index and surfaced as ArtifactClaimConflictError.
 * Returns the new claim id.
 */
export function reserveArtifactTypeClaim(input: ReserveArtifactTypeClaimInput): string {
  if (!isValidClaimScope(input.scope)) {
    throw new Error(`invalid claim scope '${input.scope}' (expected 'platform' or 'org:<id>')`);
  }
  // PERMANENT namespace tombstone (cinatra#1789, epic #1785): a retired dynamic
  // namespace (`@dynamic/types:` / `@cinatra-ai/dynamic:`) can never be claimed
  // — reject BEFORE touching the DB, fail-closed like the scope/dispositions
  // guards above. This is the direct claim-store write half of the tombstone.
  if (isTombstonedClaimedTypeId(input.objectTypeId)) {
    throw new Error(tombstonedClaimedTypeMessage(input.objectTypeId));
  }
  let dispositionsJson: string | null = null;
  if (input.dispositions !== undefined && input.dispositions !== null) {
    const parsed = parseClaimDispositions(input.dispositions);
    if (!parsed.ok) {
      throw new Error(`invalid claim dispositions: ${parsed.errors.join("; ")}`);
    }
    dispositionsJson = JSON.stringify(parsed.dispositions);
  }
  const claimId = randomUUID();
  ensurePostgresSchema();
  try {
    runPostgresQueriesSync({
      connectionString: getPostgresConnectionString(),
      transaction: true,
      queries: buildReserveClaimQueries(postgresSchema, { ...input, claimId, dispositionsJson }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isClaimConflictMessage(message)) {
      throw new ArtifactClaimConflictError(input.scope, input.objectTypeId);
    }
    throw error;
  }
  return claimId;
}

/**
 * The dormancy statement of an activation: while the claim is still
 * 'reserved' + DEDICATED (the CAS precondition — re-checked here so a failed
 * CAS never dormants anything), transition every default claim it TOTALLY
 * dominates to 'dormant' and write each one's winner-change event + queue
 * rows. Domination rule (the default-claim dormancy rule, previously also
 * mirrored by the `isDefaultClaimDominated` policy leaf, deleted in epic#1785
 * wave A5 as dead — the live SQL implementations here and in
 * `buildActivateClaimQuery` now carry it): a platform dedicated claim dominates
 * defaults at EVERY scope; an org dedicated claim dominates defaults at ITS
 * scope only.
 */
export function buildActivateDormancyQuery(schemaName: string, claimId: string, actor: string): QueryInput {
  const s = schemaName.replaceAll('"', '""');
  return {
    text: `WITH claim AS (
        SELECT id, scope, object_type_id FROM "${s}"."artifact_type_claims"
        WHERE id = $1 AND status = 'reserved' AND claim_kind = 'dedicated'
      ),
      dormanted AS (
        UPDATE "${s}"."artifact_type_claims" t
        SET status = 'dormant', updated_at = now()
        FROM claim c
        WHERE t.object_type_id = c.object_type_id
          AND t.claim_kind = 'default'
          AND t.status = 'active'
          AND (c.scope = 'platform' OR t.scope = c.scope)
        RETURNING t.id, t.scope, t.object_type_id, t.extension_package, t.extension_version, t.generation
      ),
      ev AS (
        INSERT INTO "${s}"."artifact_claim_events"
          (claim_id, scope, object_type_id, event, actor, extension_package, extension_version, generation, payload)
        SELECT d.id, d.scope, d.object_type_id, 'winner-change', $2, d.extension_package, d.extension_version, d.generation,
               jsonb_build_object('reason', 'dedicated-activated', 'transition', 'active->dormant', 'dominatingClaimId', $1::text)
        FROM dormanted d
        RETURNING id, scope, object_type_id
      )
      INSERT INTO "${s}"."artifact_binding_reconcile_queue" (scope, object_type_id, claim_event_id, kind)
      SELECT e.scope, e.object_type_id, e.id, k.kind
      FROM ev e CROSS JOIN (VALUES ('binding-reconcile'), ('re-projection')) AS k(kind)`,
    values: [claimId, actor],
  };
}

/**
 * The activation CAS: 'reserved' → 'active' — except a DEFAULT claim that is
 * currently dominated by a live dedicated claim lands 'dormant' directly
 * (never a transient second 'active' that would trip the partial unique
 * winner index). Writes the 'activate' event always (payload carries the
 * landed status) and the 'winner-change' event + queue rows only when the
 * claim actually became the active winner of its scope key. Both events go
 * through ONE ordered INSERT (activate first, winner-change second) so the
 * events table's identity `seq` reflects true transition order — sibling
 * data-modifying CTEs carry no ordering guarantee and now() is
 * transaction-stable.
 */
export function buildActivateClaimQuery(schemaName: string, claimId: string, actor: string): QueryInput {
  const s = schemaName.replaceAll('"', '""');
  return {
    text: `WITH activated AS (
        UPDATE "${s}"."artifact_type_claims" t
        SET status = CASE
            WHEN t.claim_kind = 'default' AND EXISTS (
              SELECT 1 FROM "${s}"."artifact_type_claims" d
              WHERE d.object_type_id = t.object_type_id
                AND d.claim_kind = 'dedicated'
                AND d.status IN ('active', 'retiring')
                AND (d.scope = t.scope OR d.scope = 'platform')
            ) THEN 'dormant'
            ELSE 'active'
          END,
          updated_at = now()
        WHERE t.id = $1 AND t.status = 'reserved'
        RETURNING t.id, t.scope, t.object_type_id, t.extension_package, t.extension_version, t.generation, t.status AS landed_status
      ),
      ev AS (
        INSERT INTO "${s}"."artifact_claim_events"
          (claim_id, scope, object_type_id, event, actor, extension_package, extension_version, generation, payload)
        SELECT claim_id, scope, object_type_id, event, actor, extension_package, extension_version, generation, payload
        FROM (
          SELECT a.id AS claim_id, a.scope, a.object_type_id, 'activate' AS event, $2::text AS actor,
                 a.extension_package, a.extension_version, a.generation,
                 jsonb_build_object('landedStatus', a.landed_status) AS payload, 1 AS ord
          FROM activated a
          UNION ALL
          SELECT a.id, a.scope, a.object_type_id, 'winner-change', $2::text,
                 a.extension_package, a.extension_version, a.generation,
                 jsonb_build_object('reason', 'claim-activated', 'transition', 'reserved->active'), 2 AS ord
          FROM activated a
          WHERE a.landed_status = 'active'
        ) ordered_events
        ORDER BY ord
        RETURNING id, scope, object_type_id, event
      )
      INSERT INTO "${s}"."artifact_binding_reconcile_queue" (scope, object_type_id, claim_event_id, kind)
      SELECT e.scope, e.object_type_id, e.id, k.kind
      FROM ev e CROSS JOIN (VALUES ('binding-reconcile'), ('re-projection')) AS k(kind)
      WHERE e.event = 'winner-change'
      RETURNING claim_event_id`,
    values: [claimId, actor],
  };
}

/**
 * Activate a reserved claim. One transaction: per-type advisory lock →
 * dormancy statement → activation CAS. Returns whether the CAS matched
 * (false = the claim was not in 'reserved'; nothing was written).
 */
export function activateArtifactTypeClaim(input: { claimId: string; actor: string }): { changed: boolean } {
  ensurePostgresSchema();
  const claim = readArtifactTypeClaimById(input.claimId);
  if (!claim) return { changed: false };
  let results: ReturnType<typeof runPostgresQueriesSync>;
  try {
    results = runPostgresQueriesSync({
      connectionString: getPostgresConnectionString(),
      transaction: true,
      queries: [
        claimLockQuery(claim.objectTypeId),
        buildActivateDormancyQuery(postgresSchema, input.claimId, input.actor),
        buildActivateClaimQuery(postgresSchema, input.claimId, input.actor),
      ],
    });
  } catch (error) {
    // Racing a same-scope activation lands on the one-active-winner partial
    // unique index — surface it as the typed conflict, same as reserve-time.
    const message = error instanceof Error ? error.message : String(error);
    if (isClaimConflictMessage(message)) {
      throw new ArtifactClaimConflictError(claim.scope, claim.objectTypeId);
    }
    throw error;
  }
  // The activation CAS statement ends in the queue INSERT, whose rowCount is
  // only > 0 when the claim landed 'active'. A dominated default lands
  // 'dormant' (no queue rows) — distinguish via a follow-up status read.
  if (results[2].rowCount > 0) return { changed: true };
  if (claim.status !== "reserved") return { changed: false }; // CAS precondition already failed at read time
  const after = readArtifactTypeClaimById(input.claimId);
  return { changed: after != null && after.status !== "reserved" };
}

/** 'active' → 'retiring' (wind-down; the claim REMAINS the winner until
 * retirement is finalized — epic #1424 transition safety). No winner change,
 * so no queue rows; the 'retire' event carries phase 'retiring'. */
export function buildBeginRetirementQuery(schemaName: string, claimId: string, actor: string): QueryInput {
  const s = schemaName.replaceAll('"', '""');
  return {
    text: `WITH retiring AS (
        UPDATE "${s}"."artifact_type_claims"
        SET status = 'retiring', updated_at = now()
        WHERE id = $1 AND status = 'active'
        RETURNING id, scope, object_type_id, extension_package, extension_version, generation
      )
      INSERT INTO "${s}"."artifact_claim_events"
        (claim_id, scope, object_type_id, event, actor, extension_package, extension_version, generation, payload)
      SELECT r.id, r.scope, r.object_type_id, 'retire', $2, r.extension_package, r.extension_version, r.generation,
             jsonb_build_object('phase', 'retiring')
      FROM retiring r`,
    values: [claimId, actor],
  };
}

export function beginArtifactTypeClaimRetirement(input: { claimId: string; actor: string }): { changed: boolean } {
  ensurePostgresSchema();
  const claim = readArtifactTypeClaimById(input.claimId);
  if (!claim) return { changed: false };
  const results = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    transaction: true,
    queries: [claimLockQuery(claim.objectTypeId), buildBeginRetirementQuery(postgresSchema, input.claimId, input.actor)],
  });
  return { changed: results[1].rowCount > 0 };
}

/** The retirement CAS + its events. Winner-change + queue rows are written
 * only when the claim WAS winner-eligible ('active' | 'retiring'). Both
 * events ride ONE ordered INSERT (retire first, winner-change second) so the
 * identity `seq` reflects true transition order. */
export function buildFinalizeRetirementQuery(schemaName: string, claimId: string, actor: string): QueryInput {
  const s = schemaName.replaceAll('"', '""');
  return {
    text: `WITH prior AS (
        SELECT id, status AS prior_status FROM "${s}"."artifact_type_claims" WHERE id = $1
      ),
      retired AS (
        UPDATE "${s}"."artifact_type_claims" t
        SET status = 'retired', updated_at = now()
        FROM prior p
        WHERE t.id = p.id AND p.prior_status <> 'retired'
        RETURNING t.id, t.scope, t.object_type_id, t.extension_package, t.extension_version, t.generation, p.prior_status
      ),
      ev AS (
        INSERT INTO "${s}"."artifact_claim_events"
          (claim_id, scope, object_type_id, event, actor, extension_package, extension_version, generation, payload)
        SELECT claim_id, scope, object_type_id, event, actor, extension_package, extension_version, generation, payload
        FROM (
          SELECT r.id AS claim_id, r.scope, r.object_type_id, 'retire' AS event, $2::text AS actor,
                 r.extension_package, r.extension_version, r.generation,
                 jsonb_build_object('phase', 'retired', 'from', r.prior_status) AS payload, 1 AS ord
          FROM retired r
          UNION ALL
          SELECT r.id, r.scope, r.object_type_id, 'winner-change', $2::text,
                 r.extension_package, r.extension_version, r.generation,
                 jsonb_build_object('reason', 'claim-retired', 'transition', r.prior_status || '->retired'), 2 AS ord
          FROM retired r
          WHERE r.prior_status IN ('active', 'retiring')
        ) ordered_events
        ORDER BY ord
        RETURNING id, scope, object_type_id, event
      )
      INSERT INTO "${s}"."artifact_binding_reconcile_queue" (scope, object_type_id, claim_event_id, kind)
      SELECT e.scope, e.object_type_id, e.id, k.kind
      FROM ev e CROSS JOIN (VALUES ('binding-reconcile'), ('re-projection')) AS k(kind)
      WHERE e.event = 'winner-change'`,
    values: [claimId, actor],
  };
}

/**
 * The reactivation statement: once the dedicated claim is 'retired', every
 * dormant default claim of the type that is NO LONGER dominated by any other
 * live dedicated claim reactivates with a NEW generation (generation + 1),
 * each writing its winner-change event + queue rows.
 */
export function buildReactivateDefaultsQuery(schemaName: string, claimId: string, actor: string): QueryInput {
  const s = schemaName.replaceAll('"', '""');
  return {
    text: `WITH src AS (
        SELECT object_type_id FROM "${s}"."artifact_type_claims"
        WHERE id = $1 AND status = 'retired' AND claim_kind = 'dedicated'
      ),
      reactivated AS (
        UPDATE "${s}"."artifact_type_claims" t
        SET status = 'active', generation = t.generation + 1, updated_at = now()
        FROM src s2
        WHERE t.object_type_id = s2.object_type_id
          AND t.claim_kind = 'default'
          AND t.status = 'dormant'
          AND NOT EXISTS (
            SELECT 1 FROM "${s}"."artifact_type_claims" d
            WHERE d.object_type_id = t.object_type_id
              AND d.claim_kind = 'dedicated'
              AND d.status IN ('active', 'retiring')
              AND (d.scope = t.scope OR d.scope = 'platform')
          )
        RETURNING t.id, t.scope, t.object_type_id, t.extension_package, t.extension_version, t.generation
      ),
      ev AS (
        INSERT INTO "${s}"."artifact_claim_events"
          (claim_id, scope, object_type_id, event, actor, extension_package, extension_version, generation, payload)
        SELECT r.id, r.scope, r.object_type_id, 'winner-change', $2, r.extension_package, r.extension_version, r.generation,
               jsonb_build_object('reason', 'dedicated-retired', 'transition', 'dormant->active', 'retiredClaimId', $1::text)
        FROM reactivated r
        RETURNING id, scope, object_type_id
      )
      INSERT INTO "${s}"."artifact_binding_reconcile_queue" (scope, object_type_id, claim_event_id, kind)
      SELECT e.scope, e.object_type_id, e.id, k.kind
      FROM ev e CROSS JOIN (VALUES ('binding-reconcile'), ('re-projection')) AS k(kind)`,
    values: [claimId, actor],
  };
}

/**
 * Finalize a claim's retirement. One transaction: per-type advisory lock →
 * retirement CAS (+ events/queue) → default-claim reactivation (+ events/
 * queue). Returns whether the claim actually transitioned.
 */
export function finalizeArtifactTypeClaimRetirement(input: { claimId: string; actor: string }): { changed: boolean } {
  ensurePostgresSchema();
  const claim = readArtifactTypeClaimById(input.claimId);
  if (!claim) return { changed: false };
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    transaction: true,
    queries: [
      claimLockQuery(claim.objectTypeId),
      buildFinalizeRetirementQuery(postgresSchema, input.claimId, input.actor),
      buildReactivateDefaultsQuery(postgresSchema, input.claimId, input.actor),
    ],
  });
  const after = readArtifactTypeClaimById(input.claimId);
  return { changed: after != null && after.status === "retired" && claim.status !== "retired" };
}

function mapClaimRow(r: Record<string, unknown>): ArtifactTypeClaimRow {
  return {
    id: String(r.id),
    scope: String(r.scope),
    objectTypeId: String(r.object_type_id),
    claimKind: String(r.claim_kind) as ArtifactClaimKind,
    status: String(r.status) as ArtifactClaimStatus,
    extensionPackage: String(r.extension_package),
    extensionVersion: String(r.extension_version),
    generation: Number(r.generation),
    dispositions: r.dispositions ?? null,
    installId: r.install_id == null ? null : String(r.install_id),
    createdAt: r.created_at == null ? null : String(r.created_at),
    updatedAt: r.updated_at == null ? null : String(r.updated_at),
  };
}

const CLAIM_COLUMNS =
  "id, scope, object_type_id, claim_kind, extension_package, extension_version, install_id, status, generation, dispositions, created_at, updated_at";

export function readArtifactTypeClaimById(claimId: string): ArtifactTypeClaimRow | null {
  ensurePostgresSchema();
  const s = postgresSchema.replaceAll('"', '""');
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT ${CLAIM_COLUMNS} FROM "${s}"."artifact_type_claims" WHERE id = $1`,
        values: [claimId],
      },
    ],
  });
  return result.rows.length > 0 ? mapClaimRow(result.rows[0]) : null;
}

/**
 * Every claim in an org's scope chain ('platform' + `org:<id>`), all
 * lifecycle states — arbitration/winner filtering is the pure policy leaf's
 * job (resolveClaimWinner over these rows).
 */
export function readArtifactTypeClaimsForOrg(orgId: string): ArtifactTypeClaimRow[] {
  ensurePostgresSchema();
  const s = postgresSchema.replaceAll('"', '""');
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT ${CLAIM_COLUMNS} FROM "${s}"."artifact_type_claims"
               WHERE scope = 'platform' OR scope = $1
               ORDER BY created_at ASC`,
        values: [`org:${orgId}`],
      },
    ],
  });
  return result.rows.map(mapClaimRow);
}

/**
 * The claims a given extension holds at a scope, all lifecycle states — the
 * uninstall path's retirement target set (cinatra#1432). Filters by the exact
 * `(scope, extension_package)`; the caller decides which to retire (typically
 * the live ones: 'reserved' | 'active' | 'retiring'). Ordered oldest-first for
 * deterministic retirement.
 */
export function readArtifactTypeClaimsForExtension(
  scope: string,
  extensionPackage: string,
): ArtifactTypeClaimRow[] {
  ensurePostgresSchema();
  const s = postgresSchema.replaceAll('"', '""');
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT ${CLAIM_COLUMNS} FROM "${s}"."artifact_type_claims"
               WHERE scope = $1 AND extension_package = $2
               ORDER BY created_at ASC`,
        values: [scope, extensionPackage],
      },
    ],
  });
  return result.rows.map(mapClaimRow);
}

export interface ArtifactClaimEventRow {
  id: string;
  claimId: string;
  scope: string;
  objectTypeId: string;
  event: string;
  actor: string;
  extensionPackage: string;
  extensionVersion: string;
  generation: number;
  payload: unknown;
  createdAt: string | null;
}

/** Append-only history for one (scope, objectTypeId) key, oldest first —
 * ordered by the monotonic identity `seq` (created_at is transaction-stable
 * and ids are random, so they cannot order same-transaction events). */
export function readArtifactClaimEvents(scope: string, objectTypeId: string): ArtifactClaimEventRow[] {
  ensurePostgresSchema();
  const s = postgresSchema.replaceAll('"', '""');
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT id, claim_id, scope, object_type_id, event, actor, extension_package, extension_version, generation, payload, created_at
               FROM "${s}"."artifact_claim_events"
               WHERE scope = $1 AND object_type_id = $2
               ORDER BY seq ASC`,
        values: [scope, objectTypeId],
      },
    ],
  });
  return result.rows.map((r) => ({
    id: String(r.id),
    claimId: String(r.claim_id),
    scope: String(r.scope),
    objectTypeId: String(r.object_type_id),
    event: String(r.event),
    actor: String(r.actor),
    extensionPackage: String(r.extension_package),
    extensionVersion: String(r.extension_version),
    generation: Number(r.generation),
    payload: r.payload ?? null,
    createdAt: r.created_at == null ? null : String(r.created_at),
  }));
}
