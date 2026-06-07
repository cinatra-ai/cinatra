import "server-only";

// Host-injected workflow-install saga slot.
//
// The atomic workflow-install saga (journal + preflight-against-storeDir +
// per-project instance fan-out + inverse-order compensating rollback) is a
// pure host-side orchestration that lives in `@/lib`
// (`src/lib/extension-workflow-install-saga.ts`) — it needs the package store,
// the install-op journal, the canonical store, and `withInstallLock`, none of
// which `@cinatra-ai/workflows` may import (host-app → package is the only legal
// direction). So the host INJECTS the saga via a `globalThis`-anchored slot —
// the same pattern proven by `setExtensionCapabilityTeardownHook` /
// `setLiveAgentManifestProvider` — and the workflow extension handler DELEGATES
// to it when present, falling back to the legacy in-package
// `installWorkflowExtension` (dev-checkout sourced) when no host hook is wired
// (e.g. a worker that never loaded the host module, or a unit test).
//
// MODEL-B SAFE: the slot ships NO host code into the package; it only forwards a
// `{ packageName, version, actor }` ref to a host function the host registered.

/** The injected workflow-install saga. Resolves once the install is finalized;
 *  throws on a preflight reject / write failure (the saga has already run its
 *  inverse-order compensation before re-throwing). */
export type WorkflowInstallSagaHook = (input: {
  packageName: string;
  version?: string;
  actor: { userId?: string | null; orgId?: string | null };
}) => Promise<void>;

const INSTALL_SAGA_HOOK_SLOT = Symbol.for("cinatra.workflows.installSagaHook.v1");
type HookHolder = { hook: WorkflowInstallSagaHook | null };
function hookHolder(): HookHolder {
  const g = globalThis as unknown as Record<symbol, HookHolder | undefined>;
  return (g[INSTALL_SAGA_HOOK_SLOT] ??= { hook: null });
}

/** Host wiring entry: inject the workflow-install saga driver. Pass `null` to
 *  clear (tests). */
export function setWorkflowInstallSagaHook(hook: WorkflowInstallSagaHook | null): void {
  hookHolder().hook = hook;
}

/** The currently-injected saga driver, or null when the host hasn't wired one
 *  (the handler then falls back to the legacy in-package install path). */
export function getWorkflowInstallSagaHook(): WorkflowInstallSagaHook | null {
  return hookHolder().hook;
}
