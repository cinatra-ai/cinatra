// Leaf module: enqueue-time reuse of a jobId whose previous job has SETTLED.
//
// Extracted from `background-jobs.ts` (cinatra#3033 ratchet slice) so the thin
// runtime module stays under its file-size ceiling. This is the whole of the
// `overwriteIfStale` concern — the guard, the state read, the removal and the
// not-atomic re-read — in one place, called from both `enqueueBackgroundJob`
// paths. This module has NO runtime deps: the BullMQ `Queue` arrives as a
// TYPE-ONLY import, so nothing here is pulled into the worker boot graph.
//
// WHY THE OPTION EXISTS. BullMQ's `add` is HSETNX-based: given a `jobId` that
// the queue still holds, it returns the RETAINED entry and enqueues nothing at
// all. The queue deliberately retains settled jobs (`removeOnComplete: 200` in
// `background-jobs.ts`), so any caller that re-uses one jobId across successive
// legs of the same workflow lost every leg after the first — which is how the
// setup-approval resume deadlocked a run at `queued` with no job, no trigger
// row and no error. (That caller now mints a per-leg id instead, because
// clearing a SETTLED entry cannot help a leg whose predecessor is still
// ACTIVE; this clear is the general fix, not that run's own.)
//
// WHY ONLY SETTLED JOBS. A LIVE job of that id (waiting / active / delayed /
// waiting-children / prioritized) is deliberately left alone. The id keeps its
// de-duplication meaning for a leg that is genuinely still in flight — that
// de-duplication is what a shared id is FOR.

import type { Queue } from "bullmq";

/**
 * Remove a SETTLED (completed / failed) job of `jobId` so a subsequent
 * `queue.add` of the same id actually enqueues. A no-op unless the caller asked
 * for it (`overwriteIfStale`) and actually named an id.
 *
 * The read and the removal are NOT atomic: the retained entry can be evicted by
 * `removeOnComplete`, or removed by another producer, between `getState()` and
 * `remove()` — and BullMQ's `Job.remove()` throws whenever its script reports
 * that nothing was removed. That disappearance is exactly the outcome this
 * function wants, so it is re-read and tolerated rather than raised into a
 * caller that has usually already committed a database transition. Only a job
 * that is still there AND still settled re-raises.
 */
export async function clearSettledJobForReuse(
  queue: Queue,
  overwriteIfStale: boolean | undefined,
  jobId: string | undefined,
): Promise<void> {
  if (!overwriteIfStale || !jobId) return;
  const existing = await queue.getJob(jobId);
  if (!existing) return;
  const state = await existing.getState();
  if (state !== "completed" && state !== "failed") return;
  try {
    await existing.remove();
  } catch (err) {
    const stillThere = await queue.getJob(jobId);
    if (!stillThere) return;
    const stillState = await stillThere.getState();
    if (stillState !== "completed" && stillState !== "failed") return;
    throw err;
  }
}
