// Retroactive DORMANT-HISTORY durable-content purge (cinatra#1037 P5.6 PR2
// CUTOVER, codex decision-3 — the drop-history invariant).
//
// RELOCATED from the retired src/lib/assistant-thread-mirror-backfill.ts: the
// one-shot boot mirror backfill it lived beside was DELETED in the PR2 write
// cutover (the structured mirror is now the sole writer, so there is no dormant
// legacy corpus left to shadow). This purge survives because it cleans up the
// durable `legacy:` content a PRE-guard boot backfill may ALREADY have copied in
// a deployed database — it is wired to the cutover-marker timestamp as a
// Migrate+Verify production step, independent of the (now-gone) backfill pass.
//
// cinatra#2365 (the drop-history invariant purging EVERY pre-existing thread on
// a first upgrade): on a database upgrading across the cutover for the first
// time, EVERY pre-existing thread's `updated_at` necessarily predates the
// cutover marker's own activation instant — the marker is stamped `now()` by
// the cutover migration (core__0066), not a genuinely historical dormancy
// boundary. Passing that same marker value as `beforeUpdatedAt` (the naive,
// documented-above production recipe) therefore classifies the caller's ENTIRE
// account history as "dormant" and nulls it in one pass, even though none of it
// has had a chance to be touched since the upgrade. Two changes close this:
//   1. A destructive purge now refuses a `beforeUpdatedAt` that is not
//      STRICTLY EARLIER than the recorded `assistant_cutover_marker.cutover_at`
//      (see `assertCutoffPredatesCutoverMarker` below) — the exact "cutover
//      marker == migration timestamp" footgun fails closed instead of wiping
//      every thread.
//   2. `restoreDurableContentFromChatThreads` — a companion REPAIR pass that
//      re-hydrates `assistant_turns.content` from the surviving legacy
//      `chat_threads.payload` for any thread whose structured content is
//      missing, restoring an already-affected instance's `/chat` list without
//      requiring the (still-intact) legacy row to be read anywhere else.
//
// FOLLOW-UP (live-verified on a real dev-instance DB copy): content repair
// alone was NOT sufficient — the flat `/chat` panel (`fetchChatThreads`,
// packages/chat/src/actions.ts) is additionally ORG-SCOPED per the #134
// audience contract (`listAssistantThreadSummariesForOwnerInOrg` requires
// `org_id = activeOrganizationId`). Legacy threads that predate organizations
// carry `org_id IS NULL`, so even with content restored they stay invisible to
// the owner-scoped panel (though the admin `/api/assistants/threads` path,
// which bypasses the org scope for a platform admin, already surfaced them —
// that path was never the bug). `restoreDurableContentFromChatThreads` now
// ALSO adopts an owner-having, org-null legacy thread into that owner's
// organization, but ONLY when the owner's `public.member` membership is
// UNAMBIGUOUS (exactly one org) — a zero- or multi-org owner is left
// unadopted rather than guessed at, and counted in the result.

import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";
import { buildAssistantThreadMirrorQueries } from "@/lib/project-inheritance";
import { safeParseJson } from "@/lib/database-metadata";

function schemaIdent(): string {
  return postgresSchema.replaceAll('"', '""');
}

/** Read the cutover marker's own recorded activation instant, or `null` when
 *  the marker row does not (yet) exist — i.e. the drop-history cutover has not
 *  happened on this database at all. Read-only (no raw DML verb), so it never
 *  touches the module's pinned raw-DML-site count. */
