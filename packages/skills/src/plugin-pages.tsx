import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PaginatedTable } from "@/components/ui/paginated-table";
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ScopeBadge } from "@/components/scope-badge";
import { DeleteItemForm } from "@/components/data-safety/delete-item-form";
import { SearchParamToast } from "@/components/search-param-toast";
import { getListViewCookieName } from "@/lib/list-view";
import { getAuthSession, isPlatformAdmin } from "@/lib/auth-session";
import { readOrgsWithTeamsForUser, readProjectsForUser } from "@/lib/better-auth-db";
import { SkillsToolbar } from "./skills-toolbar";
import type { AvailableScopes } from "@/components/access-scope";
import {
  DEFAULT_SCOPE_TOKEN,
  scopeSelectionMatches,
  type NormalizedResourceScope,
} from "@/lib/scope-filter";
// Skill-authoring + edit pages list installed agents from the canonical
// agent_templates reader, not workspace packages from packages/*.
import { readAgentsForSkillMatching } from "@/lib/agents-store";
import {
  createSkillFromTemplateAction,
  deletePersonalSkillAction,
  savePersonalSkillAction,
} from "./actions";
// LOCAL_USER_ID is not imported at the module top level; the actor's real
// principalId resolves via auth-session.
import { requireActorContext } from "@/lib/auth-session";
import { requireResourceAccess, buildSkillResourceRef } from "@cinatra-ai/agents/auth-policy";
import { SkillMarkdownEditor } from "./skill-markdown-editor";
import { getInstalledSkillById, listInstalledSkills } from "./skills-registry";
// Both skill_package and skill mount the generic ExtensionPermissionsClient.
// Per-kind action wiring lives in @cinatra-ai/extensions.
import { ExtensionPermissionsClient } from "@/components/extension-permissions-client";
import { getCustomSkillById, type SkillLevel } from "./skills-store";
// SkillAccessClient is not mounted on the skill detail page; the generic
// ExtensionPermissionsClient owns the UI.
// The afterPolicyWrite hook keeps the (level, scope) tuple projection in sync
// on save while readers still depend on it.
import { loadSkillPermissionsContext } from "./permissions-page-data";

type SearchParams = Record<string, string | string[] | undefined>;

function pickSearchParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

// SkillLevel → ScopeLevel mapping for ScopeBadge rendering.
// SkillLevel has 8 values; ScopeLevel has 5 (user|team|organization|workspace|project).
// - team/organization/workspace/project → identity
// - personal/agent → user (individual ownership)
// - third-party/system → user (no canonical ownership; render as default)
function mapSkillLevelToScopeLevel(level: SkillLevel): "user" | "team" | "organization" | "workspace" | "project" {
  switch (level) {
    case "team":
    case "organization":
    case "workspace":
    case "project":
      return level;
    case "personal":
    case "agent":
    case "system":
    default:
      return "user";
  }
}

type SkillsPageProps = {
  searchParams?: Promise<SearchParams>;
};

