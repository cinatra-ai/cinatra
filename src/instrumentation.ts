/**
 * Next.js instrumentation entry point.
 *
 * Next.js loads this file (compiled to .next/dev/server/instrumentation.js)
 * for BOTH the Node.js and Edge runtimes. All Node.js-specific startup logic
 * (crash handlers, DB warmup, usage event subscriber, LiteLLM weekly sync,
 * encryption-key bootstrap, etc.) lives in `src/instrumentation.node.ts`. We delegate to it
 * via a DYNAMIC import gated on `process.env.NEXT_RUNTIME === "nodejs"`.
 *
 * Why a dynamic import inside an if-block:
 * - Turbopack only emits "A Node.js API is used … not supported in the Edge
 *   Runtime" warnings for files it can statically analyze. A `static` import
 *   of `./instrumentation.node` would pull `process.on()`, `spawn`, etc. into
 *   the Edge Runtime module graph and trigger the warning on every hot reload.
 * - A dynamic `await import("./instrumentation.node")` nested inside an
 *   `if (process.env.NEXT_RUNTIME === "nodejs")` branch is not statically
 *   reachable from the Edge Runtime side, so Turbopack skips the analysis.
 *
 * The Edge runtime falls through this function as a no-op (no crash, valid
 * register() export so Next.js's `ensureInstrumentationRegistered()` is happy).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { register: registerNode } = await import("./instrumentation.node");
    await registerNode();
  }
  // Edge runtime: intentional no-op.
}

// Sentry request-error hook.
//
// Next.js calls onRequestError for thrown errors in route handlers, server
// components, and server actions. The hook fires in both Node.js and Edge
// runtimes; @sentry/nextjs's package exports field resolves the
// captureRequestError implementation to the runtime-appropriate build
// automatically. The dynamic import keeps the heavy node-only module out of
// the file's static graph so Turbopack doesn't analyse it from edge paths.
//
// Sentry.captureRequestError is a no-op when Sentry was not initialised
// (SENTRY_DSN unset), so we don't need to gate on that here.
export function onRequestError(
  error: unknown,
  request: unknown,
  errorContext: unknown,
): void {
  // Skip entirely outside the two Next runtimes that emit this hook. This
  // also short-circuits in unit-test / build-time analysis contexts where
  // NEXT_RUNTIME is unset.
  const runtime = process.env.NEXT_RUNTIME;
  if (runtime !== "nodejs" && runtime !== "edge") return;

  void import("@sentry/nextjs")
    .then(({ captureRequestError }) => {
      try {
        (captureRequestError as (e: unknown, r: unknown, c: unknown) => void)(
          error,
          request,
          errorContext,
        );
      } catch {
        // Sentry-internal errors must not surface from instrumentation.
      }
    })
    .catch(() => {
      // Module load failure is swallowed — onRequestError is best-effort.
    });
}
