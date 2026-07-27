import "server-only";
import { randomUUID } from "node:crypto";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { getPostgresConnectionString, ensurePostgresSchema, postgresSchema } from "@/lib/database";

// ---------------------------------------------------------------------------
// Semantic assertion + eligibility lifecycle. Read-decide-write MUST be one
// held lock/tx; non-matcher precedence and DB eligibility-transition guards
// are required.
//
// DESIGN: every lifecycle mutation is ONE transaction that (1) takes the
// per-artifact advisory xact lock, (2) performs the op-specific
// archive/insert as PURE SQL with precedence guards in the WHERE clause
// (NO JS read-then-decide — the decision is recomputed in SQL against the
// live, locked state), (3) appends the Graphiti projection refresh. The lock
// is held for the whole tx (auto-released at COMMIT), so concurrent ops on
// the same artifact fully serialize — no stale-decision window.
//
// The default-artifact FLOOR was retired in epic #1785 (A5): identity is now
// a pure function of the object type via the effective-identity resolver, so
// there is no floor-rebalance INSERT/UPDATE and no floor sentinel extension.
// The Graphiti-refresh tail (objects.version bump + outbox row) is preserved
// as the single-sourced `buildGraphitiRefreshQueries` tail.
//
// The pure helpers below are the documented + unit-tested CONTRACT; the SQL
// statements mirror them. DB CHECK/trigger guards (drizzle-store.ts) are the
// raw-SQL/MCP defense-in-depth backstop.
// ---------------------------------------------------------------------------

export type AssertionSource = "user" | "authoring_skill" | "agent" | "matcher";
export type Eligibility = "eligible" | "draft" | "archived";

const SOURCE_RANK: Record<AssertionSource, number> = {
  user: 3,
  authoring_skill: 2,
  agent: 1,
  matcher: 0,
};

export function initialEligibility(source: AssertionSource): Exclude<Eligibility, "archived"> {
  return source === "matcher" ? "draft" : "eligible";
}
export function sourceOutranks(a: AssertionSource, b: AssertionSource): boolean {
  return SOURCE_RANK[a] > SOURCE_RANK[b];
}

export type AssertionRecord = {
  id: string;
  orgId: string;
  artifactId: string;
  extension: string;
  assertedBy: AssertionSource;
  eligibility: Eligibility;
  confidence: number | null;
  assertedByPrincipal: string | null;
  assertedAt: string;
  archivedAt: string | null;
  // `assertion_basis` discriminant (cinatra#1426): 'classic' for every row
  // this store writes (the INSERTs never name the column — the DB DEFAULT
  // applies); 'binding' rows are written ONLY by binding reconciliation (the
  // cinatra#1429 write path) and are anchored to the exact claim row +
  // activation generation they were written under.
  assertionBasis: "binding" | "classic";
  bindingClaimId: string | null;
  bindingGeneration: number | null;
};

const conn = (): string => getPostgresConnectionString();
const q = (): string => postgresSchema.replaceAll('"', '""');
type Row = Record<string, unknown>;
const toRec = (r: Row): AssertionRecord => ({
  id: String(r.id),
  orgId: String(r.org_id),
  artifactId: String(r.artifact_id),
  extension: String(r.extension),
  assertedBy: r.asserted_by as AssertionSource,
  eligibility: r.eligibility as Eligibility,
  confidence: r.confidence == null ? null : Number(r.confidence),
  assertedByPrincipal: (r.asserted_by_principal as string | null) ?? null,
  assertedAt: String(r.asserted_at),
  archivedAt: (r.archived_at as string | null) ?? null,
  assertionBasis: (r.assertion_basis as "binding" | "classic") ?? "classic",
  bindingClaimId: r.binding_claim_id == null ? null : String(r.binding_claim_id),
  bindingGeneration: r.binding_generation == null ? null : Number(r.binding_generation),
});

// SQL fragment: integer precedence rank of the asserted_by column.
const RANK_SQL = `CASE asserted_by WHEN 'user' THEN 3 WHEN 'authoring_skill' THEN 2 WHEN 'agent' THEN 1 ELSE 0 END`;

type Query = { text: string; values: unknown[] };

