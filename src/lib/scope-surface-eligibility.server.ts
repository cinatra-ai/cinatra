import "server-only";

/**
 * THE PER-SCOPE ELIGIBILITY READ (cinatra#2808, per-scope surfaces S2).
 *
 * The SERVER half of the loader: it fetches, `scope-surface-eligibility.ts`
 * decides, and this module wires the two arms to the platform's own authorities
 * — `evaluateExtensionAccess` for the actor arm and
 * `policyFieldAdmitsScopeVantage` for the vantage arm — over ONE policy
 * snapshot per install, exactly as `installed-catalog-read.ts` does.
 *
 * ── WHICH POLICY, AND WHY THAT ONE ─────────────────────────────────────────
 * The permissions vocabulary has no `agent` resource kind: an agent package's
 * access policy is stored against its `agent_template`, which is also the row
 * the /agents surface authorizes against. So the snapshot is read for the
 * TEMPLATE of each candidate package, not for the canonical install id (that
 * spelling is the connector/artifact/workflow one). A package with no template
 * row carries no policy and no honest display name, and is skipped rather than
 * authorized against a default that belongs to another resource.
 *
 * Every heavy dependency is imported LAZILY. This module sits in the render
 * graph of ten scope-tab routes, and the extensions access modules reach the
 * permissions store and its Postgres connection; nothing pays for that until a
 * candidate actually needs authorizing.
 *
 * FAILURE POSTURE: never throws into a scope landing. Any failure logs and
 * yields an EMPTY list, which renders the tab's honest placeholder rather than a
 * broken page.
 */
import type { AgentAuthPolicy } from "@cinatra-ai/agents/auth-policy-types";
import type { AccessScopeVantage } from "@cinatra-ai/extensions/access-scope-vantage";

import {
  getAuthSession,
  requireActorContext,
  resolveActorGrantsForUserInOrg,
} from "@/lib/auth-session";
import {
  readOrgsWithTeamsForUserActiveOnly,
  readProjectAgentTemplateBindings,
  readProjectOrganizationFacts,
  readProjectsForUser,
} from "@/lib/better-auth-db";
import {
  resolveScopeSurfaceEligibility,
  type ScopeSurfaceAnchor,
  type ScopeSurfaceBinding,
  type ScopeSurfaceEligibilityRow,
  type ScopeSurfaceInstall,
  type ScopeSurfaceStatus,
} from "@/lib/scope-surface-eligibility";
import {
  buildWorkspaceVantage,
  resolveVantageOrgForScope,
} from "@/lib/scope-surface-vantage";
import {
  buildScopeSurfaceAgentRows,
  buildScopeSurfaceAssistantRows,
  type ScopeAgentCardRow,
  type ScopeAssistantCardRow,
} from "@/lib/scope-surface-rows";
import type { ScopeSurfaceRef } from "@/lib/scope-surfaces";

function warn(message: string, cause?: unknown): void {
  console.warn(
    `[scope-surfaces/eligibility] ${message}`,
    cause instanceof Error ? cause.message : cause,
  );
}

/** The statuses a scope tab lists — a scope tab never lists an archived row. */
const LIVE_STATUSES = new Set<string>(["active", "locked"]);

/** What the package's own template row tells this read: how to name it, and
 *  which permissions resource carries its access policy. */
type PackageFacts = {
  readonly templateId: string;
  /** Every template row of the package: a project binding names one of them. */
  readonly templateIds: readonly string[];
  readonly name: string;
  readonly description: string | null;
};

/**
 * The actor axes this read resolves against, for the scope being VIEWED.
 *
 * The workspace arm builds the epic's `WorkspaceVantage` and ignores the
 * session's active organization entirely; every other scope reads under the
 * organization the scope itself belongs to.
 */