export async function SkillsPage({ searchParams }: SkillsPageProps) {
  const [allSkills, resolvedSearchParams, cookieStore, actor, session] = await Promise.all([
    listInstalledSkills(),
    (searchParams ?? Promise.resolve({})) as Promise<SearchParams>,
    cookies(),
    requireActorContext(),
    getAuthSession(),
  ]);

  // The list must apply per-row authorization. A "filter system only"
  // gate leaks scoped skill metadata (name,
  // description, package, slug, source URL, usedBy) for personal/team/
  // org/project/workspace rows the actor cannot access. Apply per-row
  // `requireResourceAccess` so the rendered list mirrors what
  // `skills_installed_list` returns to MCP callers. platform_admin
  // is short-circuited inside `requireResourceAccess` and continues to
  // see everything.
  const skills = allSkills.filter((s) => {
    try {
      // Keep the UI authorization shape aligned with auth-policy.ts.
      requireResourceAccess(actor, buildSkillResourceRef({
        id: s.id,
        level: s.level,
        scope: s.scope ?? null,
      }));
      return true;
    } catch {
      return false;
    }
  });

  const preferredView = cookieStore.get(getListViewCookieName("/skills"))?.value;
  const requestedView = pickSearchParam(resolvedSearchParams.view);
  const view = requestedView === "cards" || requestedView === "table" ? requestedView : preferredView === "cards" ? "cards" : "table";
  const query = (pickSearchParam(resolvedSearchParams.q) ?? "").toLowerCase().trim();
  const sort = pickSearchParam(resolvedSearchParams.sort) ?? "name";
  const dir = pickSearchParam(resolvedSearchParams.dir) === "desc" ? "desc" : "asc";
  const nextDirection = (column: string) => (sort === column && dir === "asc" ? "desc" : "asc");

  // Scope filter — shares the hierarchical picker + token vocabulary with
  // /connectors. "admin" (Workspace: Admins only) is platform-admin-only here
  // because system skills are admin-visibility-gated; the row is hidden from
  // non-admins and a stale ?scope=admin collapses to the default.
  const isAdmin = isPlatformAdmin(session);
  const actorUserId = session?.user?.id ?? null;
  const orgs = actorUserId ? await readOrgsWithTeamsForUser(actorUserId) : [];
  const activeOrgId = session?.session?.activeOrganizationId ?? null;
  const projects =
    actorUserId && activeOrgId ? await readProjectsForUser(actorUserId, activeOrgId) : [];
  const scopes: AvailableScopes = {
    orgs: orgs.map((org) => ({
      id: org.id,
      name: org.name,
      teams: org.teams.map((t) => ({ id: t.id, name: t.name })),
    })),
    projects: projects.map((p) => ({ id: p.id, name: p.name })),
    canGrantWorkspace: true,
  };
  const accessibleScopeTokens = new Set<string>(["personal", "workspace", ...(isAdmin ? ["admin"] : [])]);
  for (const org of orgs) {
    accessibleScopeTokens.add(`org:${org.id}`);
    for (const team of org.teams) accessibleScopeTokens.add(`team:${team.id}`);
  }
  for (const project of projects) accessibleScopeTokens.add(`project:${project.id}`);
  const requestedScope = pickSearchParam(resolvedSearchParams.scope);
  const effectiveScope =
    requestedScope && accessibleScopeTokens.has(requestedScope) ? requestedScope : DEFAULT_SCOPE_TOKEN;

  // Map a skill's (level, scope) to the normalized two-axis scope shape. Only
  // bind a real org/team/project id; generic org skills (scope "org"/missing)
  // stay locus-level so any org selection matches. System skills are admin-only.
  function normalizedScopeForSkill(
    level: SkillLevel | undefined,
    scope: string | undefined | null,
  ): NormalizedResourceScope {
    const realId = scope && scope !== level && scope !== "org" ? scope : undefined;
    switch (level) {
      case "personal":
        return { locus: "personal" };
      case "team":
        return { locus: "team", locusId: realId };
      case "organization":
        return { locus: "organization", locusId: realId };
      case "project":
        return { locus: "project", locusId: realId };
      case "system":
        return { locus: "workspace", adminOnly: true };
      default:
        // workspace / agent / third-party — visible under the default view only.
        return { locus: "workspace" };
    }
  }

  const filtered = skills
    .filter((skill) =>
      scopeSelectionMatches(effectiveScope, normalizedScopeForSkill(skill.level, skill.scope)),
    )
    .filter(
      (skill) =>
        query.length === 0 ||
        skill.name.toLowerCase().includes(query) ||
        skill.slug.toLowerCase().includes(query) ||
        skill.packageName.toLowerCase().includes(query) ||
        skill.description.toLowerCase().includes(query) ||
        skill.usedBy.some((entry) => entry.toLowerCase().includes(query)),
    )
    .sort((left, right) => {
      const leftValue = sort === "packageName" ? left.packageName : sort === "slug" ? left.slug : left.name;
      const rightValue = sort === "packageName" ? right.packageName : sort === "slug" ? right.slug : right.name;
      return leftValue.localeCompare(rightValue) * (dir === "asc" ? 1 : -1);
    });

  // Sortable column-header hrefs preserve the active scope + search so a header
  // click never silently drops the scope filter.
  const rawQuery = pickSearchParam(resolvedSearchParams.q);
  const sortHref = (column: string) => {
    const params = new URLSearchParams();
    if (rawQuery) params.set("q", rawQuery);
    if (effectiveScope !== DEFAULT_SCOPE_TOKEN) params.set("scope", effectiveScope);
    params.set("view", "table");
    params.set("sort", column);
    params.set("dir", nextDirection(column));
    return `/skills?${params.toString()}`;
  };

  return (
    <Main className="min-h-screen">
      {/* Flash toasts handed off via the URL by server-side redirects:
          deletePersonalSkillAction -> ?deleted=1, savePersonalSkillAction -> ?saved=1.
          The detail/edit page calls notFound() after a delete, so the toast can't
          live in the form's own effect; the destination owns it. */}
      <SearchParamToast
        toasts={[
          { param: "deleted", value: "1", message: "Personal skill deleted" },
          { param: "saved", value: "1", message: "Personal skill saved" },
        ]}
      />
      <PageHeader title="Skills" divider={false} />
      <PageContent className="flex flex-col gap-6 pb-8">
        <SkillsToolbar
          basePath="/skills"
          query={query}
          view={view}
          scopeValue={effectiveScope}
          scopes={scopes}
          showAdmin={isAdmin}
        />

        {view === "cards" ? (
          <section className="grid gap-4">
            {filtered.map((skill) => (
              <Card key={skill.id} className="border-line bg-surface backdrop-blur-none p-6">
                <p className="font-mono text-xs uppercase tracking-[0.22em] text-muted-foreground">Skill</p>
                <h2 className="mt-2 text-xl font-semibold">
                  <Link href={`/skills/${encodeURIComponent(skill.id)}`} className="underline-offset-4 hover:underline">
                    {skill.name}
                  </Link>
                </h2>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">{skill.description}</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  {skill.level ? (
                    <ScopeBadge level={mapSkillLevelToScopeLevel(skill.level)}>{skill.level}</ScopeBadge>
                  ) : null}
                  <span className="rounded-full border border-line px-3 py-1 text-xs text-muted-foreground">
                    Extension:{" "}
                    <Link href={`/skills?q=${encodeURIComponent(skill.packageName)}`} className="font-medium underline-offset-4 hover:underline">
                      {skill.packageName}
                    </Link>
                  </span>
                  <span className="rounded-full border border-line px-3 py-1 text-xs text-muted-foreground">Skill id: {skill.slug}</span>
                  <span className="rounded-full border border-line px-3 py-1 text-xs text-muted-foreground">
                    Used in: {skill.usedBy.length > 0 ? skill.usedBy.join(", ") : "Not currently used"}
                  </span>
                </div>
              </Card>
            ))}
          </section>
        ) : (
          <PaginatedTable className="min-w-full text-left text-sm">
            <TableHeader>
              <TableRow>
                <TableHead className="whitespace-normal">
                  <Link href={sortHref("name")} className="inline-flex items-center gap-2 whitespace-normal hover:text-foreground">
                    Skill
                  </Link>
                </TableHead>
                <TableHead className="whitespace-normal">
                  <Link href={sortHref("packageName")} className="inline-flex items-center gap-2 whitespace-normal hover:text-foreground">
                    Extension
                  </Link>
                </TableHead>
                <TableHead className="whitespace-normal">Used in</TableHead>
                <TableHead className="whitespace-normal">
                  <Link href={sortHref("slug")} className="inline-flex items-center gap-2 whitespace-normal hover:text-foreground">
                    Skill id
                  </Link>
                </TableHead>
                <TableHead className="whitespace-normal">Description</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((skill) => (
                <TableRow key={skill.id}>
                  <TableCell className="whitespace-normal break-words font-semibold">
                    <Link href={`/skills/${encodeURIComponent(skill.id)}`} className="underline-offset-4 hover:underline">
                      {skill.name}
                    </Link>
                  </TableCell>
                  <TableCell className="whitespace-normal break-words text-muted-foreground">
                    <Link href={`/skills?q=${encodeURIComponent(skill.packageName)}`} className="underline-offset-4 hover:underline">
                      {skill.packageName}
                    </Link>
                  </TableCell>
                  <TableCell className="whitespace-normal break-words text-muted-foreground">{skill.usedBy.length > 0 ? skill.usedBy.join(", ") : "Not currently used"}</TableCell>
                  <TableCell className="whitespace-normal break-words text-muted-foreground">{skill.slug}</TableCell>
                  <TableCell className="whitespace-normal break-words text-muted-foreground">{skill.description}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </PaginatedTable>
        )}
      </PageContent>
    </Main>
  );
}

