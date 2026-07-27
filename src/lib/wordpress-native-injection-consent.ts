import "server-only";

// The org-admin OPT-IN surface for WordPress trusted-site native injection
// (cinatra#2019 S4): the `readNativeInjectionPolicy` / `setNativeInjectionMode`
// members the host binds onto the existing `wordpress-mcp` publication
// (register-host-connector-services.ts). ADDITIVE host-local members typed
// host-side — the frozen SDK `HostWordPressMcpService` contract is untouched;
// the connector resolves them structurally and treats their absence as an
// older host (fail-closed: no members, no way to enable).
//
// AUTHORIZATION IS INSIDE THE MEMBER (never connector-side): every call
// requires an authenticated cookie session AND `connector.update` (org_admin+)
// membership in the org that OWNS the instance, resolved host-side from the
// persisted instance row — never from caller input. One opaque refusal covers
// unknown instance / unbound instance / non-member / non-admin alike, so the
// member is not an instance-existence oracle. There is deliberately NO
// platform-admin synthesis: a platform admin who is not a member of the
// owning org is refused like any other non-member (the organization-manage
// gate invariant).
//
// CONSENT IS HOST-STAMPED AND CONTENT-EXACT: on `trusted_site` the member
// stamps the row with the CURRENTLY SHIPPED
// `{descriptor-set version, descriptor-set hash, disclosure version}` from
// wordpress-trusted-read-descriptors.ts. The caller chooses ONLY the mode —
// any stamp-shaped fields on the input are ignored, so a skewed or buggy
// connector/UI cannot forge an acknowledgement of content that is not the
// content actually shipped. The injection builder refuses stamps that are not
// exactly the shipped constants, which is what makes a descriptor-set or
// disclosure change force a fresh acknowledgement ceremony (and what keeps a
// rollback from resurrecting an acknowledgement of newer content).
//
// CONSENT IS ORG-BOUND: the gate-resolved owning org is recorded on the row
// and every read is evaluated AGAINST the instance's current owner — an
// instance id that changes hands never carries the previous org's consent
// (the new owner runs its own ceremony).
//
// DORMANT SURFACE: nothing consumes the persisted mode yet — the connector
// toolbox stays hard-guarded to emit nothing until the guard-replacement
// slice, so enabling here changes no injection behavior on today's stack.

import { roleHasPermission } from "@/lib/authz/policies";
import type { AuthzOrgRole } from "@/lib/auth-session";
import type {
  NativeInjectionMode,
  NativeInjectionPolicyView,
  SetNativeInjectionModeInput,
} from "@/lib/connector-instance-native-injection-store";
import {
  resolveShippedTrustedSiteConsent,
  type ShippedTrustedSiteConsent,
} from "@/lib/wordpress-trusted-read-descriptors";

/** The host-bound connector key these members are hard-pinned to. */
const WORDPRESS_CONNECTOR_KEY = "wordpress";

/** Typed refusal every gate failure throws. Fail-closed: the connector/UI
 * MUST surface it as a refusal, never fall back to a write. */
export class WordPressNativeInjectionConsentError extends Error {
  readonly reason:
    | "invalid_input"
    | "invalid_mode"
    | "not_authorized_for_instance";
  constructor(reason: WordPressNativeInjectionConsentError["reason"]) {
    super(`wordpress native-injection consent refused: ${reason}`);
    this.name = "WordPressNativeInjectionConsentError";
    this.reason = reason;
  }
}

/** The structural surface the `wordpress-mcp` publication is widened with
 * (host-local — deliberately NOT an SDK contract member). */
export type WordPressNativeInjectionConsentSurface = {
  /** Current opt-in state for one instance (org-admin-gated read). */
  readNativeInjectionPolicy(input: { instanceId: string }): Promise<NativeInjectionPolicyView>;
  /** Flip the opt-in mode (org-admin-gated write; host-stamped consent).
   * Returns the persisted state after the write. */
  setNativeInjectionMode(input: {
    instanceId: string;
    mode: NativeInjectionMode;
  }): Promise<NativeInjectionPolicyView>;
};