/** Run [lock, ...ops, ...graphitiRefresh] as ONE held-lock transaction.
 *
 *  Every assertion mutation must enqueue a Graphiti projection refresh so the
 *  downstream graph identity stays in lock-step with the canonical
 *  semantic_assertion state. Without this, an artifact reclassified by a
 *  matcher/agent/authoring_skill/user would leave Graphiti stuck at its prior
 *  identity until the next objects-store UPDATE bumped the version.
 *
 *  Refresh shape: bump objects.version (so the version-guard in
 *  projectObjectToGraphiti treats this as a new state, not stale),
 *  mark the row pending, INSERT a new outbox row. All inside the
 *  same held-lock tx as the assertion writes — the projector cannot
 *  observe a stale objects row + new assertions. */
/** Return shape so callers can detect inserted vs blocked-by-precedence.
 *  The query layout is:
 *    [0] advisory_lock        (always 1 row)
 *    [1..opsCount]            (caller-supplied assertion ops)
 *    [opsCount+1..]           (graphiti refresh)
 *  Callers locate their RETURNING-bearing op via the `opsCount`
 *  passed in. */
/**
 * TX-COMPOSABLE Graphiti-refresh tail. EXPORTED for callers that run their own
 * held-lock transaction over an artifact's assertions (the uninstall archival
 * / reinstall replay store, cinatra#1432) so the refresh mechanics stay
 * single-sourced — the queries are EXACTLY the tail `runOneLockedTx` appends
 * after the caller-supplied ops. The caller's outer transaction MUST already
 * hold the per-artifact advisory lock
 * (`pg_advisory_xact_lock(hashtext(artifactId))`).
 */
export function buildGraphitiRefreshQueries(
  orgId: string,
  artifactId: string,
  // Optional EXPLICIT schema, matching every sibling builder's
  // `schemaName`-first convention (buildReserveClaimQueries,
  // buildBindingReconcileQueries, …): a composing caller that runs the tail
  // inside ITS OWN transaction passes its own binding so the whole statement
  // set speaks one schema. Absent ⇒ this module's binding (unchanged callers).
  schemaName?: string,
): Query[] {
  const S = schemaName ? schemaName.replaceAll('"', '""') : q();
  return [
    {
      // Bump version + pending status. Skips silently if the row
      // doesn't exist or belongs to a different tenant — the
      // assertion ops above already failed if so.
      text: `UPDATE "${S}"."objects"
SET version = version + 1, graphiti_sync_status='pending', graphiti_projection_error=NULL, updated_at=now()
WHERE id=$1 AND org_id=$2
RETURNING version`,
      values: [artifactId, orgId],
    },
    {
      // Outbox row with the bumped version; consumed by the projector.
      text: `INSERT INTO "${S}"."graphiti_projection_outbox"
(id, object_id, object_version, org_id, operation, payload_hash, status, attempts)
SELECT gen_random_uuid()::text, o.id, o.version, o.org_id, 'upsert', NULL, 'pending', 0
FROM "${S}"."objects" o
WHERE o.id=$1 AND o.org_id=$2`,
      values: [artifactId, orgId],
    },
  ];
}

function runOneLockedTx(
  orgId: string,
  artifactId: string,
  ops: Query[],
): Array<{ rows: Array<Record<string, unknown>>; rowCount: number }> {
  ensurePostgresSchema();
  return runPostgresQueriesSync({
    connectionString: conn(),
    transaction: true,
    queries: [
      { text: `SELECT pg_advisory_xact_lock(hashtext($1))`, values: [artifactId] },
      ...ops,
      ...buildGraphitiRefreshQueries(orgId, artifactId),
    ],
  });
}

/**
 * Assert a semantic type. matcher ⇒ `draft`; non-matcher ⇒ `eligible`.
 * Precedence: the new assertion only supersedes (archives) SAME-extension
 * active rows of EQUAL-OR-LOWER source rank, and is itself skipped entirely
 * if a STRICTLY HIGHER-rank active same-extension assertion exists (a lower
 * source never overwrites a higher one — generalizes "matchers never
 * overwrite user"). All as SQL guards under the lock.
 */
