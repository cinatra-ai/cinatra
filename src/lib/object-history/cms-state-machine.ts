// CMS remote-effect state machine.
//
// State transitions: pending -> succeeded | failed. The mutable status
// lives in `cinatra.remote_effect_attempts`, keyed to the canonical
// `object_change_event.id` so the append-only history surface stays
// append-only.
//
// Idempotency contract: every connector restore must be
// idempotent (re-executing yields the same remote state) and must read-
// back-verify before marking succeeded. The state machine itself is also
// idempotent: enqueueing the same idempotency_key returns the existing
// attempt without creating a duplicate row.

import { randomUUID } from "node:crypto";

import {
  ensurePostgresSchema,
  getPostgresConnectionString,
  postgresSchema,
} from "@/lib/database";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { canonicalJsonStringify } from "./event-snapshot";

export type RemoteEffectAttemptStatus = "pending" | "succeeded" | "failed";

export type RemoteEffectAttempt = {
  id: string;
  changeEventId: string;
  connectorName: string;
  targetKind: string;
  targetId: string | null;
  intendedState: unknown;
  status: RemoteEffectAttemptStatus;
  attemptCount: number;
  lastError: string | null;
  remoteRevisionRef: unknown;
  readBackPayload: unknown;
  idempotencyKey: string;
  startedAt: string;
  updatedAt: string;
  orgId: string | null;
};

export type EnqueueRemoteEffectInput = {
  changeEventId: string;
  connectorName: string;
  targetKind: string;
  targetId?: string | null;
  intendedState?: unknown;
  idempotencyKey?: string;
  orgId?: string | null;
};

export function enqueueRemoteEffect(
  input: EnqueueRemoteEffectInput,
): RemoteEffectAttempt {
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');
  const id = `rea_${randomUUID()}`;
  const idempotencyKey =
    input.idempotencyKey ?? `rea_${input.changeEventId}_${input.connectorName}`;
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `INSERT INTO "${schema}"."remote_effect_attempts"
                 (id, change_event_id, connector_name, target_kind, target_id,
                  intended_state, status, attempt_count, idempotency_key,
                  started_at, updated_at, org_id)
               VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'pending', 0, $7, now(), now(), $8)
               ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = now()
               RETURNING id, change_event_id, connector_name, target_kind, target_id,
                         intended_state, status, attempt_count, last_error,
                         remote_revision_ref, read_back_payload, idempotency_key,
                         started_at, updated_at, org_id`,
        values: [
          id,
          input.changeEventId,
          input.connectorName,
          input.targetKind,
          input.targetId ?? null,
          // Use canonicalJsonStringify so equal values
          // serialise identically regardless of key order; preserve null
          // distinctly from missing (only `undefined` collapses).
          input.intendedState === undefined
            ? null
            : canonicalJsonStringify(input.intendedState),
          idempotencyKey,
          input.orgId ?? null,
        ],
      },
    ],
  });
  const row = result?.rows[0];
  if (!row) {
    throw new Error("enqueueRemoteEffect: failed to insert remote_effect_attempts row");
  }
  return rowToAttempt(row);
}

export type MarkRemoteEffectSucceededInput = {
  idempotencyKey: string;
  remoteRevisionRef?: unknown;
  readBackPayload?: unknown;
};

export function markRemoteEffectSucceeded(
  input: MarkRemoteEffectSucceededInput,
): RemoteEffectAttempt {
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `UPDATE "${schema}"."remote_effect_attempts"
               SET status = 'succeeded',
                   attempt_count = attempt_count + 1,
                   remote_revision_ref = COALESCE($2::jsonb, remote_revision_ref),
                   read_back_payload = COALESCE($3::jsonb, read_back_payload),
                   last_error = NULL,
                   updated_at = now()
               WHERE idempotency_key = $1
               RETURNING id, change_event_id, connector_name, target_kind, target_id,
                         intended_state, status, attempt_count, last_error,
                         remote_revision_ref, read_back_payload, idempotency_key,
                         started_at, updated_at, org_id`,
        values: [
          input.idempotencyKey,
          // Canonicalise + preserve null distinctly from missing.
          input.remoteRevisionRef === undefined
            ? null
            : canonicalJsonStringify(input.remoteRevisionRef),
          input.readBackPayload === undefined
            ? null
            : canonicalJsonStringify(input.readBackPayload),
        ],
      },
    ],
  });
  const row = result?.rows[0];
  if (!row) {
    throw new Error(
      `markRemoteEffectSucceeded: no attempt found for idempotency_key=${input.idempotencyKey}`,
    );
  }
  return rowToAttempt(row);
}

export type MarkRemoteEffectFailedInput = {
  idempotencyKey: string;
  error: string;
};

