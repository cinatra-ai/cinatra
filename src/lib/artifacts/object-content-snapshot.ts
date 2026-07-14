import "server-only";
import { randomUUID, createHash } from "node:crypto";

import { runPostgresQueriesSync } from "@/lib/postgres-sync";
// Sync-leaf connection/schema primitives (the artifact-refs-store /
// binding-write-path contract): never import `@/lib/database` from a sync
// store leaf — database.ts is an ASYNC module in Turbopack dev.
import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";

import { parseClaimDispositions } from "@cinatra-ai/objects/claims";

import { canonicalJSONStringify, deriveSubstanceKey } from "./resource-store";
import { createLocalDiskBlobStore } from "./local-disk-blob-store";

// ---------------------------------------------------------------------------
// Policy-aware content snapshots for CLAIMED typed object rows
// (cinatra#1430, epic #1424).
//
// A typed object row (`@cinatra-ai/campaigns:*`, `@cinatra-ai/email:*`, …) is
// not, by itself, context-pinnable: pinning + context resolution flow through
// the (artifactId, representationRevisionId, semanticAssertionId) triple, and
// a raw typed row has no representation. This module mints an IMMUTABLE JSON
// snapshot of the row's NORMALIZED data at RESOLUTION time so the row can be a
// context candidate WITH a concrete representation revision id.
//
// The snapshot IS a real `representation` revision over a real `blob`
// `resource` — the same substrate an uploaded file artifact uses — so the
// existing retention / GC / serve machinery handles it with no special case.
// The `object_content_snapshots` keying table (core__0045) content-addresses
// each snapshot by its full policy key:
//   (objectId, contentDigest, effectiveBaseType, snapshotSchemaVersion,
//    claim/disposition fingerprint)
// which drives reuse-vs-mint deterministically (AC-1):
//   - identical content re-pinned under the same claim/disposition REUSES the
//     existing representation revision (keyed reuse);
//   - a data change (new contentDigest) OR a claimant change (new
//     claim/disposition fingerprint) mints a FRESH snapshot — a new claimant
//     never reuses another claimant's snapshot for identical content.
//
// INVARIANTS enforced at these write paths:
//   - bytes-never-in-`objects.data`: the snapshot's bytes live on the blob
//     store (a `blob` resource), NEVER back in the mutable object row. This
//     module only READS `objects` (SELECT) and WRITES resource / artifact_blobs
//     / representation / object_content_snapshots.
//   - size cap: an oversized normalized payload is rejected (SnapshotTooLargeError).
//   - fail-closed secret/PII redaction: a snapshot whose normalized data
//     carries a recognizable secret or PII shape is BLOCKED (SnapshotRedactionError) —
//     the snapshot is never minted (AC-4). Fail-closed: any match blocks.
//   - capture runs under the per-artifact advisory lock with a
//     row-version/type/binding RE-READ inside the locked transaction (no
//     candidate committed from a stale pre-lock read — AC-2 capture half).
// ---------------------------------------------------------------------------

/** Bump when the normalized-snapshot serialization or key derivation changes,
 * so old snapshots never collide with new-shape snapshots on the key. */
export const SNAPSHOT_SCHEMA_VERSION = 1;

/** Hard cap on the normalized snapshot payload. A typed row that serializes
 * larger than this is rejected rather than snapshotted (context candidates are
 * metadata-scale, not bulk blobs). */
export const SNAPSHOT_MAX_BYTES = 256 * 1024;

const SNAPSHOT_MIME = "application/json";

const conn = (): string => getPostgresConnectionString();
const q = (): string => postgresSchema.replaceAll('"', '""');
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

const GENERIC_ARTIFACT_OBJECT_TYPE = "@cinatra-ai/artifact:object";

export class SnapshotTooLargeError extends Error {
  constructor(public readonly sizeBytes: number) {
    super(
      `[object-content-snapshot] normalized data is ${sizeBytes} bytes, exceeds the ${SNAPSHOT_MAX_BYTES}-byte snapshot cap`,
    );
    this.name = "SnapshotTooLargeError";
  }
}

export class SnapshotRedactionError extends Error {
  constructor(public readonly reason: string) {
    super(`[object-content-snapshot] snapshot blocked (fail-closed redaction): ${reason}`);
    this.name = "SnapshotRedactionError";
  }
}

export class StaleSnapshotCandidateError extends Error {
  constructor() {
    super(
      "[object-content-snapshot] object row changed (version/type/binding) between the candidate read and the capture lock — retry with a fresh read",
    );
    this.name = "StaleSnapshotCandidateError";
  }
}

/** The claim's dispositions forbid content snapshots / pinning for this row
 * (pinnable !== true, snapshotPolicy !== 'content', unparseable payload, or no
 * eligible binding at all). Fail-closed: policy is enforced at CAPTURE, at the
 * candidate query, and re-checked at FINALIZATION. */
export class SnapshotPolicyError extends Error {
  constructor(reason: string) {
    super(`[object-content-snapshot] snapshot refused (claim policy): ${reason}`);
    this.name = "SnapshotPolicyError";
  }
}

