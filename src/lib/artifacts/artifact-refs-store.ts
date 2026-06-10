import "server-only";
import { randomUUID } from "node:crypto";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";

// `database.ts` lazily `require()`s this module's `buildArtifactRefSyncQueries`
// inside `upsertChatThreadInDatabase`. A STATIC `import ... from "@/lib/database"`
// here closes that into an import cycle: under Turbopack the back-edge resolves
// to a half-initialised module namespace, so `mod.buildArtifactRefSyncQueries`
// reads as `undefined` ("is not a function") and every `POST /api/chat/save`
// 500s. Reach into database.ts LAZILY instead (the codebase's existing
// cross-module pattern — see `artifact-creation.ts`, `database.ts:1218/1385`)
// so there is no static back-edge to complete the cycle.
function db(): typeof import("@/lib/database") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@/lib/database");
}

// Replay-safe artifact reference (pin) table.
//
// `artifact_refs` is the registry for which runs/messages pin an
// artifact. A pinned representation row stays resolvable through the
// serve path even after the parent artifact is tombstoned, until
// retention elapses AND no live pin remains.
//
// Wired pin emitters:
//   - chat thread upsert: `upsertChatThreadInDatabase` composes
//     `buildArtifactRefSyncQueries` (referrerKind: "chat_thread",
//     referrerId: threadId) into the same transaction that writes
//     the thread JSON.
//
// Additional supported referrer kinds:
//   - WayFlow A2A resume envelope (`referrerKind: "wayflow_envelope"`,
//     referrerId: a2aTaskId).
//   - agent-run creation (`referrerKind: "agent_run"`, referrerId:
//     runId).
//
// Idempotency: inserts use ON CONFLICT DO NOTHING on the natural
// pin key `(org_id, artifact_id, representation_revision_id,
// referrer_kind, referrer_id)`.

export type ReferrerKind =
  | "chat_thread"
  | "agent_run"
  | "wayflow_envelope";

export type ArtifactRefInput = {
  artifactId: string;
  representationRevisionId: string;
  digest: string;
  mime: string;
  originKind: string;
};

const conn = (): string => db().getPostgresConnectionString();
const q = (): string => db().postgresSchema.replaceAll('"', '""');

/** Idempotent batch insert of artifact refs (one row per ref). The
 *  unique index on (org_id, artifact_id, representation_revision_id,
 *  referrer_kind, referrer_id) makes the operation safe to retry. */
export function recordArtifactRefs(input: {
  orgId: string;
  referrerKind: ReferrerKind;
  referrerId: string;
  createdBy?: string | null;
  refs: ArtifactRefInput[];
}): void {
  if (input.refs.length === 0) return;
  db().ensurePostgresSchema();
  // Validate each pin candidate's (representation, resource,
  // artifact_blobs) chain is fully alive. `representation` rows are
  // immutable/append-only and SURVIVE GC, so a pure
  // representation-existence check would let a pin row be created
  // long after the resource was reclaimed — pin would then point at
  // orphaned bytes (route 404). Joining through `resource` ensures
  // the resource is also alive at pin INSERT time. This narrows (but
  // does not eliminate) the concurrent-GC race window: GC can still
  // commit between this check and the INSERT under READ COMMITTED.
  // A complete fix requires pin-writer + GC sharing a resource-level
  // advisory lock.
  const queries = input.refs.map((r) => ({
    text: `INSERT INTO "${q()}"."artifact_refs"
  (id, org_id, artifact_id, representation_revision_id, digest, mime,
   origin_kind, referrer_kind, referrer_id, metadata, created_by)
SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, '{}'::jsonb, $10
WHERE EXISTS (
  SELECT 1 FROM "${q()}"."representation" rep
  JOIN "${q()}"."resource" res
    ON res.id = rep.resource_id AND res.org_id = rep.org_id
  WHERE rep.org_id = $2
    AND rep.artifact_id = $3
    AND rep.id = $4
)
ON CONFLICT (org_id, artifact_id, representation_revision_id,
             referrer_kind, referrer_id) DO NOTHING`,
    values: [
      randomUUID(),
      input.orgId,
      r.artifactId,
      r.representationRevisionId,
      r.digest,
      r.mime,
      r.originKind,
      input.referrerKind,
      input.referrerId,
      input.createdBy ?? null,
    ],
  }));
  runPostgresQueriesSync({
    connectionString: conn(),
    transaction: true,
    queries,
  });
}

/** Sync the pin set for a given referrer to EXACTLY the supplied
 *  refs. Inserts any new ones; DELETES any rows for the referrer
 *  whose (artifact_id, representation_revision_id) tuple is no
 *  longer in the new set. Use when the referrer's attachment list
 *  changes (e.g., chat thread re-saved, agent-run params updated). */
/** Build the ordered query list for syncing a referrer's pin set
 *  WITHOUT executing it. Used by `upsertChatThreadInDatabase` (and
 *  future thread-/run-/envelope-saving wire-ins) to compose the
 *  sync into the PARENT save's transaction so that the thread JSON
 *  and the pin rows commit atomically.
 *
 *  Returns: queries to execute in ORDER inside a `transaction:true`
 *  runPostgresQueriesSync call. The first query is the advisory
 *  lock; the per-referrer concurrent-save serialization works only
 *  if the caller's parent tx also passes `transaction: true`. */
