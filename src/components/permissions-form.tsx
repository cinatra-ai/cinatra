"use client";

// ---------------------------------------------------------------------------
// PermissionsForm: the HOST BINDING over the shared permissions panel.
//
// The anatomy this widget draws (the access picker, the ownership card, the
// scope line, the Save bar and the self-removal confirm) moved into
// `@cinatra-ai/sdk-ui/permissions-panel` (cinatra#3385), so the connector
// Sharing tab draws the same controls whether the app's generated page or a
// connector pack's own page draws them. One implementation, never two copies.
//
// This file keeps the host's side of the seam, and its props are unchanged:
//
//   • the kind-derived redirect target for a self-removal that loses access
//     (a route only the app knows), and
//   • the resource-kind vocabulary every existing caller passes.
//
// Every caller mounts this path exactly as before: agent runs, agent
// templates, skill packages, skills, connectors, artifacts, workflows and
// per-connection grants.
//
//   • agent runs: packages/agents/src/instance-screens.tsx
//   • skill packages and skills: packages/skills/src/plugin-pages.tsx
//   • per-connection grants: src/components/extensions/connection-sharing-section.tsx
//
// Behaviour preserved verbatim: the cmdk combobox in a popover with a 300 ms
// debounce (0 ms on open) and `shouldFilter={false}`, 20 rows a page fetched
// within 64 px of the bottom, optimistic add and remove, the last-owner guard,
// and the self-removal confirm that navigates only after the server confirms.
// ---------------------------------------------------------------------------

import type { AgentAuthPolicy } from "@cinatra-ai/agents/auth-policy";

import {
  PermissionsPanel,
  type OwnerView,
  type SharingCandidate,
  type PermissionsPanelResult,
  type PermissionsPanelSearchResult,
  type PermissionsPanelActions,
} from "@cinatra-ai/sdk-ui/permissions-panel";
import type { AvailableScopes, AllowedScopes } from "@/components/access-combobox";

// ---------------------------------------------------------------------------
// Shared types. The panel owns the shapes; these names stay the in-app import.
// ---------------------------------------------------------------------------

export type { OwnerView, SharingCandidate };
export type PermissionsFormResult = PermissionsPanelResult;
export type PermissionsFormSearchResult = PermissionsPanelSearchResult;
export type PermissionsFormActions = PermissionsPanelActions;

export type PermissionsFormResourceKind =
  | "agent_run"
  | "agent_template"
  | "skill_package"
  | "skill"
  // The uniform access model covers connector / artifact / workflow too.
  // Kept in lockstep with @cinatra-ai/extensions ExtensionKind (client-safe
  // literal copy — permissions-kind-hooks is server-only, so this union is not
  // imported from it).
  | "connector"
  | "artifact"
  | "workflow"
  // Per-connection grants (cinatra#950/#951): resource_id is the
  // nango_connection identity UUID.
  | "connection";

export type PermissionsFormProps = {
  resourceKind: PermissionsFormResourceKind;
  /** Whether the viewing actor may edit (admin / owner). */
  canEdit: boolean;
  /** Initial access policy (locksteps list/data/execute visibility in v1). */
  initialPolicy: AgentAuthPolicy;
  /** Resource's primary owner (the user who created it). */
  owner: OwnerView | null;
  /** Co-owners (excluding the primary owner). */
  coOwners: OwnerView[];
  /** Available scopes for the access picker. */
  availableScopes: AvailableScopes;
  /**
   * Containment (cinatra#1607 §6.4): restrict the offered scopes to a parent's
   * allowed set. Forwarded verbatim to the picker's first-class `allowedScopes`
   * prop; the agent_run form derives it from the parent agent_template's policy.
   * Absent → the picker offers every available scope (unchanged behaviour).
   */
  allowedScopes?: AllowedScopes;
  /** The logged-in user — used to detect self-removal. */
  currentUserId: string | null;
  /** When false, the add UI + remove buttons are hidden, lock icon shown. */
  allowSharing: boolean;
  /** Server-action bindings. */
  actions: PermissionsFormActions;
  /** Where to redirect on a self-removal that loses access. */
  selfRemoveRedirect?: string;
  /**
   * Override the default "Choose who can find and view it." helper text under
   * the access combobox. Optional.
   */
  accessHelperText?: string;
  /**
   * Override the default ownership helper text under the user-search input.
   * Optional.
   */
  ownershipHelperText?: string;
  /**
   * Value the access picker OPENS on instead of the stored policy value
   * (cinatra#953 W3): the connection share surface passes the connector's
   * `access.scope.default` recommendation while the stored policy is the
   * untouched connect-time seed, or the canonical only-value under a lock.
   * PRE-SELECTION ONLY — nothing changes until the user explicitly saves.
   */
  accessValueOverride?: string;
  /** Per-scope disabled option values forwarded to the access picker
   * (the connector `only:*` lock affordance — the server re-rejects). */
  accessDisabledScopes?: string[];
  /** Tooltip per disabled option value. */
  accessDisabledReasons?: Record<string, string>;
  /** Rendered under the picker: the lock note ("Locked by this connector…")
   * or the default-recommendation note. */
  accessScopeNote?: string;
};

// ---------------------------------------------------------------------------
// Host-only knowledge: where a self-removal lands when the caller states no
// target. These are app routes, so the panel takes the resolved string.
// ---------------------------------------------------------------------------

export function defaultRedirectFor(resourceKind: PermissionsFormResourceKind): string {
  if (resourceKind === "skill_package" || resourceKind === "skill") return "/skills";
  if (resourceKind === "agent_template") return "/configuration/extensions";
  return "/agents";
}

export function PermissionsForm({
  resourceKind,
  canEdit,
  initialPolicy,
  owner,
  coOwners,
  availableScopes,
  allowedScopes,
  currentUserId,
  allowSharing,
  actions,
  selfRemoveRedirect,
  accessHelperText,
  ownershipHelperText,
  accessValueOverride,
  accessDisabledScopes,
  accessDisabledReasons,
  accessScopeNote,
}: PermissionsFormProps) {
  return (
    <PermissionsPanel
      canEdit={canEdit}
      initialPolicy={initialPolicy}
      owner={owner}
      coOwners={coOwners}
      availableScopes={availableScopes}
      allowedScopes={allowedScopes}
      currentUserId={currentUserId}
      allowSharing={allowSharing}
      selfRemoveRedirect={selfRemoveRedirect ?? defaultRedirectFor(resourceKind)}
      accessHelperText={accessHelperText}
      ownershipHelperText={ownershipHelperText}
      accessValueOverride={accessValueOverride}
      accessDisabledScopes={accessDisabledScopes}
      accessDisabledReasons={accessDisabledReasons}
      accessScopeNote={accessScopeNote}
      actions={actions}
    />
  );
}
