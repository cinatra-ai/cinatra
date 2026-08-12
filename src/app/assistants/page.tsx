import type { Metadata } from "next";
import { requireAuthSession, isPlatformAdmin } from "@/lib/auth-session";
import {
  readOrgsWithTeamsForUserActiveOnly,
  readProjectsForUser,
} from "@/lib/better-auth-db";
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { AssistantsDirectoryClient } from "@/components/assistants/assistants-directory-client";
import type { AvailableScopes } from "@/components/access-scope";
import {
  isDefaultScopeSelection,
  parseScopeFilterParam,
  scopeSelectionMatchesAny,
} from "@/lib/scope-filter";
import { buildAssistantsDirectoryForCurrentActor } from "@/lib/assistants-directory.server";

export const metadata: Metadata = { title: "Assistants" };

type AssistantsDirectoryPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

// The /assistants directory (cinatra#1878 W3, AC#4). One row per assistant the
// actor may use: local assistants offer a single "Chat"; remote-capable
// assistants expand per authorized connected site with "Chat locally" (inside
// cinatra) and "Remote chat" (a jump-out to the site). Every row + link is built
// server-side by the audience-scoped, instance-authorized directory resolver.
//
// cinatra#2688 adds the /connectors toolbar to this surface: the scope/type
// filter bar and a "+ Assistant" add affordance. The scope half is server-side
// exactly as on /connectors — the same accessible-token set, the same ONE
// canonical `?scope=` parser, the same OR-predicate — so the token vocabulary
// cannot drift per surface. The client renders the picker; the SERVER filters.
export default async function AssistantsDirectoryPage({
  searchParams,
}: AssistantsDirectoryPageProps) {
  const session = await requireAuthSession();
  const resolvedSearchParams = searchParams ? await searchParams : undefined;

  // The actor's accessible scopes (the orgs/teams they belong to, the projects
  // they can read) populate the scope picker.
  const actorUserId = session.user?.id ?? null;
  const orgs = actorUserId ? await readOrgsWithTeamsForUserActiveOnly(actorUserId) : [];
  const activeOrgId = session.session?.activeOrganizationId ?? null;
  const projects =
    actorUserId && activeOrgId ? await readProjectsForUser(actorUserId, activeOrgId) : [];

  // As a FILTER (not a grant), "Workspace: All" is available to everyone —
  // server-side audience resolution still bounds what each actor can see — so
  // canGrantWorkspace is always true.
  const scopes: AvailableScopes = {
    orgs: orgs.map((org) => ({
      id: org.id,
      name: org.name,
      teams: org.teams.map((t) => ({ id: t.id, name: t.name })),
    })),
    projects: projects.map((p) => ({ id: p.id, name: p.name })),
    canGrantWorkspace: true,
  };

  // The scope tokens the actor may select. "personal" / "workspace" / "admin"
  // are always selectable filters; org / team / project tokens are gated to the
  // actor's memberships. `?scope=` is a comma-separated multi-value OR-filter
  // parsed by the ONE canonical parser: invalid / inaccessible tokens are
  // dropped — never honor a scope the actor can't see — and an empty or
  // workspace-containing selection collapses to the default (the broadest view).
  const accessibleScopeTokens = new Set<string>(["personal", "workspace", "admin"]);
  for (const org of orgs) {
    accessibleScopeTokens.add(`org:${org.id}`);
    for (const team of org.teams) accessibleScopeTokens.add(`team:${team.id}`);
  }
  for (const project of projects) accessibleScopeTokens.add(`project:${project.id}`);
  const effectiveScopeTokens = parseScopeFilterParam(
    resolvedSearchParams?.scope,
    accessibleScopeTokens,
  );

  // The default (broadest) selection short-circuits by passing NO predicate at
  // all — the same place /connectors puts its `isDefaultScopeSelection(...) ||`
  // short-circuit — so a row with no scope entries still shows under it. The
  // predicate is injected rather than imported by the resolver: that module is
  // also reachable from /chat and three ratcheted API routes, none of which
  // should carry the scope-filter module for a filter only this page uses.
  const rows = await buildAssistantsDirectoryForCurrentActor({
    scopeMatch: isDefaultScopeSelection(effectiveScopeTokens)
      ? undefined
      : (scopeEntries) =>
          scopeEntries.some((entry) => scopeSelectionMatchesAny(effectiveScopeTokens, entry)),
  });

  // Both "+ Assistant" entries lead to `requireAdminSession`-gated routes
  // (`/configuration/marketplace` and `/configuration/extensions/upload`), so
  // each flag reads the SAME platform-admin fact its own gate reads, from the
  // session already held. A reader is never shown a control that leads nowhere.
  //
  // A third acquisition path — "create it in the agent builder" — is
  // deliberately ABSENT. The builder's create path always writes
  // `agent_kind='executor'` (the assistant kind is set by the install seam), so
  // there is no builder route that produces an assistant to link to.
  const canReachMarketplace = isPlatformAdmin(session);
  const canUploadExtension = isPlatformAdmin(session);

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Assistants"
        description="Every assistant you can use. Chat with each inside Cinatra; connected-site assistants also offer a jump-out to the site."
        divider={false}
      />
      <PageContent>
        <AssistantsDirectoryClient
          rows={rows}
          scopeValue={effectiveScopeTokens}
          scopes={scopes}
          canReachMarketplace={canReachMarketplace}
          canUploadExtension={canUploadExtension}
        />
      </PageContent>
    </Main>
  );
}