async function resolveAnchor(scope: ScopeSurfaceRef): Promise<ScopeSurfaceAnchor | null> {
  const session = await getAuthSession();
  const userId = session?.user?.id;
  if (!session || !userId) return null;

  const activeOrgId =
    (session.session as { activeOrganizationId?: string | null } | undefined)
      ?.activeOrganizationId ?? null;

  // THE VANTAGE IS BUILT FOR EVERY SCOPE, not only the workspace one: it is the
  // membership fact this read fences on. The session's active organization is
  // NOT the organization a team, project or organization page is read under — a
  // reader may open another organization's entity page while their session
  // points elsewhere, and reading that page under the session's organization
  // would list the WRONG tenant's installs. The viewed organization is resolved
  // from the vantage instead, which also means an organization the actor has no
  // current membership in (or an archived one) resolves to nothing at all.
  const orgs = await readOrgsWithTeamsForUserActiveOnly(userId);
  const teamIdsByOrg: Record<string, string[]> = {};
  for (const org of orgs) teamIdsByOrg[org.id] = org.teams.map((t) => t.id);
  // The project axis is read only where a scope actually decides on it (the
  // project scope's own resolution, and the workspace union).
  const needsProjects = scope.kind === "project" || scope.kind === "workspace";
  const projectIdsByOrg = needsProjects ? await readProjectIdsByOrganization(userId, orgs) : {};
  const workspace = buildWorkspaceVantage({
    userId,
    memberships: orgs.map((org) => ({ orgId: org.id })),
    teamIdsByOrg,
    projectIdsByOrg,
    // Accepted and ignored by the builder — named here so the omission is
    // visible at the call site too.
    activeOrganizationId: activeOrgId,
  });

  if (scope.kind === "workspace") {
    return {
      userId,
      // The workspace scope reads under no single organization: every decision
      // is taken under one concrete member organization at a time.
      viewedOrgId: null,
      workspace,
    };
  }

  const viewedOrgId = resolveVantageOrgForScope(workspace, scope, activeOrgId);
  // FAIL CLOSED: a scope this reader reaches no organization from lists nothing.
  if (!viewedOrgId) return null;
  return { userId, viewedOrgId, workspace: null };
}

/**
 * The actor-visible projects of each member organization, EACH UNDER ITS OWN
 * ORGANIZATION (cinatra#3529).
 *
 * `readProjectsForUser` is the actor-visible project reader, but it is a
 * multi-organization union that never reads its organization argument. Taken
 * per organization as it stands, it put every project the reader sees into
 * every organization's list, and a project page was then read under whichever
 * member organization sorted first, not the one the project belongs to. So
 * each project is kept only under the organization it belongs to: the stored
 * `organization_id`, or, where an older row carries none, the organization of
 * its owning organization or team. A project that resolves to no member
 * organization is kept under none, and its tab lists nothing.
 */
async function readProjectIdsByOrganization(
  userId: string,
  orgs: readonly { id: string; teams: readonly { id: string }[] }[],
): Promise<Record<string, string[]>> {
  const visibleByOrg = new Map<string, Set<string>>();
  const allIds = new Set<string>();
  for (const org of orgs) {
    // Still read per organization, so the result stays right if the reader
    // ever narrows to the organization it is given.
    const ids = (await readProjectsForUser(userId, org.id)).map((p) => p.id);
    visibleByOrg.set(org.id, new Set(ids));
    for (const id of ids) allIds.add(id);
  }
  const out: Record<string, string[]> = {};
  for (const org of orgs) out[org.id] = [];
  if (allIds.size === 0) return out;

  const orgOfTeam = new Map<string, string>();
  for (const org of orgs) for (const team of org.teams) orgOfTeam.set(team.id, org.id);
  for (const fact of await readProjectOrganizationFacts([...allIds])) {
    const orgId =
      fact.organizationId ??
      (fact.ownerLevel === "organization"
        ? fact.ownerId
        : fact.ownerLevel === "team"
          ? (orgOfTeam.get(fact.ownerId) ?? null)
          : null);
    if (orgId && visibleByOrg.get(orgId)?.has(fact.id)) out[orgId]!.push(fact.id);
  }
  return out;
}

/** The live agent install rows, projected to what the decision and the cards need. */
async function readLiveAgentInstalls(
  facts: ReadonlyMap<string, PackageFacts>,
  bindings: ReadonlyMap<string, readonly ScopeSurfaceBinding[]>,
): Promise<readonly ScopeSurfaceInstall[]> {
  const { listInstalledExtensions } = await import("@cinatra-ai/extensions/canonical-store");
  const rows = await listInstalledExtensions({ kind: "agent" });
  const out: ScopeSurfaceInstall[] = [];
  for (const row of rows) {
    if (!LIVE_STATUSES.has(row.status)) continue;
    const fact = facts.get(row.packageName);
    // No template row → no access policy of its own and no honest name. Skipped
    // rather than shown under its raw package slug.
    if (!fact) continue;
    out.push({
      installId: row.id,
      packageName: row.packageName,
      displayName: fact.name,
      description: fact.description,
      organizationId: row.organizationId,
      ownerLevel: row.ownerLevel,
      ownerId: row.ownerId,
      status: row.status as ScopeSurfaceStatus,
      version: row.version ?? null,
      bindings: bindings.get(row.packageName) ?? [],
    });
  }
  return out;
}

