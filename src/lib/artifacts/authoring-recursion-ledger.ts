import "server-only";

// ---------------------------------------------------------------------------
// Recursion ledger for authoring-skill chains.
//
// When an artifact's authoring skill declares `agentDependencies` and the
// chat-driven authoring path invokes those agents, the chain could cycle:
//
//   marketing-icp-author -> brand-voice-agent (fans out) ->
//   brand-voice-author -> marketing-icp-author -> ... (forever).
//
// This ledger records every authoring step BEFORE it admits child
// fan-out so the server can refuse cycles (same `extension` anywhere
// on the parent chain) and excessive depth (default cap 8).
//
// **Critical security invariant:** `parent_step_id` is SERVER-DERIVED
// from the calling context — never trusted from an LLM-supplied
// MCP-primitive arg. The chat path opens a root step (parent_step_id =
// NULL) when it first fires the authoring intent, returns the resulting
// `stepId` opaque token, and any child step derived from that root MUST
// resolve its parent via the agent_run chain (or, for chat-skill direct
// fan-out, via the chat session's recorded step). A model that
// omits/spoofs ancestry simply opens a new root chain, which is fine —
// its budget starts over.
//
// **Operational, NOT append-only:** this ledger is an admission-control
// table, not an audit table. A future TTL sweep deletes rows older than
// 30 days. status='committed'|'aborted' marks finished chains.
// ---------------------------------------------------------------------------

import {
  ensurePostgresSchema,
  getPostgresConnectionString,
  postgresSchema,
} from "@/lib/database";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";

const conn = (): string => getPostgresConnectionString();
const q = (): string => postgresSchema.replaceAll('"', '""');

/** Default max depth. Conservative — chained authoring is rare; if a
 *  legitimate workflow needs more, set CINATRA_AUTHORING_MAX_DEPTH. */
const DEFAULT_MAX_DEPTH = 8;
const HARD_DEPTH_FLOOR = 1;
const HARD_DEPTH_CEILING = 32;

function resolveMaxDepth(): number {
  const raw = process.env.CINATRA_AUTHORING_MAX_DEPTH;
  if (!raw) return DEFAULT_MAX_DEPTH;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) return DEFAULT_MAX_DEPTH;
  // Clamp to [HARD_DEPTH_FLOOR, HARD_DEPTH_CEILING].
  // A value < 1 effectively bans authoring (depth=0 root would fail);
  // a value > 32 is the table CHECK constraint upper bound.
  if (parsed < HARD_DEPTH_FLOOR) return HARD_DEPTH_FLOOR;
  if (parsed > HARD_DEPTH_CEILING) return HARD_DEPTH_CEILING;
  return parsed;
}

export type AuthoringInvocationRecord = {
  authoringStepId: string;
  orgId: string;
  parentStepId: string | null;
  extension: string;
  depth: number;
  runId: string | null;
  status: "open" | "committed" | "aborted";
  startedAt: string;
  completedAt: string | null;
};

export type RecordAuthoringInvocationInput = {
  orgId: string;
  /** Server-derived parent step id (NEVER LLM-supplied). NULL for root. */
  parentStepId: string | null;
  extension: string;
  /** Optional agent_run_id when the authoring step is inside an
   *  agent_run; null for chat-skill direct path. */
  runId: string | null;
};

export type RecordAuthoringInvocationSuccess = {
  ok: true;
  stepId: string;
  depth: number;
};

export type RecordAuthoringInvocationFailure = {
  ok: false;
  reason: "cycle" | "depth-cap-exceeded" | "parent-not-found";
  /** The chain that triggered the failure, from root to attempted leaf. */
  chain: AuthoringInvocationRecord[];
  /** For cycle: the extension that already appears on the chain.
   *  For depth-cap: the depth that would have been used.
   *  For parent-not-found: the dangling parentStepId that didn't resolve. */
  detail: string;
};

export type RecordAuthoringInvocationResult =
  | RecordAuthoringInvocationSuccess
  | RecordAuthoringInvocationFailure;