// ---------------------------------------------------------------------------
// Fail-closed secret / PII detection (never a permissive fallback).
//
// Intentionally NARROW, high-signal patterns — a match BLOCKS the snapshot
// rather than silently redacting-and-storing (a stored redaction still leaks
// the SHAPE + surrounding record; a claimed row carrying a live secret is an
// authoring bug the snapshot must refuse). Additive only: add a pattern for a
// newly discovered leak shape, never broaden an existing one.
// ---------------------------------------------------------------------------

const SENSITIVE_KEY_RE =
  /^(authorization|token|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|secret|client[_-]?secret|password|passwd|private[_-]?key|session[_-]?token|request[_-]?secret|ssn|credit[_-]?card|card[_-]?number)$/i;

const SECRET_VALUE_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, "PEM private key block"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key id"],
  [/\bASIA[0-9A-Z]{16}\b/, "AWS temporary access key id"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/, "GitHub token"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, "Slack token"],
  [/\bsk-[A-Za-z0-9]{20,}\b/, "OpenAI-style secret key"],
  [/\bsk_live_[A-Za-z0-9]{16,}\b/, "Stripe live secret key"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, "JWT"],
  [/\b(?:AIza)[0-9A-Za-z_-]{35}\b/, "Google API key"],
  [/\b\d{3}-\d{2}-\d{4}\b/, "US SSN pattern"],
];

/** How many levels of JSON-encoded-string nesting the scanner decodes. A
 * secret hidden below this depth would need 4 layers of JSON.stringify —
 * beyond any legitimate data shape this substrate stores. */
const MAX_JSON_STRING_DECODE_DEPTH = 4;

/**
 * Walk the parsed value; throw `SnapshotRedactionError` on the FIRST secret /
 * PII signal (fail-closed). Checks both key names (a sensitive key carrying a
 * non-empty string value) and value shapes (recognizable secret/PII patterns
 * anywhere in a string value). A string value that itself parses as JSON is
 * DECODED and recursed (depth-bounded) so nested-JSON-in-string cannot smuggle
 * a sensitive key past the key scan. Cycle-safe.
 */
export function assertSnapshotDataClean(
  value: unknown,
  path = "<root>",
  seen = new WeakSet<object>(),
  jsonDepth = 0,
): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    for (const [re, label] of SECRET_VALUE_PATTERNS) {
      if (re.test(value)) {
        throw new SnapshotRedactionError(`${label} detected at ${path}`);
      }
    }
    // Nested-JSON-in-string: decode and recurse so `{"payload":"{\"api_key\":…}"}`
    // cannot bypass the sensitive-key scan (codex finding, fail-closed). Also
    // decode leading-quote strings (a JSON STRING literal): double-encoding
    // `JSON.stringify(JSON.stringify(obj))` yields a `"`-leading value whose
    // decode is the single-encoded object string — the recursion unwraps it
    // (codex round-2 finding).
    const head = value.trimStart();
    if (
      (head.startsWith("{") || head.startsWith("[") || head.startsWith('"')) &&
      jsonDepth < MAX_JSON_STRING_DECODE_DEPTH
    ) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        return; // not actually JSON — the pattern scan above already ran.
      }
      // A string decoding to an IDENTICAL string would loop; the depth bound
      // caps it regardless, and JSON.parse('"x"') !== '"x"' so real literals
      // always shrink by one encoding layer.
      assertSnapshotDataClean(parsed, `${path}<json-string>`, seen, jsonDepth + 1);
    }
    return;
  }
  if (typeof value !== "object") return;
  if (seen.has(value as object)) return;
  seen.add(value as object);
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertSnapshotDataClean(v, `${path}[${i}]`, seen, jsonDepth));
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_RE.test(k)) {
      const nonEmpty =
        (typeof v === "string" && v.trim().length > 0) ||
        (typeof v === "number") ||
        (v != null && typeof v === "object" && Object.keys(v as object).length > 0);
      if (nonEmpty) {
        throw new SnapshotRedactionError(`sensitive key '${k}' carries a value at ${path}`);
      }
    }
    assertSnapshotDataClean(v, `${path}.${k}`, seen, jsonDepth);
  }
}

/**
 * Deterministic claim/disposition fingerprint. Two rows with IDENTICAL content
 * but DIFFERENT claimants (different binding claim / generation / extension /
 * dispositions) fingerprint differently so they never share a snapshot (AC-1
 * fingerprint half). `null` binding (default-coverage / generic) → the stable
 * `"none"` sentinel.
 */
export function computeClaimDispositionFingerprint(input: {
  bindingClaimId: string | null;
  bindingGeneration: number | null;
  extension: string | null;
  dispositions: unknown;
}): string {
  if (input.bindingClaimId == null) return "none";
  return sha256(
    canonicalJSONStringify({
      claimId: input.bindingClaimId,
      generation: input.bindingGeneration,
      extension: input.extension,
      dispositions: input.dispositions ?? null,
    }),
  );
}

export interface CaptureObjectContentSnapshotResult {
  /** The representation revision id the snapshot bound (new OR reused). */
  representationRevisionId: string;
  /** The blob resource backing the snapshot (the GC-serialization key). */
  resourceId: string;
  /** The object's current type at capture — the effective base type. */
  effectiveBaseType: string;
  /** sha256 of the normalized snapshot data. */
  contentDigest: string;
  claimDispositionFingerprint: string;
  snapshotSchemaVersion: number;
  sizeBytes: number;
  /** True when an EXISTING snapshot for the exact key was reused (no mint). */
  reused: boolean;
  /** The eligible BINDING assertion the snapshot was captured under (R3:
   * pins are bound to this exact assertion — a binding transition between
   * capture and resolve fails closed instead of pairing an old claimant's
   * snapshot with a new claimant's identity). */
  bindingAssertionId: string;
}