/** Outcome of an assertion attempt. `inserted=true` means the new
 *  (extension, asserted_by, eligibility) row landed; the archive
 *  UPDATE may also have archived lower-rank same-extension rows on the
 *  way. `blockedByPrecedence=true` means a strictly-higher-rank active
 *  same-extension assertion was present, so neither the archive UPDATE
 *  nor the INSERT touched a row. This is the EXPECTED no-op return
 *  for the matcher worker when a user/agent/authoring_skill assertion
 *  already exists — the worker should log + continue, NOT throw. */
export type AssertSemanticTypeResult = {
  inserted: boolean;
  blockedByPrecedence: boolean;
};

/** Build the assertion-ops query pair (archive + insert-returning) for
 *  the given assertion attempt. PURE — does not execute. Used by
 *  `assertSemanticType` (which wraps with the advisory lock + graphiti
 *  refresh) AND by callers that want to compose the assertion into an outer
 *  transaction they already control (typically artifact-creation's Tx2).
 *
 *  The caller is responsible for: (a) holding a same-artifactId
 *  advisory lock around the queries, (b) running the graphiti refresh
 *  in the same transaction (or accepting that the projector won't run),
 *  (c) inspecting the second query's result via `parseResult` to detect
 *  inserted vs blocked. */
function buildAssertionOps(input: {
  orgId: string;
  artifactId: string;
  extension: string;
  assertedBy: AssertionSource;
  confidence?: number | null;
  principal?: string | null;
}): { ops: Query[]; insertOpIndex: number } {
  const S = q();
  const elig = initialEligibility(input.assertedBy);
  const newRank = SOURCE_RANK[input.assertedBy];
  // CRITICAL: split values per query so PG can infer types for every
  // declared parameter in each prepared statement.
  //
  // Bundling all 9 values into ONE shared array makes the archive-UPDATE
  // prepared statement receive 9 values while only referencing 4 of them in
  // its SQL ($1, $2, $3, $9). When the unreferenced parameters include
  // nullable inputs (chat-emit path: `confidence = null`, `principal = null`),
  // PG cannot infer their types and rejects the entire UPDATE with
  // `could not determine data type of parameter $4`.
  //
  // That failure surfaces as a tombstone-loop: artifact_authoring_emit
  // creates the artifact successfully → assertSemanticType throws on
  // the archive-UPDATE → the catch block in artifact-authoring.ts
  // tombstones the freshly-minted artifact → /artifacts only shows
  // the older upload-origin rows.
  //
  // Fix: each query receives ONLY the values its SQL references in
  // placeholder order. PG can fully type-check each prepared
  // statement independently. The casts (::text/::int) are belt-and-
  // suspenders on top.
  const newId = randomUUID();
  const ops: Query[] = [
    // archive same-ext active rows the new one supersedes (rank <= newRank),
    // ONLY if no strictly-higher-rank active same-ext row blocks us. BINDING
    // rows are EXCLUDED (assertion_basis <> 'binding'): a classic classification
    // never displaces a binding (epic #1424) — binding lifecycle is owned solely
    // by the reconcile write-path (cinatra#1429).
    {
      text: `UPDATE "${S}"."semantic_assertion" SET eligibility='archived', archived_at=now()
WHERE org_id=$1::text AND artifact_id=$2::text AND extension=$3::text AND eligibility <> 'archived'
AND assertion_basis <> 'binding'
AND (${RANK_SQL}) <= $4::int
AND NOT EXISTS (
  SELECT 1 FROM "${S}"."semantic_assertion" s2
   WHERE s2.org_id=$1::text AND s2.artifact_id=$2::text AND s2.extension=$3::text AND s2.eligibility <> 'archived'
     AND s2.assertion_basis <> 'binding'
     AND (CASE s2.asserted_by WHEN 'user' THEN 3 WHEN 'authoring_skill' THEN 2 WHEN 'agent' THEN 1 ELSE 0 END) > $4::int)`,
      values: [input.orgId, input.artifactId, input.extension, newRank],
    },
    // insert the new assertion ONLY if no active same-ext row remains that
    // outranks-or-equals it (matcher: any active same-ext blocks; non-matcher:
    // a strictly-higher active same-ext blocks; an equal/lower was archived above).
    // `RETURNING id` lets callers detect insertion vs precedence-block at
    // the row-count level.
    //
    // BINDING ROWS ARE AN UNCONDITIONAL BLOCK (cinatra#2047 D-8). The archive
    // above already refuses to touch a binding-basis row ("a classic never
    // displaces a binding" — epic #1424); until now the INSERT did not treat one
    // as a precedence block either, so a same-extension active binding left the
    // (org, artifact, extension) `sa_active_unique_idx` slot occupied while the
    // INSERT still fired → duplicate-key, rolling back the caller's whole write.
    // `artifact-creation.ts` documents this exact asymmetry for the in-Tx
    // composition ordering; every POST-Tx caller of `assertSemanticType`
    // (the blog-post/blog-idea/blog-image materializers, artifact templates,
    // authoring emit, the upload typing action) re-created it the moment
    // cinatra#1868 made the writer mint a binding in Tx2 for a claim-backed
    // declared type — i.e. on any org that actually holds the pack's claim.
    // Blocking is the CORRECT outcome, not a degradation: the binding already
    // asserts that exact extension on that exact artifact with strictly higher
    // authority, so the classic row would be redundant. The caller sees the
    // ordinary `{inserted:false, blockedByPrecedence:true}` verdict.
    // NOTE the rank CASE cannot express this: a binding carries
    // `asserted_by='system'` (binding-write-path), which the rank CASE floors to
    // 0 — the lowest rank — so a rank comparison can never block on it.
    {
      text: `INSERT INTO "${S}"."semantic_assertion"
  (id, org_id, artifact_id, extension, asserted_by, eligibility, confidence, asserted_by_principal)
SELECT $8::text,$1::text,$2::text,$3::text,$4::text,$5::text,$6::real,$7::text
WHERE NOT EXISTS (
  SELECT 1 FROM "${S}"."semantic_assertion" s3
   WHERE s3.org_id=$1::text AND s3.artifact_id=$2::text AND s3.extension=$3::text AND s3.eligibility <> 'archived'
     AND (
       s3.assertion_basis = 'binding'
       OR (CASE s3.asserted_by WHEN 'user' THEN 3 WHEN 'authoring_skill' THEN 2 WHEN 'agent' THEN 1 ELSE 0 END)
          >= CASE WHEN $4::text = 'matcher' THEN 0 ELSE $9::int + 1 END))
RETURNING id`,
      values: [
        input.orgId,              // $1
        input.artifactId,         // $2
        input.extension,          // $3
        input.assertedBy,         // $4
        elig,                     // $5
        input.confidence ?? null, // $6
        input.principal ?? null,  // $7
        newId,                    // $8
        newRank,                  // $9
      ],
    },
  ];
  return { ops, insertOpIndex: 1 };
}