export class AuthoringRecursionError extends Error {
  readonly code = "AUTHORING_RECURSION_LIMIT";
  constructor(
    public readonly reason: "cycle" | "depth-cap-exceeded" | "parent-not-found",
    public readonly chain: AuthoringInvocationRecord[],
    detail: string,
  ) {
    super(
      `authoring-recursion-ledger: ${reason} — ${detail}. chain.length=${chain.length}`,
    );
    this.name = "AuthoringRecursionError";
  }
}

// ---------------------------------------------------------------------------
// PRNG-safe ulid-shaped id. We don't pull in a ulid dep; the
// timestamp+random shape is enough for primary-key uniqueness within
// a deployment and stays sort-friendly.
// ---------------------------------------------------------------------------

function generateAuthoringStepId(): string {
  // crypto.randomUUID() is available on Node 24 (the cinatra runtime
  // minimum). Prefix `aut_` so the id is grep-able + distinguishable
  // from other table primary keys.
  return `aut_${crypto.randomUUID()}`;
}

// ---------------------------------------------------------------------------
// Ancestor-chain walk. Used both for cycle detection and depth
// calculation. Returns the chain from root → immediate-parent. NULL
// parentStepId yields an empty array.
// ---------------------------------------------------------------------------

function loadParentChain(
  orgId: string,
  parentStepId: string | null,
): AuthoringInvocationRecord[] {
  if (parentStepId === null) return [];
  ensurePostgresSchema();
  // Recursive CTE walks parents up to the root.
  const r = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `WITH RECURSIVE chain AS (
  SELECT
    authoring_step_id, org_id, parent_step_id, extension, depth,
    run_id, status, started_at, completed_at, 0 AS rank
  FROM "${q()}"."authoring_invocation_ledger"
  WHERE org_id=$1 AND authoring_step_id=$2
  UNION ALL
  SELECT
    n.authoring_step_id, n.org_id, n.parent_step_id, n.extension, n.depth,
    n.run_id, n.status, n.started_at, n.completed_at, c.rank + 1
  FROM "${q()}"."authoring_invocation_ledger" n
  JOIN chain c ON c.parent_step_id IS NOT NULL AND n.authoring_step_id=c.parent_step_id AND n.org_id=$1
)
SELECT authoring_step_id, org_id, parent_step_id, extension, depth, run_id, status, started_at, completed_at
FROM chain ORDER BY rank DESC`,
        values: [orgId, parentStepId],
      },
    ],
  });
  const rows = (r?.[0]?.rows ?? []) as Array<Record<string, unknown>>;
  return rows.map(rowToRecord);
}

function rowToRecord(row: Record<string, unknown>): AuthoringInvocationRecord {
  return {
    authoringStepId: String(row.authoring_step_id),
    orgId: String(row.org_id),
    parentStepId: row.parent_step_id == null ? null : String(row.parent_step_id),
    extension: String(row.extension),
    depth: Number(row.depth),
    runId: row.run_id == null ? null : String(row.run_id),
    status: String(row.status) as "open" | "committed" | "aborted",
    startedAt: String(row.started_at),
    completedAt: row.completed_at == null ? null : String(row.completed_at),
  };
}

// ---------------------------------------------------------------------------
// recordAuthoringInvocation — the core admission gate. Walks the
// ancestor chain, computes depth, detects cycle + depth-cap, INSERTs
// (status='open') on success.
// ---------------------------------------------------------------------------

