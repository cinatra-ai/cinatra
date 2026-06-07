// Module-resolution hook: force every `extensions/cinatra-ai/` specifier to
// fail with ERR_MODULE_NOT_FOUND, simulating a fresh checkout where the
// gitignored clone-back target has not been populated yet.
//
// A TOP-LEVEL static import of the connector crashes the CLI at module load
// (the pre-fix bug); a lazy `await import()` inside a handler only fires
// post-config, so `cinatra --help` — which runs no handler — must still load
// cleanly. This hook is process-local to the spawned child, so it never
// touches the real on-disk tree (race-free under parallel vitest).
export async function resolve(specifier, context, nextResolve) {
  if (specifier.includes("extensions/cinatra-ai/")) {
    const err = new Error(
      `cold-import test: forced ERR_MODULE_NOT_FOUND for "${specifier}" ` +
        `(extensions/cinatra-ai is absent on a fresh checkout)`,
    );
    err.code = "ERR_MODULE_NOT_FOUND";
    throw err;
  }
  return nextResolve(specifier, context);
}
