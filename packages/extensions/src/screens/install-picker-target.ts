// ---------------------------------------------------------------------------
// Picker value → install target adapter (cinatra#2373).
//
// PURE module (no React, no IO) so the fail-closed rules below are directly
// unit-testable and can be shared by the in-card install panel without pulling
// a client component into the graph.
//
// Rules are IDENTICAL to the canonical adapter behind the server action
// (auth-policy-types.ts) and to the popup this panel replaced:
//   - "owner" is NOT an install target → null.
//   - "workspace" / "admin" (cinatra#1527) ARE targets and carry the active-org
//     id as the tenant anchor; the SERVER re-derives that id canonically and
//     never trusts this client value, so a forged id cannot cross tenants.
//   - an EMPTY tail ("org:" / "team:" / "project:") is not a target → null, so
//     a stray value can never reach the action with an empty id.
//
// The UI gate this feeds is an affordance only — `assertCanInstallAtTarget`
// server-side is the authority boundary (installer AUTHORITY), while the value
// itself names the AUDIENCE the extension is installed for.
//
// This is now the SINGLE implementation on the marketplace surface. The popup
// that used to carry a private duplicate of these rules was deleted in
// cinatra#2374, once its last consumer — the §II detail modal's install flow —
// was removed by owner ruling (2026-08-04, cinatra#2406: the modal is
// details-only). The agent-registry install dialog is a separate surface and
// keeps its own copy, pinned by the access-combobox org-token suite.
// ---------------------------------------------------------------------------

export type InstallTargetLevel =
  | "organization"
  | "team"
  | "project"
  | "workspace"
  | "admin";

export type ResolvedInstallTarget = { level: InstallTargetLevel; id: string };

export function pickerValueToInstallTarget(
  value: string,
  activeOrgId: string,
): ResolvedInstallTarget | null {
  if (value === "workspace")
    return activeOrgId ? { level: "workspace", id: activeOrgId } : null;
  if (value === "admin")
    return activeOrgId ? { level: "admin", id: activeOrgId } : null;
  if (value.startsWith("org:")) {
    const id = value.slice("org:".length);
    return id ? { level: "organization", id } : null;
  }
  // Bare legacy "org" — kept for read-compat with a persisted legacy value.
  if (value === "org")
    return activeOrgId ? { level: "organization", id: activeOrgId } : null;
  if (value.startsWith("team:")) {
    const id = value.slice("team:".length);
    return id ? { level: "team", id } : null;
  }
  if (value.startsWith("project:")) {
    const id = value.slice("project:".length);
    return id ? { level: "project", id } : null;
  }
  return null;
}
