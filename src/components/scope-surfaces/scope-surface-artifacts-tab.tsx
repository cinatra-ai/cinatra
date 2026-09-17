import "server-only";
/**
 * THE ARTIFACTS TAB OF A SCOPE PAGE (cinatra#2810, per-scope surfaces S4).
 *
 * The acceptance sentences this component serves, verbatim:
 *
 *   "Rendering reuses the landed list components (`LibraryMode`; the skills
 *    catalog rows)."
 *
 *   "The workspace tab does not inherit the `/artifacts` active-org redirect
 *    (org-independent read)."
 *
 * There is no second artifact list in the product. This body mounts the SAME
 * `LibraryMode` the global `/artifacts` page mounts and hands it the viewed
 * scope's ownership locus; the narrowing happens inside that one component,
 * over the durable tuple, through this slice's pure reader. Nothing about the
 * global page's own behaviour changes: it passes no locus, and a `LibraryMode`
 * with no locus is the component it always was.
 *
 * ── THE ORG-INDEPENDENT WORKSPACE READ ────────────────────────────────────
 *
 * `/artifacts` redirects a reader with no active organization to sign-in. A
 * workspace tab must not: the workspace sits ABOVE every organization, and the
 * `WorkspaceVantage` it lists is defined without reference to an active one.
 * So this body never consults `activeOrganizationId` for the workspace scope
 * and never redirects on its absence — it reads with no tenant boundary of its
 * own and lets the vantage be the boundary.
 *
 * That is not a widening. Every row still passes `listArtifacts`'s per-row
 * `object.read` for THIS actor, and the vantage then keeps only the loci this
 * actor is positioned at. A scope tab can only ever narrow what the actor could
 * already read.
 *
 * The four concrete scopes carry their own tenant boundary instead: an
 * organization tab reads inside that organization, and the personal, team and
 * project tabs read inside the active one — the team gate is already bound to
 * it, and a project's artifacts ride the tenant's own `objects.project_id`.
 * Their absence of an active organization yields an empty tab, never a
 * redirect.
 */
import { LibraryMode } from "@/components/artifacts/library-mode";
import { ScopeSurfaceTabEmpty } from "@/components/scope-surface-page";
import { getAuthSession, requireActorContext } from "@/lib/auth-session";
import { readWorkspaceVantage } from "@/lib/scope-surface-workspace-vantage";
import type { ArtifactOwnershipLocus } from "@/lib/scope-surface-artifact-rows";
import type { ScopeSurfaceRef } from "@/lib/scope-surfaces";

/** The ownership locus and the tenant boundary the viewed scope reads inside. */
async function readScopeArtifactLocus(
  scope: ScopeSurfaceRef,
  userId: string,
  activeOrgId: string | null,
): Promise<{ ownership: ArtifactOwnershipLocus; orgId: string | null }> {
  switch (scope.kind) {
    case "workspace":
      // No active organization is consulted, so none can be missing.
      return {
        ownership: { kind: "workspace", vantage: await readWorkspaceVantage(userId) },
        orgId: null,
      };
    case "personal":
      return { ownership: { kind: "personal", userId }, orgId: activeOrgId };
    case "organization":
      return { ownership: { kind: "organization", orgId: scope.id }, orgId: scope.id };
    case "team":
      return { ownership: { kind: "team", teamId: scope.id }, orgId: activeOrgId };
    case "project":
      return { ownership: { kind: "project", projectId: scope.id }, orgId: activeOrgId };
  }
}

/**
 * The Artifacts tab's body for one scope: the library, listing exactly what
 * this scope owns.
 */
export async function ScopeSurfaceArtifactsTab({ scope }: { scope: ScopeSurfaceRef }) {
  const [session, actor] = await Promise.all([getAuthSession(), requireActorContext()]);
  const userId = session?.user?.id ?? null;
  // The route has already required a session; without a user id there is no
  // ownership locus to read at all, so the tab lists nothing. Everything below
  // this line is the library's own, empty state included.
  if (!userId) return <ScopeSurfaceTabEmpty tab="artifacts" read />;
  const { ownership, orgId } = await readScopeArtifactLocus(
    scope,
    userId,
    session?.session?.activeOrganizationId ?? null,
  );
  return (
    <LibraryMode
      orgId={orgId}
      actor={actor}
      userId={userId}
      ownership={ownership}
    />
  );
}