export function assertSemanticType(input: {
  orgId: string;
  artifactId: string;
  extension: string;
  assertedBy: AssertionSource;
  confidence?: number | null;
  principal?: string | null;
}): AssertSemanticTypeResult {
  const { ops, insertOpIndex } = buildAssertionOps(input);
  const results = runOneLockedTx(
    input.orgId,
    input.artifactId,
    ops,
  );
  // runOneLockedTx prepends the advisory_lock at index 0, then the
  // ops, then the graphiti refresh. Our insert-returning sits at
  // `1 + insertOpIndex` in the result array.
  return interpretInsertResult(results, 1 + insertOpIndex);
}

/** Turn the INSERT-RETURNING result slot into the
 *  {inserted, blockedByPrecedence} verdict.
 *  THROWS when the slot is absent or malformed: a missing/truncated
 *  result must NOT be silently coerced into `blockedByPrecedence`
 *  (that would mask an integration bug — wrong offset, extra spliced
 *  queries, truncated result array — as the matcher's expected
 *  no-op, defeating the entire point of this refactor). `rows.length
 *  === 0` stays the valid precedence-block case, but ONLY once the
 *  slot is confirmed present + well-formed. */
function interpretInsertResult(
  results: Array<{ rows: Array<Record<string, unknown>>; rowCount: number }>,
  index: number,
): AssertSemanticTypeResult {
  const insertResult = results[index];
  if (!insertResult || !Array.isArray(insertResult.rows)) {
    throw new Error(
      `[semantic-assertion-store] insert result missing/malformed at index ${index} ` +
        `(results.length=${results.length}) — wrong offset or truncated result array; ` +
        `refusing to mask as blockedByPrecedence`,
    );
  }
  const inserted = insertResult.rows.length > 0;
  return { inserted, blockedByPrecedence: !inserted };
}

