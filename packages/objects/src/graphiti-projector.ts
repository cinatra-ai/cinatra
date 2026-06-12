import "server-only";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { getPostgresConnectionString, postgresSchema } from "@/lib/database";
import { addEpisode, deleteEpisode, identityHashToUuid } from "./graphiti-client";
import { DEFAULT_ARTIFACT_EXTENSION } from "./generated/artifact-floor";
import { objectSyncAdapterRegistry } from "./sync-adapters/registry";
import type { ObjectSyncAdapter, StoredObject } from "./sync-adapters/adapter";

// ---------------------------------------------------------------------------
// Reads cinatra.graphiti_projection_outbox, calls Graphiti, updates objects
// row with version-guard SQL. NEVER called synchronously from MCP handlers —
// invoked exclusively via the GRAPHITI_PROJECTION_REPAIR BullMQ job
// (background-jobs.ts) or directly by the cinatra graph rebuild CLI.
//
// Exposed via tsconfig sub-path alias `@cinatra-ai/objects/graphiti-projector`
// (NOT re-exported from packages/objects/src/index.ts) to avoid the
// barrel-import trap that drags @cinatra-ai/mcp-server (host-only) into worker
// dispatch contexts.
// ---------------------------------------------------------------------------

type OutboxRow = {
  id: string;
  object_id: string;
  object_version: number;
  org_id: string | null;
  operation: "upsert" | "delete";
  payload_hash: string | null;
  attempts: number;
};

type CanonicalRow = {
  id: string;
  type: string;
  data: Record<string, unknown>;
  org_id: string | null;
  version: number;
  run_id: string | null;
  agent_id: string | null;
  graphiti_episode_uuid: string | null;
  // `source` gates projection to cinatra-originated writes (agent | ui);
  // `created_at` feeds the adapter's reference_time when routing.
  source: string | null;
  created_at: string;
};

function deriveGroupId(orgId: string | null): string {
  return orgId ? `cinatra-org-${orgId}` : "cinatra-default";
}

function deriveEntityName(data: Record<string, unknown>, type: string): string {
  const candidate =
    (data.name as string | undefined) ??
    (data.title as string | undefined) ??
    (data.email as string | undefined) ??
    type;
  return String(candidate).slice(0, 200);
}

// Metadata/excerpt-only projection for artifact object rows.
// Returns null for non-artifact data (caller keeps the raw-data projection).
// An artifact row is identified by the
// ArtifactObjectData shape (artifactType + latestRepresentationRevisionId).
// Whitelisted fields only; excerpt hard-capped; NEVER body bytes/base64/
// storage keys.
//
// The Graphiti projection carries the semantic identity (the eligible
// extensions + the primary) read from `semantic_assertion`. Callers pass
// the identity via the optional `semanticIdentity` arg; the projector itself
// stays pure (no DB access) so the function remains unit-testable with a
// single fixture call.
const ARTIFACT_EXCERPT_CAP = 2000;
export type ArtifactSemanticIdentity = {
  eligibleExtensions: string[];
  primaryExtension: string;
};
export function projectArtifactSafe(
  data: Record<string, unknown>,
  semanticIdentity?: ArtifactSemanticIdentity,
): Record<string, unknown> | null {
  if (
    !data ||
    typeof data !== "object" ||
    typeof data.artifactType !== "string" ||
    typeof data.latestRepresentationRevisionId !== "string"
  ) {
    return null;
  }
  const pick = (k: string): unknown =>
    typeof data[k] === "string" || typeof data[k] === "number"
      ? data[k]
      : undefined;
  const excerptRaw = data.excerpt;
  return {
    artifactType: data.artifactType,
    latestRepresentationRevisionId: data.latestRepresentationRevisionId,
    latestDigest: pick("latestDigest"),
    mime: pick("mime"),
    size: pick("size"),
    originKind: pick("originKind"),
    viewerHint: pick("viewerHint"),
    title: pick("title"),
    // Semantic identity in the Graphiti projection.
    // Empty arrays / floor-default are valid sentinels
    // for "no enrichment yet" (e.g., projection ran before any
    // classifier asserted) — Graphiti consumers can still navigate
    // by the immutable artifactId.
    primaryExtension:
      semanticIdentity?.primaryExtension ?? DEFAULT_ARTIFACT_EXTENSION,
    eligibleExtensions: semanticIdentity?.eligibleExtensions ?? [],
    excerpt:
      typeof excerptRaw === "string"
        ? excerptRaw.slice(0, ARTIFACT_EXCERPT_CAP)
        : undefined,
  };
}

