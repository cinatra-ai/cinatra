/**
 * Start the boot sequence, and decide WHO WAITS FOR IT.
 *
 * `src/instrumentation.node.ts` is the framework's entry point and stays a thin
 * shim: it installs the process-level safety nets, guards the build phase, and
 * hands the boot to this module. The rules below live here so that entry point
 * does not grow a second concern.
 *
 * PRODUCTION WAITS. A `fatal` boot phase must abort startup before the process
 * serves anything, and that only works while the framework is still waiting on
 * the instrumentation hook. Nothing about the production runtime changes here:
 * `runBoot()` is awaited and a throw propagates exactly as it always did. So
 * does every runtime that is not the development server — see
 * `@/lib/boot/register-await-policy`.
 *
 * THE DEVELOPMENT SERVER DOES NOT — see that same module for why waiting there
 * leaves the server answering 404 for the life of the process, and
 * `@/lib/boot/dev-route-tree-repair` for the loopback ask that resolves the
 * route tree before the first boot phase runs. Neither step gates the boot: a
 * failed ask is ignored, and the boot starts either way. A boot failure is
 * reported here rather than thrown, because nothing is waiting to catch it —
 * the readiness surface carries the failing phase and `/api/health` answers 503.
 *
 * ONE BOOT PER PROCESS. The development server re-invokes the instrumentation
 * hook (a hot reload does it, and the route-tree repair above deliberately
 * touches a file under `src/app`). While the boot was awaited that was
 * self-limiting; a detached boot is not, so a second call would run a second
 * migration and extension-activation pass CONCURRENTLY with the first, each
 * resetting the other's phase log. The first call owns the boot and every later
 * call joins it.
 */

import { runBoot } from "@/lib/boot/boot-orchestrator";
import { ensureDevRouteTreeResolves } from "@/lib/boot/dev-route-tree-repair";
import { shouldAwaitBootInRegister } from "@/lib/boot/register-await-policy";

export type StartBootDeps = {
  boot?: () => Promise<void>;
  ensureRouteTree?: () => Promise<unknown>;
  logError?: (message: string, err: unknown) => void;
};

/** The boot this process already started, or null before the first call. */
let inFlight: Promise<void> | null = null;

/** True when that boot is one nobody waits for, so a later caller must not. */
let detached = false;

/** Test seam: forget the process-wide boot so a case can start its own. */
export function resetStartBootForTests(): void {
  inFlight = null;
  detached = false;
}

export async function startBoot(
  env: Record<string, string | undefined> = process.env,
  deps: StartBootDeps = {},
): Promise<void> {
  const boot = deps.boot ?? runBoot;
  const ensureRouteTree = deps.ensureRouteTree ?? ensureDevRouteTreeResolves;
  const logError =
    deps.logError ??
    ((message: string, err: unknown) => {
      console.error(message, err);
    });

  // A later call joins the boot this process already started. It waits for it
  // only where the first caller did: handing a detached boot to a caller that
  // awaits would park the development server behind exactly the wait this
  // module exists to remove.
  if (inFlight) return detached ? undefined : inFlight;

  if (shouldAwaitBootInRegister(env)) {
    inFlight = boot();
    // A fatal phase must still abort startup, so the throw is not caught here —
    // but the remembered promise must not become an unhandled rejection for a
    // later caller that joins it.
    inFlight.catch(() => undefined);
    return inFlight;
  }

  detached = true;
  inFlight = ensureRouteTree()
    .catch(() => undefined)
    .then(() => boot())
    .catch((err: unknown) => {
      logError(
        "[boot] the boot sequence failed. The readiness surface carries the failing phase and " +
          "/api/health answers 503 until it is fixed.",
        err,
      );
    });
  // Detached ON PURPOSE: the development server must serve while this runs.
  return Promise.resolve();
}
