import "server-only";

import { createHash } from "node:crypto";

/** Minimal task shape the review-packet hash reads (structurally satisfied by
 *  the full workflow_task row). */
export type ReviewPacketTask = { id: string; key: string; title: string };

/**
 * Stable hash of an approval's "review packet" — the gating task's identity
 * (key + title) + its approver scope + its upstream dependencies (keys,
 * outcomes, upstream titles). When any of these change after the approval
 * opened, the prior sign-off is for different content and the approval is
 * stale. Deps are sorted so the hash is order-independent.
 *
 * Shared by the reconciler (G9 staleness on ACTIVE workflows) and the store's
 * paused diff-apply (which must apply the same staleness check synchronously,
 * because the reconciler never runs on a paused workflow).
 */
export function computeReviewPacketHash(
  task: ReviewPacketTask,
  requiredScope: unknown,
  deps: Array<{ taskId: string; dependsOnTaskId: string; outcome?: string | null }>,
  taskById: ReadonlyMap<string, ReviewPacketTask>,
  keyById: ReadonlyMap<string, string>,
): string {
  const edges = deps
    .filter((d) => d.taskId === task.id)
    .map((d) => ({
      on: keyById.get(d.dependsOnTaskId) ?? d.dependsOnTaskId,
      outcome: d.outcome ?? "success",
      upstreamTitle: taskById.get(d.dependsOnTaskId)?.title ?? null,
    }))
    .sort((a, b) => a.on.localeCompare(b.on));
  const packet = { key: task.key, title: task.title, requiredScope: requiredScope ?? null, deps: edges };
  return createHash("sha256").update(JSON.stringify(packet)).digest("hex");
}
