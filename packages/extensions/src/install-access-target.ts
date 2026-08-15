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
//    stays ORG-ANCHORED (ownerLevel "organization") for the organization /
//    team / project targets — the row identity is a lookup key
//    (resolveConnectorResource hard-codes it) and there is no "project" owner
//    level. The chosen audience is carried by the ACCESS POLICY visibility
//    tiers, which enforceExtensionAccess already evaluates ("team:<id>" /
//    "project:<id>" / workspace).
//    SUPERSEDED FOR THE TWO WORKSPACE TARGETS (cinatra#2694/#2695): the
//    `workspace` and `admin` targets resolve to the WORKSPACE ANCHOR tuple
//    (ownerLevel "workspace", organizationId NULL, ownerId
//    PLATFORM_OWNER_SENTINEL) — see accessTargetToRowOwnership below. Those
//    two targets are therefore NOT org-anchored; every other target is
//    unchanged.
//  - organization target → the kind's install default: return undefined so
//    setExtensionInstallAccess applies it — workspace for artifact/workflow,
//    and for a CONNECTOR the policy derived from its own cinatra/config.json
//    declaration cached on the canonical row (cinatra#955).
//  - team / project target → all three visibility fields scoped to the
//    target; sharing disabled (matches the per-kind defaults).
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { AgentAuthPolicy } from "@cinatra-ai/agents/auth-policy-types";

import { PLATFORM_OWNER_SENTINEL } from "./canonical-types";
import type { ExtensionOwnerLevel } from "./canonical-types";

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

// ---------------------------------------------------------------------------
// Target → ROW-OWNERSHIP contract (cinatra#2694 / S1 #2695).
//
// The second half of the target mapping: which canonical `installed_extension`
// row identity an install at each target ANCHORS to. Structurally the
// `RowOwnership` tuple the dependency planner / install batch thread
// (`src/lib/extension-dependency-plan.ts`) — declared here independently so
// this module stays PURE (no server-only import chain).
//
// This module is the CONTRACT only. The write path that persists the tuple
// end-to-end (install action → dependency batch → registry/dispatcher) is S2
// (#2696); the connector substrate is S3 (#2697); lifecycle ops are S4
// (#2698). Nothing here writes a row.
// ---------------------------------------------------------------------------

/**
 * The canonical row-identity tuple an install anchors to —
 * `(organizationId, ownerLevel, ownerId)`. Named `rowOwnership` upstream
 * (NEVER "scope"): this is WHO OWNS the installed row, not who may USE it
 * (that is the audience policy above).
 */
export type InstallRowOwnership = {
  ownerLevel: ExtensionOwnerLevel;
  ownerId: string | null;
  organizationId: string | null;
};

/**
 * The WORKSPACE ANCHOR tuple — the app-wide row identity the two workspace
 * targets resolve to. `organizationId` is NULL by construction, which is
 * exactly what makes the row reach every organization: the cross-org guard in
 * enforceExtensionAccess only fences rows that HAVE an owning org, so an
 * org-NULL anchor is evaluated on its audience tier alone (the same mechanism
 * the system's bundled workspace-tier extensions already ride).
 *
 * The DB admits this shape today — no schema change: the platform-invariant
 * CHECK `installed_extension_platform_invariant_chk` explicitly allows
 * `owner_level='workspace' AND organization_id IS NULL AND
 * owner_id='__platform__'` (src/lib/drizzle-store.ts), and the org-NULL
 * partial identity / one-default indexes
 * (`installed_extension_identity_platform_v_idx`,
 * `installed_extension_one_default_platform_idx`, both `WHERE organization_id
 * IS NULL`, keyed on `owner_level`) key workspace rows apart from
 * platform-bundled ones (src/lib/extension-grant-schema.ts).
 *
 * `ownerId` is the `__platform__` sentinel EXPLICITLY rather than null: the
 * canonical store would normalize null at this tier anyway
 * (`platformizeOwnerId`), but the CHECK constraint names the sentinel, so the
 * contract states it rather than depending on a downstream normalization.
 */
export const WORKSPACE_ANCHOR_ROW_OWNERSHIP: InstallRowOwnership = Object.freeze({
  ownerLevel: "workspace",
  ownerId: PLATFORM_OWNER_SENTINEL,
  organizationId: null,
});

/**
 * Map the validated target to the canonical row-ownership tuple.
 *
 *  - workspace / admin → {@link WORKSPACE_ANCHOR_ROW_OWNERSHIP}. The
 *    installer's active organization is IGNORED (so is `target.id`, which the
 *    picker stamps with the active org id — a client-forged id cannot move the
 *    anchor). These two targets are the ONLY ones whose row is not org-anchored.
 *  - organization / team / project → UNCHANGED: the canonical default derived
 *    from the installer's active organization, byte-identical to
 *    `defaultRowOwnership(activeOrganizationId)` in
 *    src/lib/extension-dependency-plan.ts (an org install is
 *    `organization`-owned; a null-org install is `platform`-owned with a null
 *    ownerId the canonical store platformizes on write). A team / project
 *    target narrows the AUDIENCE, never the row anchor — there is no team or
 *    project owner level on this path.
 */
