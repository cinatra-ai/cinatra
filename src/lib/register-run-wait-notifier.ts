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
//
// Import the seam from the TRUE-LEAF `@cinatra-ai/agents/run-wait-notifier`
// subpath, NOT the `@cinatra-ai/agents` barrel. Both boot sites (the Next
// server via instrumentation.node.ts, and the BullMQ worker via
// background-jobs.ts) are reachable FROM the barrel's own cold-import graph
// (barrel → store.ts → `@/lib/*` → background-jobs → here), so importing the
// barrel here would close an init-time cycle and read `setRunWaitNotifier`
// while the barrel is mid-evaluation — it resolves `undefined` and the
// top-level call below throws. The leaf module has ZERO runtime deps, so
// importing it directly is fully initialised regardless of barrel state.
import { setRunWaitNotifier } from "@cinatra-ai/agents/run-wait-notifier";
import { runWaitNotifier } from "@/lib/agent-run-wait-notifications";

setRunWaitNotifier(runWaitNotifier);

// THE RUN OUTBOX IS WIRED FROM HERE TOO (cinatra#2930, epic #2926 W3).
//
// The two seams are the same boot concern and want the same two sites: when a
// run reaches a moment, one of them tells the person where to go and the other
// puts the moment's card in front of them. Both fire wherever the coordinator
// states a moment — the Next.js server and the BullMQ run worker — and both are
// idempotent global-symbol slots, so a boot path that already imports this file
// is exactly the boot path the outbox needs.
//
// It rides HERE rather than being imported at the two boot files directly
// because both of those are size-ratcheted architecture bottlenecks: the
// ratchet exists so a baselined file stops accumulating wiring, and adding a
// line to each to reach a seam this file already reaches would be growing them
// for nothing. The registration itself lives in its own module, which is what a
// reader greps for.
import "@/lib/register-lifecycle-part-outbox";