/** The package → template facts map, read once per request. */
async function readPackageFacts(): Promise<ReadonlyMap<string, PackageFacts>> {
  const { readInstalledAgentTemplates } = await import("@cinatra-ai/agents/store");
  const templates = await readInstalledAgentTemplates();
  const facts = new Map<string, PackageFacts & { templateIds: string[] }>();
  for (const template of templates) {
    const packageName = template.packageName ?? null;
    if (!packageName) continue;
    const known = facts.get(packageName);
    if (known) {
      known.templateIds.push(template.id);
      continue;
    }
    facts.set(packageName, {
      templateId: template.id,
      templateIds: [template.id],
      name: template.name,
      description: template.description ?? null,
    });
  }
  return facts;
}

/**
 * The PROJECT scope's bindings, per package, in the shape the pure core reads
 * (cinatra#2808 change item 1: "exact-project installs + non-hidden project
 * bindings + exact-org (hidden bindings never surface)").
 *
 * Only a project scope reads any: a binding is a project fact, and no other
 * scope's rule consults one. The pure core drops a hidden binding before any
 * rule reads it; this read only has to say which bindings are hidden. It does
 * so FAIL-CLOSED: a binding is visible only when its stored visibility is one
 * the table names as surfaced (`visible`, `project-private`).
 *
 * A binding only ever ADDS a row, so a failed read degrades to "no bindings"
 * (the narrower list), never to an empty tab: the project keeps its exact-org
 * and exact-project rows, and the Assistants tab, which reads the same
 * eligibility, is not blanked either.
 */
async function readProjectBindings(
  scope: ScopeSurfaceRef,
  facts: ReadonlyMap<string, PackageFacts>,
): Promise<ReadonlyMap<string, readonly ScopeSurfaceBinding[]>> {
  const out = new Map<string, ScopeSurfaceBinding[]>();
  if (scope.kind !== "project") return out;
  let rows: Awaited<ReturnType<typeof readProjectAgentTemplateBindings>>;
  try {
    rows = await readProjectAgentTemplateBindings(scope.id);
  } catch (e) {
    warn("project binding read failed; listing the project without bound packages", e);
    return out;
  }
  if (rows.length === 0) return out;
  const packageOfTemplate = new Map<string, string>();
  for (const [packageName, fact] of facts) {
    for (const templateId of fact.templateIds) packageOfTemplate.set(templateId, packageName);
  }
  for (const row of rows) {
    const packageName = packageOfTemplate.get(row.agentTemplateId);
    if (!packageName) continue;
    const surfaced = row.visibility === "visible" || row.visibility === "project-private";
    const list = out.get(packageName) ?? [];
    list.push({ kind: "project", id: scope.id, hidden: !surfaced });
    out.set(packageName, list);
  }
  return out;
}

/** Every eligible row for a scope, or `[]` on any failure. */
export async function readScopeSurfaceEligibility(
  scope: ScopeSurfaceRef,
): Promise<readonly ScopeSurfaceEligibilityRow[]> {
  return (await readScopeSurfaceEligibilityWithAnchor(scope)).rows;
}

/** The same read, keeping the resolved anchor for the callers that also need
 *  the organization the scope was read under (the assistants predicate), and
 *  `ok`: whether the read actually COMPLETED.
 *
 *  An empty `rows` means two different things, and the assistants tab turns on
 *  the difference: a COMPLETED read that found no eligible install (`ok` true —
 *  the ordinary installation that has installed no assistant package), or a read
 *  that could not be taken at all (`ok` false — no resolvable anchor, or a
 *  failed membership/permission read). The failed read stays FAIL-CLOSED: a
 *  caller that would otherwise fold rows of its own in must render nothing. */
