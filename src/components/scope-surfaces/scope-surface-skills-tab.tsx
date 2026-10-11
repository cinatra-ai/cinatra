import "server-only";
/**
 * THE SKILLS TAB OF A SCOPE PAGE (cinatra#2810, per-scope surfaces S4).
 *
 * The acceptance sentences this component serves, verbatim:
 *
 *   "Rendering reuses the landed list components (`LibraryMode`; the skills
 *    catalog rows)."
 *
 *   "The workspace tab does not inherit the `/artifacts` active-org redirect
 *    (org-independent read)."
 *
 * The read is the skills surface's OWN gated one — `listInstalledSkills` with
 * the list's per-row `requireResourceAccess` gate, shared with `/skills` rather
 * than re-approximated here — and the narrowing is this slice's pure reader
 * over the durable `(owner_scope, owner_id)` tuple. Not the `?scope=` filter:
 * that grammar is not addressed on a scope tab at all, and could not express an
 * ownership subset if it were.
 *
 * ORG-INDEPENDENT ON EVERY SCOPE. A skill's ownership tuple carries its own
 * locus, so no tab needs an active organization to read one, and none consults
 * it. The workspace union's boundary is the `WorkspaceVantage`, which is
 * defined without an active organization by contract.
 */
// The rows come from their own light entry point; the list gate from the
// surfaces entry point that already carries the registry and the store.
import { SkillsCatalogRows } from "@cinatra-ai/skills/catalog-rows";
import { listAuthorizedInstalledSkills } from "@cinatra-ai/skills/pages";

import { ScopeSurfaceTabEmpty } from "@/components/scope-surface-page";
import { getAuthSession, requireActorContext } from "@/lib/auth-session";
import { readWorkspaceVantage } from "@/lib/scope-surface-workspace-vantage";
import {
  selectScopeOwnedSkills,
  type SkillOwnershipLocus,
} from "@/lib/scope-surface-skill-rows";
import type { ScopeSurfaceRef } from "@/lib/scope-surfaces";

/** The ownership locus the viewed scope reads its skills at. */
async function readScopeSkillLocus(
  scope: ScopeSurfaceRef,
  userId: string,
): Promise<SkillOwnershipLocus> {
  switch (scope.kind) {
    case "workspace":
      return { kind: "workspace", vantage: await readWorkspaceVantage(userId) };
    case "personal":
      return { kind: "personal", userId };
    case "organization":
      return { kind: "organization", orgId: scope.id };
    case "team":
      return { kind: "team", teamId: scope.id };
    case "project":
      return { kind: "project", projectId: scope.id };
  }
}

/**
 * The Skills tab's body for one scope: the catalog rows, listing exactly what
 * this scope owns.
 */
export async function ScopeSurfaceSkillsTab({ scope }: { scope: ScopeSurfaceRef }) {
  const [session, actor] = await Promise.all([getAuthSession(), requireActorContext()]);
  const userId = session?.user?.id ?? null;
  // The route has already required a session; without a user id there is no
  // ownership locus to read at all, so the tab lists nothing.
  if (!userId) return <ScopeSurfaceTabEmpty tab="skills" read />;
  const [authorized, locus] = await Promise.all([
    listAuthorizedInstalledSkills(actor),
    readScopeSkillLocus(scope, userId),
  ]);
  const owned = selectScopeOwnedSkills(authorized, locus);
  // The read HAPPENED and found nothing — which is a different statement from
  // "this tab is not ready yet", and the shell's own empty state is where that
  // difference is worded. The catalog rows carry no empty state of their own.
  if (owned.length === 0) return <ScopeSurfaceTabEmpty tab="skills" read />;
  return <SkillsCatalogRows skills={owned} />;
}
