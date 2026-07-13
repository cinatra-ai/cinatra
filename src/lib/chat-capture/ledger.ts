import "server-only";

// Chat-capture turn ledger — DB primitives (cinatra#1367).
//
// The durable idempotency + provenance + quota record behind the detection
// pipeline. One row per (thread_id, turn_id). See chat-capture-schema.ts for
// the table + the full status-vocabulary contract.
//
// All functions use the synchronous pg layer (postgres-sync), matching the
// other operational stores this pipeline composes with.

import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";

/** Mirrored by the CHECK constraint in chat-capture-schema.ts / core__0037
 * (sync pinned by chat-capture-schema.test.ts). */
export const CHAT_CAPTURE_TURN_STATUSES = [
  "claimed",
  "classifying",
  "skipped_disabled",
  "skipped_missing",
  "skipped_prefilter",
  "skipped_rate_capped",
  "skipped_classifier",
  "captured",
  "error",
] as const;
export type ChatCaptureTurnStatus = (typeof CHAT_CAPTURE_TURN_STATUSES)[number];

/** Nonterminal statuses a re-delivered job may RE-CLAIM (worker crash /
 * transient failure recovery — codex round-0 finding 3). */
export const CHAT_CAPTURE_RECLAIMABLE_STATUSES = ["claimed", "classifying", "error"] as const;

/** Default per-user rolling-24h LLM-classifier cap. */
export const CHAT_CAPTURE_DAILY_CLASSIFIER_CAP_DEFAULT = 50;

export function resolveChatCaptureDailyClassifierCap(): number {
  const raw = Number.parseInt(process.env.CHAT_CAPTURE_CLASSIFIER_DAILY_CAP ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : CHAT_CAPTURE_DAILY_CLASSIFIER_CAP_DEFAULT;
}

function schemaIdent(): string {
  return postgresSchema.replaceAll('"', '""');
}

/**
 * Claim the (thread, turn) row. Returns true when THIS invocation holds the
 * claim (fresh insert, or a re-claim of a nonterminal/error row); false when
 * the row is already terminal — the caller must no-op.
 *
 * Single statement so the claim is atomic: INSERT ... ON CONFLICT DO UPDATE
 * with a WHERE gate on the reclaimable statuses. A conflicting terminal row
 * fails the DO UPDATE's WHERE ⇒ zero rows returned.
 */
export function claimChatCaptureTurn(input: {
  threadId: string;
  turnId: string;
  ownerUserId: string;
}): boolean {
  ensurePostgresSchema();
  const s = schemaIdent();
  const [res] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `INSERT INTO "${s}"."chat_capture_turns" (thread_id, turn_id, owner_user_id, status)
          VALUES ($1, $2, $3, 'claimed')
          ON CONFLICT (thread_id, turn_id) DO UPDATE
            SET status = 'claimed', updated_at = now()
            WHERE "chat_capture_turns".status IN ('claimed','classifying','error')
          RETURNING status`,
        values: [input.threadId, input.turnId, input.ownerUserId],
      },
    ],
  });
  return (res?.rowCount ?? 0) > 0;
}

/**
 * Atomically reserve one classifier call against the owner's rolling-24h cap
 * AND move the row to 'classifying' (codex round-0 finding: quota reservation
 * must be a single conditional statement, not check-then-set). Rows counted:
 * the owner's classifier_called rows in the window, EXCLUDING this turn's own
 * row (so a re-claimed retry does not double-count itself). Returns true when
 * the reservation succeeded; false ⇒ the caller finalizes
 * 'skipped_rate_capped'.
 */
export function reserveChatCaptureClassifierQuota(input: {
  threadId: string;
  turnId: string;
  ownerUserId: string;
  cap?: number;
}): boolean {
  ensurePostgresSchema();
  const s = schemaIdent();
  const cap = input.cap ?? resolveChatCaptureDailyClassifierCap();
  const [res] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `UPDATE "${s}"."chat_capture_turns" AS t
          SET status = 'classifying', classifier_called = true, updated_at = now()
          WHERE t.thread_id = $1 AND t.turn_id = $2
            AND t.status IN ('claimed','classifying','error')
            AND (
              SELECT count(*) FROM "${s}"."chat_capture_turns" AS c
              WHERE c.owner_user_id = $3
                AND c.classifier_called
                AND c.created_at > now() - interval '24 hours'
                AND NOT (c.thread_id = $1 AND c.turn_id = $2)
            ) < $4
          RETURNING status`,
        values: [input.threadId, input.turnId, input.ownerUserId, cap],
      },
    ],
  });
  return (res?.rowCount ?? 0) > 0;
}

/**
 * Finalize the row (terminal statuses + 'error').
 *
 * A TERMINAL row is IMMUTABLE (the `status IN (<reclaimable>)` guard mirrors
 * claim's and reserve's reclaimable set): finalize only writes from a
 * non-terminal state (`claimed`/`classifying`/`error`). Once a turn is terminal
 * — `captured` or any `skipped_*` — no later finalize can overwrite it. This is
 * the completion of the terminal-immutability invariant with the matching guard
 * on reserveChatCaptureClassifierQuota (which likewise refuses to resurrect a
 * terminal row to `classifying`): together they close the duplicate-execution
 * corruption path where a stale re-delivery — one that CLAIMED before the first
 * execution captured (jobId dedup only suppresses while Redis retains the job) —
 * could downgrade a `captured` row and clobber its skill_id/revision_id
 * provenance. The deterministic skill id already prevents a duplicate skill;
 * these guards keep the provenance record intact.
 */
export function finalizeChatCaptureTurn(input: {
  threadId: string;
  turnId: string;
  status: Exclude<ChatCaptureTurnStatus, "claimed" | "classifying">;
  skillId?: string | null;
  revisionId?: string | null;
  detail?: string | null;
}): void {
  ensurePostgresSchema();
  const s = schemaIdent();
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `UPDATE "${s}"."chat_capture_turns"
          SET status = $3, skill_id = $4, revision_id = $5, detail = $6, updated_at = now()
          WHERE thread_id = $1 AND turn_id = $2
            AND status IN ('claimed','classifying','error')`,
        values: [
          input.threadId,
          input.turnId,
          input.status,
          input.skillId ?? null,
          input.revisionId ?? null,
          input.detail ?? null,
        ],
      },
    ],
  });
}

/** Read one ledger row (tests + operator debugging). */
export function readChatCaptureTurn(input: {
  threadId: string;
  turnId: string;
}): {
  status: string;
  ownerUserId: string;
  classifierCalled: boolean;
  skillId: string | null;
  revisionId: string | null;
  detail: string | null;
} | null {
  ensurePostgresSchema();
  const s = schemaIdent();
  const [res] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT status, owner_user_id, classifier_called, skill_id, revision_id, detail
          FROM "${s}"."chat_capture_turns" WHERE thread_id = $1 AND turn_id = $2 LIMIT 1`,
        values: [input.threadId, input.turnId],
      },
    ],
  });
  const row = res?.rows?.[0] as
    | {
        status?: unknown;
        owner_user_id?: unknown;
        classifier_called?: unknown;
        skill_id?: unknown;
        revision_id?: unknown;
        detail?: unknown;
      }
    | undefined;
  if (!row || typeof row.status !== "string") return null;
  return {
    status: row.status,
    ownerUserId: String(row.owner_user_id ?? ""),
    classifierCalled: row.classifier_called === true,
    skillId: typeof row.skill_id === "string" ? row.skill_id : null,
    revisionId: typeof row.revision_id === "string" ? row.revision_id : null,
    detail: typeof row.detail === "string" ? row.detail : null,
  };
}