/** TX-COMPOSABLE assertion builder. Returns the assertion ops + a result
 *  parser so callers (e.g. `artifact-creation.ts`'s
 *  Tx2) can compose the assertion atomically with the artifact-creation
 *  writes.
 *
 *  Unlike `assertSemanticType`, this builder DOES NOT include the
 *  advisory_lock or the graphiti outbox refresh — the caller's outer
 *  transaction is responsible for those. (For artifact-creation's path,
 *  the lock is already on the artifactId at Tx2 open and the outbox
 *  refresh runs as part of creation.)
 *
 *  Return:
 *    `queries`: assertion ops to splice into the caller's `queries[]`.
 *    `parseResult(results, offset)`: given the caller's result array
 *       and the offset where these ops were spliced in, returns
 *       `{inserted, blockedByPrecedence}`.
 */
export function buildAssertSemanticTypeQueries(input: {
  orgId: string;
  artifactId: string;
  extension: string;
  assertedBy: AssertionSource;
  confidence?: number | null;
  principal?: string | null;
}): {
  queries: Query[];
  parseResult: (
    results: Array<{ rows: Array<Record<string, unknown>>; rowCount: number }>,
    offsetInResults: number,
  ) => AssertSemanticTypeResult;
} {
  const { ops, insertOpIndex } = buildAssertionOps(input);
  return {
    queries: ops,
    parseResult: (results, offsetInResults) =>
      interpretInsertResult(results, offsetInResults + insertOpIndex),
  };
}

/**
 * Confirm an extension as a NON-matcher eligible assertion: archive any
 * matcher drafts of that ext, INSERT a NEW eligible assertion. The draft is
 * NEVER mutated to eligible. When an ACTIVE same-extension BINDING already
 * holds the identity, the insert is a NO-OP (cinatra#2047 D-8) — the binding
 * outranks any classic and owns the unique slot.
 */
export function confirmAssertion(input: {
  orgId: string;
  artifactId: string;
  extension: string;
  confirmedBy: Exclude<AssertionSource, "matcher">;
  principal?: string | null;
}): void {
  const S = q();
  const cRank = SOURCE_RANK[input.confirmedBy];
  const newId = randomUUID();
  // Split values per query — same handling as buildAssertionOps.
  // The archive UPDATE only references $1, $2, $3 + the rank parameter;
  // the insert references all 6 placeholders. Without the split, the
  // shared `v = [..., principal ?? null, ...]` makes pg-node reject the
  // archive UPDATE with "could not determine data type of parameter $4"
  // whenever principal is null (chat-emit path and the user-confirms
  // path with no principal).
  //
  // confirmAssertion IS semantically "assert this ext eligible by a
  // non-matcher" — so it uses the SAME precedence-supersede semantics as
  // assertSemanticType. A drafts-only archive can leave an active lower-rank
  // agent eligible, causing a partial-unique collision on user insert.
  // Archive same-ext active rows of rank <= confirmedBy (this covers the
  // matcher draft, rank 0, AND a lower agent) UNLESS a strictly-higher
  // active same-ext blocks; insert ONLY if no active same-ext rank >
  // confirmedBy remains. ⇒ never two active same-ext rows; precedence kept.
  const ops: Query[] = [
    {
      text: `UPDATE "${S}"."semantic_assertion" SET eligibility='archived', archived_at=now()
WHERE org_id=$1::text AND artifact_id=$2::text AND extension=$3::text AND eligibility <> 'archived'
AND assertion_basis <> 'binding'
AND (${RANK_SQL}) <= $4::int
AND NOT EXISTS (
  SELECT 1 FROM "${S}"."semantic_assertion" s2
   WHERE s2.org_id=$1::text AND s2.artifact_id=$2::text AND s2.extension=$3::text AND s2.eligibility <> 'archived'
     AND s2.assertion_basis <> 'binding'
     AND (CASE s2.asserted_by WHEN 'user' THEN 3 WHEN 'authoring_skill' THEN 2 WHEN 'agent' THEN 1 ELSE 0 END) > $4::int)`,
      values: [input.orgId, input.artifactId, input.extension, cRank],
    },
    // Same binding block as `buildAssertionOps` (cinatra#2047 D-8): the archive
    // above excludes binding rows, so a same-extension active binding keeps the
    // `sa_active_unique_idx` slot — inserting on top of it is a duplicate-key,
    // not a confirmation. A binding already asserts this extension with higher
    // authority, so the confirm is a no-op rather than a throw.
    {
      text: `INSERT INTO "${S}"."semantic_assertion"
  (id, org_id, artifact_id, extension, asserted_by, eligibility, asserted_by_principal)
SELECT $6::text,$1::text,$2::text,$3::text,$4::text,'eligible',$5::text
WHERE NOT EXISTS (
  SELECT 1 FROM "${S}"."semantic_assertion" s
   WHERE s.org_id=$1::text AND s.artifact_id=$2::text AND s.extension=$3::text AND s.eligibility <> 'archived'
     AND (
       s.assertion_basis = 'binding'
       OR (CASE s.asserted_by WHEN 'user' THEN 3 WHEN 'authoring_skill' THEN 2 WHEN 'agent' THEN 1 ELSE 0 END) > $7::int))`,
      values: [
        input.orgId,              // $1
        input.artifactId,         // $2
        input.extension,          // $3
        input.confirmedBy,        // $4
        input.principal ?? null,  // $5
        newId,                    // $6
        cRank,                    // $7
      ],
    },
  ];
  runOneLockedTx(input.orgId, input.artifactId, ops);
}

