import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, gt, lte, sql } from "drizzle-orm";
import {
  anthropicSkillLease,
  anthropicSkillSyncDb,
} from "@/lib/anthropic-skill-sync-store";

/**
 * Namespace-scoped DAO for `cinatra.anthropic_skill_lease`.
 *
 * A lease is the in-flight reference signal: a creation run resolving a synced
 * skill at dispatch records a short-lived lease on its (catalog_skill_id,
 * anthropic_version). EVERY operation is scoped to a single
 * (apiKeyFingerprint, environment) namespace — one Anthropic API key is shared
 * across worktree/clone/staging/prod, so the remote ids are NOT globally
 * unique and must never be the only filter.
 *
 * The GC engine's correctness anchor is the `stale_at` GRACE window, not the
 * lease (a dropped best-effort lease only DELAYS reclamation). The lease is a
 * tightening optimization + a hard pre-delete TOCTOU re-check.
 */

/**
 * Acquire a short-lived lease. Returns the random `lease_id` (callers MAY
 * release early via {@link releaseSkillLease}; not required — `expires_at`
 * self-reaps a crashed run). Best-effort at the call site: a failure here MUST
 * NOT break dispatch.
 */
export async function acquireSkillLease(
  apiKeyFingerprint: string,
  environment: string,
  input: {
    catalogSkillId: string;
    anthropicSkillId: string;
    anthropicVersion: string;
    ttlMs: number;
  },
): Promise<string> {
  const leaseId = randomUUID();
  await anthropicSkillSyncDb.insert(anthropicSkillLease).values({
    apiKeyFingerprint,
    environment,
    catalogSkillId: input.catalogSkillId,
    anthropicSkillId: input.anthropicSkillId,
    anthropicVersion: input.anthropicVersion,
    leaseId,
    acquiredAt: new Date(),
    expiresAt: new Date(Date.now() + input.ttlMs),
  });
  return leaseId;
}

/** Optional early release of a lease (TTL reaps it regardless). */
export async function releaseSkillLease(
  apiKeyFingerprint: string,
  environment: string,
  catalogSkillId: string,
  anthropicVersion: string,
  leaseId: string,
): Promise<void> {
  await anthropicSkillSyncDb
    .delete(anthropicSkillLease)
    .where(
      and(
        eq(anthropicSkillLease.apiKeyFingerprint, apiKeyFingerprint),
        eq(anthropicSkillLease.environment, environment),
        eq(anthropicSkillLease.catalogSkillId, catalogSkillId),
        eq(anthropicSkillLease.anthropicVersion, anthropicVersion),
        eq(anthropicSkillLease.leaseId, leaseId),
      ),
    );
}

/**
 * The GC guard: number of NON-expired leases on ANY version of an anthropic
 * skill in this namespace. `> 0` ⇒ GC must not reclaim the skill.
 */
export async function countActiveLeasesForSkill(
  apiKeyFingerprint: string,
  environment: string,
  anthropicSkillId: string,
): Promise<number> {
  const rows = await anthropicSkillSyncDb
    .select({ n: sql<number>`count(*)::int` })
    .from(anthropicSkillLease)
    .where(
      and(
        eq(anthropicSkillLease.apiKeyFingerprint, apiKeyFingerprint),
        eq(anthropicSkillLease.environment, environment),
        eq(anthropicSkillLease.anthropicSkillId, anthropicSkillId),
        gt(anthropicSkillLease.expiresAt, new Date()),
      ),
    );
  return rows[0]?.n ?? 0;
}

/**
 * Housekeeping: drop expired leases in this namespace (called at GC start so
 * the active-lease counts are tight). Namespace-scoped, never global.
 */
export async function pruneExpiredLeases(
  apiKeyFingerprint: string,
  environment: string,
): Promise<void> {
  await anthropicSkillSyncDb
    .delete(anthropicSkillLease)
    .where(
      and(
        eq(anthropicSkillLease.apiKeyFingerprint, apiKeyFingerprint),
        eq(anthropicSkillLease.environment, environment),
        lte(anthropicSkillLease.expiresAt, new Date()),
      ),
    );
}
