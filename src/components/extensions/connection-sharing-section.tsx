import "server-only";

// ---------------------------------------------------------------------------
// ConnectionSharingSection (cinatra#953 W3) — the HOST-owned per-connection
// share surface, injected on the connector setup dispatch route (every render
// branch: schema-config, invalid-schema-config, rebuild states, and the
// bundled-react page — codex round-0 finding 4).
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
// ---------------------------------------------------------------------------

import { inArray } from "drizzle-orm";
import { getAuthSession } from "@/lib/auth-session";
import {
  betterAuthDb,
  betterAuthUsers,
  readOrgsWithTeamsForUser,
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

type ConnectionSharingSectionProps = {
  /** The connector package whose OWN connections the actor manages here. */
  packageId: string;
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

  const orgs = await readOrgsWithTeamsForUser(userId);
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

  return (
    <section
      aria-label="Connection sharing"
      className="mx-auto w-full max-w-3xl px-4 pb-10 sm:px-8 lg:px-6 flex flex-col gap-4"
    >
      <div>
        <h2 className="text-base font-semibold text-foreground">Connection sharing</h2>
        <p className="text-xs text-muted-foreground">
          Choose who can use each of your saved connections. Shared use always
          acts through your connected account and is audited.
        </p>
      </div>
      {panels.map(({ identity, surface, policy, coOwners, sharingAllowed }) => (
        <div key={identity.id} className="flex flex-col gap-2">
          {panels.length > 1 && (
            <p className="text-xs text-muted-foreground font-mono truncate">
              {identity.connectionId}
            </p>
          )}
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
        </div>
      ))}
    </section>
  );
}