/** Archive every active assertion of an extension. */
export function archiveAssertion(input: {
  orgId: string;
  artifactId: string;
  extension: string;
  archivedBy?: AssertionSource;
}): void {
  const S = q();
  const ops: Query[] = [
    {
      text: `UPDATE "${S}"."semantic_assertion" SET eligibility='archived', archived_at=now()
WHERE org_id=$1 AND artifact_id=$2 AND extension=$3 AND eligibility <> 'archived'`,
      values: [input.orgId, input.artifactId, input.extension],
    },
  ];
  runOneLockedTx(input.orgId, input.artifactId, ops);
}

export function listEligibleAssertions(orgId: string, artifactId: string): AssertionRecord[] {
  ensurePostgresSchema();
  const r = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `SELECT id, org_id, artifact_id, extension, asserted_by, eligibility, confidence, asserted_by_principal, asserted_at, archived_at, assertion_basis, binding_claim_id, binding_generation
FROM "${q()}"."semantic_assertion" WHERE org_id=$1 AND artifact_id=$2 AND eligibility='eligible' ORDER BY asserted_at`,
        values: [orgId, artifactId],
      },
    ],
  });
  return ((r?.[0]?.rows ?? []) as Row[]).map(toRec);
}

/** List ALL active assertions for one artifact, including matcher drafts.
 *  Used by the assertion MCP
 *  primitive so a caller can see the full active state (eligible +
 *  draft), not just eligible. Archived rows are excluded by default;
 *  use `getAssertionByIdForReplay` for archived/replay-safe access. */
export function listActiveAssertions(orgId: string, artifactId: string): AssertionRecord[] {
  ensurePostgresSchema();
  const r = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `SELECT id, org_id, artifact_id, extension, asserted_by, eligibility, confidence, asserted_by_principal, asserted_at, archived_at, assertion_basis, binding_claim_id, binding_generation
FROM "${q()}"."semantic_assertion"
WHERE org_id=$1 AND artifact_id=$2 AND eligibility <> 'archived'
ORDER BY asserted_at`,
        values: [orgId, artifactId],
      },
    ],
  });
  return ((r?.[0]?.rows ?? []) as Row[]).map(toRec);
}

/** Batch query: eligible assertions for a set of artifact ids, returned as
 *  a `Map<artifactId, AssertionRecord[]>`.
 *  Avoids N+1 in `listArtifacts` summary enrichment. Empty input ⇒
 *  empty map. */