interface CandidateRead {
  type: string;
  version: number;
  bindingId: string | null;
  bindingClaimId: string | null;
  bindingGeneration: number | null;
  extension: string | null;
  dispositions: unknown;
  normalized: string;
  contentDigest: string;
  fingerprint: string;
}

async function* bytesOf(s: string): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(s);
}

/** Pre-lock read: object row + its active binding + the claim's dispositions,
 * then build the candidate (normalized data, digest, fingerprint). Returns
 * `null` when the row is absent / deleted (a dead row is never snapshotted). */
function readCandidate(orgId: string, objectId: string): CandidateRead | null {
  const schema = q();
  const [res] = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `SELECT o.type, o.version, o.data, o.deleted_at,
  ab.id AS binding_id, ab.binding_claim_id, ab.binding_generation, ab.extension,
  c.dispositions AS claim_dispositions
FROM "${schema}"."objects" o
LEFT JOIN "${schema}"."semantic_assertion" ab
  ON ab.org_id = o.org_id AND ab.artifact_id = o.id
   AND ab.assertion_basis = 'binding' AND ab.eligibility <> 'archived'
LEFT JOIN "${schema}"."artifact_type_claims" c
  ON c.id = ab.binding_claim_id
WHERE o.id = $1 AND o.org_id = $2
LIMIT 1`,
        values: [objectId, orgId],
      },
    ],
  });
  const row = res?.rows?.[0] as
    | {
        type: string;
        version: number | string;
        data: unknown;
        deleted_at: string | null;
        binding_id: string | null;
        binding_claim_id: string | null;
        binding_generation: number | string | null;
        extension: string | null;
        claim_dispositions: unknown;
      }
    | undefined;
  if (!row || row.deleted_at != null) return null;

  // Content snapshots exist ONLY for claimed rows: no eligible binding ⇒ not a
  // snapshot subject (an unclaimed/generic row's context path is the classic
  // artifact substrate). Fail-closed rather than fingerprint-"none".
  if (row.binding_id == null) return null;

  // CLAIM DISPOSITION POLICY GATE (codex round-2 finding): the claim payload
  // governs snapshot/pinning behavior. Only a VALIDLY-PARSED dispositions
  // payload with pinnable === true AND snapshotPolicy === 'content' admits a
  // content snapshot — unparseable/absent payloads fail CLOSED (the zod
  // defaults are pinnable:false / snapshotPolicy:'none').
  const parsedDisp = parseClaimDispositions(row.claim_dispositions ?? {});
  if (!parsedDisp.ok) {
    throw new SnapshotPolicyError(
      `claim ${row.binding_claim_id} carries an unparseable dispositions payload`,
    );
  }
  if (parsedDisp.dispositions.pinnable !== true) {
    throw new SnapshotPolicyError(`claim ${row.binding_claim_id} is not pinnable`);
  }
  if (parsedDisp.dispositions.snapshotPolicy !== "content") {
    throw new SnapshotPolicyError(
      `claim ${row.binding_claim_id} snapshotPolicy is '${parsedDisp.dispositions.snapshotPolicy}', not 'content'`,
    );
  }

  const data = row.data ?? {};
  // Canonical, deterministic normalization (recursively key-sorted). This is
  // also the JSON-safety boundary — a row whose data is not plain JSON throws
  // here (never a silent dedupe collision).
  const normalized = canonicalJSONStringify(data);
  const contentDigest = sha256(normalized);
  const fingerprint = computeClaimDispositionFingerprint({
    bindingClaimId: row.binding_claim_id ?? null,
    bindingGeneration: row.binding_generation == null ? null : Number(row.binding_generation),
    extension: row.extension ?? null,
    dispositions: row.claim_dispositions ?? null,
  });
  return {
    type: String(row.type),
    version: Number(row.version),
    bindingId: row.binding_id ?? null,
    bindingClaimId: row.binding_claim_id ?? null,
    bindingGeneration: row.binding_generation == null ? null : Number(row.binding_generation),
    extension: row.extension ?? null,
    dispositions: row.claim_dispositions ?? null,
    normalized,
    contentDigest,
    fingerprint,
  };
}

/**
 * Fast-path reuse lookup, VALIDATED in one statement (one MVCC snapshot):
 * returns a reusable snapshot only when
 *   - the exact policy key matches, AND
 *   - the OBJECT ROW still matches the candidate (version/type/binding — the
 *     stale-candidate guard applies to the reuse path too, codex finding), AND
 *   - the backing resource chain is ALIVE (representation → resource; GC
 *     deletes the resource but the append-only representation and the keying
 *     row survive — a dead-resource key must MISS so the mint path can remint,
 *     codex finding).
 * Any miss falls through to the advisory-locked mint transaction, which
 * re-reads and reuses-or-mints correctly.
 */
