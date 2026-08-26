import "server-only";

// Boot wiring for the lifecycle run-outbox seam (cinatra#2930, epic #2926 W3).
//
// Injects the host writer (`src/lib/lifecycle/lifecycle-run-outbox.ts`) into the
// `packages/agents` `setLifecyclePartOutbox` seam, so the coordinator's moment
// record also lands the moment's card in the run's own turn.
//
// Auto-registers on import. Imported at boot from BOTH contexts the coordinator
// states a moment in:
//   - the Next.js server (`src/instrumentation.node.ts`), and
//   - the BullMQ run worker (`src/lib/background-jobs.ts`),
// exactly like `register-run-wait-notifier.ts` beside it, and for the same
// reason: a moment opens on both. Registration is idempotent (a single
// global-symbol slot), so importing it on both paths is harmless.
//
// Import the seam from the TRUE-LEAF `@cinatra-ai/agents/lifecycle-part-outbox`
// subpath, NOT the `@cinatra-ai/agents` barrel — both boot sites are reachable
// from the barrel's own cold-import graph, so importing the barrel here would
// close an init-time cycle and read `setLifecyclePartOutbox` while the barrel is
// mid-evaluation. The leaf module has ZERO runtime deps.
import { setLifecyclePartOutbox } from "@cinatra-ai/agents/lifecycle-part-outbox";
import { lifecycleRunOutbox } from "@/lib/lifecycle/lifecycle-run-outbox";

setLifecyclePartOutbox(lifecycleRunOutbox);
