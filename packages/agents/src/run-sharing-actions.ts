"use server";

import { and, eq, ilike, isNull, notInArray, or } from "drizzle-orm";

import { isPlatformAdmin, requireAuthSession } from "@/lib/auth-session";
import {
  betterAuthDb,
  betterAuthUsers,
} from "@/lib/better-auth-db";

import {
  readAgentRunById,
  readRunCoOwners,
  addRunCoOwner as addRunCoOwnerStore,
  removeRunCoOwner as removeRunCoOwnerStore,
  clearRunRunBy as clearRunRunByStore,
} from "./store";
import type { AgentRunRecord } from "./store";
import type { AgentAuthPolicy } from "./auth-policy-types";

// ---------------------------------------------------------------------------
// Run Sharing server actions.
//
// Authorization sequence mirrors the permissions actions:
// session -> run-exists -> owner-or-admin (with orphan-runBy=null branch).
//
// Additional clause for add/remove: require effectivePolicy.allowRunSharing
// === true; reject with the distinct "sharing_disabled" code so the UI can
// disambiguate from a generic 403.
// ---------------------------------------------------------------------------

export type SharingCandidate = {
  id: string;
  name: string;
  email: string;
  image: string | null;
};

// Caller is the original run owner OR a co-owner OR a platform admin.
async function isOwnerOrCoOwnerOrAdmin(
  runBy: string | null,
  callerUserId: string,
  isAdmin: boolean,
  runId: string,
): Promise<boolean> {
  if (isAdmin) return true;
  if (runBy === callerUserId) return true;
  const coOwners = await readRunCoOwners(runId);
  return coOwners.some((c) => c.userId === callerUserId);
}

/**
 * Workspace-wide user search for the Add Co-owner Combobox.
 * Searches all Better Auth users, excludes the run owner and existing
 * co-owners, and returns max 20 results.
 *
 * Gates:
 *   - Owner-or-admin check (lines below) — callers without a relation to the
 *     run cannot enumerate workspace users via this action.
 *   - Run-existence check.
 * Scope:
 *   - Requires an active organization context but does not filter by org
 *     membership.
 *   - Empty query returns the first 20 users ordered by name.
 */
const DEFAULT_SHARING_PAGE_SIZE = 20;
const MAX_SHARING_PAGE_SIZE = 50;

export async function searchOrgMembersForSharing(
  runId: string,
  query: string,
  page?: { offset?: number; limit?: number },
): Promise<
  | { ok: true; results: SharingCandidate[]; hasMore: boolean }
  | { ok: false; error: string }
> {
  const requestedLimit = Math.min(
    Math.max(1, Math.floor(page?.limit ?? DEFAULT_SHARING_PAGE_SIZE)),
    MAX_SHARING_PAGE_SIZE,
  );
  const offset = Math.max(0, Math.floor(page?.offset ?? 0));
  const session = await requireAuthSession().catch(() => null);
  const userId = session?.user?.id ?? null;
  if (!userId) return { ok: false, error: "unauthorized" };

  // Fail closed when no active organization is selected. Without this guard
  // the action leaked workspace-wide user enumeration to sessions in an
  // indeterminate org context.
  const activeOrganizationId = session?.session?.activeOrganizationId ?? null;
  if (!activeOrganizationId) return { ok: false, error: "no_active_org" };

  const run = await readAgentRunById(runId);
  if (!run) return { ok: false, error: "not_found" };

  const isAdmin = isPlatformAdmin(session);
  if (!(await isOwnerOrCoOwnerOrAdmin(run.runBy, userId, isAdmin, runId))) {
    return { ok: false, error: "forbidden" };
  }

  // Exclude the run owner + the calling user + existing co-owners.
  // The calling user is not a meaningful co-owner candidate: adding self has
  // no authorization effect for owners and creates audit-noise rows for admins
  // where granted_by === user_id. On orphan runs (run.runBy === null), the
  // typeahead would otherwise show the admin themselves as a candidate.
  const existing = await readRunCoOwners(runId);
  const excludeIds = [run.runBy, userId, ...existing.map((c) => c.userId)].filter(
    (id): id is string => Boolean(id),
  );

  const trimmed = query.trim();
  const like = trimmed.length > 0
    ? `%${trimmed.replace(/[%_]/g, "\\$&")}%`
    : null;

  const rows = await betterAuthDb
    .select({
      id: betterAuthUsers.id,
      name: betterAuthUsers.name,
      email: betterAuthUsers.email,
      image: betterAuthUsers.image,
    })
    .from(betterAuthUsers)
    .where(
      and(
        excludeIds.length > 0
          ? notInArray(betterAuthUsers.id, excludeIds)
          : undefined,
        // Filter out assistant / bot accounts from the ownership typeahead.
        // `userType` is set to "assistant" for service accounts (chatgpt,
        // etc., registered via scripts/register-*-assistant.mts). Humans
        // either have `userType = "human"` or NULL; both should remain
        // visible.
        or(
          isNull(betterAuthUsers.userType),
          eq(betterAuthUsers.userType, "human"),
        ),
        like !== null
          ? or(
              ilike(betterAuthUsers.name, like),
              ilike(betterAuthUsers.email, like),
            )
          : undefined,
      ),
    )
    .orderBy(betterAuthUsers.name)
    // Over-fetch by one row to detect "has more" without a separate count
    // query. The extra row is sliced off before returning.
    .limit(requestedLimit + 1)
    .offset(offset);

  const hasMore = rows.length > requestedLimit;
  const trimmedRows = hasMore ? rows.slice(0, requestedLimit) : rows;

  return {
    ok: true,
    results: trimmedRows.map((r) => ({
      id: r.id,
      name: r.name ?? r.email ?? "Unknown",
      email: r.email ?? "",
      image: r.image,
    })),
    hasMore,
  };
}

