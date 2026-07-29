import "server-only";

// The org-admin surface for the per-instance destructive-confirmation
// override (cinatra#2020 design §7.2, PR-4) — the machinery half of the
// org-disable switch. S5 ships these two ADDITIVE host-local members on the
// existing `wordpress-mcp` publication (the S3 manual-route / S4 consent
// precedent: structural members, frozen SDK contract untouched; an older
// consumer simply lacks them, which reads fail-closed); S7 ships the settings
// toggle that calls them.
//
// AUTHORIZATION lives INSIDE the members (the S4
// connector-instance-native-injection-consent pattern, mirrored verbatim):
// an authenticated cookie session AND `connector.update` (org_admin+) in the
// org that OWNS the instance — resolved from the persisted instance row,
// never caller input, no platform-admin synthesis. Every failure mode
// (unknown instance, unbound instance, membership lookup error, non-member,
// non-admin) throws the SAME opaque refusal — no existence oracle.
//
// SEMANTICS: `mode: "disabled"` turns require-confirmation OFF for that ONE
// instance (the D7 matrix's org-disable leg — the destructive hook reads it
// per park decision); `mode: "default"` restores the surface defaults. The
// store's `confirmation_policy_changed` audit rides every write. The hook
// fail-SAFES an unknown stored mode to NOT-disabled, so a garbled row can
// never silently drop the confirmation gate.

import { roleHasPermission } from "@/lib/authz/policies";
import type { AuthzOrgRole } from "@/lib/auth-session";
import {
  readConfirmationPolicy,
  setConfirmationPolicy,
  type ConnectorInstanceConfirmationPolicyMode,
} from "@/lib/connector-instance-pending-call-store";

/** The view the members return — absent row reads as the defaults. */
export type InstanceConfirmationPolicyView = {
  instanceId: string;
  mode: ConnectorInstanceConfirmationPolicyMode;
  /** Present only when an explicit override row exists. */
  updatedBy?: string;
  updatedAt?: string;
};

/** Typed refusal every gate failure throws. Fail-closed: the caller MUST
 * surface it as a refusal, never fall back to a write. */
export class ConnectorInstanceConfirmationPolicyError extends Error {
  readonly reason: "invalid_input" | "invalid_mode" | "not_authorized_for_instance";
  constructor(reason: ConnectorInstanceConfirmationPolicyError["reason"]) {
    super(`connector-instance confirmation policy refused: ${reason}`);
    this.name = "ConnectorInstanceConfirmationPolicyError";
    this.reason = reason;
  }
}

/** The structural surface the `wordpress-mcp` publication is widened with
 * (host-local — deliberately NOT an SDK contract member). */
export type WordPressConfirmationPolicySurface = {
  /** Current per-instance override state (org-admin-gated read). */
  readInstanceConfirmationPolicy(input: {
    instanceId: string;
  }): Promise<InstanceConfirmationPolicyView>;
  /** Flip the override (org-admin-gated write; store-audited). Returns the
   * persisted state after the write. */
  setInstanceConfirmationPolicy(input: {
    instanceId: string;
    mode: ConnectorInstanceConfirmationPolicyMode;
  }): Promise<InstanceConfirmationPolicyView>;
};

export type ConfirmationPolicySurfaceDeps = {
  /** The host-bound connector this publication governs (never caller input). */
  connectorKey: string;
  /** The cookie-session requirement (`requireAuthSession` host-side). */
  requireSession: () => Promise<{ user: { id: string } }>;
  /** Resolve the org that OWNS an instance from the persisted row — host-side,
   * never caller input. `null` for an unknown or org-unbound instance. */
  resolveInstanceOrgId: (instanceId: string) => string | null;
  /** Membership-role lookup in the owning org (`resolveOrgRoleForUser`). */
  resolveOrgRole: (orgId: string, userId: string) => Promise<AuthzOrgRole | undefined>;
  /** Store read/write (defaults = the stage-1 store; tests inject doubles). */
  readPolicy?: typeof readConfirmationPolicy;
  writePolicy?: typeof setConfirmationPolicy;
};

const MODES = new Set<ConnectorInstanceConfirmationPolicyMode>(["default", "disabled"]);

/**
 * Build the two publication members. The binder calls this once at publish
 * time with the live host deps; tests call it with fakes.
 */
export function createConfirmationPolicySurfaceMembers(
  deps: ConfirmationPolicySurfaceDeps,
): WordPressConfirmationPolicySurface {
  const readPolicy = deps.readPolicy ?? readConfirmationPolicy;
  const writePolicy = deps.writePolicy ?? setConfirmationPolicy;

  /** Session + owning-org + org-admin (`connector.update`) gate — the S4
   * consent gate mirrored: every failure mode collapses to the same opaque
   * refusal (fail-closed, no existence oracle). */
  async function requireOrgAdminForInstance(
    instanceId: unknown,
  ): Promise<{ userId: string }> {
    if (typeof instanceId !== "string" || !instanceId.trim()) {
      throw new ConnectorInstanceConfirmationPolicyError("invalid_input");
    }
    const session = await deps.requireSession();
    const userId = session?.user?.id;
    if (!userId) {
      throw new ConnectorInstanceConfirmationPolicyError("not_authorized_for_instance");
    }
    let orgId: string | null = null;
    try {
      orgId = deps.resolveInstanceOrgId(instanceId);
    } catch {
      orgId = null;
    }
    if (!orgId) {
      throw new ConnectorInstanceConfirmationPolicyError("not_authorized_for_instance");
    }
    const role = await deps.resolveOrgRole(orgId, userId).catch(() => undefined);
    if (!role || !roleHasPermission(role, "connector.update")) {
      throw new ConnectorInstanceConfirmationPolicyError("not_authorized_for_instance");
    }
    return { userId };
  }

  async function readView(instanceId: string): Promise<InstanceConfirmationPolicyView> {
    const record = await readPolicy(deps.connectorKey, instanceId);
    if (!record) return { instanceId, mode: "default" };
    // Fail-SAFE an unknown stored mode to NOT-disabled (require stays on).
    const mode: ConnectorInstanceConfirmationPolicyMode =
      record.mode === "disabled" ? "disabled" : "default";
    return {
      instanceId,
      mode,
      updatedBy: record.updatedBy,
      updatedAt: record.updatedAt,
    };
  }

  return {
    async readInstanceConfirmationPolicy(input) {
      await requireOrgAdminForInstance(input?.instanceId);
      return readView(input.instanceId);
    },
    async setInstanceConfirmationPolicy(input) {
      const { userId } = await requireOrgAdminForInstance(input?.instanceId);
      const mode = input?.mode;
      if (!MODES.has(mode as ConnectorInstanceConfirmationPolicyMode)) {
        throw new ConnectorInstanceConfirmationPolicyError("invalid_mode");
      }
      await writePolicy({
        connectorKey: deps.connectorKey,
        instanceId: input.instanceId,
        mode: mode as ConnectorInstanceConfirmationPolicyMode,
        updatedBy: userId,
      });
      return readView(input.instanceId);
    },
  };
}