export function recordAuthoringInvocation(
  input: RecordAuthoringInvocationInput,
): RecordAuthoringInvocationResult {
  ensurePostgresSchema();
  const maxDepth = resolveMaxDepth();

  const chain = loadParentChain(input.orgId, input.parentStepId);

  // When parentStepId is non-null but the chain walk returned EMPTY,
  // the parent is dangling (typo / spoofed / deleted-by-TTL / cross-org).
  // Refuse — do NOT silently insert a dangling-parent row that would
  // look like a root step. This is the second tier of defense alongside
  // the server-derived parentStepId requirement at the MCP layer.
  if (input.parentStepId !== null && chain.length === 0) {
    return {
      ok: false,
      reason: "parent-not-found",
      chain: [],
      detail: `parentStepId "${input.parentStepId}" did not resolve to a ledger entry in org "${input.orgId}" (typo / spoofed / TTL-purged / cross-org). Authoring refused; do NOT retry without a fresh, server-derived parentStepId.`,
    };
  }

  const depth = chain.length;

  // Cycle: same extension already on the parent chain.
  const cycleHit = chain.find((c) => c.extension === input.extension);
  if (cycleHit) {
    return {
      ok: false,
      reason: "cycle",
      chain,
      detail: `extension "${input.extension}" already appears in the parent chain at depth ${cycleHit.depth} (step ${cycleHit.authoringStepId})`,
    };
  }

  // Depth cap.
  if (depth > maxDepth) {
    return {
      ok: false,
      reason: "depth-cap-exceeded",
      chain,
      detail: `attempted depth ${depth} exceeds cap ${maxDepth} (set CINATRA_AUTHORING_MAX_DEPTH to override; clamped to [${HARD_DEPTH_FLOOR},${HARD_DEPTH_CEILING}])`,
    };
  }

  const stepId = generateAuthoringStepId();
  runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `INSERT INTO "${q()}"."authoring_invocation_ledger"
  (authoring_step_id, org_id, parent_step_id, extension, depth, run_id, status)
VALUES ($1::text, $2::text, $3::text, $4::text, $5::int, $6::text, 'open')`,
        values: [
          stepId,
          input.orgId,
          input.parentStepId,
          input.extension,
          depth,
          input.runId,
        ],
      },
    ],
  });

  return { ok: true, stepId, depth };
}

// ---------------------------------------------------------------------------
// markAuthoringInvocationCommitted / Aborted — close the step. Used
// when the artifact-emit (committed) or the authoring attempt
// (aborted) finishes. A future TTL sweep purges rows where
// status='open' AND started_at < now() - interval '30 days' (the
// crashed-mid-authoring case).
// ---------------------------------------------------------------------------

export function markAuthoringInvocationCommitted(
  orgId: string,
  stepId: string,
): void {
  updateStatus(orgId, stepId, "committed");
}

export function markAuthoringInvocationAborted(
  orgId: string,
  stepId: string,
): void {
  updateStatus(orgId, stepId, "aborted");
}

function updateStatus(
  orgId: string,
  stepId: string,
  status: "committed" | "aborted",
): void {
  ensurePostgresSchema();
  runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `UPDATE "${q()}"."authoring_invocation_ledger"
SET status=$3, completed_at=now()
WHERE org_id=$1 AND authoring_step_id=$2 AND status='open'`,
        values: [orgId, stepId, status],
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// getAuthoringChain — debug/replay surface. Walks parent chain from
// the given step back to the root. Used by `artifact_authoring_*`
// MCP primitives to expose the chain for chat-side debugging.
// ---------------------------------------------------------------------------

export function getAuthoringChain(
  orgId: string,
  stepId: string,
): AuthoringInvocationRecord[] {
  ensurePostgresSchema();
  const r = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `WITH RECURSIVE chain AS (
  SELECT authoring_step_id, org_id, parent_step_id, extension, depth, run_id, status, started_at, completed_at, 0 AS rank
  FROM "${q()}"."authoring_invocation_ledger"
  WHERE org_id=$1 AND authoring_step_id=$2
  UNION ALL
  SELECT n.authoring_step_id, n.org_id, n.parent_step_id, n.extension, n.depth, n.run_id, n.status, n.started_at, n.completed_at, c.rank + 1
  FROM "${q()}"."authoring_invocation_ledger" n
  JOIN chain c ON c.parent_step_id IS NOT NULL AND n.authoring_step_id=c.parent_step_id AND n.org_id=$1
)
SELECT authoring_step_id, org_id, parent_step_id, extension, depth, run_id, status, started_at, completed_at
FROM chain ORDER BY rank DESC`,
        values: [orgId, stepId],
      },
    ],
  });
  const rows = (r?.[0]?.rows ?? []) as Array<Record<string, unknown>>;
  return rows.map(rowToRecord);
}

// ---------------------------------------------------------------------------
// Helpers exposed for callers that want to validate before recording.
// ---------------------------------------------------------------------------