export function buildArtifactRefSyncQueries(input: {
  orgId: string;
  referrerKind: ReferrerKind;
  referrerId: string;
  createdBy?: string | null;
  refs: ArtifactRefInput[];
}): Array<{ text: string; values: unknown[] }> {
  const wantedKeys = input.refs.map(
    (r) => `${r.artifactId}::${r.representationRevisionId}`,
  );
  const queries: Array<{ text: string; values: unknown[] }> = [
    {
      text: `SELECT pg_advisory_xact_lock(hashtext($1 || ':' || $2 || ':' || $3))`,
      values: [input.orgId, input.referrerKind, input.referrerId],
    },
  ];
  for (const r of input.refs) {
    queries.push({
      text: `INSERT INTO "${q()}"."artifact_refs"
  (id, org_id, artifact_id, representation_revision_id, digest, mime,
   origin_kind, referrer_kind, referrer_id, metadata, created_by)
SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, '{}'::jsonb, $10
WHERE EXISTS (
  SELECT 1 FROM "${q()}"."representation" rep
  JOIN "${q()}"."resource" res
    ON res.id = rep.resource_id AND res.org_id = rep.org_id
  WHERE rep.org_id = $2
    AND rep.artifact_id = $3
    AND rep.id = $4
)
ON CONFLICT (org_id, artifact_id, representation_revision_id,
             referrer_kind, referrer_id) DO NOTHING`,
      values: [
        randomUUID(),
        input.orgId,
        r.artifactId,
        r.representationRevisionId,
        r.digest,
        r.mime,
        r.originKind,
        input.referrerKind,
        input.referrerId,
        input.createdBy ?? null,
      ],
    });
  }
  if (wantedKeys.length === 0) {
    queries.push({
      text: `DELETE FROM "${q()}"."artifact_refs"
WHERE org_id = $1 AND referrer_kind = $2 AND referrer_id = $3`,
      values: [input.orgId, input.referrerKind, input.referrerId],
    });
  } else {
    queries.push({
      text: `DELETE FROM "${q()}"."artifact_refs"
WHERE org_id = $1 AND referrer_kind = $2 AND referrer_id = $3
  AND (artifact_id || '::' || representation_revision_id) != ALL($4::text[])`,
      values: [
        input.orgId,
        input.referrerKind,
        input.referrerId,
        wantedKeys,
      ],
    });
  }
  return queries;
}

export function syncArtifactRefsForReferrer(input: {
  orgId: string;
  referrerKind: ReferrerKind;
  referrerId: string;
  createdBy?: string | null;
  refs: ArtifactRefInput[];
}): void {
  db().ensurePostgresSchema();
  // Per-referrer advisory lock + single held-lock transaction
  // spanning INSERTs + DELETE. The composable query-builder is the
  // canonical impl; this standalone wraps it in its own transaction.
  // Callers that also want to commit OTHER state in the same tx
  // (e.g., `upsertChatThreadInDatabase` writing the thread JSON)
  // should use `buildArtifactRefSyncQueries` directly instead.
  runPostgresQueriesSync({
    connectionString: conn(),
    transaction: true,
    queries: buildArtifactRefSyncQueries(input),
  });
}

/** Count active pins on a given artifact (any referrer). Used by
 *  `tombstoneArtifact` to decide between immediate-GC and retention. */
export function countArtifactRefs(orgId: string, artifactId: string): number {
  db().ensurePostgresSchema();
  const [res] = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `SELECT COUNT(*)::int AS n FROM "${q()}"."artifact_refs"
WHERE org_id = $1 AND artifact_id = $2`,
        values: [orgId, artifactId],
      },
    ],
  });
  return Number((res?.rows?.[0] as { n?: number } | undefined)?.n ?? 0);
}

/** True iff a given (artifact, representation) pair is pinned. Used
 *  by the deleted-allowed serve replay path: a tombstoned artifact
 *  may still serve its bytes through a pinned representation. */
export function isRepresentationPinned(
  orgId: string,
  artifactId: string,
  representationRevisionId: string,
): boolean {
  db().ensurePostgresSchema();
  const [res] = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `SELECT 1 FROM "${q()}"."artifact_refs"
WHERE org_id = $1 AND artifact_id = $2 AND representation_revision_id = $3
LIMIT 1`,
        values: [orgId, artifactId, representationRevisionId],
      },
    ],
  });
  return Boolean(res?.rows && res.rows.length > 0);
}

/** Delete every pin row for a referrer. Use when the referrer is
 *  itself deleted (e.g., chat thread purged, agent-run pruned). */
export function deleteArtifactRefsForReferrer(input: {
  orgId: string;
  referrerKind: ReferrerKind;
  referrerId: string;
}): void {
  db().ensurePostgresSchema();
  runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `DELETE FROM "${q()}"."artifact_refs"
WHERE org_id = $1 AND referrer_kind = $2 AND referrer_id = $3`,
        values: [input.orgId, input.referrerKind, input.referrerId],
      },
    ],
  });
}