function findExistingSnapshot(
  orgId: string,
  objectId: string,
  cand: CandidateRead,
): { representationRevisionId: string; resourceId: string; sizeBytes: number } | null {
  const schema = q();
  const [res] = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `SELECT s.representation_revision_id, s.resource_id, s.size_bytes
FROM "${schema}"."object_content_snapshots" s
JOIN "${schema}"."objects" o
  ON o.id = s.object_id AND o.org_id = s.org_id
JOIN "${schema}"."representation" rep
  ON rep.id = s.representation_revision_id AND rep.org_id = s.org_id
JOIN "${schema}"."resource" res
  ON res.id = rep.resource_id AND res.org_id = rep.org_id
LEFT JOIN "${schema}"."semantic_assertion" ab
  ON ab.org_id = o.org_id AND ab.artifact_id = o.id
   AND ab.assertion_basis = 'binding' AND ab.eligibility <> 'archived'
WHERE s.org_id = $1 AND s.object_id = $2 AND s.content_digest = $3
  AND s.effective_base_type = $4 AND s.snapshot_schema_version = $5
  AND s.claim_disposition_fingerprint = $6
  AND o.deleted_at IS NULL AND o.type = $4 AND o.version = $7
  AND (ab.id IS NOT DISTINCT FROM $8)
LIMIT 1`,
        values: [
          orgId,
          objectId,
          cand.contentDigest,
          cand.type,
          SNAPSHOT_SCHEMA_VERSION,
          cand.fingerprint,
          cand.version,
          cand.bindingId,
        ],
      },
    ],
  });
  const row = res?.rows?.[0] as
    | { representation_revision_id: string; resource_id: string; size_bytes: string | number }
    | undefined;
  if (!row) return null;
  return {
    representationRevisionId: String(row.representation_revision_id),
    resourceId: String(row.resource_id),
    sizeBytes: typeof row.size_bytes === "number" ? row.size_bytes : Number(row.size_bytes),
  };
}

/**
 * Capture (or reuse) the content snapshot for one typed object row.
 *
 * Flow:
 *   1. Pre-lock read of the object row + active binding + claim dispositions →
 *      normalize data, compute digest + claim/disposition fingerprint.
 *   2. Fail-closed redaction scan + size cap on the normalized data.
 *   3. Fast reuse check (keyed) — an existing snapshot short-circuits with NO
 *      blob write and NO lock.
 *   4. Orphan-safe blob write (content-addressed; idempotent by sha).
 *   5. ONE advisory-locked transaction (`pg_advisory_xact_lock(hashtext(objectId))`
 *      FIRST) that RE-READS the row under the lock and only writes when the
 *      candidate still matches (version/type/binding) — never a stale-read
 *      commit. A concurrent capture that raced past the fast check sees the
 *      winner's snapshot inside the tx and reuses it (no orphan representation).
 *
 * Bounded-retry on a stale candidate (a concurrent object write bumped the row
 * between the pre-lock read and the lock).
 */
