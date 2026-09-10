import "server-only";

// ---------------------------------------------------------------------------
// ConnectionSharingSection (cinatra#953 W3; moved onto its own tab by
// cinatra#3374) — the HOST-owned per-connection share surface. On the generated
// setup page it is the body of the FIXED SECOND TAB, Sharing (§II: "sharing is
// decided on its own tab, never inside Setup"); the route still mounts it
// directly on the branches that draw no tab strip (invalid-schema-config, the
// rebuild states, and the bundled-react pages — codex round-0 finding 4).
//
// Lists the ACTOR's OWN saved connections for THIS connector (owner-bound
// entities — the owner manages their own grants; deliberately NO cross-owner
// listing and NO pinning/candidate-selection affordance, per the W2 ambiguity
// ruling) and mounts the generic six-scope permissions widget per connection:
//
//   • `access.scope.default` PRE-SELECTED while the stored grant is the
//     untouched connect seed — never auto-shares; the owner must save.
//   • `access.scope.only` renders the picker LOCKED at the only-value (every
//     out-of-ceiling option disabled) — the AFFORDANCE; the server write path
//     (`saveExtensionAccessPolicy` → connection kind hook) independently
//     REJECTS out-of-ceiling grants with `scope_locked_by_connector`.
//   • `only:"user"` (or an unreadable declaration) renders NOTHING — the
//     sharing surface is removed entirely.
//
// Grants are issued against REAL loci: the picker's org/team/project options
// come from the actor's actual memberships (AvailableScopes) — the exact
// `org:<id>` / `team:<id>` / `project:<id>` tokens `evaluateExtensionAccess`
// enforces at use time.
//
// ---------------------------------------------------------------------------
// THE REAL PRODUCT CONSUMER of the §II connection primitives (cinatra#2357,
// closing the #2382 §4 disclosure).
//
// `ConnectionsList` / `ConnectionRow` / `ConnectionsStatusCard` shipped with
// #2354 with NO core consumer: the conformance harness played the consumer
// itself, so the only thing exercising the row primitive's status→presentation
// derivation was test-owned wiring. This section is the host surface that has
// always listed the actor's own saved connections for a connector — it just
// drew its own identity line (a bare mono `<p>` of the connection id, and only
// when there was more than one). It now composes the SHIPPED primitives:
//
//   • the roll-up `ConnectionsStatusCard` heads the section — "The roll-up card
//     is the Connections status card of the Setup tab, with no Check and no All
//     connections link: the list it counts is directly beneath it" (§II, the
//     Sharing tab), so it sits ABOVE the list whenever the list exists;
//   • the list is the real `ConnectionsList`, so `connector-connections` is
//     emitted by a PRODUCTION route (every connector setup page where the
//     actor owns a connection), not by a fixture;
//   • each connection's identity line is a real `ConnectionRow` — its name and
//     the mono secondary line.
//
// WHAT IS STILL NOT WIRED, precisely — two things, both for the same reason
// (the host holds no per-connection signal):
//   1. The row ACTION slot. A per-connection Disconnect would be a destructive
//      write addressed by connection-row id, and no such host path exists —
//      disconnecting is owned by each connector's own `role:"disconnect"` named
//      action on its setup form, not by a generic host-level endpoint.
//      Inventing one here would mean inventing its authz.
//   2. The row STATUS badge — see "Status honesty" below.
// So the two `connector-connections` row ACTION drivers and the badge
// derivation stay harness-owned. The SURFACE, its states, its cardinality and
// its row chrome now have a real production consumer; those three do not, and
// that is the whole of the remaining gap.
//
// Status honesty — WHY THESE ROWS CARRY NO BADGE. A row returned by
// `listNangoConnectionsByOwner` proves the identity is STORED and not
// soft-deleted. It does NOT prove the connection still answers: readiness
// probes are per CONNECTOR, not per connection, so a credential revoked at the
// provider leaves a row that looks untouched. Passing `status="connected"`
// would paint a green joined-plug chip and `data-status="connected"` — the
// colour and the glyph are the claim as much as any label would be, so a
// relabelled green chip is not a softer claim, it is the same one in different
// words. The rows therefore omit `status` entirely (the prop is optional for
// exactly this case), and the connector-level answer this page CAN back is
// already on it, in the right-column status card. A genuine per-connection
// reachability signal is a follow-up, not something to fake here — and so the
// row primitive's status→presentation derivation stays harness-driven along
// with the two row actions.
// ---------------------------------------------------------------------------

