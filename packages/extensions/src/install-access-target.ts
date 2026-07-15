// ---------------------------------------------------------------------------
// Install-time access target → policy mapping (cinatra#805).
//
// PURE module (no IO, no server-only) so the mapping is directly
// unit-testable. Used by installExtensionPackageFormAction to translate the
// pre-install access selection (org / team / project — the same target rows
// the agent InstallScopeDialog offers) into the AgentAuthPolicy shape the
// sanctioned install-time access contract (setExtensionInstallAccess)
// persists.
//
// Semantics (deliberate — see issue #805):
//  - The canonical `installed_extension` row for connector/artifact/workflow
//    stays ORG-ANCHORED (ownerLevel "organization") — the row identity is a
//    lookup key (resolveConnectorResource hard-codes it) and there is no
//    "project" owner level. The chosen audience is carried by the ACCESS
//    POLICY visibility tiers, which enforceExtensionAccess already evaluates
//    ("team:<id>" / "project:<id>" / workspace).
//  - organization target → the kind's install default: return undefined so
//    setExtensionInstallAccess applies it — workspace for artifact/workflow,
//    and for a CONNECTOR the policy derived from its own cinatra/config.json
//    declaration cached on the canonical row (cinatra#955).
//  - team / project target → all three visibility fields scoped to the
//    target; sharing disabled (matches the per-kind defaults).
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { AgentAuthPolicy } from "@cinatra-ai/agents/auth-policy-types";

// ---------------------------------------------------------------------------
// Server-action boundary rule (cinatra#1602 — the enforced picker contract).
//
// For these kinds an access target is MANDATORY at the server install action
// (installExtensionPackageFormAction). An ABSENT accessTarget is REJECTED
// fail-closed — the action refuses to persist the implicit per-kind default
// (WORKSPACE_DEFAULT for artifact/workflow; the config.json-derived default for
// a connector), which would be a silent workspace-wide grant. The kind is
// resolved from the installed canonical row (the pre-install packument probe is
// unreliable) and a fresh install is rolled back on refusal. This is the
// defense-in-depth boundary behind the UI pickers (#1541): every caller —
// including a batch installer / MCP tool / admin script that bypasses the UI —
// hits the same refusal. Kinds NOT in this set have no access semantics and keep
// the direct install path unchanged.
// ---------------------------------------------------------------------------

/** The kinds whose marketplace install offers the pre-install access selector. */
export const INSTALL_ACCESS_TARGET_KINDS = [
  "connector",
  "artifact",
  "workflow",
] as const;

export type InstallAccessTargetKind = (typeof INSTALL_ACCESS_TARGET_KINDS)[number];

export function isInstallAccessTargetKind(
  value: unknown,
): value is InstallAccessTargetKind {
  return (INSTALL_ACCESS_TARGET_KINDS as readonly string[]).includes(
    String(value),
  );
}

export type InstallAccessTarget = {
  // "workspace" / "admin" (cinatra#1527) are the always-offered workspace
  // scopes — both platform-admin-only to install (assertCanInstallAtTarget).
  // "user" stays out (it is not an install target). For workspace/admin the id
  // is the authenticated tenant, re-derived server-side by the install action
  // (never trusted from the client — issue AC3).
  level: "organization" | "team" | "project" | "workspace" | "admin";
  id: string;
};

/**
 * Zod schema for the optional accessTarget the marketplace install action
 * accepts. `level` admits the org/team/project targets plus the two
 * always-offered workspace scopes (cinatra#1527: "workspace" / "admin"). It
 * INTENTIONALLY omits "user" — it is not a selectable install target. NOTE the
 * agent-at-scope install schema (makeInstallRegistryAtScopeInputSchema) is
 * deliberately NARROWER (org/team/project only): workspace/admin map to an
 * AUDIENCE policy, which the extension canonical row supports but the agent
 * install's owner-level persistence does not.
 */
export const InstallAccessTargetSchema: z.ZodType<InstallAccessTarget> =
  z.object({
    level: z.enum(["organization", "team", "project", "workspace", "admin"]),
    id: z.string().min(1),
  });

/**
 * Map the validated target to the install-time access policy.
 * Returns undefined for the organization target so the caller lets
 * setExtensionInstallAccess apply the kind's install default (workspace for
 * artifact/workflow; the cached cinatra/config.json declaration for a
 * connector — cinatra#955).
 *
 * The workspace scopes (cinatra#1527) map to an EXPLICIT audience token so the
 * install-time selection is never silently downgraded to a per-kind default:
 *   - workspace → ["workspace"]  (every workspace member — the established
 *                 workspace visibility tier; see enforce-extension-access).
 *   - admin     → ["admin"]      (the established OWNER-AWARE admin tier:
 *                 platform admins + the owning org's admins/owners; a plain
 *                 member is denied). The target.id is unused here — the
 *                 audience token carries no id — so a client-forged id cannot
 *                 influence the persisted policy.
 */
export function accessTargetToInstallPolicy(
  target: InstallAccessTarget,
): AgentAuthPolicy | undefined {
  if (target.level === "organization") return undefined;
  if (target.level === "workspace" || target.level === "admin") {
    const audience = target.level; // "workspace" | "admin"
    return {
      runListVisibility: [audience],
      runDataVisibility: [audience],
      runExecuteVisibility: [audience],
      allowRunSharing: false,
    };
  }
  const visibility =
    target.level === "team"
      ? (`team:${target.id}` as const)
      : (`project:${target.id}` as const);
  return {
    // Multi-scope W1: non-empty token array (single install target).
    runListVisibility: [visibility],
    runDataVisibility: [visibility],
    runExecuteVisibility: [visibility],
    allowRunSharing: false,
  };
}