export async function captureObjectContentSnapshot(input: {
  orgId: string;
  objectId: string;
  createdBy?: string | null;
  createdByRunId?: string | null;
  maxAttempts?: number;
}): Promise<CaptureObjectContentSnapshotResult | null> {
  ensurePostgresSchema();
  const schema = q();
  const maxAttempts = Math.max(1, input.maxAttempts ?? 3);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const cand = readCandidate(input.orgId, input.objectId);
    if (!cand) return null; // dead / missing row.

    // Redaction (fail-closed) + size cap run on the NORMALIZED data before any
    // byte hits the blob store.
    const sizeBytes = Buffer.byteLength(cand.normalized, "utf8");
    if (sizeBytes > SNAPSHOT_MAX_BYTES) throw new SnapshotTooLargeError(sizeBytes);
    // Parse-then-scan: canonicalJSONStringify already proved JSON-safety, so
    // JSON.parse round-trips the plain structure for the key/value walk.
    assertSnapshotDataClean(JSON.parse(cand.normalized));

    // Fast keyed reuse — the common "identical content re-pinned" path.
    const existing = findExistingSnapshot(input.orgId, input.objectId, cand);
    if (existing) {
      return {
        representationRevisionId: existing.representationRevisionId,
        resourceId: existing.resourceId,
        effectiveBaseType: cand.type,
        contentDigest: cand.contentDigest,
        claimDispositionFingerprint: cand.fingerprint,
        snapshotSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
        sizeBytes: existing.sizeBytes,
        reused: true,
        bindingAssertionId: cand.bindingId as string,
      };
    }

    // Orphan-safe blob write (content-addressed by sha; a same-bytes racer
    // writes the SAME file — the reachability-guarded store keeps it).
    const blobStore = createLocalDiskBlobStore();
    const preallocResourceId = randomUUID();
    const representationRevisionId = randomUUID();
    const snapshotId = randomUUID();
    let newBlob: Awaited<ReturnType<ReturnType<typeof createLocalDiskBlobStore>["put"]>>;
    try {
      newBlob = await blobStore.put({
        orgId: input.orgId,
        artifactId: input.objectId,
        representationRevisionId,
        stream: bytesOf(cand.normalized),
        declaredMime: SNAPSHOT_MIME,
        maxBytes: SNAPSHOT_MAX_BYTES,
      });
    } catch (err) {
      throw err;
    }

    const substanceKey = deriveSubstanceKey({ kind: "blob", sha256: newBlob.sha256 });

    // ONE advisory-locked transaction: re-read under the lock (the `cur`/`valid`
    // CTEs) and write resource+blob+representation+snapshot ONLY when the
    // candidate still matches AND no snapshot already exists for the key.
    // results: [0]=lock, [1]=dead-key delete, [2]=capture CTE.
    const [, , capRes] = runPostgresQueriesSync({
      connectionString: conn(),
      transaction: true,
      queries: [
        { text: `SELECT pg_advisory_xact_lock(hashtext($1))`, values: [input.objectId] },
        // Dead-key cleanup (separate statement so the subsequent INSERT's
        // unique-index check sees the delete): a keying row whose backing
        // resource was GC-reclaimed (resource gone; the append-only
        // representation row survives) blocks the exact key forever — remove
        // it so an identical (content, claimant) capture can REMINT. The
        // keying table is a reuse index, not audit history; deleting a dead
        // key loses nothing (the audit trail lives in run_context_selections
        // / artifact_audit).
        {
          text: `DELETE FROM "${schema}"."object_content_snapshots" s
WHERE s.org_id = $1 AND s.object_id = $2 AND s.content_digest = $3
  AND s.effective_base_type = $4 AND s.snapshot_schema_version = $5
  AND s.claim_disposition_fingerprint = $6
  AND NOT EXISTS (
    SELECT 1 FROM "${schema}"."representation" rep
    JOIN "${schema}"."resource" res
      ON res.id = rep.resource_id AND res.org_id = rep.org_id
    WHERE rep.id = s.representation_revision_id AND rep.org_id = s.org_id
  )`,
          values: [
            input.orgId,
            input.objectId,
            cand.contentDigest,
            cand.type,
            SNAPSHOT_SCHEMA_VERSION,
            cand.fingerprint,
          ],
        },
        {
          text: `WITH cur AS (
  SELECT o.id, o.org_id, o.type, o.version, o.deleted_at,
         ab.id AS binding_id
  FROM "${schema}"."objects" o
  LEFT JOIN "${schema}"."semantic_assertion" ab
    ON ab.org_id = o.org_id AND ab.artifact_id = o.id
     AND ab.assertion_basis = 'binding' AND ab.eligibility <> 'archived'
  WHERE o.id = $2 AND o.org_id = $1
),
valid AS (
  SELECT 1 FROM cur
  WHERE cur.deleted_at IS NULL
    AND cur.type = $3
    AND cur.version = $4
    AND (cur.binding_id IS NOT DISTINCT FROM $5)
),
existing AS (
  -- Reusable ONLY when the backing resource chain is alive (the dead-key
  -- statement above already removed a reclaimed key row; the join is the
  -- same-guard belt-and-braces within this statement's snapshot).
  SELECT s.representation_revision_id, s.resource_id
  FROM "${schema}"."object_content_snapshots" s
  JOIN "${schema}"."representation" rep
    ON rep.id = s.representation_revision_id AND rep.org_id = s.org_id
  JOIN "${schema}"."resource" res
    ON res.id = rep.resource_id AND res.org_id = rep.org_id
  WHERE s.org_id = $1 AND s.object_id = $2 AND s.content_digest = $6
    AND s.effective_base_type = $3 AND s.snapshot_schema_version = $7
    AND s.claim_disposition_fingerprint = $8
  LIMIT 1
),
resource_op AS (
  INSERT INTO "${schema}"."resource"
    (id, org_id, kind, substance_key, mime, size_bytes, created_by, metadata)
  SELECT $9::text, $1::text, 'blob', $10::text, $11::text, $12::bigint, $13::text,
         jsonb_build_object('storageKey', $15::text, 'blobId', $14::text)
  WHERE EXISTS (SELECT 1 FROM valid) AND NOT EXISTS (SELECT 1 FROM existing)
  ON CONFLICT (org_id, kind, substance_key) DO UPDATE SET org_id = EXCLUDED.org_id
  RETURNING id, (xmax = 0) AS is_new
),
blob_insert AS (
  INSERT INTO "${schema}"."artifact_blobs"
    (id, org_id, storage_backend, storage_key, sha256, size_bytes, mime_detected, created_by)
  SELECT $14::text, $1::text, 'local-disk', $15::text, $16::text, $12::bigint, $11::text, $13::text
  WHERE EXISTS (SELECT 1 FROM resource_op WHERE is_new)
  RETURNING id
),
rep_insert AS (
  INSERT INTO "${schema}"."representation"
    (id, org_id, artifact_id, resource_id, revision, form, created_by, created_by_run_id)
  SELECT $17::text, $1::text, $2::text, (SELECT id FROM resource_op),
    COALESCE((SELECT MAX(revision) FROM "${schema}"."representation" WHERE org_id = $1 AND artifact_id = $2), 0) + 1,
    'file', $13::text, $18
  WHERE EXISTS (SELECT 1 FROM resource_op)
  RETURNING id, resource_id
),
snap_insert AS (
  INSERT INTO "${schema}"."object_content_snapshots"
    (id, org_id, object_id, content_digest, effective_base_type, snapshot_schema_version,
     claim_disposition_fingerprint, representation_revision_id, resource_id, size_bytes, created_by)
  SELECT $19::text, $1::text, $2::text, $6::text, $3::text, $7::integer, $8::text,
    (SELECT id FROM rep_insert), (SELECT resource_id FROM rep_insert), $12::bigint, $13::text
  WHERE EXISTS (SELECT 1 FROM rep_insert)
  RETURNING representation_revision_id, resource_id, size_bytes
)
SELECT
  EXISTS (SELECT 1 FROM valid) AS valid,
  EXISTS (SELECT 1 FROM existing) AS reused,
  COALESCE((SELECT representation_revision_id FROM snap_insert),
           (SELECT representation_revision_id FROM existing)) AS representation_revision_id,
  COALESCE((SELECT resource_id FROM snap_insert),
           (SELECT resource_id FROM existing)) AS resource_id`,
          values: [
            input.orgId, // $1
            input.objectId, // $2
            cand.type, // $3
            cand.version, // $4
            cand.bindingId, // $5
            cand.contentDigest, // $6
            SNAPSHOT_SCHEMA_VERSION, // $7
            cand.fingerprint, // $8
            preallocResourceId, // $9
            substanceKey, // $10
            newBlob.mimeDetected, // $11
            sizeBytes, // $12
            input.createdBy ?? null, // $13
            newBlob.blobId, // $14
            newBlob.storageKey, // $15
            newBlob.sha256, // $16
            representationRevisionId, // $17
            input.createdByRunId ?? null, // $18
            snapshotId, // $19
          ],
        },
      ],
    });

    const out = capRes?.rows?.[0] as
      | {
          valid: boolean;
          reused: boolean;
          representation_revision_id: string | null;
          resource_id: string | null;
        }
      | undefined;

    if (!out || out.valid !== true) {
      // The row changed under us. Best-effort cleanup: deleteByStorageKey is
      // reachability-guarded AND grace-period-guarded (young content-addressed
      // files are kept), so a stale-retry file may survive as a disk orphan
      // until the artifact-blob-verifier's sweep reports it — the same
      // residual class createSemanticArtifact's dedupe-loser cleanup accepts
      // (cinatra#926). Retry with a fresh read.
      await blobStore
        .deleteByStorageKey({ orgId: input.orgId, storageKey: newBlob.storageKey })
        .catch(() => {});
      continue;
    }
    if (!out.representation_revision_id || !out.resource_id) {
      throw new Error("[object-content-snapshot] capture returned no representation despite a valid candidate");
    }
    return {
      representationRevisionId: String(out.representation_revision_id),
      resourceId: String(out.resource_id),
      effectiveBaseType: cand.type,
      contentDigest: cand.contentDigest,
      claimDispositionFingerprint: cand.fingerprint,
      snapshotSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
      sizeBytes,
      reused: out.reused === true,
      bindingAssertionId: cand.bindingId as string,
    };
  }
  throw new StaleSnapshotCandidateError();
}