import { inArray } from "drizzle-orm";
import { getAuthSession } from "@/lib/auth-session";
import {
  betterAuthDb,
  betterAuthUsers,
  readOrgsWithTeamsForUserActiveOnly,
  readProjectsForUser,
} from "@/lib/better-auth-db";
import {
  listNangoConnectionsByOwner,
  type NangoConnectionIdentity,
} from "@cinatra-ai/extensions/connection-identity-store";
import {
  readExtensionAccessPolicy,
  readExtensionCoOwners,
} from "@cinatra-ai/extensions/permissions-store";
import { defaultAccessPolicyForKind } from "@cinatra-ai/extensions/install-access-contract";
import { resolveConnectionAccessDeclaration } from "@/lib/connection-use-gate";
import {
  decideConnectionShareSurface,
  type ConnectionShareSurface,
} from "@/lib/connection-share-ui";
import type { AvailableScopes } from "@/components/access-scope";
import type { OwnerView } from "@/components/permissions-form";
import { ExtensionPermissionsClient } from "@/components/extension-permissions-client";
import {
  ConnectorSharingPanels,
  CONNECTOR_SHARING_INTRO,
  type ConnectorSharingPanelView,
} from "@/components/extensions/connector-sharing-panels";

type ConnectionSharingSectionProps = {
  /** The connector package whose OWN connections the actor manages here. */
  packageId: string;
  /**
   * Where this section is mounted. `tab` = the setup page's Sharing tab, whose
   * page shell already holds the Wide column, so the section adds no column or
   * page padding of its own; `standalone` = a page that mounts it directly (the
   * §II error treatments and the bundled-react setup pages, which own no tab
   * strip), where the section still carries the Wide column itself.
   */
  variant?: "tab" | "standalone";
};

type PanelData = {
  identity: NangoConnectionIdentity;
  surface: Exclude<ConnectionShareSurface, { surface: "hidden" }>;
  policy: import("@cinatra-ai/agents/auth-policy").AgentAuthPolicy;
  coOwners: OwnerView[];
  sharingAllowed: boolean;
};

