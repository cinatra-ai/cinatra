import "server-only";

import type { ActorContext } from "@/lib/authz/actor-context";
import { getConnectorDescriptorByPackageId } from "@cinatra-ai/connectors-catalog/descriptors.mjs";
import {
  readConnectorAccessPolicy,
  type ConnectorVisibility,
} from "@/lib/connector-policy-store";
import { resolveConnectorCanonicalAccessSync } from "@/lib/connector-access-resolver";
import {
  evaluateExtensionAccess,
  type ExtensionAccessOp,
} from "@cinatra-ai/extensions/enforce-extension-access";
import type { AgentAuthPolicy } from "@cinatra-ai/agents/auth-policy";

// `enforceConnectorPolicy(packageId, actor, mode)`.
//
// Connector access flows through the UNIFORM polymorphic model. Resolves
// the canonical connector `installed_extension` + its `extension_access_policy`
// and delegates to the pure `evaluateExtensionAccess`. When no canonical row
// exists for the org (not yet migrated), it falls back to the legacy
// `connector_access_policy` read — an ABSENCE-ONLY shim (never on error) that
// is removed after production migration. `manage` always requires
// org_admin / org_owner / platform_admin (preserved by the uniform manage gate).

export type ConnectorPolicyMode = "read" | "use" | "manage";

export type ConnectorPolicyDecision = {
  allowed: boolean;
  reason?: string;
  visibility: ConnectorVisibility;
};

const CONNECTOR_MODE_TO_OP: Record<ConnectorPolicyMode, ExtensionAccessOp> = {
  read: "read",
  use: "use",
  manage: "manage",
};

let warnedLegacyFallback = false;

export function isOrgAdmin(actor: ActorContext): boolean {
  return (
    actor.orgRole === "org_owner" ||
    actor.orgRole === "org_admin" ||
    actor.platformRole === "platform_admin"
  );
}

// Map a canonical policy's data-visibility back to the 2-tier
// ConnectorVisibility surfaced in the decision (connectors only ever store
// workspace|admin).
function visibilityFromPolicy(policy: AgentAuthPolicy | null): ConnectorVisibility {
  return policy?.runDataVisibility === "admin" ? "admin" : "workspace";
}

function policyFromVisibility(visibility: ConnectorVisibility): AgentAuthPolicy {
  return {
    runListVisibility: visibility,
    runDataVisibility: visibility,
    runExecuteVisibility: visibility,
    allowRunSharing: false,
  };
}

function resolveEffectiveVisibility(
  packageId: string,
  orgId: string | undefined,
): ConnectorVisibility | undefined {
  const descriptor = getConnectorDescriptorByPackageId(packageId);
  if (!descriptor) return undefined;
  if (orgId) {
    try {
      const row = readConnectorAccessPolicy(orgId, packageId);
      if (row) return row.visibility;
    } catch {
      // Fall through to catalog default if the DB lookup fails (e.g. tests
      // that don't stub postgres-sync). The catalog default is the safe
      // baseline — for admin-default connectors that means stricter not
      // looser visibility.
    }
  }
  return descriptor.defaultVisibility;
}