function readCutoverMarkerActivatedAt(): string | null {
  const schema = schemaIdent();
  const [res] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT cutover_at FROM "${schema}"."assistant_cutover_marker" LIMIT 1`,
        values: [],
      },
    ],
  });
  const row = res?.rows?.[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const v = row.cutover_at;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") return v;
  return null;
}

/**
 * Fail closed on the cinatra#2365 first-upgrade footgun: a destructive purge's
 * `beforeUpdatedAt` cutoff must be STRICTLY EARLIER than the cutover marker's
 * own `cutover_at` (when the marker exists). Equal-or-later means the caller
 * is (naively or not) using the marker's own just-stamped activation instant —
 * or something even later — as the dormancy cutoff, which classifies every
 * pre-existing thread as dormant on a first upgrade. A marker-less database
 * (cutover not yet activated) has no boundary to compare against and is left
 * to the existing unbounded-cutoff guard.
 */
function assertCutoffPredatesCutoverMarker(before: string): void {
  const markerAt = readCutoverMarkerActivatedAt();
  if (markerAt === null) return;
  const cutoffMs = Date.parse(before);
  const markerMs = Date.parse(markerAt);
  if (!Number.isFinite(cutoffMs) || !Number.isFinite(markerMs)) return;
  if (cutoffMs >= markerMs) {
    throw new Error(
      `purgeBackfilledDormantContentTurns: beforeUpdatedAt (${before}) is not strictly earlier than the cutover marker's own cutover_at (${markerAt}) — refusing a first-upgrade purge that would classify every pre-existing thread as dormant (cinatra#2365). Pass a cutoff that genuinely predates the cutover.`,
    );
  }
}

export type DormantContentPurgeResult = {
  /** Count of legacy-mirror content turns in scope (the audit number). */
  auditedContentTurns: number;
  /** Rows whose durable content was nulled (0 on a dry run). */
  purged: number;
  dryRun: boolean;
};

/**
 * Audit (and optionally purge) DORMANT-HISTORY durable content that a PRE-guard
 * boot backfill may have copied into `legacy:` content turns (cinatra#1037 P5.6
 * PR2 CUTOVER, codex decision-3 — the drop-history invariant).
 *
 * Before the (now-removed) `stripTurnContent` guard landed, the dormant-thread
 * boot backfill reused the (post-EXPAND) contentful mirror projection and could
 * copy a pre-cutover thread's message history into durable `legacy:` content
 * turns — making a thread that must DROP wrongly re-appear as post-cutover
 * content. This helper finds those rows and, when `dryRun` is false, NULLs their
 * durable content + ordinal so the thread falls back out of the content-presence
 * gate (the drop-history exclusion), exactly as if it had never been backfilled.
 *
 * SCOPE (fail-safe): only `legacy:`-namespaced, run_id-NULL, content-bearing
 * turns are ever touched — a runtime-native turn (bare UUID / run_id set) can
 * never be reached. `beforeUpdatedAt` (RECOMMENDED for production) restricts the
 * purge to threads not modified since a cutoff — i.e. genuinely dormant
 * pre-cutover threads — so an actively-conversing thread's live durable history
 * is never nulled. The production cutoff is the cutover-marker timestamp.
 * Omitting it audits/purges the WHOLE legacy-mirror content set and MUST NOT be
 * run destructively in production (a lane-DB / test-corpus audit only).
 *
 * DEFAULT dryRun=true — the caller must OPT IN to the destructive purge.
 */