type SkillDetailPageProps = { params: Promise<{ skillId: string }> };

export async function SkillDetailPage({ params }: SkillDetailPageProps) {
  const { skillId } = await params;
  const [skill, session, actor] = await Promise.all([
    getInstalledSkillById(decodeURIComponent(skillId)),
    getAuthSession(),
    requireActorContext(),
  ]);

  if (!skill) {
    notFound();
  }

  const isAdmin = isPlatformAdmin(session);

  // Server-side deny for non-admin GET on system-level skills.
  // notFound() is called BEFORE any data is rendered so nothing leaks.
  if (skill.level === "system" && !isAdmin) {
    notFound();
  }

  // This page renders `{skill.content}` below; without a per-skill access
  // gate, any
  // authenticated user could read the markdown body of any installed
  // skill regardless of personal/team/org/project/workspace scope.
  // Apply the same `requireResourceAccess` gate the MCP handlers use
  // (mode = "read" — the default). AuthzError → notFound() so the route
  // cannot distinguish "denied" from "not found" via timing. Mirrors
  // The system/admin special-case above is preserved: `requireResourceAccess`
  // throws 404 hidden for non-admin on system rows, and both paths converge
  // on `notFound()`.
  try {
    // Keep the UI authorization shape aligned with auth-policy.ts.
    requireResourceAccess(actor, buildSkillResourceRef({
      id: skill.id,
      level: skill.level,
      scope: skill.scope ?? null,
    }));
  } catch {
    notFound();
  }

  const userId = session?.user?.id ?? null;
  // canEdit kept for the read-only-banner branch above; PermissionsForm
  // computes its own canEdit from the parent-package gate via the loader.
  const ownsPersonalSkill = skill.level === "personal" && skill.scope === userId;
  void (isAdmin || ownsPersonalSkill);
  void userId;

  // Load the per-skill permissions context up front. Falls through to the
  // parent package's policy when the skill row
  // has no override (loader semantics). Result is null only when the skill
  // is not found, which is short-circuited by the notFound() above.
  const skillPermissions = await loadSkillPermissionsContext(skill.id);

  return (
    <Main className="min-h-screen">
      <PageHeader
        title={skill.name}
        description="Skill administration"
        actions={
          <div className="flex flex-wrap gap-2">
            {ownsPersonalSkill ? (
              <Button asChild variant="outline">
                <Link href={`/skills/${encodeURIComponent(skill.id)}/edit`}>Edit</Link>
              </Button>
            ) : null}
            <Button asChild>
              <Link href={`/skills/${encodeURIComponent(skill.id)}/create`}>Create new skill from this</Link>
            </Button>
          </div>
        }
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <Link href="/skills" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors w-fit">
          <ChevronLeft className="h-4 w-4" />
          Skills
        </Link>

        {skill.level === "system" && (
          <Alert variant="default">
            <AlertDescription>
              This is a system skill — it cannot be edited or deleted. Use <strong>Create new skill from this</strong> to make a customized copy.
            </AlertDescription>
          </Alert>
        )}

        <Card className="border-line bg-surface backdrop-blur-none p-6">
          <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
            {skill.level ? (
              <ScopeBadge level={mapSkillLevelToScopeLevel(skill.level)}>{skill.level}</ScopeBadge>
            ) : null}
            <span className="rounded-full border border-line px-3 py-1">Skill id: {skill.slug}</span>
            <span className="rounded-full border border-line px-3 py-1">Used in: {skill.usedBy.length > 0 ? skill.usedBy.join(", ") : "Not currently used"}</span>
            <span className="rounded-full border border-line px-3 py-1">
              Package:{" "}
              <Link href={`/skills?q=${encodeURIComponent(skill.packageName)}`} className="underline-offset-4 hover:underline">
                {skill.packageName}
              </Link>
            </span>
            {skill.sourceUrl ? (
              <span className="rounded-full border border-line px-3 py-1">
                <Link href={skill.sourceUrl} className="underline-offset-4 hover:underline">
                  Open source
                </Link>
              </span>
            ) : null}
          </div>
        </Card>

        <Card className="border-line bg-surface backdrop-blur-none p-6">
          <h2 className="text-xl font-semibold">SKILL.md</h2>
          <pre className="mt-5 overflow-x-auto whitespace-pre-wrap break-words rounded-panel border border-line bg-surface-strong px-5 py-4 font-mono text-sm leading-6 text-foreground">
            {skill.content}
          </pre>
        </Card>

        {/* The generic PermissionsForm lets operators override the parent
            package's policy and add per-skill co-owners. The form's Save click
            also projects to the (level, scope) tuple so matching and
            visibility readers stay correct. SkillAccessClient and
            skill-access-actions remain in the tree for dependent readers, but
            are not mounted here. */}
        {skillPermissions ? (
          <ExtensionPermissionsClient
            kind="skill"
            resourceId={skillPermissions.skillId}
            canEdit={skillPermissions.canEdit}
            initialPolicy={skillPermissions.initialPolicy}
            owner={skillPermissions.owner}
            coOwners={skillPermissions.coOwners}
            availableScopes={skillPermissions.availableScopes}
            currentUserId={skillPermissions.currentUserId}
            allowSharing={skillPermissions.canEdit}
          />
        ) : null}
      </PageContent>
    </Main>
  );
}

