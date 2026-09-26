"use client";

// ---------------------------------------------------------------------------
// Conformance fixtures for the three §II SHARING-tab surfaces (cinatra#3374):
// `connector-sharing` (one panel per owned connection), `connector-sharing-rollup`
// (the roll-up card above the list) and `connector-sharing-locked` (a connector
// that declares a ceiling, or only recommends a scope).
//
// WHAT IS REAL: every rendered element is the shipped implementation of the
// surface — the SDK's own `ConnectorSharingPanels` (which OWNS the three
// conformance ids), the sdk-ui `ConnectionsStatusCard` and
// `ConnectionsList` / `ConnectionRow` beneath it, and the SDK's own
// `PermissionsPanel` the panels component draws itself: the SAME access
// picker and ownership card the permissions surface draws, never a
// connector-specific copy. NO host permissions component is mounted here: the
// fixture drives the export the way a connector pack does, with data and
// callbacks only, so the drivers grade the parts the SDK draws. The product
// route mounts exactly this component tree; only the panels' DATA differs.
//
// WHAT IS SUBSTITUTED (and why): the four server-action bindings
// (`savePolicy`, `searchCandidates`, `addCoOwner`, `removeCoOwner`). They
// require an authenticated session and real `nango_connection` /
// `extension_access_policy` rows, which the standalone conformance harness has
// by construction not got — the same substitution the approvals / scheduling /
// connector-connections fixtures make. Everything the manifest's four actions
// name is driven through the REAL form state machinery; only the round trip is
// answered here.
//
// The ceiling values (`disabledScopes` / `disabledReasons` / the note) are the
// product's own composition — `decideConnectionShareSurface` builds exactly
// these for `only:"admin"`, pinned by src/lib/__tests__/connection-share-ui.test.ts
// — seeded rather than recomputed because that decider is `server-only` and
// reaches the canonical store; importing it here would put DB modules on the
// harness route's graph.
// ---------------------------------------------------------------------------

import * as React from "react";

import type {
  OwnerView,
  PermissionsPanelPolicy,
  PermissionsPanelProps,
  PermissionsPanelResult,
} from "@cinatra-ai/sdk-ui/permissions-panel";
import type { AvailableScopes } from "@cinatra-ai/sdk-ui/access/scope";
import {
  ConnectorSharingPanels,
  type ConnectorSharingPanelView,
} from "@cinatra-ai/sdk-ui/connector-sharing-panels";

import {
  CONNECTOR_SHARING_ACCESS_HELPER,
  CONNECTOR_SHARING_CANDIDATE,
  CONNECTOR_SHARING_CO_OWNER,
  CONNECTOR_SHARING_CONNECTION,
  CONNECTOR_SHARING_INITIAL_SCOPE,
  CONNECTOR_SHARING_OWNER_SCOPE,
  CONNECTOR_SHARING_LOCKED_SCOPES,
  CONNECTOR_SHARING_LOCKED_VALUE,
  CONNECTOR_SHARING_LOCK_NOTE,
  CONNECTOR_SHARING_ORG,
  CONNECTOR_SHARING_OWNER,
  CONNECTOR_SHARING_OWNERSHIP_HELPER,
  CONNECTOR_SHARING_PANEL_COUNT,
  CONNECTOR_SHARING_PROJECT,
  CONNECTOR_SHARING_RECOMMENDATION_NOTE,
  CONNECTOR_SHARING_SEARCH_QUERY,
} from "./connector-sharing-seed";

const SCOPES: AvailableScopes = {
  orgs: [
    {
      id: CONNECTOR_SHARING_ORG.id,
      name: CONNECTOR_SHARING_ORG.name,
      teams: [{ id: CONNECTOR_SHARING_ORG.team.id, name: CONNECTOR_SHARING_ORG.team.name }],
    },
  ],
  projects: [{ id: CONNECTOR_SHARING_PROJECT.id, name: CONNECTOR_SHARING_PROJECT.name }],
  canGrantWorkspace: true,
};

const OWNER: OwnerView = {
  userId: CONNECTOR_SHARING_OWNER.userId,
  name: CONNECTOR_SHARING_OWNER.name,
  email: CONNECTOR_SHARING_OWNER.email,
  image: null,
};

const CO_OWNER: OwnerView = {
  userId: CONNECTOR_SHARING_CO_OWNER.userId,
  name: CONNECTOR_SHARING_CO_OWNER.name,
  email: CONNECTOR_SHARING_CO_OWNER.email,
  image: null,
};

/**
 * The stored grant every seeded panel opens on. `runListVisibility` — the ONE
 * field the access picker binds to — carries a scope that is neither the
 * picker's owner floor nor any override this fixture supplies, and the other
 * two visibility fields keep that floor: a panel that read the wrong field, or
 * ignored the policy altogether, draws a different label and REDS.
 */
const INITIAL_POLICY: PermissionsPanelPolicy = {
  runListVisibility: [CONNECTOR_SHARING_INITIAL_SCOPE],
  runDataVisibility: [CONNECTOR_SHARING_OWNER_SCOPE],
  runExecuteVisibility: [CONNECTOR_SHARING_OWNER_SCOPE],
  allowRunSharing: true,
};

