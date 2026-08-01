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

/**
 * What the destructive step KNEW before it destroyed anything.
 *
 * The hook fires after the rows are gone, so anything a participant needs to
 * identify the destroyed work has to travel with the call. Today that is the
 * package's agent-run ids: the execution plane uses them to cancel queued
 * sandbox work and collect retained run workspaces (cinatra#1705 AC9), and it
 * has no other way to learn them — `agent_runs` is deleted by the very step
 * that fires this hook.
 *
 * OPTIONAL BY CONTRACT. A caller that cannot capture the ids (a kind with no
 * run rows, a read that failed) omits the context, and every participant must
 * treat that as "nothing to do here", never as "there were none".
 */
export type ExtensionDataTeardownContext = {
  /** Ids of the agent_runs the destructive step deleted. */
  runIds?: readonly string[];
  /** True when the id list was capped — there were MORE runs than are listed. */
  runIdsTruncated?: boolean;
};

/** Performs the durable data cleanup for a hard-removed package. Returns
 *  anything (e.g. a count of reaped keys) — the result is logged, not depended
 *  on. May be sync or async; the firer awaits it. */
export type ExtensionDataTeardownHook = (
  packageName: string,
  context?: ExtensionDataTeardownContext,
) => unknown | Promise<unknown>;

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
export async function fireExtensionDataTeardown(
  packageName: string,
  context?: ExtensionDataTeardownContext,
): Promise<void> {
  const { hook } = hookHolder();
  if (!hook) return;
  try {
    await hook(packageName, context);
  } catch (err) {
    console.warn(
      '[cinatra:extensions] data teardown hook threw for "%s" ' +
        "(durable cleanup is idempotent + re-runnable; committed removal is unaffected):",
      packageName,
      err instanceof Error ? err.message : err,
    );
  }
}