export type WordPressNativeInjectionConsentDeps = {
  /** The cookie-session requirement (`requireAuthSession` host-side; throws /
   * redirects for an unauthenticated caller). */
  requireSession: () => Promise<{ user: { id: string } }>;
  /** Resolve the org that OWNS an instance from the persisted row — host-side,
   * never caller input. `null` for an unknown or org-unbound instance. */
  resolveInstanceOrgId: (instanceId: string) => string | null;
  /** Membership-role lookup in the owning org (`resolveOrgRoleForUser`). */
  resolveOrgRole: (orgId: string, userId: string) => Promise<AuthzOrgRole | undefined>;
  /** The persistence reader/writer (connector-instance-native-injection-store).
   * Reads are OWNER-SCOPED: the gate-resolved owning org rides every call. */
  readPolicy: (
    connectorKey: string,
    instanceId: string,
    ownerOrgId: string,
  ) => Promise<NativeInjectionPolicyView>;
  writeMode: (input: SetNativeInjectionModeInput) => Promise<void>;
  /** TEST-ONLY override of the shipped consent stamps. The production binder
   * never passes it — the factory resolves the real shipped constants. */
  shippedConsent?: ShippedTrustedSiteConsent;
};

/**
 * Build the two publication members. The binder calls this once at publish
 * time with the live host deps; tests call it with fakes.
 */
export function createWordPressNativeInjectionConsentMembers(
  deps: WordPressNativeInjectionConsentDeps,
): WordPressNativeInjectionConsentSurface {
  const shipped = deps.shippedConsent ?? resolveShippedTrustedSiteConsent();

  /** Session + owning-org + org-admin (`connector.update`) gate. Returns the
   * authenticated admin's user id AND the instance's owning org (the org the
   * gate was evaluated against — the same org every store call is scoped to).
   * Every failure mode — unknown instance, unbound instance, membership
   * lookup error, non-member, non-admin — throws the SAME opaque refusal
   * (fail-closed, no existence oracle). */
  async function requireOrgAdminForInstance(
    instanceId: unknown,
  ): Promise<{ userId: string; orgId: string }> {
    if (typeof instanceId !== "string" || !instanceId.trim()) {
      throw new WordPressNativeInjectionConsentError("invalid_input");
    }
    const session = await deps.requireSession();
    const userId = session?.user?.id;
    if (!userId) {
      throw new WordPressNativeInjectionConsentError("not_authorized_for_instance");
    }
    // A throwing instance/org lookup is UNCERTAINTY, not an internal error to
    // surface: it collapses to the same opaque refusal (fail-closed, and no
    // internal error shape leaks to the connector).
    let orgId: string | null = null;
    try {
      orgId = deps.resolveInstanceOrgId(instanceId);
    } catch {
      orgId = null;
    }
    if (!orgId) {
      throw new WordPressNativeInjectionConsentError("not_authorized_for_instance");
    }
    const role = await deps.resolveOrgRole(orgId, userId).catch(() => undefined);
    if (!role || !roleHasPermission(role, "connector.update")) {
      throw new WordPressNativeInjectionConsentError("not_authorized_for_instance");
    }
    return { userId, orgId };
  }

  return {
    readNativeInjectionPolicy: async (input) => {
      const { orgId } = await requireOrgAdminForInstance(input?.instanceId);
      return deps.readPolicy(WORDPRESS_CONNECTOR_KEY, input.instanceId, orgId);
    },
    setNativeInjectionMode: async (input) => {
      const { userId, orgId } = await requireOrgAdminForInstance(input?.instanceId);
      const mode = input?.mode;
      if (mode !== "off" && mode !== "trusted_site") {
        throw new WordPressNativeInjectionConsentError("invalid_mode");
      }
      await deps.writeMode({
        connectorKey: WORDPRESS_CONNECTOR_KEY,
        instanceId: input.instanceId,
        mode,
        actorUserId: userId,
        actorOrgId: orgId,
        // HOST-STAMPED consent — always the shipped constants, never input.
        ...(mode === "trusted_site"
          ? {
              disclosureVersion: shipped.disclosureVersion,
              descriptorSetVersion: shipped.descriptorSetVersion,
              descriptorSetHash: shipped.descriptorSetHash,
            }
          : {}),
      });
      return deps.readPolicy(WORDPRESS_CONNECTOR_KEY, input.instanceId, orgId);
    },
  };
}