export function purgeBackfilledDormantContentTurns(options?: {
  dryRun?: boolean;
  /** ISO timestamp: restrict to threads whose `updated_at` is strictly before
   *  this (the pre-cutover dormancy cutoff). Omit to scope the whole set. */
  beforeUpdatedAt?: string | null;
}): DormantContentPurgeResult {
  const dryRun = options?.dryRun ?? true;
  const before = options?.beforeUpdatedAt ?? null;
  // A DESTRUCTIVE purge MUST be cutoff-bounded (codex convergence): without a
  // `beforeUpdatedAt` the scope predicate degenerates to "$1 IS NULL → every
  // legacy-mirror content turn", which would null an actively-conversing
  // thread's live durable history. The unbounded form is permitted ONLY for a
  // dry-run AUDIT (count). Fail-closed — guard FIRST, before any DB touch
  // (ensurePostgresSchema itself may hit Postgres on a cold path).
  if (!dryRun && before === null) {
    throw new Error(
      "purgeBackfilledDormantContentTurns: a destructive purge (dryRun:false) requires an explicit beforeUpdatedAt cutoff — refusing an unbounded content wipe.",
    );
  }
  ensurePostgresSchema();
  const schema = schemaIdent();

  // cinatra#2365: a destructive purge additionally refuses a cutoff that is
  // not strictly before the cutover marker's own activation instant — see
  // assertCutoffPredatesCutoverMarker's header. Checked AFTER ensurePostgresSchema
  // (it reads the marker table) but BEFORE the audit/purge queries, so a
  // first-upgrade misuse never touches assistant_turns at all.
  if (!dryRun && before !== null) {
    assertCutoffPredatesCutoverMarker(before);
  }

  // Scope predicate: legacy-mirror content turns, optionally restricted to
  // threads dormant since the cutoff. Parameter $1 is the cutoff (or NULL → no
  // time restriction). The join keys the cutoff on the OWNING thread's
  // updated_at, so a per-turn timestamp can never widen the scope.
  const scope = `t.id LIKE 'legacy:%'
       AND t.run_id IS NULL
       AND t.content IS NOT NULL
       AND ($1::timestamptz IS NULL OR th.updated_at < $1::timestamptz)`;

  const [auditRes] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT count(*)::int AS n
               FROM "${schema}"."assistant_turns" t
               JOIN "${schema}"."assistant_threads" th ON th.id = t.thread_id
               WHERE ${scope}`,
        values: [before],
      },
    ],
  });
  const auditedContentTurns = Number(
    (auditRes?.rows?.[0] as Record<string, unknown> | undefined)?.n ?? 0,
  );

  if (dryRun || auditedContentTurns === 0) {
    return { auditedContentTurns, purged: 0, dryRun };
  }

  const [purgeRes] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    transaction: true,
    queries: [
      {
        text: `UPDATE "${schema}"."assistant_turns" t
               SET content = NULL, ordinal = NULL, updated_at = now()
               FROM "${schema}"."assistant_threads" th
               WHERE th.id = t.thread_id AND ${scope}`,
        values: [before],
      },
    ],
  });
  const purged = Number(
    (purgeRes as { rowCount?: number } | undefined)?.rowCount ?? auditedContentTurns,
  );
  return { auditedContentTurns, purged, dryRun: false };
}

// ---------------------------------------------------------------------------
// REPAIR (cinatra#2365): re-hydrate a thread's structured-store content from
// the surviving legacy `chat_threads.payload`, for threads whose durable
// `legacy:` mirror turns carry NO content at all — whether because this purge
// (or an earlier PRE-guard backfill gap) nulled/never-populated it. The legacy
// row is never dropped by this cutover (that is PR3), so its `payload` remains
// a faithful backup as long as it exists; this is the "Recovery note" one-off
// backfill the issue describes made into a real, idempotent, re-runnable op.
// ---------------------------------------------------------------------------

/**
 * Find thread ids whose structured mirror carries NO durable `/chat` content
 * (no `legacy:`-namespaced, run_id-NULL turn with non-NULL content) but which
 * DO have a surviving `chat_threads` row with a non-null payload to restore
 * from. Read-only (no raw DML verb) — safe to call at any time, including
 * dry-run reporting.
 */
export function findLegacyThreadIdsMissingDurableContent(): string[] {
  ensurePostgresSchema();
  const schema = schemaIdent();
  const [res] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT at.id
               FROM "${schema}"."assistant_threads" at
               JOIN "${schema}"."chat_threads" ct ON ct.id = at.id
               WHERE ct.payload IS NOT NULL
                 AND NOT EXISTS (
                   SELECT 1 FROM "${schema}"."assistant_turns" t
                   WHERE t.thread_id = at.id
                     AND t.content IS NOT NULL
                     AND t.run_id IS NULL
                     AND t.id LIKE 'legacy:%'
                 )`,
        values: [],
      },
    ],
  });
  return (res?.rows ?? []).map((r) => String((r as Record<string, unknown>).id));
}