export async function ConnectionSharingSection({
  packageId,
  variant = "standalone",
}: ConnectionSharingSectionProps) {
  const session = await getAuthSession();
  const userId = session?.user?.id ?? null;
  if (!userId) return null;
  const activeOrgId = session?.session?.activeOrganizationId ?? null;

  // The actor's OWN live connections for this connector, bounded to the
  // active workspace (org rows of the active org + the owner's null-org
  // legacy rows).
  const ownRows = (await listNangoConnectionsByOwner(userId)).filter(
    (row) =>
      row.connectorPackageId === packageId &&
      (row.organizationId === null || row.organizationId === activeOrgId),
  );
  if (ownRows.length === 0) return null;

  const orgs = await readOrgsWithTeamsForUserActiveOnly(userId);
  const projects = activeOrgId ? await readProjectsForUser(userId, activeOrgId) : [];
  const scopes: AvailableScopes = {
    orgs: orgs.map((org) => ({
      id: org.id,
      name: org.name,
      teams: org.teams.map((t) => ({ id: t.id, name: t.name })),
    })),
    projects: projects.map((p) => ({ id: p.id, name: p.name })),
    canGrantWorkspace: true,
  };

  const panels: PanelData[] = [];
  for (const identity of ownRows) {
    const resolution = await resolveConnectionAccessDeclaration(identity);
    const unresolved = resolution.kind === "package_unresolved";
    const declaration = unresolved ? null : resolution.declaration;
    const storedPolicy = await readExtensionAccessPolicy("connection", identity.id);
    const surface = decideConnectionShareSurface({
      identity,
      declaration,
      unresolved,
      storedPolicy,
      scopes,
    });
    if (surface.surface === "hidden") continue;

    const coOwnerRows = await readExtensionCoOwners("connection", identity.id);
    const coOwnerIds = coOwnerRows.map((r) => r.userId).filter((id) => id !== userId);
    let coOwners: OwnerView[] = [];
    if (coOwnerIds.length > 0) {
      const userRows = await betterAuthDb
        .select({
          id: betterAuthUsers.id,
          name: betterAuthUsers.name,
          email: betterAuthUsers.email,
          image: betterAuthUsers.image,
        })
        .from(betterAuthUsers)
        .where(inArray(betterAuthUsers.id, coOwnerIds));
      const byId = new Map(userRows.map((u) => [u.id, u]));
      coOwners = coOwnerIds.map((id) => {
        const u = byId.get(id);
        return {
          userId: id,
          name: u?.name ?? u?.email ?? "Unknown",
          email: u?.email ?? "",
          image: u?.image ?? null,
        };
      });
    }

    // Mirror of the connection kind's `allowSharing` hook: person-grants are
    // dead under an `only` ceiling whose collective dimension cannot be
    // verified for a person — hide the add UI (the action re-rejects anyway).
    const sharingAllowed = !(
      declaration?.mode === "only" &&
      (declaration.scope === "user" ||
        declaration.scope === "team" ||
        declaration.scope === "project")
    );

    panels.push({
      identity,
      surface,
      policy: storedPolicy ?? defaultAccessPolicyForKind("connection"),
      coOwners,
      sharingAllowed,
    });
  }
  if (panels.length === 0) return null;

  const owner: OwnerView = {
    userId,
    name: session?.user?.name ?? session?.user?.email ?? "You",
    email: session?.user?.email ?? "",
    image: session?.user?.image ?? null,
  };

  const panelViews: ConnectorSharingPanelView[] = panels.map(
    ({ identity, surface, policy, coOwners, sharingAllowed }) => ({
      key: identity.id,
      name: identity.connectionId,
      url: identity.connectorKey,
      // What the connector declares about this panel's scope choice: a ceiling
      // (every out-of-ceiling option locked with its reason) or a recommended
      // scope (the recommendation line, nothing shared until saved).
      scopeConstraint:
        surface.surface === "locked"
          ? ("locked" as const)
          : surface.recommendationNote
            ? ("recommended" as const)
            : null,
      permissions: (
        <ExtensionPermissionsClient
          kind="connection"
          resourceId={identity.id}
          canEdit
          initialPolicy={policy}
          owner={owner}
          coOwners={coOwners}
          availableScopes={scopes}
          currentUserId={userId}
          allowSharing={sharingAllowed}
          selfRemoveRedirect="/connectors"
          accessHelperText="Choose who can use this connection."
          ownershipHelperText="Owners can change this connection's sharing and disconnect it."
          accessValueOverride={surface.value}
          accessDisabledScopes={
            surface.surface === "locked" ? surface.disabledScopes : undefined
          }
          accessDisabledReasons={
            surface.surface === "locked" ? surface.disabledReasons : undefined
          }
          accessScopeNote={
            surface.surface === "locked" ? surface.note : surface.recommendationNote
          }
        />
      ),
    }),
  );

  return (
    <section
      aria-label="Connection sharing"
      className={
        variant === "tab"
          ? "flex w-full flex-col gap-4"
          : "mx-auto w-full max-w-3xl px-4 pb-10 sm:px-8 lg:px-6 flex flex-col gap-4"
      }
    >
      <div>
        <h2 className="text-base font-semibold text-foreground">Connection sharing</h2>
        <p className="text-xs text-muted-foreground">{CONNECTOR_SHARING_INTRO}</p>
      </div>
      <ConnectorSharingPanels panels={panelViews} />
    </section>
  );
}