export function accessTargetToRowOwnership(
  target: InstallAccessTarget,
  activeOrganizationId: string | null,
): InstallRowOwnership {
  if (target.level === "workspace" || target.level === "admin") {
    return { ...WORKSPACE_ANCHOR_ROW_OWNERSHIP };
  }
  const orgId = activeOrganizationId ?? null;
  return {
    ownerLevel: orgId ? "organization" : "platform",
    ownerId: orgId ?? null,
    organizationId: orgId ?? null,
  };
}

/**
 * The whole target→ownership contract in one call: the row anchor plus the
 * audience policy the install persists. This is the seam S2 (#2696) threads
 * end-to-end; callers that need only one half keep using
 * {@link accessTargetToRowOwnership} / {@link accessTargetToInstallPolicy}.
 *
 * `policy: undefined` keeps its established meaning — the organization target
 * defers to the kind's install default (see accessTargetToInstallPolicy).
 */
export function resolveInstallAccessTargetContract(
  target: InstallAccessTarget,
  activeOrganizationId: string | null,
): { rowOwnership: InstallRowOwnership; policy: AgentAuthPolicy | undefined } {
  return {
    rowOwnership: accessTargetToRowOwnership(target, activeOrganizationId),
    policy: accessTargetToInstallPolicy(target),
  };
}

// ---------------------------------------------------------------------------
// The dispatcher-side half of the target→ownership contract (cinatra#2694 /
// S2 #2696): which canonical row identity an install WRITES to. S1 defined the
// CONTRACT above (accessTargetToRowOwnership / resolveInstallAccessTargetContract)
// but nothing persisted it: the dispatcher derived the row anchor solely from
// the actor's active organization, so a "Workspace: All" install still wrote an
// org-anchored row. The helpers below are the seam that closes that gap: the
// install action resolves the tuple, the dependency batch threads it per
// member, and the dispatcher resolves it HERE into the anchor the canonical row
// is created at. They live in this module (not a sibling file) so the
// dispatcher's reachable graph does not grow by a module for a 60-line seam.
// PURE (no IO, no server-only).
// ---------------------------------------------------------------------------

/**
 * The ACTOR-DERIVED default anchor — the tuple the dispatcher has always
 * written: an install with an active organization is `organization`-owned; a
 * null-org install is `platform`-owned with a null ownerId the canonical store
 * platformizes on write. Byte-identical to `defaultRowOwnership(orgId)` in
 * src/lib/extension-dependency-plan.ts and to the organization/team/project
 * branch of `accessTargetToRowOwnership` (S1) — one rule, three call sites.
 */
export function actorDerivedRowAnchor(actorOrgId: string | null): InstallRowOwnership {
  const orgId = actorOrgId ?? null;
  return {
    ownerLevel: orgId ? "organization" : "platform",
    ownerId: orgId ?? null,
    organizationId: orgId ?? null,
  };
}

/**
 * Resolve the canonical row anchor an install writes at.
 *
 *  - `planned` ABSENT (every caller that does not thread the contract — the
 *    direct dispatcher paths, restore/reinstall, the MCP surface) → the
 *    actor-derived default. This is the whole pre-#2696 behavior, unchanged.
 *  - `planned` PRESENT → the planned tuple, verbatim. For the two workspace
 *    install targets that is the workspace anchor (`owner_level='workspace'`,
 *    `organization_id NULL`, `owner_id='__platform__'`), which is precisely what
 *    gives the row app-wide reach: the cross-org guard only fences rows that
 *    HAVE an owning org.
 *
 * The ownerId is normalized for the org-NULL tiers so the row satisfies the
 * platform-invariant CHECK (`installed_extension_platform_invariant_chk`) that
 * NAMES the `__platform__` sentinel, rather than depending on the canonical
 * store's downstream `platformizeOwnerId` normalization.
 */
export function resolveInstallRowAnchor(
  actorOrgId: string | null,
  planned?: InstallRowOwnership | null,
): InstallRowOwnership {
  if (!planned) return actorDerivedRowAnchor(actorOrgId);
  const organizationId = planned.organizationId ?? null;
  const ownerId =
    organizationId === null && planned.ownerLevel !== "user" && planned.ownerLevel !== "team"
      ? (planned.ownerId ?? PLATFORM_OWNER_SENTINEL)
      : (planned.ownerId ?? null);
  return { ownerLevel: planned.ownerLevel, ownerId, organizationId };
}

/**
 * Is this the app-wide WORKSPACE anchor (org-NULL)? The discriminator the write
 * path uses where a workspace-anchored row needs different handling from an
 * org-anchored one — notably the install action's rollback, which cannot route
 * an org-NULL row through the org-pinned lifecycle resolver (that is S4 #2698)
 * and takes the row-scoped inverse instead.
 */
export function isWorkspaceRowAnchor(anchor: InstallRowOwnership): boolean {
  return anchor.ownerLevel === "workspace" && (anchor.organizationId ?? null) === null;
}