/** An owner-having, org-null legacy thread — an org-adoption candidate. */
export type OrgAdoptionCandidate = {
  threadId: string;
  ownerUserId: string;
};

/**
 * Find legacy-origin threads that HAVE an owner but no org anchor
 * (`org_id IS NULL`) — the set the #134 org-scoped `/chat` panel
 * (`fetchChatThreads` -> `listAssistantThreadSummariesForOwnerInOrg`) can
 * never surface no matter how much durable content they carry, because that
 * path requires `org_id = activeOrganizationId`. Scoped to `origin =
 * 'legacy-chat'` so a deliberately org-less assistant-native thread (if one
 * ever exists) is never touched. Read-only (no raw DML verb).
 */
export function findLegacyThreadIdsMissingOrgAdoption(): OrgAdoptionCandidate[] {
  ensurePostgresSchema();
  const schema = schemaIdent();
  const [res] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT id, owner_user_id
               FROM "${schema}"."assistant_threads"
               WHERE owner_user_id IS NOT NULL
                 AND org_id IS NULL
                 AND origin = 'legacy-chat'`,
        values: [],
      },
    ],
  });
  return (res?.rows ?? []).map((r) => {
    const row = r as Record<string, unknown>;
    return { threadId: String(row.id), ownerUserId: String(row.owner_user_id) };
  });
}

/** The distinct organizations `ownerUserId` belongs to, via Better Auth's
 *  `public.member` (fixed schema — organization membership is never
 *  per-app-schema). Read-only. */
function ownerOrganizationIds(ownerUserId: string): string[] {
  const [res] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT DISTINCT "organizationId" FROM public."member" WHERE "userId" = $1`,
        values: [ownerUserId],
      },
    ],
  });
  return (res?.rows ?? []).map((r) => String((r as Record<string, unknown>).organizationId));
}

/**
 * Adopt org-null owned legacy threads into their owner's organization,
 * UNAMBIGUOUSLY ONLY: an owner belonging to exactly one organization gets
 * their org-null threads adopted into it; an owner belonging to zero or
 * multiple organizations is left unadopted (never guessed) and counted as
 * `skippedAmbiguous`. `dryRun` classifies (read-only) without writing —
 * `adopted` stays 0, `skippedAmbiguous` still reports the real classification
 * since it requires no mutation to compute. Per-owner membership is cached
 * across candidates sharing the same owner (a single owner's whole legacy
 * history is the common case) to avoid redundant lookups.
 */
function adoptOrgNullOwnedLegacyThreads(dryRun: boolean): {
  adopted: number;
  skippedAmbiguous: number;
} {
  const candidates = findLegacyThreadIdsMissingOrgAdoption();
  if (candidates.length === 0) return { adopted: 0, skippedAmbiguous: 0 };

  const schema = schemaIdent();
  const orgIdsByOwner = new Map<string, string[]>();
  let adopted = 0;
  let skippedAmbiguous = 0;
  for (const { threadId, ownerUserId } of candidates) {
    let orgIds = orgIdsByOwner.get(ownerUserId);
    if (orgIds === undefined) {
      orgIds = ownerOrganizationIds(ownerUserId);
      orgIdsByOwner.set(ownerUserId, orgIds);
    }
    if (orgIds.length !== 1) {
      // Zero orgs (not yet a member anywhere) or multiple orgs (which one?)
      // — no unambiguous adoption target. Never guess.
      skippedAmbiguous += 1;
      continue;
    }
    if (dryRun) continue; // would-adopt; nothing written in a dry run

    runPostgresQueriesSync({
      connectionString: getPostgresConnectionString(),
      transaction: true,
      queries: [
        {
          // org_id is SET-ONCE elsewhere in this codebase (never reassigned
          // once non-null) — the `org_id IS NULL` guard mirrors that here.
          text: `UPDATE "${schema}"."assistant_threads" SET org_id = $2 WHERE id = $1 AND org_id IS NULL`,
          values: [threadId, orgIds[0]],
        },
      ],
    });
    adopted += 1;
  }
  return { adopted, skippedAmbiguous };
}

