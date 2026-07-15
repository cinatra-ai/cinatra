import "server-only";

// Boot wiring for the run human-wait notifier seam (cinatra #1559 /
// notifications epic E9).
//
// Injects the host durable-notification write path
// (`src/lib/agent-run-wait-notifications.ts`) into the `packages/agents`
// `setRunWaitNotifier` seam, so `transitionRunStatus` mints/clears the
// awaiting-human notification on every human-gate enter/leave.
//
// Auto-registers on import. Imported at boot from BOTH status-seam contexts:
//   - the Next.js server (`src/instrumentation.node.ts`), and
//   - the BullMQ run worker (`src/lib/background-jobs.ts`),
// because `transitionRunStatus` fires in both. Registration is idempotent (a
// single global-symbol slot), so importing it on both paths is harmless.

import { setRunWaitNotifier } from "@cinatra-ai/agents";
import { runWaitNotifier } from "@/lib/agent-run-wait-notifications";

setRunWaitNotifier(runWaitNotifier);