// ---------------------------------------------------------------------------
// Resolution-time capture composition (cinatra#1430 context plumbing).
//
// "Capture at RESOLUTION time": a claimed typed row can only become a context
// candidate WITH a concrete representation revision id — which it gets from a
// content snapshot. This composition runs BEFORE `resolveContextSlot` on the
// production context-resolve/finalize paths and RETURNS THE PINS (objectId →
// representationRevisionId) the resolver must use for claimed rows — the
// resolver never falls back to "latest revision" for a claimed row, so an
// older representation can never leak past a capture failure and an A→B→A
// content cycle resolves to the REUSED (correct) revision, not the newest.
//
// Policy: only rows whose winning claim dispositions allow it (pinnable AND
// snapshotPolicy 'content' — checked in SQL here and re-checked fail-closed in
// readCandidate) are candidates at all.
//
// Steady state is BATCHED (codex round-2 finding): one candidate query, one
// batched candidate-content read, one batched validated-reuse query — per-row
// work (the advisory-locked mint) happens only for rows with NO valid
// snapshot. Per-row failures (size cap, fail-closed redaction, persistent
// staleness, policy refusal) SKIP that row — a poison row never blocks the
// other candidates or the generic-artifact resolution.
// ---------------------------------------------------------------------------

import { buildOwnershipFilter } from "@/lib/derived-store-ownership";
import type { ActorContext } from "@/lib/authz/actor-context";
import type { AgentContextSlot } from "@cinatra-ai/extensions/agent-context-slots-reader";
import {
  expandAcceptedViaSatisfies,
  type InstalledExtensionDescriptor,
} from "./context-resolver";

/** Cap on candidate rows captured per slot resolution — an operational safety
 * valve against a pathological org-wide claimed-type sweep on the request
 * path. Candidates are ordered NARROWEST-SCOPE-FIRST (mirroring the
 * resolver's project < user < team < organization < workspace precedence)
 * before the cap, so truncation can only ever drop the BROADEST rows; a
 * truncation is logged. */
const CAPTURE_CANDIDATES_MAX = 500;

export interface SnapshotPin {
  objectId: string;
  representationRevisionId: string;
  /** The eligible BINDING assertion the snapshot was captured under — the
   * resolver emits the claimed row ONLY as this assertion (fail-closed on a
   * binding transition between capture and resolve). */
  semanticAssertionId: string;
}