export function enforceConnectorPolicy(
  packageId: string,
  actor: ActorContext | undefined,
  mode: ConnectorPolicyMode = "read",
): ConnectorPolicyDecision {
  const descriptor = getConnectorDescriptorByPackageId(packageId);
  if (!descriptor) {
    return { allowed: false, reason: "unknown_connector", visibility: "admin" };
  }
  if (!actor) {
    return {
      allowed: false,
      reason: "no_actor",
      visibility: descriptor.defaultVisibility,
    };
  }

  // Canonical-first: delegate to the uniform evaluator when a migrated
  // connector install row exists for the actor's org.
  const canonical = resolveConnectorCanonicalAccessSync(actor.organizationId, packageId);
  if (canonical.status === "error") {
    // Fail closed on a canonical read error — do NOT fall back to the possibly
    // looser legacy/catalog default (that could grant access a tighter
    // canonical policy denies).
    return { allowed: false, reason: "access_read_error", visibility: descriptor.defaultVisibility };
  }
  if (canonical.status === "found") {
    const { access } = canonical;
    const effectivePolicy = access.policy ?? policyFromVisibility(descriptor.defaultVisibility);
    const visibility = visibilityFromPolicy(effectivePolicy);
    // Connector `manage` stays ADMIN-ONLY (preserve the legacy rule): the
    // uniform `manage` op also admits installer/co-owners, which would broaden
    // who can manage a connector. Gate it here before delegating.
    if (mode === "manage") {
      return isOrgAdmin(actor)
        ? { allowed: true, visibility }
        : { allowed: false, reason: "manage_requires_admin", visibility };
    }
    const decision = evaluateExtensionAccess({
      policy: effectivePolicy,
      coOwnerUserIds: access.coOwnerUserIds,
      installedByUserId: access.installedByUserId,
      owner: access.owner,
      actor,
      op: CONNECTOR_MODE_TO_OP[mode],
    });
    return decision.allowed
      ? { allowed: true, visibility }
      : { allowed: false, reason: decision.reason, visibility };
  }

  // status === "absent" → absence-only legacy fallback (org not yet migrated).
  // Removed after prod migration. Warn once per process so the deprecation is
  // visible without spamming sync render paths.
  if (!warnedLegacyFallback) {
    warnedLegacyFallback = true;
    // eslint-disable-next-line no-console
    console.warn(
      "[connector-policy] using legacy connector_access_policy fallback — run the connector migration to move off it.",
    );
  }
  const visibility =
    resolveEffectiveVisibility(packageId, actor.organizationId) ??
    descriptor.defaultVisibility;

  if (mode === "manage") {
    return isOrgAdmin(actor)
      ? { allowed: true, visibility }
      : { allowed: false, reason: "manage_requires_admin", visibility };
  }

  if (visibility === "admin") {
    return isOrgAdmin(actor)
      ? { allowed: true, visibility }
      : { allowed: false, reason: "admin_only_connector", visibility };
  }

  return { allowed: true, visibility };
}

/**
 * Action-path policy used ONLY by the extension-action guard. Identical to
 * `enforceConnectorPolicy` except it adds a generic fallback for INFRASTRUCTURE
 * connectors that have no user-facing catalog descriptor (e.g. the Nango
 * gateway). Those surface as `unknown_connector`; their `manage` actions require
 * plain org-admin (a workspace-wide infra credential) and `read` is allowed.
 *
 * Catalog connectors are unaffected — the fallback only triggers on
 * `unknown_connector`, so every other deny reason (`no_actor`,
 * `manage_requires_admin`, `admin_only_connector`, `access_read_error`) is
 * returned unchanged. The render-time visibility path keeps the strict
 * `enforceConnectorPolicy` (unknown → not visible). Generic: no per-connector
 * host knowledge, so core never names a specific extension. `requireExtensionAction`
 * is only ever called with a connector's own static packageId, so there is no
 * untrusted-packageId path that could exploit the relaxed branch.
 */
export function enforceConnectorActionPolicy(
  packageId: string,
  actor: ActorContext | undefined,
  mode: ConnectorPolicyMode = "read",
): ConnectorPolicyDecision {
  const decision = enforceConnectorPolicy(packageId, actor, mode);
  if (decision.allowed) return decision;
  if (decision.reason === "unknown_connector" && actor && (mode !== "manage" || isOrgAdmin(actor))) {
    return { allowed: true, visibility: "admin" };
  }
  return decision;
}

export function isConnectorVisibleToActor(
  packageId: string,
  actor: ActorContext | undefined,
): boolean {
  return enforceConnectorPolicy(packageId, actor, "read").allowed;
}