export function listEligibleAssertionsForArtifacts(
  orgId: string,
  artifactIds: string[],
): Map<string, AssertionRecord[]> {
  const out = new Map<string, AssertionRecord[]>();
  if (artifactIds.length === 0) return out;
  ensurePostgresSchema();
  const r = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `SELECT id, org_id, artifact_id, extension, asserted_by, eligibility, confidence, asserted_by_principal, asserted_at, archived_at, assertion_basis, binding_claim_id, binding_generation
FROM "${q()}"."semantic_assertion"
WHERE org_id=$1 AND artifact_id = ANY($2::text[]) AND eligibility='eligible'
ORDER BY artifact_id, asserted_at`,
        values: [orgId, artifactIds],
      },
    ],
  });
  for (const row of (r?.[0]?.rows ?? []) as Row[]) {
    const rec = toRec(row);
    const list = out.get(rec.artifactId);
    if (list) list.push(rec);
    else out.set(rec.artifactId, [rec]);
  }
  return out;
}

/** The set of artifact ids in the org that carry an ELIGIBLE assertion for
 *  the named extension. Query-level filter for artifacts_list's
 *  `extensionPackageName` (applied BEFORE limit/pagination). */
export function listArtifactIdsForExtension(orgId: string, extension: string): Set<string> {
  ensurePostgresSchema();
  const r = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `SELECT DISTINCT artifact_id FROM "${q()}"."semantic_assertion"
WHERE org_id=$1 AND extension=$2 AND eligibility='eligible'`,
        values: [orgId, extension],
      },
    ],
  });
  const out = new Set<string>();
  for (const row of (r?.[0]?.rows ?? []) as Row[]) {
    if (typeof row.artifact_id === "string") out.add(row.artifact_id);
  }
  return out;
}

/** Derive the PRIMARY extension for an artifact from its eligible assertions:
 *  the highest-precedence eligible assertion's extension, or `null` when there
 *  is none (no-primary). The default-artifact floor was retired (epic #1785,
 *  A5): there is no floor sentinel to fall back to, so an artifact with no
 *  eligible assertion has no primary extension — mirroring the
 *  effective-identity resolver's `no-primary` outcome.
 *
 *  NOTE (cinatra#1426): the artifact surfaces (service enrichment + MCP
 *  outputs) resolve identity through the effective-identity resolver
 *  (packages/objects/src/effective-identity.ts), which is now a pure function
 *  of the object TYPE (its installed namespace-definer) — no assertion/claim
 *  axis. This helper remains the raw assertion-precedence contract for the
 *  legacy semantic_assertion state that survives until the A6 purge. */
export function primaryExtensionFor(eligible: AssertionRecord[]): string | null {
  if (eligible.length === 0) return null;
  // Same precedence ranking as RANK_SQL: user(3) > authoring_skill(2) >
  // agent(1) > matcher(0).
  //
  // Same-rank tie-breaker is deterministic. Primary tie-break = newest
  // asserted_at (latest wins); secondary
  // tie-break = lexicographic extension id (final tiebreaker so the
  // result is total-ordered even under same-rank, same-timestamp).
  const rank = (src: AssertionSource): number =>
    src === "user" ? 3 : src === "authoring_skill" ? 2 : src === "agent" ? 1 : 0;
  const sorted = [...eligible].sort((a, b) => {
    const r = rank(b.assertedBy) - rank(a.assertedBy);
    if (r !== 0) return r;
    if (a.assertedAt !== b.assertedAt) {
      return a.assertedAt < b.assertedAt ? 1 : -1; // newer first
    }
    return a.extension < b.extension ? -1 : a.extension > b.extension ? 1 : 0;
  });
  return sorted[0]!.extension;
}

/** Replay: a pinned assertion id, returned regardless of CURRENT eligibility. */
export function getAssertionByIdForReplay(orgId: string, assertionId: string): AssertionRecord | null {
  ensurePostgresSchema();
  const r = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `SELECT id, org_id, artifact_id, extension, asserted_by, eligibility, confidence, asserted_by_principal, asserted_at, archived_at, assertion_basis, binding_claim_id, binding_generation
FROM "${q()}"."semantic_assertion" WHERE org_id=$1 AND id=$2 LIMIT 1`,
        values: [orgId, assertionId],
      },
    ],
  });
  const row = r?.[0]?.rows?.[0] as Row | undefined;
  return row ? toRec(row) : null;
}