export interface CaptureSnapshotsForContextSlotResult {
  attempted: number;
  captured: number;
  reused: number;
  skipped: number;
  /** objectId → snapshot representation for the resolver's claimed-row join. */
  pins: SnapshotPin[];
}

/**
 * Capture (or keyed-reuse) content snapshots for every actor-visible CLAIMED
 * typed row matching the slot's accepted extensions whose claim dispositions
 * permit pinning. Mirrors the resolver's visibility CTE (ownership filter +
 * project narrowing + tombstone exclusion) restricted to rows carrying an
 * eligible BINDING whose extension is in the accepted set. Idempotent:
 * unchanged rows keyed-reuse their snapshot via ONE batched query.
 */
export async function captureSnapshotsForContextSlot(input: {
  actor: ActorContext;
  slot: AgentContextSlot;
  projectId?: string;
  installedExtensions: ReadonlyArray<InstalledExtensionDescriptor>;
}): Promise<CaptureSnapshotsForContextSlotResult> {
  const out: CaptureSnapshotsForContextSlotResult = {
    attempted: 0,
    captured: 0,
    reused: 0,
    skipped: 0,
    pins: [],
  };
  const orgId = input.actor.organizationId;
  if (!orgId) return out; // fail-closed: no org, no candidates (resolver throws).
  if (input.slot.acceptedArtifactExtensions.length === 0) return out;
  // Mirror the resolver's projectId fail-closed gate.
  if (input.projectId !== undefined) {
    const actorProjects = input.actor.projectIds ?? [];
    if (!actorProjects.includes(input.projectId)) return out;
  }
  ensurePostgresSchema();
  const schema = q();
  const accepted = expandAcceptedViaSatisfies(
    input.slot.acceptedArtifactExtensions,
    input.installedExtensions,
  );
  const ownership = buildOwnershipFilter(input.actor);
  const params: unknown[] = [...ownership.params];
  const ph = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const acceptedPh = ph(accepted);
  const orgIdPh = ph(orgId);
  const projectNarrow =
    input.projectId !== undefined ? ` AND o.project_id = ${ph(input.projectId)}` : "";
  const projectExcludeWhenUnset =
    input.projectId === undefined ? " AND o.project_id IS NULL" : "";

  // 1. Candidate rows: visible + claimed by an accepted extension + the
  // winning claim's dispositions permit content snapshots/pinning (SQL-side
  // string checks align with the zod defaults: an absent key IS the
  // fail-closed default). Ordered narrowest-scope-first, then id.
  const [candRes] = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `SELECT o.id
FROM "${schema}"."objects" o
WHERE o.org_id = ${orgIdPh}
  AND o.deleted_at IS NULL
  AND EXISTS (
    SELECT 1 FROM "${schema}"."semantic_assertion" b
    JOIN "${schema}"."artifact_type_claims" c ON c.id = b.binding_claim_id
    WHERE b.org_id = o.org_id AND b.artifact_id = o.id
      AND b.assertion_basis = 'binding' AND b.eligibility = 'eligible'
      AND b.extension = ANY(${acceptedPh}::text[])
      AND c.dispositions->>'pinnable' = 'true'
      AND c.dispositions->>'snapshotPolicy' = 'content'
  )
  AND (${ownership.sql})${projectNarrow}${projectExcludeWhenUnset}
ORDER BY
  (CASE
     WHEN o.project_id IS NOT NULL THEN 0
     WHEN o.owner_level = 'user' THEN 1
     WHEN o.owner_level = 'team' THEN 2
     WHEN o.owner_level = 'organization' THEN 3
     ELSE 4
   END) ASC,
  o.id ASC
LIMIT ${CAPTURE_CANDIDATES_MAX}`,
        values: params,
      },
    ],
  });
  const ids = ((candRes?.rows ?? []) as Array<{ id: string }>).map((r) => String(r.id));
  if (ids.length === CAPTURE_CANDIDATES_MAX) {
    console.warn(
      `[object-content-snapshot] capture candidate set truncated at ${CAPTURE_CANDIDATES_MAX} rows for org ${orgId} — broadest-scope rows dropped first`,
    );
  }
  if (ids.length === 0) return out;

  // 2. ONE batched content read for all candidates (row + binding + claim).
  const [batchRes] = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `SELECT o.id, o.type, o.version, o.data,
  ab.id AS binding_id, ab.binding_claim_id, ab.binding_generation, ab.extension,
  c.dispositions AS claim_dispositions
FROM "${schema}"."objects" o
LEFT JOIN "${schema}"."semantic_assertion" ab
  ON ab.org_id = o.org_id AND ab.artifact_id = o.id
   AND ab.assertion_basis = 'binding' AND ab.eligibility <> 'archived'
LEFT JOIN "${schema}"."artifact_type_claims" c
  ON c.id = ab.binding_claim_id
WHERE o.org_id = $1 AND o.id = ANY($2::text[]) AND o.deleted_at IS NULL`,
        values: [orgId, ids],
      },
    ],
  });
  type BatchRow = {
    id: string;
    type: string;
    version: number | string;
    data: unknown;
    binding_id: string | null;
    binding_claim_id: string | null;
    binding_generation: number | string | null;
    extension: string | null;
    claim_dispositions: unknown;
  };
  const contentRows = (batchRes?.rows ?? []) as BatchRow[];

  // 3. JS-side per-row derivation (digest + fingerprint) with the SAME
  // fail-closed gates the capture primitive applies (redaction, size,
  // policy) — a failing row is skipped and gets NO pin, so it is NOT
  // resolvable through any older representation.
  type Derived = {
    objectId: string;
    type: string;
    version: number;
    bindingId: string;
    contentDigest: string;
    fingerprint: string;
  };
  const derived: Derived[] = [];
  for (const row of contentRows) {
    out.attempted += 1;
    try {
      if (row.binding_id == null) throw new SnapshotPolicyError("binding vanished");
      const parsedDisp = parseClaimDispositions(row.claim_dispositions ?? {});
      if (!parsedDisp.ok || parsedDisp.dispositions.pinnable !== true || parsedDisp.dispositions.snapshotPolicy !== "content") {
        throw new SnapshotPolicyError(`claim ${row.binding_claim_id} policy forbids snapshots`);
      }
      const normalized = canonicalJSONStringify(row.data ?? {});
      const sizeBytes = Buffer.byteLength(normalized, "utf8");
      if (sizeBytes > SNAPSHOT_MAX_BYTES) throw new SnapshotTooLargeError(sizeBytes);
      assertSnapshotDataClean(JSON.parse(normalized));
      derived.push({
        objectId: String(row.id),
        type: String(row.type),
        version: Number(row.version),
        bindingId: String(row.binding_id),
        contentDigest: sha256(normalized),
        fingerprint: computeClaimDispositionFingerprint({
          bindingClaimId: row.binding_claim_id ?? null,
          bindingGeneration: row.binding_generation == null ? null : Number(row.binding_generation),
          extension: row.extension ?? null,
          dispositions: row.claim_dispositions ?? null,
        }),
      });
    } catch (err) {
      out.skipped += 1;
      const name = err instanceof Error ? err.name : "Error";
      console.warn(
        `[object-content-snapshot] capture skipped for object ${row.id} (org ${orgId}): ${name}`,
      );
    }
  }
  if (derived.length === 0) return out;

  // 4. ONE batched validated-reuse query: for each derived key, an existing
  // snapshot whose object row STILL matches (version/type/binding) and whose
  // resource chain is ALIVE. Rows that hit here need no further work.
  const [reuseRes] = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `SELECT k.object_id, s.representation_revision_id
FROM unnest($2::text[], $3::text[], $4::text[], $5::int[], $6::text[], $7::text[])
  AS k(object_id, content_digest, effective_base_type, version, binding_id, fingerprint)
JOIN "${schema}"."object_content_snapshots" s
  ON s.org_id = $1 AND s.object_id = k.object_id
 AND s.content_digest = k.content_digest
 AND s.effective_base_type = k.effective_base_type
 AND s.snapshot_schema_version = $8
 AND s.claim_disposition_fingerprint = k.fingerprint
JOIN "${schema}"."objects" o
  ON o.id = k.object_id AND o.org_id = $1 AND o.deleted_at IS NULL
 AND o.type = k.effective_base_type AND o.version = k.version
JOIN "${schema}"."semantic_assertion" ab
  ON ab.org_id = $1 AND ab.artifact_id = o.id AND ab.id = k.binding_id
 AND ab.assertion_basis = 'binding' AND ab.eligibility <> 'archived'
JOIN "${schema}"."representation" rep
  ON rep.id = s.representation_revision_id AND rep.org_id = s.org_id
JOIN "${schema}"."resource" res
  ON res.id = rep.resource_id AND res.org_id = rep.org_id`,
        values: [
          orgId,
          derived.map((d) => d.objectId),
          derived.map((d) => d.contentDigest),
          derived.map((d) => d.type),
          derived.map((d) => d.version),
          derived.map((d) => d.bindingId),
          derived.map((d) => d.fingerprint),
          SNAPSHOT_SCHEMA_VERSION,
        ],
      },
    ],
  });
  const reusedByObject = new Map<string, string>();
  for (const row of (reuseRes?.rows ?? []) as Array<{ object_id: string; representation_revision_id: string }>) {
    reusedByObject.set(String(row.object_id), String(row.representation_revision_id));
  }

  // 5. Mint (advisory-locked) ONLY for rows with no valid snapshot.
  for (const d of derived) {
    const reusedRep = reusedByObject.get(d.objectId);
    if (reusedRep) {
      out.reused += 1;
      out.pins.push({
        objectId: d.objectId,
        representationRevisionId: reusedRep,
        semanticAssertionId: d.bindingId,
      });
      continue;
    }
    try {
      const snap = await captureObjectContentSnapshot({ orgId, objectId: d.objectId });
      if (!snap) {
        out.skipped += 1; // row died/unclaimed between the batch read and the capture.
      } else {
        if (snap.reused) out.reused += 1;
        else out.captured += 1;
        out.pins.push({
          objectId: d.objectId,
          representationRevisionId: snap.representationRevisionId,
          semanticAssertionId: snap.bindingAssertionId,
        });
      }
    } catch (err) {
      out.skipped += 1;
      const name = err instanceof Error ? err.name : "Error";
      console.warn(
        `[object-content-snapshot] capture skipped for object ${d.objectId} (org ${orgId}): ${name}`,
      );
    }
  }
  return out;
}
