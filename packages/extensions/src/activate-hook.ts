import "server-only";

// Hot-activate seam (the activation half — symmetric to
// `capability-teardown-hook.ts`, the teardown half).
//
// After a verdaccio-source NEW install commits (the dispatcher flips the
// canonical row active), the running process must pick up the package WITHOUT a
// restart: record its REAL tarball provenance, materialize it into the on-disk
// package store, and targeted-activate it in-process through the SAME shared
// activation driver the boot RuntimePackageLoader uses. That whole flow lives in
// the host (`@/lib` — it needs the install pipeline + the package store + the
// trusted anchor resolver), which `@cinatra-ai/extensions` cannot import (it
// would invert the dependency direction). So the host injects the activator via
// a `globalThis`-anchored slot (mirroring `setExtensionCapabilityTeardownHook`),
// and the dispatcher FIRES it after the install commits.
//
// HONEST SCOPE: this activates the package in the CURRENT process only. It is
// best-effort + non-fatal — a registry-unreachable / activation-throw must NEVER
// roll back the already-finalized install. The package is still picked up on the
// next boot by the RuntimePackageLoader (the durable path); the hot-activate is
// the no-restart convenience on top of it.

/** The result of a hot-activate attempt. */
export type ExtensionActivateResult = {
  /** True when the package was activated (registered) in-process this call. The
   *  activation half is best-effort: an `activated:false` with `finalized:true`
   *  means the install COMMITTED (durable; the boot loader will pick it up) but
   *  in-process registration did not happen this call. */
  activated: boolean;
  /**
   * True when the real-integrity install pipeline reached `finalized` — the row
   * is now anchorable/activatable (real provenance recorded + journal finalized).
   * The dispatcher uses this as the AUTHORITATIVE success signal: a freshly-
   * created (or previously-broken) canonical row is rolled back when the pipeline
   * did NOT finalize, so no row is ever left active-but-non-anchorable. Distinct
   * from `activated` (in-process registration, best-effort). `undefined` when no
   * host hook ran (the dispatcher then leaves the row as the handler set it).
   */
  finalized?: boolean;
  /**
   * Atomic hot-update with durable-rollback-first: true when this was an
   * UPDATE whose NEW digest failed live activation and the install was DURABLY
   * ROLLED BACK to the previous version. The update did NOT take — the caller
   * (extensions_update handler) MUST report the previous version was retained, NOT
   * update success. `activated` is always false when this is true. Note that
   * `finalized` may still be true (the NEW install committed before the rollback
   * re-pinned the durable anchor to OLD); `rolledBack` is the authoritative
   * "did the update take" signal for an update.
   */
  rolledBack?: boolean;
  /**
   * When `rolledBack` is true, whether the durable rollback was
   * CLEAN — EVERY durable restore step (OLD provenance, journal op, host-port grant)
   * succeeded. `true` ⇒ the previous version is fully restored (the dispatcher may
   * report the calm "previous version retained" outcome). `false` ⇒ the durable
   * state is only PARTIALLY restored — the dispatcher MUST throw a LOUD
   * manual-recovery error, NOT a calm success. Undefined when not a rollback.
   */
  rollbackComplete?: boolean;
  /** Machine-readable reason when `activated` is false (e.g. "no-host-hook",
   *  "not-trusted", "no-server-entry", an activation reason, or an error tag). */
  reason?: string;
};

/** Host-injected activator. Given a package (and optional org scope), records its
 *  real provenance, materializes it, and targeted-activates it in-process. May be
 *  sync or async; the firer awaits it.
 *
 *  `version` is the REQUESTED install/target version (the dispatcher passes
 *  `ref.version`). The host hook uses it as the install version so an UPDATE
 *  installs the NEW version — NOT the stale version still on the canonical row
 *  (which carries the OLD version until provenance is rewritten). When omitted the
 *  host falls back to the row's recorded source version (a fresh install already
 *  has `row.source.version === ref.version`, so passing it is consistent). */
export type ExtensionActivateHook = (
  packageName: string,
  orgId?: string | null,
  version?: string,
) => ExtensionActivateResult | Promise<ExtensionActivateResult>;

const ACTIVATE_HOOK_SLOT = Symbol.for("cinatra.extensions.activateHook.v1");
type HookHolder = { hook: ExtensionActivateHook | null };
function hookHolder(): HookHolder {
  const g = globalThis as unknown as Record<symbol, HookHolder | undefined>;
  return (g[ACTIVATE_HOOK_SLOT] ??= { hook: null });
}

/** Host wiring entry: inject the in-process activator. Pass `null` to clear (tests). */
export function setExtensionActivateHook(hook: ExtensionActivateHook | null): void {
  hookHolder().hook = hook;
}

/** Fire (and AWAIT) the injected activator for `packageName`. No-op (returns
 *  `{ activated:false, reason:"no-host-hook" }`) when no host hook is wired (e.g.
 *  a worker that never loaded the host module). Best-effort: a throwing/rejecting
 *  hook is logged and swallowed — activation is process convenience layered on a
 *  COMMITTED install, so it must never propagate and roll the install back. */
export async function fireExtensionActivate(
  packageName: string,
  orgId?: string | null,
  version?: string,
): Promise<ExtensionActivateResult> {
  const { hook } = hookHolder();
  if (!hook) return { activated: false, reason: "no-host-hook" };
  try {
    // Forward `version` ONLY when defined so the 2-arg hook invocation
    // (and its tests asserting `toHaveBeenCalledWith(pkg, orgId)`) is unchanged.
    return version === undefined
      ? await hook(packageName, orgId ?? null)
      : await hook(packageName, orgId ?? null, version);
  } catch (err) {
    console.warn(
      '[cinatra:extensions] activate hook threw for "%s" ' +
        "(in-process activation only; committed install is unaffected):",
      packageName,
      err instanceof Error ? err.message : err,
    );
    return { activated: false, reason: "activate-threw" };
  }
}
