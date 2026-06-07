import "server-only";

import { isPlatformAdmin } from "@/lib/auth-session";
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
  const teamRows = userId && orgId ? await readTeamsForUser(userId, orgId) : [];
  const scope: ExtensionDiscoveryScope = {
    userId: userId ?? null,
    organizationId: orgId,
    teamIds: teamRows.map((t) => t.id),
    vendorScope: vendorScope ?? null,
    platformRole: isPlatformAdmin(session) ? "platform_admin" : "member",
  };
  const actor = actorFromSession(session) as Actor;
  return { actor, scope };
}