function readCanonicalRow(objectId: string, orgId: string | null): CanonicalRow | null {
  const schema = postgresSchema.replaceAll('"', '""');
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT id, type, data, org_id, version, run_id, agent_id, graphiti_episode_uuid, source, created_at
             FROM "${schema}"."objects"
             WHERE id = $1 AND (org_id = $2 OR $2 IS NULL) AND deleted_at IS NULL
             LIMIT 1`,
        values: [objectId, orgId],
      },
    ],
  });
  return (result?.rows[0] as CanonicalRow | undefined) ?? null;
}

function markProjected(input: {
  objectId: string;
  episodeUuid: string;
  projectedVersion: number;
}): void {
  const schema = postgresSchema.replaceAll('"', '""');
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `UPDATE "${schema}"."objects"
             SET graphiti_sync_status = 'synced',
                 graphiti_episode_uuid = $1,
                 graphiti_projected_version = $2,
                 graphiti_projected_at = now(),
                 graphiti_projection_error = NULL
             WHERE id = $3
               AND (graphiti_projected_version IS NULL OR graphiti_projected_version < $2)`,
        values: [input.episodeUuid, input.projectedVersion, input.objectId],
      },
    ],
  });
  // 0 rows affected ⇒ a newer version already won; benign.
}

function markDeleted(objectId: string): void {
  const schema = postgresSchema.replaceAll('"', '""');
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `UPDATE "${schema}"."objects"
             SET graphiti_sync_status = 'deleted',
                 graphiti_projected_at = now(),
                 graphiti_projection_error = NULL
             WHERE id = $1`,
        values: [objectId],
      },
    ],
  });
}

/**
 * Project an object to Graphiti as a NEW append-only episode.
 * Calls addEpisode only; never deleteEpisode + addEpisode.
 *
 * Returns `{ episodeUuid: string }` on success, or `{ episodeUuid: null,
 * skipped: true }` when the canonical row's version has already advanced
 * past this outbox entry (stale-outbox guard).
 */
export async function projectObjectToGraphiti(input: {
  objectId: string;
  objectVersion: number;
  orgId: string | null;
}): Promise<{ episodeUuid: string | null; skipped?: boolean }> {
  // episodeUuid is "" when Graphiti returns no uuid in any known shape.
  // Callers should treat empty string as a soft-failure signal (still marks
  // the row projected to avoid retry loops, but downstream lookups by uuid
  // will return nothing — the reconcile CLI handles such orphans).
  const row = readCanonicalRow(input.objectId, input.orgId);
  if (!row) {
    throw new Error(`projectObjectToGraphiti: canonical row not found id=${input.objectId}`);
  }
  // Stale-outbox guard (BEFORE addEpisode).
  // If the canonical row has already advanced past this outbox entry's
  // object_version, a newer entry will land later and overwrite the episode
  // pointer. Calling addEpisode here would append a stale ghost episode that
  // the version-guard markProjected UPDATE could not later retract. Guard the
  // network call BEFORE making it.
  if (row.version > input.objectVersion) {
    console.log(
      `[graphiti-projector] skipping stale outbox entry for ${input.objectId} ` +
        `(row.version=${row.version} > input.objectVersion=${input.objectVersion})`,
    );
    return { episodeUuid: null, skipped: true };
  }

  // Source gate. Graphiti indexes data ORIGINATED in cinatra (agent
  // writes through a connector trigger ObjectSyncAdapter.export → Graphiti).
  // Data PULLED from external systems is NOT projected. Rows with source ∉
  // {agent, ui} are skipped terminally — the outbox row is marked done (not
  // failed), no retry. A `null` source predates this gate and is treated as
  // cinatra-originated to avoid dropping legacy rows.
  if (row.source !== null && row.source !== "agent" && row.source !== "ui") {
    console.log(
      `[graphiti-projector] skipping non-cinatra-originated row ${row.id} (source=${row.source})`,
    );
    return { episodeUuid: null, skipped: true };
  }

  // Adapter routing. Adapter-owned types (CRM account/contact under
  // the Twenty migration) route here to TwentyToGraphitiAdapter.export(),
  // which hydrates the full record from Twenty via the crm_* facade before
  // composing the episode. Filter to targetSystem === "graphiti" so a
  // future non-Graphiti sync adapter on the same type cannot be invoked by
  // this Graphiti-specific projection path. The adapter calls addEpisode
  // itself + returns a deterministic externalId (the episode UUID) which we
  // use for markProjected bookkeeping.
  const adapters = objectSyncAdapterRegistry
    .getAdaptersForType(row.type)
    .filter((a: ObjectSyncAdapter) => a.targetSystem === "graphiti");
  if (adapters.length > 0) {
    const adapter = adapters[0]!;
    const storedObject: StoredObject = {
      id: row.id,
      type: row.type,
      data: row.data,
      parentId: null,
      orgId: row.org_id,
      createdAt: row.created_at,
      createdBy: null,
      agentId: row.agent_id,
      runId: row.run_id,
      source: (row.source as StoredObject["source"]) ?? null,
      classificationConfidence: null,
      exportedTo: {},
      deletedAt: null,
    };
    // Adapters are configless built-ins for now (the Twenty→Graphiti
    // adapter ships without a config row). Pass an empty config; future per-row
    // configs can plug in via `readActiveObjectSyncAdapterConfigs` here.
    const result = await adapter.export(storedObject, {} as never);
    if (!result.ok) {
      // Adapter export failed — let processProjectionOutbox surface this as
      // a failed outbox row (same retry semantics as the generic path).
      throw new Error(
        `adapter ${adapter.id} export failed for ${row.id}: ${result.error ?? "(no error message)"}`,
      );
    }
    // externalId is the deterministic episode UUID the adapter generated +
    // recorded with Graphiti. Use it for the projector's bookkeeping so
    // future delete attempts hit the right episode.
    const adapterEpisodeUuid = result.externalId ?? "";
    markProjected({
      objectId: row.id,
      episodeUuid: adapterEpisodeUuid,
      projectedVersion: input.objectVersion,
    });
    return { episodeUuid: adapterEpisodeUuid };
  }

  const groupId = deriveGroupId(input.orgId ?? row.org_id);
  // EPISODE-UUID-EMPTY: knowledge-graph-mcp 1.0.x add_memory returns only a
  // message string — no uuid in any known response path. We compute a stable
  // deterministic UUID locally for Postgres bookkeeping and delete attempts.
  // NOTE: do NOT pass uuid to addEpisode. Graphiti 0.28.2 queue_service
  // interprets the uuid param as "re-process an existing node" — it issues
  // MATCH (uuid) which fails with "node not found" when the episode is new,
  // permanently blocking its processing. Episodes must be created without uuid.
  //
  // Embed [oid:<objectId>] in the episode name so it travels with
  // the episode record. NOTE: live verification (2026-04-30) showed this tag does
  // NOT propagate to entity node names via LLM extraction in Graphiti 0.28.2.
  // OID_RE in handlers.ts extractObjectIds is therefore inert for now; kept for
  // a future Graphiti version or text-body embedding approach. Deferred.
  const episodeUuid = identityHashToUuid(row.id, groupId);
  // Artifact projection policy. Artifact rows MUST NOT
  // spread raw `row.data` into graph memory: even though the artifact writer
  // keeps bytes/base64/storage keys OUT of objects.data by invariant
  // by invariant, defence-in-depth requires a metadata/excerpt-only
  // projection so a future writer bug, a large editable body, or stray
  // fields can never poison Graphiti. Non-artifact rows are unchanged.
  //
  // For semantic artifact rows, fetch the eligible semantic assertions
  // in lock-step with the projection so Graphiti sees the current
  // `primaryExtension` + the eligible extension set. Reads
  // `semantic_assertion` directly (this file already has PG access).
  // Skips for non-artifact rows (no extra query) and for rows with no
  // semantic_assertion entries, which naturally return empty arrays.
  // Skip the assertion lookup when org_id is null (project / no-tenant
  // path — semantic_assertion is org-scoped, would return nothing
  // anyway, so the resulting empty identity is identical).
  const semanticIdentity =
    row.type === "@cinatra-ai/artifact:object" && row.org_id !== null
      ? readSemanticIdentityForProjection(row.org_id, row.id)
      : undefined;
  const projectionData = projectArtifactSafe(row.data, semanticIdentity) ?? row.data;
  const episodeBody = JSON.stringify({
    ...projectionData,
    cinatra_object_id: row.id,
    _cinatra: {
      objectId: row.id,
      version: row.version,
      type: row.type,
      runId: row.run_id,
      agentId: row.agent_id,
    },
  });

  await addEpisode({
    name: `${deriveEntityName(row.data, row.type)} [oid:${row.id}]`,
    episode_body: episodeBody,
    source: "json",
    source_description: `objects projection (run ${row.run_id ?? "n/a"})`,
    group_id: groupId,
    // uuid intentionally omitted — see EPISODE-UUID-EMPTY note above
  });

  markProjected({
    objectId: row.id,
    episodeUuid,
    projectedVersion: input.objectVersion,
  });
  return { episodeUuid };
}

// Caller note:
// `processProjectionOutbox` must treat `{ skipped: true }` as a successful
// outcome and mark the corresponding outbox row `done` (not `failed`). The
// loop body in this file already wraps the call in try/catch — the success
// path falls through to the "Mark outbox row done" UPDATE, which is the
// correct behavior for skipped entries (do not retry; a newer outbox row
// will deliver the latest state). No special-casing needed in the worker
// loop, but executors MUST verify the resolved value is awaited (not the
// promise) so the skipped flag is observable.

/**
 * Delete the current episode pointer (does NOT hard-delete extracted entities).
 */
export async function deleteCurrentEpisodeFromGraphiti(input: {
  objectId: string;
  orgId: string | null;
}): Promise<void> {
  const row = readCanonicalRow(input.objectId, input.orgId);
  if (!row) return; // already gone
  if (row.graphiti_episode_uuid) {
    try {
      await deleteEpisode({ uuid: row.graphiti_episode_uuid });
    } catch (err) {
      console.warn(
        `[graphiti-projector] deleteEpisode failed for ${input.objectId}:`,
        err,
      );
      // Continue — we still mark deleted in PG; the cleanup CLI handles orphans.
    }
  }
  markDeleted(row.id);
}

/**
 * Repair worker: claim batch via FOR UPDATE SKIP LOCKED, project each row,
 * mark outbox rows done/failed.
 */
export async function processProjectionOutbox(options?: {
  batchSize?: number;
  maxAttempts?: number;
}): Promise<{ processed: number; failed: number }> {
  const batchSize = options?.batchSize ?? 20;
  const maxAttempts = options?.maxAttempts ?? 5;
  const schema = postgresSchema.replaceAll('"', '""');

  // Recover rows stuck in 'processing' for > 5 min (server crash/OOM
  // mid-batch leaves them unclaimable forever — the claim query below skips them).
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `UPDATE "${schema}"."graphiti_projection_outbox"
               SET status = 'failed',
                   last_error = 'recovered from stuck processing state'
               WHERE status = 'processing'
                 AND created_at < now() - interval '5 minutes'`,
        values: [],
      },
    ],
  });

  // 1. Claim batch
  const [claimResult] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `UPDATE "${schema}"."graphiti_projection_outbox"
             SET status = 'processing', attempts = attempts + 1
             WHERE id IN (
               SELECT id FROM "${schema}"."graphiti_projection_outbox"
               WHERE status IN ('pending', 'failed') AND attempts < $1
               ORDER BY created_at
               LIMIT $2
               FOR UPDATE SKIP LOCKED
             )
             RETURNING id, object_id, object_version, org_id, operation, payload_hash, attempts`,
        values: [maxAttempts, batchSize],
      },
    ],
  });

  const rows = (claimResult?.rows ?? []) as OutboxRow[];
  let processed = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      if (row.operation === "upsert") {
        await projectObjectToGraphiti({
          objectId: row.object_id,
          objectVersion: row.object_version,
          orgId: row.org_id,
        });
      } else if (row.operation === "delete") {
        await deleteCurrentEpisodeFromGraphiti({
          objectId: row.object_id,
          orgId: row.org_id,
        });
      }
      // Mark outbox row done
      runPostgresQueriesSync({
        connectionString: getPostgresConnectionString(),
        queries: [
          {
            text: `UPDATE "${schema}"."graphiti_projection_outbox"
                 SET status = 'done', processed_at = now(), last_error = NULL
                 WHERE id = $1`,
            values: [row.id],
          },
        ],
      });
      processed += 1;
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      runPostgresQueriesSync({
        connectionString: getPostgresConnectionString(),
        queries: [
          {
            text: `UPDATE "${schema}"."graphiti_projection_outbox"
                 SET status = 'failed', last_error = $1
                 WHERE id = $2`,
            values: [message.slice(0, 1000), row.id],
          },
        ],
      });
      // Also mark canonical row as failed for observability
      runPostgresQueriesSync({
        connectionString: getPostgresConnectionString(),
        queries: [
          {
            text: `UPDATE "${schema}"."objects"
                 SET graphiti_sync_status = 'failed',
                     graphiti_projection_error = $1
                 WHERE id = $2`,
            values: [message.slice(0, 1000), row.object_id],
          },
        ],
      });
    }
  }

  return { processed, failed };
}


// Semantic identity reader for the Graphiti projector. Direct PG read of
// `semantic_assertion` for the active (non-archived, eligible-only) rows
// of an artifact. Same precedence ranking as `primaryExtensionFor` in the
// assertion store (user > authoring_skill > agent > matcher). Inlined here
// (not imported from src/lib) so the objects package keeps its lean
// dependency surface — postgres-sync is already imported.
function readSemanticIdentityForProjection(
  orgId: string,
  artifactId: string,
): ArtifactSemanticIdentity {
  const schema = postgresSchema.replaceAll('"', '""');
  const [res] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        // Deterministic ORDER BY so eligibleExtensions
        // is stable across projections (matches the canonical service
        // ordering in `listEligibleAssertions`).
        text: `SELECT extension, asserted_by, asserted_at
FROM "${schema}"."semantic_assertion"
WHERE org_id=$1 AND artifact_id=$2 AND eligibility='eligible'
ORDER BY asserted_at, extension`,
        values: [orgId, artifactId],
      },
    ],
  });
  type Row = { extension: string; asserted_by: string; asserted_at: string };
  const rows = (res?.rows ?? []) as Row[];
  const DEFAULT_EXT = DEFAULT_ARTIFACT_EXTENSION;
  const eligibleExtensions = rows.map((r) => String(r.extension));
  const nonDefault = rows.filter((r) => r.extension !== DEFAULT_EXT);
  if (nonDefault.length === 0) {
    return {
      eligibleExtensions,
      primaryExtension: DEFAULT_EXT,
    };
  }
  const rank = (src: string): number =>
    src === "user" ? 3 : src === "authoring_skill" ? 2 : src === "agent" ? 1 : 0;
  nonDefault.sort((a, b) => {
    const r = rank(b.asserted_by) - rank(a.asserted_by);
    if (r !== 0) return r;
    if (a.asserted_at !== b.asserted_at) {
      return a.asserted_at < b.asserted_at ? 1 : -1;
    }
    return a.extension < b.extension ? -1 : a.extension > b.extension ? 1 : 0;
  });
  return {
    eligibleExtensions,
    primaryExtension: String(nonDefault[0]!.extension),
  };
}
