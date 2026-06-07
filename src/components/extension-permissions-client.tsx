"use client";

// ---------------------------------------------------------------------------
// Generic ExtensionPermissionsClient.
//
// One client wrapper that binds the kind-discriminated server actions in
// @cinatra-ai/extensions/permissions-actions to the generic <PermissionsForm>
// widget for every extension kind. This replaces the near-identical per-kind
// wrappers for agent runs, skill packages, and skills.
//
// All call sites pass `kind` + `resourceId`. Optional `removeOwner` lets the
// agent_run mount keep its existing semantic (clear runBy + last-owner guard)
// without polluting the generic store path.
// ---------------------------------------------------------------------------

import type { AgentAuthPolicy } from "@cinatra-ai/agents/auth-policy";
import {
  addExtensionCoOwner,
  removeExtensionCoOwner,
  saveExtensionAccessPolicy,
  searchExtensionCoOwnerCandidates,
} from "@cinatra-ai/extensions/permissions-actions";
import type { ExtensionKind } from "@cinatra-ai/extensions/permissions-kind-hooks";

import {
  PermissionsForm,
  type OwnerView,
  type PermissionsFormResult,
} from "@/components/permissions-form";
import type { AvailableScopes } from "@/components/access-combobox-hierarchical";

export type ExtensionPermissionsClientProps = {
  kind: ExtensionKind;
  resourceId: string;
  canEdit: boolean;
  initialPolicy: AgentAuthPolicy;
  owner: OwnerView | null;
  coOwners: OwnerView[];
  availableScopes: AvailableScopes;
  currentUserId: string | null;
  /**
   * Whether co-owner add / remove UI should be shown. Agent runs gate this
   * on policy.allowRunSharing; other kinds usually bind to `canEdit`.
   */
  allowSharing: boolean;
  /**
   * Optional kind-specific primary-owner clear. Only agent_run currently
   * exposes this (clears agent_runs.run_by, last-owner guard). Other kinds
   * have intrinsic primary owners and omit this prop.
   */
  removeOwner?: () => Promise<PermissionsFormResult>;
  /**
   * Optional override for the redirect target after a self-removal that
   * loses access. When omitted, PermissionsForm falls back to a kind-derived
   * default (/skills, /configuration/extensions, etc).
   */
  selfRemoveRedirect?: string;
  /** Optional helper-text overrides forwarded verbatim. */
  accessHelperText?: string;
  ownershipHelperText?: string;
};

export function ExtensionPermissionsClient({
  kind,
  resourceId,
  canEdit,
  initialPolicy,
  owner,
  coOwners,
  availableScopes,
  currentUserId,
  allowSharing,
  removeOwner,
  selfRemoveRedirect,
  accessHelperText,
  ownershipHelperText,
}: ExtensionPermissionsClientProps) {
  return (
    <PermissionsForm
      resourceKind={kind}
      canEdit={canEdit}
      initialPolicy={initialPolicy}
      owner={owner}
      coOwners={coOwners}
      availableScopes={availableScopes}
      currentUserId={currentUserId}
      allowSharing={allowSharing}
      selfRemoveRedirect={selfRemoveRedirect}
      accessHelperText={accessHelperText}
      ownershipHelperText={ownershipHelperText}
      actions={{
        savePolicy: (policy) =>
          saveExtensionAccessPolicy(kind, resourceId, policy),
        searchCandidates: async (query, page) => {
          const result = await searchExtensionCoOwnerCandidates(
            kind,
            resourceId,
            query,
            page,
          );
          if (!result.ok) return { ok: false, error: result.error };
          return {
            ok: true,
            results: result.results,
            hasMore: result.hasMore,
          };
        },
        addCoOwner: (userId) =>
          addExtensionCoOwner(kind, resourceId, userId),
        removeCoOwner: (userId) =>
          removeExtensionCoOwner(kind, resourceId, userId),
        removeOwner,
      }}
    />
  );
}