export function markRemoteEffectFailed(
  input: MarkRemoteEffectFailedInput,
): RemoteEffectAttempt {
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `UPDATE "${schema}"."remote_effect_attempts"
               SET status = 'failed',
                   attempt_count = attempt_count + 1,
                   last_error = $2,
                   updated_at = now()
               WHERE idempotency_key = $1
               RETURNING id, change_event_id, connector_name, target_kind, target_id,
                         intended_state, status, attempt_count, last_error,
                         remote_revision_ref, read_back_payload, idempotency_key,
                         started_at, updated_at, org_id`,
        values: [input.idempotencyKey, input.error],
      },
    ],
  });
  const row = result?.rows[0];
  if (!row) {
    throw new Error(
      `markRemoteEffectFailed: no attempt found for idempotency_key=${input.idempotencyKey}`,
    );
  }
  return rowToAttempt(row);
}

export function listRemoteEffectsByChangeEvent(
  changeEventId: string,
): RemoteEffectAttempt[] {
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT id, change_event_id, connector_name, target_kind, target_id,
                      intended_state, status, attempt_count, last_error,
                      remote_revision_ref, read_back_payload, idempotency_key,
                      started_at, updated_at, org_id
               FROM "${schema}"."remote_effect_attempts"
               WHERE change_event_id = $1
               ORDER BY started_at DESC`,
        values: [changeEventId],
      },
    ],
  });
  return (result?.rows ?? []).map(rowToAttempt);
}

function rowToAttempt(row: Record<string, unknown>): RemoteEffectAttempt {
  return {
    id: String(row.id),
    changeEventId: String(row.change_event_id),
    connectorName: String(row.connector_name),
    targetKind: String(row.target_kind),
    targetId: row.target_id == null ? null : String(row.target_id),
    intendedState: row.intended_state ?? null,
    status: String(row.status) as RemoteEffectAttemptStatus,
    attemptCount: Number(row.attempt_count ?? 0),
    lastError: row.last_error == null ? null : String(row.last_error),
    remoteRevisionRef: row.remote_revision_ref ?? null,
    readBackPayload: row.read_back_payload ?? null,
    idempotencyKey: String(row.idempotency_key),
    startedAt:
      row.started_at instanceof Date
        ? row.started_at.toISOString()
        : String(row.started_at),
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : String(row.updated_at),
    orgId: row.org_id == null ? null : String(row.org_id),
  };
}

// CMS-restore convenience: wraps the connector's restore call with the
// state machine. The connector callable receives the intended state and
// must return either { ok: true, readBack: ... } or throw on failure.
// Idempotent: re-running with the same idempotencyKey resumes from the
// stored attempt.
export type CmsRestoreCallable = (args: {
  intendedState: unknown;
  attempt: RemoteEffectAttempt;
}) => Promise<{ remoteRevisionRef?: unknown; readBack?: unknown }>;

export async function runCmsRestore(input: {
  changeEventId: string;
  connectorName: string;
  targetKind: string;
  targetId: string;
  intendedState: unknown;
  idempotencyKey?: string;
  orgId?: string | null;
  callable: CmsRestoreCallable;
}): Promise<RemoteEffectAttempt> {
  const attempt = enqueueRemoteEffect({
    changeEventId: input.changeEventId,
    connectorName: input.connectorName,
    targetKind: input.targetKind,
    targetId: input.targetId,
    intendedState: input.intendedState,
    idempotencyKey: input.idempotencyKey,
    orgId: input.orgId,
  });
  // Terminal states are returned unchanged. A
  // `failed` attempt is NOT auto-retried here — the caller must
  // explicitly retry via a different idempotency key or via a separate
  // retry primitive.
  if (attempt.status === "succeeded" || attempt.status === "failed") {
    return attempt;
  }
  // If the attempt was previously enqueued with
  // a different intendedState, reject — the stored state is authoritative.
  // Compare via canonicalJsonStringify so key-order changes don't cause
  // false rejections.
  const storedState = attempt.intendedState as unknown;
  if (storedState != null) {
    const storedJson = canonicalJsonStringify(storedState);
    const incomingJson = canonicalJsonStringify(input.intendedState);
    if (storedJson !== incomingJson) {
      throw new Error(
        `runCmsRestore: intendedState mismatch for idempotencyKey=${attempt.idempotencyKey}. ` +
          `Use the previously stored intendedState or call with a different idempotencyKey.`,
      );
    }
  }
  try {
    const result = await input.callable({
      // Pass the STORED intendedState (the source of truth), not the
      // caller's fresh input.
      intendedState: storedState ?? input.intendedState,
      attempt,
    });
    return markRemoteEffectSucceeded({
      idempotencyKey: attempt.idempotencyKey,
      remoteRevisionRef: result.remoteRevisionRef,
      readBackPayload: result.readBack,
    });
  } catch (e) {
    return markRemoteEffectFailed({
      idempotencyKey: attempt.idempotencyKey,
      error: (e as Error).message ?? String(e),
    });
  }
}

// ===========================================================================
// Remote-effect attempts visibility + admin retry.
// ===========================================================================

// Single attempt lookup (org-scoped) for the admin retry path.
export function getRemoteEffectAttemptById(
  attemptId: string,
  scope: { orgId: string | null },
): RemoteEffectAttempt | null {
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT id, change_event_id, connector_name, target_kind, target_id,
                      intended_state, status, attempt_count, last_error,
                      remote_revision_ref, read_back_payload, idempotency_key,
                      started_at, updated_at, org_id
               FROM "${schema}"."remote_effect_attempts"
               WHERE id = $1
                 AND (org_id = $2 OR ($2 IS NULL AND org_id IS NULL))
               LIMIT 1`,
        values: [attemptId, scope.orgId],
      },
    ],
  });
  const row = result?.rows[0];
  return row ? rowToAttempt(row) : null;
}

