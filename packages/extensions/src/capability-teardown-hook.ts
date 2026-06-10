import "server-only";

// True-IoC split-brain guard (the teardown half).
//
// When an extension is purged, its in-memory capability registrations (today:
// the MCP tool registry + authz effective-set in `@/lib/extension-mcp-registry`)
// must be torn down in the CURRENT process so the tool is no longer listable or
// invocable without a restart. The teardown implementation lives in the host
// (`@/lib`), which `@cinatra-ai/extensions` cannot import (it would invert the
// dependency direction). So the host injects the teardown via a
// `globalThis`-anchored slot — the same pattern proven by
// `setLiveAgentManifestProvider` for the agent MCP-tool gate — and the purge
// saga FIRES it after the DB delete commits.
//
// HONEST SCOPE: this clears the CURRENT process's in-memory registry only. It is
// NOT cross-worker live uninstall (that, plus signature/worker isolation, is a
// separate concern). Paired with the StaticBundleLoader strict allow-list gate,
// the two together mean: (1) a purged extension's tools are dropped from the
// running process, and (2) a retired static `serverEntry` package does not
// re-register on the next restart — BOTH retire paths are covered: archive
// leaves archived rows, and a HARD uninstall tombstones the static-bundle
// ANCHOR row (see static-bundle-anchor.ts + lifecycle-primitive.ts), so
// neither yields a live row for the gate to activate.

/** Tears down the in-memory capability registrations for a purged package.
 *  Returns anything (e.g. the removed tool names) — the result is logged, not
 *  depended on. May be sync or async; the firer awaits it (so the update
 *  path can deterministically sequence old-package teardown BEFORE re-activating
 *  the new digest, mirroring the durable `ExtensionDataTeardownHook`). */
export type ExtensionCapabilityTeardownHook = (
  packageName: string,
) => unknown | Promise<unknown>;

const TEARDOWN_HOOK_SLOT = Symbol.for("cinatra.extensions.capabilityTeardownHook.v1");
type HookHolder = { hook: ExtensionCapabilityTeardownHook | null };
function hookHolder(): HookHolder {
  const g = globalThis as unknown as Record<symbol, HookHolder | undefined>;
  return (g[TEARDOWN_HOOK_SLOT] ??= { hook: null });
}

/** Host wiring entry: inject the in-memory capability teardown. Pass `null` to
 *  clear (tests). */
export function setExtensionCapabilityTeardownHook(
  hook: ExtensionCapabilityTeardownHook | null,
): void {
  hookHolder().hook = hook;
}

/** Fire (and AWAIT) the injected teardown for `packageName`. No-op when no host
 *  hook is wired (e.g. a worker that never loaded the host module). Best-effort:
 *  a throwing (or rejecting) hook is logged and swallowed — in-memory teardown
 *  is process state, not durable state, so it must never abort the committed
 *  purge.
 *
 *  ASYNC: the firer awaits the hook so the new-digest UPDATE path can
 *  deterministically fire teardown for the OLD package and await its completion
 *  BEFORE re-activating the new module (see the update-teardown note in the
 *  module header). Purge/uninstall/archive
 *  callers already invoke this from async contexts via `await import(...)`, so
 *  they only need to add an `await` (a fire-and-forget call still works — the
 *  returned promise is best-effort and never rejects). */
export async function fireExtensionCapabilityTeardown(packageName: string): Promise<void> {
  const { hook } = hookHolder();
  if (!hook) return;
  try {
    await hook(packageName);
  } catch (err) {
    console.warn(
      `[cinatra:extensions] capability teardown hook threw for "${packageName}" ` +
        "(in-memory cleanup only; committed purge is unaffected):",
      err instanceof Error ? err.message : err,
    );
  }
}