const OK: PermissionsPanelResult = { ok: true };

/** The four bindings the harness answers in the server's place. */
function fixtureActions() {
  return {
    savePolicy: async () => OK,
    searchCandidates: async (query: string) => ({
      ok: true as const,
      results: query && CONNECTOR_SHARING_CANDIDATE.name.toLowerCase().includes(query.toLowerCase())
        ? [
            {
              id: CONNECTOR_SHARING_CANDIDATE.userId,
              name: CONNECTOR_SHARING_CANDIDATE.name,
              email: CONNECTOR_SHARING_CANDIDATE.email,
              image: null,
            },
          ]
        : [],
      hasMore: false,
    }),
    addCoOwner: async () => OK,
    removeCoOwner: async () => OK,
  };
}

/**
 * The connection mount's permissions DATA and bindings: what a connector pack
 * states, and what the product route states. The access picker and the
 * ownership card are drawn by the SDK's own panel from exactly this.
 */
function sharingPermissions(options: {
  coOwners: OwnerView[];
  /**
   * OMITTED by the unconstrained panels, so their picker resolves the stored
   * `policy.runListVisibility` and the field driver reads a real binding. Only
   * a panel whose connector CONSTRAINS the scope states one.
   */
  accessValueOverride?: string;
  accessDisabledScopes?: string[];
  accessDisabledReasons?: Record<string, string>;
  accessScopeNote?: string;
  /** Which line the note is: only the ceiling line carries the lock (cinatra#3454). */
  accessScopeNoteKind?: "locked" | "recommended";
}): PermissionsPanelProps {
  return {
    canEdit: true,
    initialPolicy: INITIAL_POLICY,
    owner: OWNER,
    coOwners: options.coOwners,
    availableScopes: SCOPES,
    currentUserId: OWNER.userId,
    allowSharing: true,
    selfRemoveRedirect: "/connectors",
    accessHelperText: CONNECTOR_SHARING_ACCESS_HELPER,
    ownershipHelperText: CONNECTOR_SHARING_OWNERSHIP_HELPER,
    accessValueOverride: options.accessValueOverride,
    accessDisabledScopes: options.accessDisabledScopes,
    accessDisabledReasons: options.accessDisabledReasons,
    accessScopeNote: options.accessScopeNote,
    accessScopeNoteKind: options.accessScopeNoteKind,
    actions: fixtureActions(),
  };
}

function panel(index: number, extra: Partial<ConnectorSharingPanelView> = {}): ConnectorSharingPanelView {
  return {
    key: `sharing-panel-${index}`,
    // Panel 1 carries the seeded identity the field drivers read; every further
    // panel is distinct so a driver cannot read the wrong row.
    name: index === 0 ? CONNECTOR_SHARING_CONNECTION.name : `${CONNECTOR_SHARING_CONNECTION.name}-${index}`,
    url: CONNECTOR_SHARING_CONNECTION.url,
    scopeConstraint: null,
    permissions: sharingPermissions({
      coOwners: index === 0 ? [CO_OWNER] : [],
    }),
    ...extra,
  };
}

export type ConnectorSharingFixtureVariant =
  | "populated"
  | "locked"
  | "recommended"
  | "loading";

export function ConnectorSharingFixture({
  variant = "populated",
}: {
  variant?: ConnectorSharingFixtureVariant;
}) {
  let panels: ConnectorSharingPanelView[] = [];
  if (variant === "populated") {
    panels = Array.from({ length: CONNECTOR_SHARING_PANEL_COUNT }, (_, i) => panel(i));
  } else if (variant === "locked") {
    panels = [
      panel(0, {
        scopeConstraint: "locked",
        permissions: sharingPermissions({
          coOwners: [],
          accessValueOverride: CONNECTOR_SHARING_LOCKED_VALUE,
          accessDisabledScopes: [...CONNECTOR_SHARING_LOCKED_SCOPES],
          accessDisabledReasons: Object.fromEntries(
            CONNECTOR_SHARING_LOCKED_SCOPES.map((v) => [v, CONNECTOR_SHARING_LOCK_NOTE]),
          ),
          accessScopeNote: CONNECTOR_SHARING_LOCK_NOTE,
          accessScopeNoteKind: "locked",
        }),
      }),
    ];
  } else if (variant === "recommended") {
    panels = [
      panel(0, {
        scopeConstraint: "recommended",
        permissions: sharingPermissions({
          coOwners: [],
          // The recommending connector shares NOTHING until Save is pressed,
          // so its picker states the owner floor its sentence names
          // ("Currently: only you") — distinct from the stored scope above.
          accessValueOverride: CONNECTOR_SHARING_OWNER_SCOPE,
          accessScopeNote: CONNECTOR_SHARING_RECOMMENDATION_NOTE,
          accessScopeNoteKind: "recommended",
        }),
      }),
    ];
  }

  return (
    <div
      data-surface-id="connector-sharing"
      data-variant={variant}
      className="flex w-full max-w-3xl flex-col gap-4"
    >
      <ConnectorSharingPanels
        panels={panels}
        state={variant === "loading" ? "loading" : "ready"}
      />
    </div>
  );
}

export { CONNECTOR_SHARING_SEARCH_QUERY };
