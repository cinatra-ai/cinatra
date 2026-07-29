import "server-only";

/**
 * BOOT-ONLY runtime bindings for the upload-on-install reconcile
 * (cinatra#2092, epic #2086 S5).
 *
 * Two seams, both bound here rather than imported at their use sites, for the
 * route-graph ratchet (the same posture as `register-cms-review-host-seam-runtime`
 * and the `background-jobs-registry` runner slots):
 *
 *   1. the DRAIN runner slot — the drain core reaches the Anthropic sync/GC
 *      services and the `@cinatra-ai/llm` engine graph, which must not be
 *      reachable (even dynamically) from `background-jobs-registry`;
 *   2. the COMMIT KICK slot — the kick enqueues a BullMQ job, and
 *      `@/lib/database` (a synchronous hub in the locked dev-perf routes' graph)
 *      must not reach the background-jobs runtime.
 *
 * Keeping the one-shot kick's `enqueueBackgroundJob(...)` call in THIS module
 * (not in `boot/phases/system-loops.ts`) is also what keeps it out of the
 * perpetual-system-loops gate's boot-SEED scan: every enqueue in the phase file
 * is read as a boot-seeded recurring loop, and this kick is deliberately a
 * one-shot with no canonical loop id.
 *
 * Idempotent — last write wins; safe to call on every boot.
 */
export async function bindAnthropicSkillReconcileRuntime(): Promise<void> {
  const { registerAnthropicSkillReconcileRunner } = await import(
    "@/lib/background-jobs-registry"
  );
  const { runAnthropicSkillUploadReconcile } = await import(
    "@/lib/anthropic-skill-reconcile-service"
  );
  registerAnthropicSkillReconcileRunner({
    drain: (options) => runAnthropicSkillUploadReconcile(options),
  });

  const { registerAnthropicSkillReconcileKick } = await import(
    "@/lib/skill-lifecycle-store"
  );
  registerAnthropicSkillReconcileKick(async () => {
    const { enqueueBackgroundJob, BACKGROUND_JOB_NAMES } = await import(
      "@/lib/background-jobs"
    );
    // ANONYMOUS job id on purpose. A stable id would be silently dropped by the
    // queue's dedup while an earlier kick is still queued — exactly the
    // promptness this seam exists to provide. Running several is safe: the
    // drain claims outbox rows atomically and the namespace + catalog-digest
    // idempotency key collapses duplicates into a single engine run.
    await enqueueBackgroundJob(
      BACKGROUND_JOB_NAMES.ANTHROPIC_SKILL_UPLOAD_RECONCILE,
      {},
      { inheritActorContext: false },
    );
  });
}
