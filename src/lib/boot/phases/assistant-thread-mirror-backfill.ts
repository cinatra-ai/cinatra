// Dormant assistant-thread mirror backfill boot phase (cinatra#1218, epic
// #1216 S2 — cutover-owned data residual 2 on the issue).
//
// The P2b lockstep mirror self-backfills only threads that receive a write;
// this phase mirrors the DORMANT legacy chat_threads (no structured shadow
// yet) so the structured store covers the whole corpus before the S2 delete
// stage retires the legacy write path. Reuses the P2b builders verbatim —
// set-once org anchor, `legacy:` turn namespace, no content copy, no
// fabricated run_id (see src/lib/assistant-thread-mirror-backfill.ts).
//
// `retryable`: a failure must never abort boot — the pass is idempotent
// (the dormancy predicate converges), soft-failing per thread, and simply
// retries next boot. Kill switch: CINATRA_ASSISTANT_THREAD_BACKFILL=off.
//
// Deliberately NOT importing "server-only": unit tests import the phase list.

import type { BootPhase } from "@/lib/boot/boot-phase";

export function assistantThreadMirrorBackfillPhases(): BootPhase[] {
  return [
    {
      name: "assistant-thread-mirror-backfill",
      policy: "retryable",
      run: async () => {
        const { runDormantAssistantThreadMirrorBackfill } = await import(
          "@/lib/assistant-thread-mirror-backfill"
        );
        const r = runDormantAssistantThreadMirrorBackfill({ log: (m) => console.warn(m) });
        if (r.skippedReason) {
          return { skipped: r.skippedReason };
        }
        if (r.scanned > 0) {
          console.info(
            `[boot] AssistantThreadMirrorBackfill: scanned ${r.scanned}, ` +
              `backfilled ${r.backfilled}, failed ${r.failed}`,
          );
        }
      },
    },
  ];
}