async function readScopeSurfaceEligibilityWithAnchor(
  scope: ScopeSurfaceRef,
): Promise<{
  rows: readonly ScopeSurfaceEligibilityRow[];
  viewedOrgId: string | null;
  ok: boolean;
}> {
  try {
    const anchor = await resolveAnchor(scope);
    if (!anchor) return { rows: [], viewedOrgId: null, ok: false };
    const viewedOrgId = anchor.viewedOrgId;
    const facts = await readPackageFacts();
    if (facts.size === 0) return { rows: [], viewedOrgId, ok: true };
    const installs = await readLiveAgentInstalls(facts, await readProjectBindings(scope, facts));
    if (installs.length === 0) return { rows: [], viewedOrgId, ok: true };

    const [
      { readExtensionAccessPolicies, readExtensionCoOwners, readExtensionInstalledBy },
      { DEFAULT_EXTENSION_ACCESS_POLICY, evaluateExtensionAccess },
      vantageModule,
      actor,
    ] = await Promise.all([
      import("@cinatra-ai/extensions/permissions-store"),
      import("@cinatra-ai/extensions/enforce-extension-access"),
      import("@cinatra-ai/extensions/access-scope-vantage"),
      requireActorContext(),
    ]);

    const templateIdOf = (install: ScopeSurfaceInstall) =>
      facts.get(install.packageName)!.templateId;

    // ONE batch read for every candidate — the list-surface reader, not N
    // singles — and the ONE snapshot both arms then read.
    const policies = await readExtensionAccessPolicies(
      "agent_template",
      installs.map(templateIdOf),
    );

    // ── PER-TEMPLATE AND PER-ORGANIZATION MEMOS ────────────────────────────
    // The actor arm runs once per (install, candidate organization). The
    // trusted-party reads depend only on the template and the actor axes only
    // on the organization, so each is resolved at most once and shared.
    const coOwnerCache = new Map<string, Promise<string[]>>();
    const trustedParties = (templateId: string): Promise<string[]> => {
      let hit = coOwnerCache.get(templateId);
      if (!hit) {
        hit = readExtensionCoOwners("agent_template", templateId).then((rows) =>
          rows.map((c) => c.userId),
        );
        coOwnerCache.set(templateId, hit);
      }
      return hit;
    };
    const installerCache = new Map<string, Promise<string | null>>();
    const installerOf = (templateId: string): Promise<string | null> => {
      let hit = installerCache.get(templateId);
      if (!hit) {
        hit = readExtensionInstalledBy("agent_template", templateId);
        installerCache.set(templateId, hit);
      }
      return hit;
    };
    const actorCache = new Map<string, Promise<typeof actor>>();
    const actorForOrg = (orgId: string): Promise<typeof actor> => {
      let hit = actorCache.get(orgId);
      if (!hit) {
        hit = resolveActorGrantsForUserInOrg(anchor.userId, orgId).then((grants) => ({
          ...actor,
          organizationId: orgId,
          teamIds: grants.teamIds,
          projectGrants: grants.projectGrants,
          // `projectIds` is the derived shortcut the legacy membership
          // predicates still read, and it is kept in lockstep with the grants.
          projectIds: grants.projectGrants.map((g) => g.projectId).sort(),
          ...(grants.orgRole ? { orgRole: grants.orgRole } : { orgRole: undefined }),
          ...(grants.teamRoles ? { teamRoles: grants.teamRoles } : { teamRoles: undefined }),
        }));
        actorCache.set(orgId, hit);
      }
      return hit;
    };

    const rows = await resolveScopeSurfaceEligibility<AgentAuthPolicy>({
      scope,
      anchor,
      installs,
      arms: {
        policyFor: (install) =>
          policies.get(templateIdOf(install)) ?? DEFAULT_EXTENSION_ACCESS_POLICY,
        vantageAdmits: (policy: AgentAuthPolicy, vantage: AccessScopeVantage) =>
          vantageModule.policyFieldAdmitsScopeVantage(policy.runDataVisibility, vantage),
        // THE ACTOR ARM, over that SAME already-resolved policy value — never a
        // second read of the policy.
        actorAdmits: async (policy, install, orgId) => {
          const templateId = templateIdOf(install);
          // The trusted-party facts belong to the TEMPLATE, not to the
          // organization the decision is taken in: read once per template and
          // reused across every candidate organization.
          const [coOwners, installedBy, actorInOrg] = await Promise.all([
            trustedParties(templateId),
            installerOf(templateId),
            actorForOrg(orgId),
          ]);
          return evaluateExtensionAccess({
            kind: "agent_template",
            policy,
            coOwnerUserIds: coOwners,
            installedByUserId: installedBy,
            owner: {
              ownerLevel: install.ownerLevel,
              ownerId: install.ownerId,
              organizationId: install.organizationId,
            },
            // Org-fenced sources are read SEPARATELY under each member
            // organization (the epic's WorkspaceVantage anchor), so the actor is
            // evaluated anchored to the concrete organization the decision is
            // taken in — never to whichever organization the session points at.
            // Anchoring means the WHOLE actor: the role, the teams and the
            // project grants are re-resolved IN that organization too, because
            // an admin of one organization is an ordinary member of the next and
            // the evaluator reads exactly those axes.
            actor: actorInOrg,
            op: "use",
          }).allowed;
        },
      },
    });
    return { rows, viewedOrgId, ok: true };
  } catch (e) {
    warn("eligibility read failed; rendering no rows", e);
    return { rows: [], viewedOrgId: null, ok: false };
  }
}

/**
 * The AGENTS tab's rows for a scope: the eligible packages, minus the assistant
 * packages (which are the Assistants tab's), with the scoped hrefs of #2809.
 */
