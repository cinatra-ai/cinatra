import "server-only";

// The DURABLE, ORG-SCOPED dashboard-archival half of extension lifecycle
// (cinatra-ai/cinatra#1628, S11a — re-homing the archival step W5/#1035 dropped).
//
// When a `kind:"workflow"` extension used to be uninstalled, its materialized
// dashboard rows were archived. #1035 removed the workflow kind AND that archival
// step, leaving extension dashboards able to outlive their extension. S11a
// re-establishes the archival, but attaches it to the COMMITTED lifecycle
// transition with EXACT (install, org) identity — NOT the org-less, in-memory,
// package-global `capability-teardown-hook` (`teardownExtensionCapabilities`),
// which would risk cross-org archival + archive-on-reinstall (it has no org
// dimension). This hook fires from the ROW-SCOPED `archive`/`restore` transitions
// in the registry dispatcher, which resolve exactly the actor's (package, org)
// canonical row.
//
// The archival IMPLEMENTATION (the dashboards single-writer
// `archiveExtensionDashboards`/`restoreExtensionDashboards`) lives in the host
// (`@/lib`), which `@cinatra-ai/extensions` cannot import (it would invert the
// dependency direction), so the host injects it via a `globalThis`-anchored slot
// — the same pattern as `setExtensionDataTeardownHook` — and the dispatcher
// AWAITS it.
//
// FIRES on the recoverable, org-scoped transitions:
//   - "archive"  → archive this (package, org)'s extension dashboards (an
//     org-admin uninstall routes here too; the rows are preserved + restorable).
//   - "restore"  → un-archive them.
// It intentionally does NOT fire on the package-global platform-admin hard
// delete / forceDelete / purge paths: those remove the install ENTIRELY (durable
// absence), where the migration orphan sweep + the reader gate are the recovery.
//
// AWAITED + IDEMPOTENT + BEST-EFFORT: the archive/restore writes are idempotent
// (status flips), so re-running is safe; a throwing hook is logged + swallowed —
// the durable lifecycle transition is already committed, and the migration sweep
// + reader gate remain the backstop, so a transient DB error must never abort an
// already-committed archive/restore.

/** The recoverable, org-scoped lifecycle transitions that move an extension's
 *  dashboards. */
export type ExtensionDashboardLifecycleTransition = "archive" | "restore";

/**
 * Performs the durable dashboard archive/restore for a (package, org) on a
 * committed transition. Returns anything (e.g. an affected-row count) — the
 * result is logged, not depended on. May be sync or async; the firer awaits it.
 */
export type ExtensionDashboardLifecycleHook = (input: {
  packageName: string;
  organizationId: string;
  transition: ExtensionDashboardLifecycleTransition;
  /** The acting principal id (for the archival audit row); a system id when absent. */
  actorPrincipalId?: string;
}) => unknown | Promise<unknown>;

const DASHBOARD_LIFECYCLE_HOOK_SLOT = Symbol.for("cinatra.extensions.dashboardLifecycleHook.v1");
type HookHolder = { hook: ExtensionDashboardLifecycleHook | null };
function hookHolder(): HookHolder {
  const g = globalThis as unknown as Record<symbol, HookHolder | undefined>;
  return (g[DASHBOARD_LIFECYCLE_HOOK_SLOT] ??= { hook: null });
}

/** Host wiring entry: inject the durable dashboard archive/restore. Pass `null`
 *  to clear (tests). */
export function setExtensionDashboardLifecycleHook(
  hook: ExtensionDashboardLifecycleHook | null,
): void {
  hookHolder().hook = hook;
}

/**
 * Fire (and AWAIT) the injected dashboard archive/restore for (package, org). A
 * no-op when no host hook is wired (a worker that never loaded the host module)
 * or when `organizationId` is null (a system/global install carries no org-scoped
 * extension dashboards). Best-effort: a throwing hook is logged + swallowed so a
 * committed archive/restore is never aborted by a transient dashboards error.
 */
export async function fireExtensionDashboardLifecycle(input: {
  packageName: string;
  organizationId: string | null | undefined;
  transition: ExtensionDashboardLifecycleTransition;
  actorPrincipalId?: string;
}): Promise<void> {
  const { hook } = hookHolder();
  if (!hook || input.organizationId == null) return;
  try {
    await hook({
      packageName: input.packageName,
      organizationId: input.organizationId,
      transition: input.transition,
      ...(input.actorPrincipalId !== undefined ? { actorPrincipalId: input.actorPrincipalId } : {}),
    });
  } catch (err) {
    console.warn(
      '[cinatra:extensions] dashboard lifecycle hook threw for "%s" (org "%s", %s) ' +
        "(archive/restore is idempotent + re-runnable; the migration sweep + reader gate backstop it; " +
        "committed transition is unaffected):",
      input.packageName,
      input.organizationId,
      input.transition,
      err instanceof Error ? err.message : err,
    );
  }
}
