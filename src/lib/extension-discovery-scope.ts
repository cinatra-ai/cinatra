import "server-only";

import { isPlatformAdmin, resolveOrgRoleForSession } from "@/lib/auth-session";
import { readTeamsForUser } from "@/lib/better-auth-db";
import { actorFromSession } from "@/lib/authz/build-actor-context";
import type { Actor, ExtensionDiscoveryScope } from "@cinatra-ai/extension-types";

// ---------------------------------------------------------------------------
// Host resolution of the runtime-discovery actor + ExtensionDiscoveryScope.
//
// The `ExtensionDiscoveryScope` is the VISIBILITY authority the runtime-discovery
// dispatcher hands to each kind's reader facet (the per-kind native store decides
// "may this actor see this row?"). It is deliberately NOT derived from the MCP
// `PrimitiveActorContext` (an audit/actor envelope with no membership model) —
// the host resolves it from the Better Auth session + the approved-vendor state.
//
// Fail-closed: a session with no active org / no team membership yields a scope
// that sees only public + platform-visible rows, never "everything active".
// This is the ONE place per-actor discovery surfaces (e.g. the extensions
// registry-catalog screen) resolve their scope, so the session→scope mapping
// cannot drift across consumers.
// ---------------------------------------------------------------------------

type DiscoverySession = {
  user: { id: string; role?: string | null } & Record<string, unknown>;
  session?: { activeOrganizationId?: string | null } & Record<string, unknown>;
};

/**
 * Resolve the `{ actor, scope }` pair for a per-actor `discoverActiveExtension
 * Capabilities` call from an already-loaded session.
 *
 * `vendorScope` is passed in (the caller resolves it from instance identity via
 * `getEffectiveViewerScope`) so this helper performs no instance-state read and
 * stays a pure session→scope mapping plus the team-membership lookup.
 */
export async function resolveExtensionDiscoveryContext(
  session: DiscoverySession,
  vendorScope: string | null,
): Promise<{ actor: Actor; scope: ExtensionDiscoveryScope }> {
  const userId = session.user.id;
  const orgId = session.session?.activeOrganizationId ?? null;
  // Resolve team membership + the active-org role in parallel. `orgRole` admits
  // an org_owner/org_admin to every catalog row anchored to their org (the P3
  // catalog-side mirror of the P1 evaluator's admin standing) — without it, the
  // manifest gate can only see the platform-admin axis. Fail closed: an org-less
  // session (no activeOrganizationId) resolves undefined ⇒ no admin standing.
  const [teamRows, orgRole] = await Promise.all([
    userId && orgId ? readTeamsForUser(userId, orgId) : Promise.resolve([]),
    resolveOrgRoleForSession(session),
  ]);
  const scope: ExtensionDiscoveryScope = {
    userId: userId ?? null,
    organizationId: orgId,
    teamIds: teamRows.map((t) => t.id),
    vendorScope: vendorScope ?? null,
    platformRole: isPlatformAdmin(session) ? "platform_admin" : "member",
    ...(orgRole ? { orgRole } : {}),
  };
  const actor = actorFromSession(session) as Actor;
  return { actor, scope };
}