type CreateFromSkillPageProps = { params: Promise<{ skillId: string }> };

export async function CreateFromSkillPage({ params }: CreateFromSkillPageProps) {
  const { skillId } = await params;
  const skill = await getInstalledSkillById(decodeURIComponent(skillId));

  if (!skill) {
    notFound();
  }

  // This page renders `defaultValue={skill.content}` below; without a
  // per-skill access
  // gate, any authenticated user could read the markdown body of any
  // installed skill regardless of personal/team/org/project/workspace
  // scope. Apply the same `requireResourceAccess` gate the MCP handlers
  // use (mode = "read" — the default). On any AuthzError, return 404
  // (notFound) to avoid leaking the resource's existence via 403.
  const actor = await requireActorContext();
  try {
    // Keep the UI authorization shape aligned with auth-policy.ts.
    requireResourceAccess(actor, buildSkillResourceRef({
      id: skill.id,
      level: skill.level,
      scope: skill.scope ?? null,
    }));
  } catch {
    notFound();
  }

  return (
    <Main className="min-h-screen">
      <PageHeader
        title={skill.name}
        description="Create skill from template — start from this skill’s existing markdown, then adapt the name, package, and content for your own version."
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <Link href={`/skills/${encodeURIComponent(skill.id)}`} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors w-fit">
          <ChevronLeft className="h-4 w-4" />
          {skill.name}
        </Link>

        <Card className="border-line bg-surface backdrop-blur-none">
        <CardContent className="p-6">
        <form action={createSkillFromTemplateAction} className="grid gap-6">
          <input type="hidden" name="basedOnSkillId" value={skill.id} />

          <div className="grid gap-5 md:grid-cols-2">
            <Label className="grid gap-2 text-sm font-semibold leading-normal text-foreground">
              Skill name
              <Input
                name="skillName"
                defaultValue={`${skill.name} Copy`}
                required
                className="rounded-control border border-line bg-surface-strong px-4 py-3 text-sm font-normal text-foreground outline-none transition focus:border-primary"
              />
            </Label>
            <Label className="grid gap-2 text-sm font-semibold leading-normal text-foreground">
              Package
              <Input
                name="packageName"
                defaultValue={skill.packageName}
                required
                className="rounded-control border border-line bg-surface-strong px-4 py-3 text-sm font-normal text-foreground outline-none transition focus:border-primary"
              />
            </Label>
          </div>

          <SkillMarkdownEditor name="content" defaultValue={skill.content} label="Skill markdown" />

          <div className="flex flex-wrap gap-3">
            <Button type="submit">Create skill</Button>
            <Button asChild variant="outline">
              <Link href={`/skills/${encodeURIComponent(skill.id)}`}>Cancel</Link>
            </Button>
          </div>
        </form>
        </CardContent>
        </Card>
      </PageContent>
    </Main>
  );
}