// List attempts for a change-set's events (org-scoped). Joins
// remote_effect_attempts to object_change_event so the caller can constrain
// by change_set_id.
export function listRemoteEffectAttemptsForChangeSet(input: {
  changeSetId: string;
  orgId: string | null;
}): RemoteEffectAttempt[] {
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT rea.id, rea.change_event_id, rea.connector_name, rea.target_kind,
                      rea.target_id, rea.intended_state, rea.status, rea.attempt_count,
                      rea.last_error, rea.remote_revision_ref, rea.read_back_payload,
                      rea.idempotency_key, rea.started_at, rea.updated_at, rea.org_id
               FROM "${schema}"."remote_effect_attempts" rea
               JOIN "${schema}"."object_change_event" oce
                 ON oce.id = rea.change_event_id
               WHERE oce.change_set_id = $1
                 AND (rea.org_id = $2 OR ($2 IS NULL AND rea.org_id IS NULL))
               ORDER BY rea.started_at DESC`,
        values: [input.changeSetId, input.orgId],
      },
    ],
  });
  return (result?.rows ?? []).map(rowToAttempt);
}

// CMS-restore callable registry. The remote-effect substrate exists, but a
// connector restore EXECUTOR is not yet wired (runCmsRestore has no production
// callers). Real per-connector restore callables register here; until then the
// registry is empty and retry honestly reports "unsupported" rather than a
// silent no-op.
const CMS_RESTORE_ADAPTERS = new Map<string, CmsRestoreCallable>();

export function registerCmsRestoreAdapter(
  connectorName: string,
  callable: CmsRestoreCallable,
): void {
  CMS_RESTORE_ADAPTERS.set(connectorName, callable);
}

export function getCmsRestoreCallable(
  connectorName: string,
): CmsRestoreCallable | null {
  return CMS_RESTORE_ADAPTERS.get(connectorName) ?? null;
}

export type RetryRemoteEffectResult =
  | { ok: true; attempt: RemoteEffectAttempt }
  | { ok: false; reason: "not-found" | "unsupported"; message: string };

// Retry a failed/pending connector restore. Mints a FRESH idempotency key so
// runCmsRestore creates a new attempt (the original key is a terminal no-op).
// Resolves a connector restore callable; when none is registered, returns
// `unsupported` (no silent no-op). Authz (platform_admin) is enforced by the
// caller (handler / server action), NOT here.
export async function retryRemoteEffect(input: {
  attemptId: string;
  orgId: string | null;
}): Promise<RetryRemoteEffectResult> {
  const attempt = getRemoteEffectAttemptById(input.attemptId, {
    orgId: input.orgId,
  });
  if (!attempt) {
    return { ok: false, reason: "not-found", message: "attempt not found" };
  }
  const callable = getCmsRestoreCallable(attempt.connectorName);
  if (!callable) {
    return {
      ok: false,
      reason: "unsupported",
      message: `No connector restore adapter is registered for "${attempt.connectorName}". Connector restore execution is wired in a future release.`,
    };
  }
  const result = await runCmsRestore({
    changeEventId: attempt.changeEventId,
    connectorName: attempt.connectorName,
    targetKind: attempt.targetKind,
    targetId: attempt.targetId ?? "",
    intendedState: attempt.intendedState,
    // Fresh idempotency key — the original is terminal and would no-op.
    idempotencyKey: `rea_retry_${randomUUID()}`,
    orgId: input.orgId,
    callable,
  });
  return { ok: true, attempt: result };
}
