/**
 * Start the boot sequence, and decide WHO WAITS FOR IT.
 *
 * `src/instrumentation.node.ts` is the framework's entry point and stays a thin
 * shim: it installs the process-level safety nets, guards the build phase, and
 * hands the boot to this module. The two rules below live here so that entry
 * point does not grow a second concern.
 *
 * PRODUCTION WAITS. A `fatal` boot phase must abort startup before the process
 * serves anything, and that only works while the framework is still waiting on
 * the instrumentation hook. Nothing about the production runtime changes here:
 * `runBoot()` is awaited and a throw propagates exactly as it always did.
 *
 * THE DEVELOPMENT SERVER DOES NOT — see `@/lib/boot/register-await-policy` for
 * why waiting there leaves the server answering 404 for the life of the process,
 * and `@/lib/boot/dev-route-tree-repair` for the loopback ask that resolves the
 * route tree before the first boot phase runs. Neither step gates the boot: a
 * failed ask is ignored, and the boot starts either way. A boot failure is
 * reported here rather than thrown, because nothing is waiting to catch it — the
 * readiness surface carries the failing phase and `/api/health` answers 503.
 */

import { runBoot } from "@/lib/boot/boot-orchestrator";
import { ensureDevRouteTreeResolves } from "@/lib/boot/dev-route-tree-repair";
import { shouldAwaitBootInRegister } from "@/lib/boot/register-await-policy";

export async function startBoot(
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  if (shouldAwaitBootInRegister(env)) {
    await runBoot();
    return;
  }

  void ensureDevRouteTreeResolves()
    .catch(() => "unresolved" as const)
    .then(() => runBoot())
    .catch((err: unknown) => {
      console.error(
        "[boot] the boot sequence failed. The readiness surface carries the failing phase and " +
          "/api/health answers 503 until it is fixed.",
        err,
      );
    });
}
