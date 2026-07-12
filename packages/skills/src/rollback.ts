import "server-only";

import { revalidatePath } from "next/cache";

import {
  readSkillCatalogFromDatabase,
  applySkillRollbackInDatabase,
  readSkillActiveRevisionFromDatabase,
  readSkillRevisionContentForRollback,
} from "@/lib/database";
import type { ActorContext } from "@/lib/authz";

import { buildSkillSourceForWrite, buildRevisionRecord, isCustomOrPersonalSkillPayload } from "./skill-source";
import type { PersistedSkill } from "./skills-store";

// Content-authority rollback for custom/personal skills (cinatra#1362). Kept in
// its own leaf (not the skills-store bottleneck): the orchestrator is reached
// only by its callers (a later render-held rollback surface) + its tests — never
// from the request routes — so it adds no reachable route-graph node.

export interface RollbackCustomSkillResult {
  skillId: string;
  /** The new immutable `rollback` revision that is now the active head. */
  newRevisionId: string;
  /** The prior revision whose exact content was restored. */
  restoredFromRevisionId: string;
  /** The restored content's digest (equals the target revision's digest). */
  contentDigest: string;
}

/**
 * Roll a custom/personal skill's content back to a prior revision's EXACT
 * content (cinatra#1362). A forward-only content write: it records a NEW
 * `rollback` revision restoring the target's content and re-points the single
 * mutable active head at it. It NEVER mutates or deletes history.
 *
 * Fail-closed at every step:
 *  - AUTHORIZATION is the trusted "manage" check (requireResourceAccess) derived
 *    from the PERSISTED skill (level/scope) + the caller's session ActorContext
 *    — never a caller-supplied owner/role flag (throws AuthzError on deny,
 *    before any DB read of the target or any write).
 *  - the target revision must BELONG to the skill and resolve to DURABLE content
 *    (a revision with no stored blob — a legacy / untruthful head — is rejected:
 *    content authority never restores content whose digest it cannot verify).
 *  - the write is an active-pointer COMPARE-AND-SWAP: if a concurrent edit or
 *    rollback advanced the head between our read and our write, the swap is a
 *    no-op and we throw, never silently reverting the concurrent write.
 *
 * This is the AUTHORITATIVE (DB) write; the on-disk SKILL.md projection
 * reconciles on the read-side cutover / the skill's next content write (a later
 * lifecycle slice), so rollback does not itself touch disk. On success it fires
 * the standard re-match hook (`enqueueInlineForSkill`) + `/skills` revalidation
 * — the same post-write hooks a normal edit fires.
 */
export async function rollbackCustomSkill(input: {
  skillId: string;
  /** The prior revision whose content to restore. */
  targetRevisionId: string;
  /** The trusted session-derived caller identity — NOT caller-asserted roles. */
  actor: ActorContext;
}): Promise<RollbackCustomSkillResult> {
  const { skillId, targetRevisionId, actor } = input;

  // 1. Load the PERSISTED skill row (the authority for content + level/scope).
  //    Read the raw DB catalog (no disk-sync side effects).
  const existing = readSkillCatalogFromDatabase().skills.find(
    (s) => (s as { id?: string }).id === skillId,
  ) as PersistedSkill | undefined;
  if (!existing) {
    throw new Error(`rollback: skill not found: ${skillId}`);
  }
  // Only custom/personal skills carry lifecycle authority here; extension /
  // legacy rows have no revision history to roll back.
  if (!isCustomOrPersonalSkillPayload(existing)) {
    throw new Error(`rollback: ${skillId} is not a custom/personal skill`);
  }

  // 2. AUTHORIZE against the persisted resource + the trusted actor. Uses the
  //    same chokepoint as the edit path; throws AuthzError when denied. Derived
  //    from persisted (level, scope) — never a caller-supplied flag.
  const { requireResourceAccess, buildSkillResourceRef } = await import(
    "@cinatra-ai/agents/auth-policy"
  );
  requireResourceAccess(
    actor,
    buildSkillResourceRef({
      id: existing.id,
      level: existing.level ?? "personal",
      scope: existing.scope ?? null,
    }),
    "manage",
  );

  // 3. Resolve the current active head (the CAS guard) + the target revision's
  //    authoritative content (fail-closed on a foreign/blob-less revision).
  const head = readSkillActiveRevisionFromDatabase(skillId);
  const expectedActiveRevisionId = head?.activeRevisionId ?? null;
  if (!expectedActiveRevisionId) {
    throw new Error(`rollback: ${skillId} has no established active revision`);
  }
  const target = readSkillRevisionContentForRollback(skillId, targetRevisionId);
  if (!target) {
    throw new Error(
      `rollback: revision ${targetRevisionId} does not belong to skill ${skillId}`,
    );
  }
  if (target.contentDigest == null || target.content == null) {
    throw new Error(
      `rollback: revision ${targetRevisionId} has no durable content to restore — content authority cannot verify it`,
    );
  }
  const restoredContent = target.content;

  // 4. Build the restored payload: content swapped to the target's, the
  //    SkillSource digest recomputed (it equals target.contentDigest), all other
  //    metadata (name/description/owner/policy/sourcePath) preserved — a rollback
  //    restores CONTENT, not the whole historical row.
  const restoredSource =
    buildSkillSourceForWrite({
      packageId: existing.packageId,
      packageName: existing.packageName,
      packageSlug: existing.packageSlug,
      sourcePath: existing.sourcePath,
      scope: existing.isCustomSkill ? existing.ownerUserId : existing.scope,
      isCustomSkill: existing.isCustomSkill || undefined,
      content: restoredContent,
    }) ??
    existing.source ??
    null;
  const restoredSkill: PersistedSkill = {
    ...existing,
    content: restoredContent,
    source: restoredSource,
    updatedAt: new Date().toISOString(),
  };

  // 5. Build the immutable rollback revision (pure policy validates the
  //    rollback-provenance biconditional: source='rollback' ⇔ restoresRevisionId).
  const revision = buildRevisionRecord({
    skillId,
    contentDigest: target.contentDigest,
    source: "rollback",
    restoresRevisionId: targetRevisionId,
    authorUserId: actor.principalId ?? null,
  });

  // 6. Atomic compare-and-swap write. changed=false ⇒ the head moved under us.
  const { changed } = applySkillRollbackInDatabase({
    skillId,
    expectedActiveRevisionId,
    newRevisionId: revision.id,
    targetRevisionId,
    restoredContent,
    restoredContentDigest: target.contentDigest,
    restoredPayloadJson: JSON.stringify(restoredSkill),
    authorUserId: revision.authorUserId,
  });
  if (!changed) {
    throw new Error(
      `rollback: ${skillId} active revision moved concurrently (expected ${expectedActiveRevisionId}) — not applied`,
    );
  }

  // 7. Fire the standard re-match + revalidation hooks a normal edit fires —
  //    matching re-evaluates against the now-authoritative rolled-back content.
  try {
    const { enqueueInlineForSkill } = await import("./llm-matching/event-hooks");
    await enqueueInlineForSkill(skillId);
  } catch (err) {
    console.warn(
      `[skills] rollback re-match enqueue failed for ${skillId}:`,
      err instanceof Error ? err.message : err,
    );
  }
  try {
    revalidatePath("/skills");
  } catch {
    /* best-effort: non-RSC contexts (boot/instrumentation) lack the store */
  }

  return {
    skillId,
    newRevisionId: revision.id,
    restoredFromRevisionId: targetRevisionId,
    contentDigest: target.contentDigest,
  };
}
