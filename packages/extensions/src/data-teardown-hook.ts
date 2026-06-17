import "server-only";

// The DURABLE half of extension teardown.
//
// Distinct from `capability-teardown-hook` (which clears the CURRENT process's
// IN-MEMORY registrations and is fire-and-forget): this hook performs DURABLE,
// cross-process data cleanup — physically deleting an uninstalled extension's
// org-scoped settings/secrets rows (`ext:<pkg>:` / `ext-secret:<pkg>:` on the
// `connector_config` KV); a forthcoming dev-fixtures contract extends the same
// hook to also reap its provenance-tagged dev-fixture rows. The cleanup
// IMPLEMENTATION lives in the host (`@/lib`),
// which `@cinatra-ai/extensions` cannot import (it would invert the dependency
// direction), so the host injects it via a `globalThis`-anchored slot — the
// same pattern as `setExtensionCapabilityTeardownHook` — and the lifecycle
// dispatchers AWAIT it.
//
// FIRES ONLY ON HARD REMOVAL — the registry `uninstall` hard-delete branch,
// `forceDelete`, and the purge saga. It MUST NOT fire on `archive` (an archived
// extension preserves run history and is restorable, so its org-scoped config
// must survive) — see ExtensionRegistryImpl.uninstall.
//
// AWAITED + IDEMPOTENT: a prefix delete of already-absent rows is a no-op, so
// re-running is safe; the caller awaits so cleanup completes before the
// lifecycle op returns. BEST-EFFORT on failure: a throwing hook is logged and
// swallowed — the destructive lifecycle step is already committed, and the
// next teardown (idempotent) re-cleans, so a transient DB error must never
// abort an already-committed uninstall.

/** Performs the durable data cleanup for a hard-removed package. Returns
 *  anything (e.g. a count of reaped keys) — the result is logged, not depended
 *  on. May be sync or async; the firer awaits it. */
export type ExtensionDataTeardownHook = (packageName: string) => unknown | Promise<unknown>;

const DATA_TEARDOWN_HOOK_SLOT = Symbol.for("cinatra.extensions.dataTeardownHook.v1");
type HookHolder = { hook: ExtensionDataTeardownHook | null };
function hookHolder(): HookHolder {
  const g = globalThis as unknown as Record<symbol, HookHolder | undefined>;
  return (g[DATA_TEARDOWN_HOOK_SLOT] ??= { hook: null });
}

/** Host wiring entry: inject the durable data teardown. Pass `null` to clear
 *  (tests). */
export function setExtensionDataTeardownHook(hook: ExtensionDataTeardownHook | null): void {
  hookHolder().hook = hook;
}

/** Fire (and AWAIT) the injected durable teardown for `packageName`. No-op when
 *  no host hook is wired (e.g. a worker that never loaded the host module).
 *  Best-effort: a throwing hook is logged and swallowed so a committed
 *  hard-removal is never aborted by a transient data-cleanup error. */
export async function fireExtensionDataTeardown(packageName: string): Promise<void> {
  const { hook } = hookHolder();
  if (!hook) return;
  try {
    await hook(packageName);
  } catch (err) {
    console.warn(
      '[cinatra:extensions] data teardown hook threw for "%s" ' +
        "(durable cleanup is idempotent + re-runnable; committed removal is unaffected):",
      packageName,
      err instanceof Error ? err.message : err,
    );
  }
}