export async function NewSkillPage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  const resolvedSearchParams: SearchParams = await (searchParams ?? Promise.resolve({} as SearchParams));
  await requireActorContext();
  const agents = await readAgentsForSkillMatching();
  const errorMessage = pickSearchParam(resolvedSearchParams.error);

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="New skill"
        description="Create a personal skill for one of the installed agents."
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <Link href="/skills?scope=personal" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors w-fit">
          <ChevronLeft className="h-4 w-4" />
          Skills
        </Link>

        {errorMessage ? (
          <Alert variant="destructive"><AlertDescription>{errorMessage}</AlertDescription></Alert>
        ) : null}

        <Card className="border-line bg-surface backdrop-blur-none p-6">
          <form action={savePersonalSkillAction} className="grid gap-5">
            <Label className="grid gap-2 text-sm font-semibold leading-normal text-foreground">
              Agent
              <select
                name="agentId"
                required
                defaultValue=""
                className="rounded-control border border-line bg-surface-strong px-4 py-3 text-sm font-normal text-foreground outline-none transition focus:border-primary"
              >
                <option value="" disabled>
                  Select an agent
                </option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.humanReadableName}
                  </option>
                ))}
              </select>
            </Label>

            <Label className="grid gap-2 text-sm font-semibold leading-normal text-foreground">
              Skill name
              <Input
                name="name"
                required
                className="rounded-control border border-line bg-surface-strong px-4 py-3 text-sm font-normal text-foreground outline-none transition focus:border-primary"
              />
            </Label>

            <SkillMarkdownEditor
              name="content"
              defaultValue={`---\nidentifier: my-personal-skill\ndisplay_name: My Personal Skill\ndescription: What this skill does\nkeywords: email, outreach\n---\n\n# My Personal Skill\n`}
              label="SKILL.md content"
            />

            <div className="flex flex-wrap gap-3">
              <Button type="submit">Create skill</Button>
              <Button asChild variant="outline">
                <Link href="/skills?scope=personal">Cancel</Link>
              </Button>
            </div>
          </form>
        </Card>
      </PageContent>
    </Main>
  );
}