export function getConfiguredMaxDepth(): number {
  return resolveMaxDepth();
}

export const __test = {
  generateAuthoringStepId,
  rowToRecord,
};

// ---------------------------------------------------------------------------
// Downward-walk helpers for workflow artifact binding.
//
// getAuthoringStepDescendants: walks DOWNWARD from a root step (the inverse
// direction of getAuthoringChain). Bounded by distance ≤ 32 to match the
// ledger's CHECK(depth ≤ 32). Deterministic order: by distance ASC then
// step id ASC.
//
// getArtifactsForAuthoringStep: bulk-fetches artifact refs emitted under
// any of the supplied step ids, joining the ledger to filter on
// status='committed' and to surface the artifact extension as `kind`.
// ---------------------------------------------------------------------------

export type AuthoringStepDescendant = {
  stepId: string;
  parentStepId: string | null;
  depth: number;
  distance: number;
};

export function getAuthoringStepDescendants(
  orgId: string,
  rootStepId: string,
): AuthoringStepDescendant[] {
  ensurePostgresSchema();
  const r = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `WITH RECURSIVE descendants AS (
  SELECT authoring_step_id, parent_step_id, depth, 0 AS distance
  FROM "${q()}"."authoring_invocation_ledger"
  WHERE org_id=$1 AND authoring_step_id=$2
  UNION ALL
  SELECT l.authoring_step_id, l.parent_step_id, l.depth, d.distance + 1
  FROM "${q()}"."authoring_invocation_ledger" l
  JOIN descendants d ON l.parent_step_id = d.authoring_step_id AND l.org_id=$1
  WHERE d.distance < 32
)
SELECT authoring_step_id, parent_step_id, depth, distance
FROM descendants
ORDER BY distance ASC, authoring_step_id ASC`,
        values: [orgId, rootStepId],
      },
    ],
  });
  const rows = (r?.[0]?.rows ?? []) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    stepId: String(row.authoring_step_id ?? ""),
    parentStepId: row.parent_step_id == null ? null : String(row.parent_step_id),
    depth: Number(row.depth ?? 0),
    distance: Number(row.distance ?? 0),
  }));
}

export type AuthoringStepArtifactRow = {
  stepId: string;
  artifactId: string;
  representationRevisionId: string;
  kind: string;
};

export function getArtifactsForAuthoringStep(
  orgId: string,
  stepIds: readonly string[],
): AuthoringStepArtifactRow[] {
  if (stepIds.length === 0) return [];
  ensurePostgresSchema();
  // Build a placeholder list `$2, $3, ...` for the IN clause. `$1` is orgId.
  const placeholders = stepIds.map((_, i) => `$${i + 2}`).join(", ");
  const r = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `SELECT asa.authoring_step_id, asa.artifact_id, asa.representation_revision_id, l.extension
FROM "${q()}"."authoring_step_artifacts" asa
JOIN "${q()}"."authoring_invocation_ledger" l ON l.authoring_step_id = asa.authoring_step_id AND l.org_id=$1
WHERE asa.org_id=$1
  AND asa.authoring_step_id IN (${placeholders})
  AND l.status='committed'
ORDER BY asa.authoring_step_id ASC, asa.artifact_id ASC, asa.representation_revision_id ASC`,
        values: [orgId, ...stepIds],
      },
    ],
  });
  const rows = (r?.[0]?.rows ?? []) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    stepId: String(row.authoring_step_id ?? ""),
    artifactId: String(row.artifact_id ?? ""),
    representationRevisionId: String(row.representation_revision_id ?? ""),
    kind: String(row.extension ?? ""),
  }));
}

export function insertAuthoringStepArtifactLinkage(
  orgId: string,
  authoringStepId: string,
  artifactId: string,
  representationRevisionId: string,
): void {
  ensurePostgresSchema();
  runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `INSERT INTO "${q()}"."authoring_step_artifacts"
  (authoring_step_id, org_id, artifact_id, representation_revision_id)
VALUES ($1, $2, $3, $4)`,
        values: [authoringStepId, orgId, artifactId, representationRevisionId],
      },
    ],
  });
}