/**
 * Add a co-owner to a run. Owner-or-admin gate + allowRunSharing clause.
 * Idempotent at the DB layer via ON CONFLICT DO NOTHING in the store helper.
 *
 * Verifies the target user is a member of the caller's active organization
 * before writing the row. Without this, a run owner could grant any user-id
 * (including users from another org or fabricated ids) co-owner status.
 * Since co-owners are included in enforceRunAccess, missing this check would
 * create a cross-org data-leak vector. The runtime check is mandatory; an FK
 * on run_co_owners.user_id is added as defense-in-depth (see drizzle-store.ts
 * + schema.ts).
 */
export async function addRunCoOwner(
  runId: string,
  targetUserId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireAuthSession().catch(() => null);
  const userId = session?.user?.id ?? null;
  if (!userId) return { ok: false, error: "unauthorized" };

  const run = await readAgentRunById(runId);
  if (!run) return { ok: false, error: "not_found" };

  const isAdmin = isPlatformAdmin(session);
  if (!(await isOwnerOrCoOwnerOrAdmin(run.runBy, userId, isAdmin, runId))) {
    return { ok: false, error: "forbidden" };
  }

  // When the run's effective auth policy disallows sharing, reject even for
  // owners/admins with the distinct "sharing_disabled" code so the UI can
  // disambiguate from a generic 403. Fail-closed against shape drift: only
  // explicit `true` permits sharing; any other value denies. readAgentRunById
  // always populates effectivePolicy (store.ts:1457-1466), so this is
  // defense-in-depth, not a fallback path.
  const effectivePolicy = (run as AgentRunRecord & {
    effectivePolicy: AgentAuthPolicy | null;
  }).effectivePolicy;
  if (effectivePolicy?.allowRunSharing !== true) {
    return { ok: false, error: "sharing_disabled" };
  }

  // Verify the target both EXISTS and is eligible (human user, not an
  // assistant / bot account) before writing the co-owner row. The
  // search-candidates endpoint already filters out assistants; this clause
  // replays the same predicate on the direct-add path so a caller can't bypass
  // the typeahead and grant an assistant account co-owner status by posting a
  // known id. NULL userType rows are treated as human, matching the search
  // filter.
  const [targetUser] = await betterAuthDb
    .select({ id: betterAuthUsers.id })
    .from(betterAuthUsers)
    .where(
      and(
        eq(betterAuthUsers.id, targetUserId),
        or(
          isNull(betterAuthUsers.userType),
          eq(betterAuthUsers.userType, "human"),
        ),
      ),
    )
    .limit(1);
  if (!targetUser) return { ok: false, error: "user_not_found" };

  await addRunCoOwnerStore(runId, targetUserId, userId);
  return { ok: true };
}

/**
 * Remove a co-owner from a run. Owner-or-admin gate ONLY; the
 * allowRunSharing flag deliberately does NOT gate removal so existing
 * co-owners can always be cleaned up after sharing has been turned off
 * (idempotent: the underlying DELETE matches zero or one row).
 *
 * Cleanup must always be possible. If removal were gated by allowRunSharing,
 * turning sharing off would make existing co-owner rows impossible to remove
 * through this action.
 */
export async function removeRunCoOwner(
  runId: string,
  targetUserId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireAuthSession().catch(() => null);
  const userId = session?.user?.id ?? null;
  if (!userId) return { ok: false, error: "unauthorized" };

  const run = await readAgentRunById(runId);
  if (!run) return { ok: false, error: "not_found" };

  const isAdmin = isPlatformAdmin(session);
  if (!(await isOwnerOrCoOwnerOrAdmin(run.runBy, userId, isAdmin, runId))) {
    return { ok: false, error: "forbidden" };
  }

  // Last-owner guard: at least one owner must remain after the remove.
  // Total owners = (run.runBy ? 1 : 0) + co-owners.length
  const coOwners = await readRunCoOwners(runId);
  const isTargetCoOwner = coOwners.some((c) => c.userId === targetUserId);
  if (!isTargetCoOwner) {
    // No-op delete; nothing to remove
    return { ok: true };
  }
  const ownersAfter = (run.runBy ? 1 : 0) + (coOwners.length - 1);
  if (ownersAfter < 1) {
    return { ok: false, error: "last_owner" };
  }

  await removeRunCoOwnerStore(runId, targetUserId);
  return { ok: true };
}

/**
 * Remove the original run owner (clears agent_runs.run_by). Allowed only when
 * at least one co-owner remains, so the run never becomes ownerless via the UI.
 */
export async function removeRunOwner(
  runId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireAuthSession().catch(() => null);
  const userId = session?.user?.id ?? null;
  if (!userId) return { ok: false, error: "unauthorized" };

  const run = await readAgentRunById(runId);
  if (!run) return { ok: false, error: "not_found" };

  const isAdmin = isPlatformAdmin(session);
  if (!(await isOwnerOrCoOwnerOrAdmin(run.runBy, userId, isAdmin, runId))) {
    return { ok: false, error: "forbidden" };
  }

  if (run.runBy === null) {
    // Already cleared
    return { ok: true };
  }

  const coOwners = await readRunCoOwners(runId);
  if (coOwners.length < 1) {
    return { ok: false, error: "last_owner" };
  }

  await clearRunRunByStore(runId);
  return { ok: true };
}