type EditSkillPageProps = {
  params: Promise<{ skillId: string }>;
  searchParams?: Promise<SearchParams>;
};

export async function EditSkillPage({ params, searchParams }: EditSkillPageProps) {
  const [{ skillId }, resolvedSearchParams, actor] = await Promise.all([
    params,
    (searchParams ?? Promise.resolve({})) as Promise<SearchParams>,
    requireActorContext(),
  ]);
  const [skill, agents] = await Promise.all([
    getCustomSkillById({
      ownerUserId: actor.principalId,
      skillId: decodeURIComponent(skillId),
    }),
    readAgentsForSkillMatching(),
  ]);

  if (!skill) {
    notFound();
  }

  const errorMessage = pickSearchParam(resolvedSearchParams.error);

  return (
    <Main className="min-h-screen">
      <PageHeader
        title={skill.name}
        description="Update the skill metadata and markdown."
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <Link href={`/skills/${encodeURIComponent(skill.id)}`} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors w-fit">
          <ChevronLeft className="h-4 w-4" />
          {skill.name}
        </Link>

        {errorMessage ? (
          <Alert variant="destructive"><AlertDescription>{errorMessage}</AlertDescription></Alert>
        ) : null}

        <Card className="border-line bg-surface backdrop-blur-none p-6">
          <form action={savePersonalSkillAction} className="grid gap-5">
            <input type="hidden" name="skillId" value={skill.id} />

            <Label className="grid gap-2 text-sm font-semibold leading-normal text-foreground">
              Agent
              <select
                name="agentId"
                required
                defaultValue={skill.agentId ?? ""}
                className="rounded-control border border-line bg-surface-strong px-4 py-3 text-sm font-normal text-foreground outline-none transition focus:border-primary"
              >
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.humanReadableName}
                  </option>
                ))}
              </select>
            </Label>

            <Label className="grid gap-2 text-sm font-semibold leading-normal text-foreground">
              Skill name
              <Input
                name="name"
                required
                defaultValue={skill.name}
                className="rounded-control border border-line bg-surface-strong px-4 py-3 text-sm font-normal text-foreground outline-none transition focus:border-primary"
              />
            </Label>

            <SkillMarkdownEditor name="content" defaultValue={skill.content} label="SKILL.md content" />

            <div className="flex flex-wrap gap-3">
              <Button type="submit">Save changes</Button>
              <Button asChild variant="outline">
                <Link href={`/skills/${encodeURIComponent(skill.id)}`}>Cancel</Link>
              </Button>
            </div>
          </form>
          {/* DeleteItemForm renders its own <form>, so it MUST be a sibling
              of the save form — nesting <form> elements is invalid HTML and
              breaks submit ownership / hydration. */}
          <div className="mt-4 flex flex-wrap gap-3 border-t border-line pt-4">
            {/* No successHref / deletedTitle on purpose: deletePersonalSkillAction
                redirects server-side on success (a returned MutationResult would let
                this edit page re-render to notFound() and unmount the form before its
                success effect runs — the user would see a 404). /skills shows the
                "Personal skill deleted" toast via ?deleted=1. DeleteItemForm still owns
                the pending/double-submit guard and the in-place error toast. */}
            <DeleteItemForm
              action={deletePersonalSkillAction}
              hiddenFields={[{ name: "skillId", value: skill.id }]}
              ariaLabel="Delete personal skill"
              variant="destructive"
            >
              Delete skill
            </DeleteItemForm>
          </div>
        </Card>
      </PageContent>
    </Main>
  );
}

export const skillsPluginPages = {
  SkillsPage,
  SkillDetailPage,
  CreateFromSkillPage,
  NewSkillPage,
  EditSkillPage,
};
