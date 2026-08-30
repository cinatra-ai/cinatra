/**
 * Does `instrumentation.register()` hold Next.js open until the boot finishes?
 *
 * PRODUCTION: yes. A `fatal` boot phase must abort startup before the process
 * serves anything, and that only works while the framework is still waiting on
 * `register()`. Nothing about the production runtime changes here.
 *
 * THE DEVELOPMENT SERVER: no — and that is a correctness rule, not a speed one.
 * Next.js awaits `register()` before it serves its FIRST request, so awaiting a
 * boot that takes minutes on a fresh instance parks the development server's
 * first request behind the whole sequence. Measured on the development runtime
 * (Next 16 / Turbopack): a first request answered after such a wait is resolved
 * against an App Router route tree the server has not finished building, so it
 * is answered from the not-found entry — and that answer STICKS, so every later
 * request for the same path answers 404 too, for the life of the process.
 * `/api/health`, the endpoint every development harness polls for readiness,
 * then answers 404 for as long as the instance runs while the boot itself
 * completes normally; only a filesystem change under `src/app` clears it.
 *
 * Detaching removes the wait, so the development server builds its route tree
 * the way it does with no instrumentation at all. Nothing is skipped and no
 * readiness claim is weakened: the boot still runs in the same order, still
 * records every phase, and `/api/health` still reports `starting` with HTTP 503
 * until the boot marks itself ready (src/lib/boot/health-status.ts). A poller
 * waits for exactly the condition it waited for before — it now waits on the
 * ANSWER rather than on the connection.
 */
export function shouldAwaitBootInRegister(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.NODE_ENV === "production";
}
