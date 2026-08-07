// ---------------------------------------------------------------------------
// Picker value → install target adapter (cinatra#2373).
//
// PURE module (no React, no IO) so the fail-closed rules below are directly
// unit-testable and can be shared by the in-card install panel without pulling
// a client component into the graph.
//
// Rules are IDENTICAL to the canonical adapter behind the server action
// (auth-policy-types.ts) and to the popup this panel replaces:
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
// NOTE: `extension-install-scope-dialog.tsx` still carries its own private copy
// of these rules for the detail-modal path it serves; that component (and the
// copy) is removed with the modal's inline panel (S3), at which point this is
// the single implementation. Deliberately NOT refactored here: the card path
// is the only consumer this slice owns.
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