export type RestoreDurableContentResult = {
  /** Threads found with missing structured content AND a surviving legacy backup. */
  auditedThreads: number;
  /** Threads whose structured content was actually re-hydrated (0 on a dry run). */
  restored: number;
  /** Org-null owned legacy threads adopted into their owner's sole org (0 on a dry run). */
  adopted: number;
  /** Org-null owned legacy threads left unadopted: their owner belongs to zero or multiple orgs. */
  skippedAmbiguous: number;
  dryRun: boolean;
};

/**
 * Restore durable `/chat` content for threads whose structured mirror lost it
 * (cinatra#2365) by re-running the SAME self-backfilling mirror projection
 * (`buildAssistantThreadMirrorQueries`) that every legacy chat-thread write
 * already composes — sourced from the surviving `chat_threads.payload` instead
 * of a live request body. Idempotent: `ON CONFLICT (id) DO UPDATE` on the mirror
 * turns means re-running this against an already-restored thread is a no-op.
 *
 * DEFAULT dryRun=true (matches purgeBackfilledDormantContentTurns's contract):
 * the caller must opt in to writing. A malformed/unparseable payload is
 * skipped defensively (chat_threads.payload is arbitrary historical JSON) —
 * never lets one bad row abort the whole repair pass.
 *
 * ALSO runs the org-adoption step (`adoptOrgNullOwnedLegacyThreads` — see the
 * module header's FOLLOW-UP note): content restoration alone does not make a
 * pre-organization legacy thread visible in the org-scoped `/chat` panel, so
 * this is required for AC1 ("an owner still sees their pre-existing threads
 * in /chat"). Runs independently of content restoration (an org-null thread
 * that never lost its content still needs adopting) and, like content
 * restoration, only classifies (never writes) in a dry run.
 */
export function restoreDurableContentFromChatThreads(options?: {
  dryRun?: boolean;
}): RestoreDurableContentResult {
  const dryRun = options?.dryRun ?? true;
  const threadIds = findLegacyThreadIdsMissingDurableContent();
  const { adopted, skippedAmbiguous } = adoptOrgNullOwnedLegacyThreads(dryRun);

  if (dryRun || threadIds.length === 0) {
    return { auditedThreads: threadIds.length, restored: 0, adopted, skippedAmbiguous, dryRun };
  }

  ensurePostgresSchema();
  const schema = schemaIdent();
  let restored = 0;
  for (const threadId of threadIds) {
    const [payloadRes] = runPostgresQueriesSync({
      connectionString: getPostgresConnectionString(),
      queries: [
        {
          text: `SELECT payload FROM "${schema}"."chat_threads" WHERE id = $1 LIMIT 1`,
          values: [threadId],
        },
      ],
    });
    const rawPayload = (payloadRes?.rows?.[0] as Record<string, unknown> | undefined)?.payload;
    if (typeof rawPayload !== "string") continue; // no surviving legacy row — nothing to restore from
    const parsed = safeParseJson<Record<string, unknown> | null>(rawPayload, null);
    if (parsed === null || typeof parsed !== "object") continue; // defensive: corrupt legacy payload

    const thread = { ...parsed, id: threadId };
    const queries = buildAssistantThreadMirrorQueries({
      schemaName: postgresSchema,
      thread,
      explicitMirrorOrgId: null, // org_id is SET-ONCE on the mirror — never clobbers an established anchor
    });
    runPostgresQueriesSync({
      connectionString: getPostgresConnectionString(),
      transaction: true,
      queries,
    });
    restored += 1;
  }
  return { auditedThreads: threadIds.length, restored, adopted, skippedAmbiguous, dryRun: false };
}