export async function readScopeSurfaceAgentRows(
  scope: ScopeSurfaceRef,
): Promise<readonly ScopeAgentCardRow[]> {
  try {
    const eligible = await readScopeSurfaceEligibility(scope);
    if (eligible.length === 0) return [];
    // FAIL-CLOSED: an unreadable assistants directory must not be read as "no
    // assistants", which would list every assistant as an agent.
    const assistantPackages = await readAssistantPackageNames();
    const rows = eligible.filter((row) => !assistantPackages.has(row.packageName));
    return buildScopeSurfaceAgentRows(scope, rows);
  } catch (e) {
    warn("agents tab read failed; rendering no rows", e);
    return [];
  }
}

/**
 * The ASSISTANTS tab's rows for a scope: the /assistants directory resolver's
 * own rows, narrowed by the viewed scope through an INJECTED predicate (never a
 * value import of `scope-filter` — the resolver is reached from /chat and three
 * ratcheted API routes), then extended with Settings and the installed-card
 * fields by the eligibility read.
 *
 * THE DIRECTORY IS CONSULTED WHETHER OR NOT AN INSTALLED ASSISTANT PACKAGE IS
 * ELIGIBLE. The built-in platform assistant is never an `installed_extension`
 * row — the registry reader unions its descriptor in unconditionally — so an
 * eligible set that is empty says nothing about what the tab lists; short-
 * circuiting on it drew the empty-read placeholder on every installation that
 * has installed no assistant package. The eligibility read is what filters the
 * INSTALLED assistant packages, and `buildScopeSurfaceAssistantRows` applies it
 * to those alone.
 */
export async function readScopeSurfaceAssistantRows(
  scope: ScopeSurfaceRef,
): Promise<readonly ScopeAssistantCardRow[]> {
  try {
    const { rows: eligible, viewedOrgId, ok } = await readScopeSurfaceEligibilityWithAnchor(scope);
    // FAIL-CLOSED on a read that could not be TAKEN. An eligible set that is
    // empty because nothing is installed is a real answer and the directory is
    // consulted for it; an unresolvable anchor or a failed membership read is
    // not, and must not surface the built-in row on a tab whose fence never ran.
    if (!ok) return [];

    const { buildAssistantsDirectoryForCurrentActor } = await import(
      "@/lib/assistants-directory.server"
    );
    const directory = await buildAssistantsDirectoryForCurrentActor({
      scopeMatch: scopeSurfaceAudiencePredicate(scope, viewedOrgId),
    });
    return buildScopeSurfaceAssistantRows(scope, directory, eligible);
  } catch (e) {
    warn("assistants tab read failed; rendering no rows", e);
    return [];
  }
}

/**
 * The viewed scope as an audience predicate over a row's folded scope entries.
 *
 * INJECTED into the directory resolver, exactly as /assistants injects its
 * `?scope=` predicate: the resolver never imports the scope vocabulary, so the
 * route budgets of /chat and the ratcheted API routes are unchanged.
 *
 * The workspace and personal scopes pass NO predicate (the broadest view, which
 * the eligibility read has already narrowed); an organization, team or project
 * scope admits a row whose audience names that entity, or the workspace tier.
 */
export function scopeSurfaceAudiencePredicate(
  scope: ScopeSurfaceRef,
  viewedOrgId?: string | null,
):
  | ((entries: readonly { locus: string; locusId?: string; adminOnly?: boolean }[]) => boolean)
  | undefined {
  if (scope.kind === "workspace" || scope.kind === "personal") return undefined;
  const locus =
    scope.kind === "organization" ? "organization" : scope.kind === "team" ? "team" : "project";
  return (entries) =>
    entries.some(
      (entry) =>
        (entry.locus === locus && entry.locusId === scope.id) ||
        // EXACT-ORG INHERITANCE, the same rule the eligibility fence applies to
        // installs: a team or project surfaces its organization's rows too, so
        // an organization-audience assistant is not dropped from the team and
        // project tabs of that very organization.
        (locus !== "organization" &&
          entry.locus === "organization" &&
          !!viewedOrgId &&
          entry.locusId === viewedOrgId) ||
        (entry.locus === "workspace" && entry.adminOnly !== true),
    );
}

/** The package names the assistants directory owns — the Agents tab's exclusion. */
async function readAssistantPackageNames(): Promise<ReadonlySet<string>> {
  const { buildAssistantsDirectoryForCurrentActor } = await import(
    "@/lib/assistants-directory.server"
  );
  const rows = await buildAssistantsDirectoryForCurrentActor();
  return new Set(rows.map((r) => r.packageName));
}
