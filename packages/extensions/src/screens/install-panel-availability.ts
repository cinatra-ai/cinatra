// ---------------------------------------------------------------------------
// In-card install panel — availability model (cinatra#2373).
//
// The marketplace install panel resolves ONE discriminated availability state,
// evaluated in a fixed order, before it renders anything:
//
//   1. `no-active-organization` — the session carries no active organization.
//      Every install target is anchored to the active org (the server action
//      re-derives the workspace/admin id from it and REFUSES an access target
//      without one), so there is nothing selectable and nothing submittable.
//      This is checked FIRST because the role-oriented empty state below would
//      otherwise mis-describe the cause ("you need org admin…") for a viewer
//      whose roles are fine and whose SESSION is the problem.
//   2. `ready` — an installable audience exists. The default selection is the
//      `Workspace: All` row (the broadest AUDIENCE — every workspace user)
//      whenever the server offered it enabled; narrower audiences stay
//      selectable. Absent an enabled workspace row the shared picker fallback
//      (project → team → org) still applies, so a non-platform admin keeps the
//      selection they are actually allowed to install at.
//   3. `no-installable-scope` — no target at all; the existing role-oriented
//      empty state renders with its copy unchanged.
//
// TWO DIMENSIONS, deliberately not collapsed:
//   - INSTALLER AUTHORITY — *who may install at a target*. Owned by the server
//     (`assertCanInstallAtTarget`); the picker's per-row `disabled`/`reason`
//     state is the UX shadow of it, never the boundary.
//   - AUDIENCE — *who may then use the installed extension*. That is what the
//     selected row NAMES ("Workspace: All" = every workspace user, "Workspace:
//     Admins only" = admins), and what `setExtensionInstallAccess` persists.
// Widening the default AUDIENCE to `Workspace: All` does not widen installer
// AUTHORITY by one row: an audience row the viewer lacks authority for is
// server-disabled and stays unselectable here.
//
// Marketplace-local ON PURPOSE: `pickDefaultPickerValue`
// (@cinatra-ai/agents/install-targets) is the SHARED default used by the agent
// registry and is left untouched — this override applies to the marketplace
// install panel only.
// ---------------------------------------------------------------------------

import type { InstallTarget } from "@cinatra-ai/agents/install-targets";

export type InstallPanelAvailability =
  | { state: "no-active-organization" }
  | { state: "ready"; defaultValue: string }
  | { state: "no-installable-scope" };

export type ResolveInstallPanelAvailabilityInput = {
  /** `session.session.activeOrganizationId ?? ""` — empty when unset. */
  activeOrgId: string;
  /** SERVER-COMPUTED picker rows (single source of truth for enabled state). */
  installTargets: InstallTarget[];
  /**
   * The SHARED picker fallback (`pickDefaultPickerValue`) — used only when the
   * marketplace's own `Workspace: All` preference is not available.
   */
  fallbackDefaultValue: string | null;
};

/**
 * Resolve the panel's availability state. PURE — no IO, no session access, so
 * the ordering contract is directly unit-testable.
 */
export function resolveInstallPanelAvailability({
  activeOrgId,
  installTargets,
  fallbackDefaultValue,
}: ResolveInstallPanelAvailabilityInput): InstallPanelAvailability {
  // (1) No active organization. Checked before any role reasoning: a
  // whitespace-only / empty id is "no active org", not a narrower audience.
  if (activeOrgId.trim() === "") return { state: "no-active-organization" };

  // (2) Ready — `Workspace: All` when the server offered it ENABLED.
  const workspaceAll = installTargets.find(
    (target) => target.level === "workspace" && !target.disabled,
  );
  if (workspaceAll) return { state: "ready", defaultValue: workspaceAll.value };
  if (fallbackDefaultValue) {
    return { state: "ready", defaultValue: fallbackDefaultValue };
  }

  // (3) Nothing installable — the role-oriented empty state.
  return { state: "no-installable-scope" };
}
