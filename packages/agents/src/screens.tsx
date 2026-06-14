import { redirect, notFound } from "next/navigation";
import { format, formatDistanceToNow } from "date-fns";
import { TriangleAlert, Upload } from "lucide-react";
import semver from "semver";
import Link from "next/link";
import {
  requireAdminSession,
  requireAuthSession,
  getAuthSession,
  buildCanDoOptsFromSession,
  isPlatformAdmin,
  resolveOrgRoleForSession,
} from "@/lib/auth-session";
import {
  readOrgsWithTeamsForUser,
  readProjectsForUser,
} from "@/lib/better-auth-db";
import { canDo } from "@/lib/authz";
import { buildAgentWorkspacePath } from "@/lib/agent-url";
import {
  readAgentTemplateById,
  readAgentTemplateByPackageName,
} from "./store";
import {
  // InstallScopeDialog targets installRegistryPackageAtScope directly.
  // Update + uninstall actions are unchanged.
  updateRegistryPackage,
  uninstallRegistryPackage,
  installRegistryPackageAtScope,
} from "./actions";
import { RegistryUninstallForm } from "./registry-uninstall-form";
import { getAgentPackage } from "@cinatra-ai/registries";
import type { VerdaccioConfig } from "@cinatra-ai/registries";
import { loadVerdaccioConfigForReads } from "@/lib/verdaccio-config";
import { RegistryVersionHistoryList, type RegistryVersionRow } from "./registry-version-history-list";
import { RecompileForm } from "./recompile-form";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PaginatedTable } from "@/components/ui/paginated-table";
import { Badge } from "@/components/ui/badge";
import { RiskBadge } from "@/components/risk-badge";
import { Button } from "@/components/ui/button";
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { MarketplaceReadmeMarkdownSection } from "@/components/marketplace-readme-section";
import { RequiredDependenciesSection } from "@/components/extensions/required-dependencies-section";
import { summarizeRequiredDependencies } from "@/lib/extension-dependency-ux";
import { parseManifestDependencyEdges } from "@cinatra-ai/extensions/manifest-dependencies";
import { Tabs, TabsContent, TabsList, TabsListRow, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ImportAgentForm } from "./import-form";
import { ImportSkillFromGitHubForm } from "./import-skill-from-github-form";
// InstallScopeDialog + server-side picker target builder.
import { InstallScopeDialog } from "./components/install-scope-dialog";
import {
  buildInstallTargets,
  pickDefaultPickerValue,
  type InstallActorForTargets,
} from "./install-targets";
import {
  readTeamsForUser,
  betterAuthDb,
  betterAuthOrganizations,
} from "@/lib/better-auth-db";
import {
  readProjectById,
  readProjectCoOwners,
  projects as projectsTable,
  projectsDb,
} from "@/lib/projects-store";
import { and, eq, inArray, or } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Risk-class badge palette — 4-tier visual distinction.
 *
 * Keep `draft_create` and `send_external_message` visually distinct; sharing
 * the same `warning` palette loses the third tier. The intended scale is:
 *
 *  - read_only / unknown        → muted   (no risk; informational)
 *  - external_lookup            → info    (network read, no side effects)
 *  - draft_create               → warning (reversible local mutation)
 *  - send_external_message      → destructive (irrecoverable external send;
 *                                  treated like delete/financial_commitment
 *                                  because once an outbound message lands it
 *                                  cannot be unsent)
 *  - delete / financial_commitment → destructive
 *
 * Keep the 4 tiers visually distinct — collapsing them hides risk gradients
 * from operators reviewing planned actions.
 */
function getRiskBadgeClass(
  riskClass: string,
): string {
  switch (riskClass) {
    case "read_only":
      return "bg-muted text-muted-foreground border-line";
    case "external_lookup":
      return "bg-info/10 text-info border-info/30";
    case "draft_create":
      return "bg-warning/10 text-warning border-warning/30";
    case "send_external_message":
    case "delete":
    case "financial_commitment":
      return "bg-destructive/10 text-destructive border-destructive/30";
    default:
      return "bg-muted text-muted-foreground border-line";
  }
}

function getRunStatusBadgeVariant(
  status: string,
): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "completed":
      return "default";
    case "running":
      return "secondary";
    case "failed":
      return "destructive";
    case "stopped":
      return "outline";
    default:
      return "outline";
  }
}

function toLabel(key: string, title?: string): string {
  if (title) return title;
  // snake_case or camelCase → Title Case
  return key
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function getActiveOrganizationId(session: {
  session?: {
    activeOrganizationId?: string | null;
  } | null;
}): string | undefined {
  return session.session?.activeOrganizationId ?? undefined;
}

function isRegistryPackageNotFound(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  const status = (error as { status?: number; statusCode?: number }).status
    ?? (error as { status?: number; statusCode?: number }).statusCode;
  return code === "E404" || status === 404;
}

function formatDate(date: Date | string | null | undefined): string {
  if (!date) return "—";
  try {
    return format(new Date(date), "MMM d, yyyy HH:mm");
  } catch {
    return "—";
  }
}


// ---------------------------------------------------------------------------
// AgentBuilderRunScreen
// ---------------------------------------------------------------------------

export async function AgentBuilderRunScreen({ templateId }: { templateId: string }) {
  await requireAdminSession();
  const template = await readAgentTemplateById(templateId);
  if (!template) notFound();
  redirect(`/agents/${template.id}/new`);
}

// ---------------------------------------------------------------------------
// Shared helpers for approval screens
// ---------------------------------------------------------------------------

function riskVariant(riskClass: string): "default" | "secondary" | "destructive" | "outline" {
  if (["send_external_message", "delete", "financial_commitment"].includes(riskClass)) {
    return "destructive";
  }
  if (riskClass === "draft_create") return "outline";
  return "secondary";
}

// ---------------------------------------------------------------------------
// AgentApprovalInboxBody
// ---------------------------------------------------------------------------
//
// Body-only renderer (no Main / PageHeader / requireAdminSession). The caller
// is responsible for the page chrome and the admin gate. Used by the unified
// /configuration/approvals tabbed page.

export async function AgentApprovalInboxBody({
  statusFilter,
  filterBaseHref,
}: {
  statusFilter: string;
  /**
   * Base href for the status-filter pill links. The caller passes the URL
   * fragment up to (but not including) the `&status=...` portion — e.g.
   * `/configuration/approvals?tab=agents`. The body appends `&status=<value>`.
   */
  filterBaseHref: string;
}) {
  const session = await getAuthSession();
  const orgId = session?.session?.activeOrganizationId ?? null;
  type ApprovalInboxTask = {
    id: string;
    runId: string;          // repurposed: shows request id prefix
    title: string;          // repurposed: packageName@version
    riskClass: string;      // repurposed: status as risk pill
    itemCount: number;      // repurposed: rejection-cycle count or 0
    status: string;
    expiresAt: Date;        // repurposed: created_at
  };
  let tasks: ApprovalInboxTask[] = [];
  if (orgId) {
    const { listAgentCreationRequests } = await import(
      "@/lib/agent-creation-requests-store"
    );
    const rows = listAgentCreationRequests({
      orgId,
      status: statusFilter === "all" ? "all" :
        (["pending"].includes(statusFilter) ? "proposed" :
        (["approved", "rejected", "published", "draft"].includes(statusFilter)
          ? (statusFilter as "approved" | "rejected" | "published" | "draft")
          : "proposed")),
    });
    tasks = rows.map((r) => ({
      id: r.id,
      runId: r.id,
      title: `${r.packageName}@${r.packageVersion}`,
      riskClass: r.status === "proposed" ? "medium" : r.status === "rejected" ? "high" : "low",
      itemCount: r.rejectionReason ? 1 : 0,
      status: r.status,
      expiresAt: new Date(r.createdAt),
    }));
  }

  // Filter -> agent_creation_request.status mapping. Real statuses are
  // draft | proposed | approved | rejected | published. "Expired" had no
  // backing status (the previous pill silently fell through to "proposed",
  // duplicating Pending) and is dropped.
  const filterOptions = [
    { label: "All", value: "all" },
    { label: "Pending", value: "pending" },
    { label: "Approved", value: "approved" },
    { label: "Rejected", value: "rejected" },
  ];
  const activeTab = filterOptions.some((o) => o.value === statusFilter)
    ? statusFilter
    : "pending";

  return (
    <Tabs value={activeTab}>
      <Card>
        <CardHeader className="border-b border-line">
          <TabsList>
            {filterOptions.map((opt) => (
              <TabsTrigger key={opt.value} value={opt.value} asChild>
                <Link href={`${filterBaseHref}&status=${opt.value}`} scroll={false}>
                  {opt.label}
                </Link>
              </TabsTrigger>
            ))}
          </TabsList>
        </CardHeader>
        <CardContent className="p-0">
          {tasks.length === 0 ? (
            <div className="flex items-center justify-center py-16">
              <p className="text-muted-foreground text-sm">
                No {statusFilter} approval requests
              </p>
            </div>
          ) : (
            <PaginatedTable>
              <TableHeader>
                <TableRow>
                  <TableHead>Task</TableHead>
                  <TableHead>Risk</TableHead>
                  <TableHead>Items</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Deadline</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tasks.map((task) => (
                  <TableRow key={task.id}>
                    <TableCell>
                      <Link
                        href={`/configuration/agents/approvals/${task.id}`}
                        className="font-medium text-foreground hover:underline"
                      >
                        {task.title}
                      </Link>
                      <div className="text-xs text-muted-foreground font-mono">
                        run {task.runId.slice(0, 8)}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={riskVariant(task.riskClass)}>
                        {task.riskClass.replace(/_/g, " ")}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{task.itemCount}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{task.status}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {formatDistanceToNow(new Date(task.expiresAt), { addSuffix: true })}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </PaginatedTable>
          )}
        </CardContent>
      </Card>
    </Tabs>
  );
}

// ---------------------------------------------------------------------------
// AgentApprovalDetailScreen
// ---------------------------------------------------------------------------

export async function AgentApprovalDetailScreen({ id }: { id: string }) {
  await requireAdminSession();
  const session = await getAuthSession();
  const orgId = session?.session?.activeOrganizationId ?? null;
  if (!orgId) {
    return (
      <Main className="min-h-screen">
        <PageContent className="flex flex-col gap-6 pb-8">
          <div className="soft-panel rounded-card px-6 py-8 text-center">
            <p className="text-muted-foreground mb-4">No active organization.</p>
            <Link href="/configuration/approvals?tab=agents" className="text-sm text-foreground hover:underline">
              ← Approval Inbox
            </Link>
          </div>
        </PageContent>
      </Main>
    );
  }
  const { readAgentCreationRequestById } = await import(
    "@/lib/agent-creation-requests-store"
  );
  const req = readAgentCreationRequestById(id, orgId);
  if (!req) {
    return (
      <Main className="min-h-screen">
        <PageContent className="flex flex-col gap-6 pb-8">
          <div className="soft-panel rounded-card px-6 py-8 text-center">
            <p className="text-muted-foreground mb-4">Agent creation request not found.</p>
            <Link href="/configuration/approvals?tab=agents" className="text-sm text-foreground hover:underline">
              ← Approval Inbox
            </Link>
          </div>
        </PageContent>
      </Main>
    );
  }
  const isPending = req.status === "proposed";

  // Lazy import the server-action module — it lives in the host app and the
  // package can't import directly without a circular dep at the type layer.
  // Render a plain HTML form that POSTs to the server actions (Next App Router
  // server-action conventions; the receiving route is a server component).
  const { ApprovalDecisionForm } = await import(
    "@/app/configuration/agents/approvals/[id]/decision-form"
  );

  return (
    <Main className="min-h-screen">
      <PageHeader
        label="Agents"
        title={`${req.packageName}@${req.packageVersion}`}
        description={`Proposal from ${req.authorId} — status ${req.status}`}
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <div className="soft-panel rounded-card px-6 py-4">
          <div className="text-xs text-muted-foreground font-mono">request {req.id}</div>
          <div className="text-xs text-muted-foreground font-mono">snapshotHash {req.snapshotHash.slice(0, 16)}…</div>
          {req.rejectionReason ? (
            <div className="mt-2 text-sm">
              <span className="text-muted-foreground">Rejection reason:</span> {req.rejectionReason}
            </div>
          ) : null}
        </div>

        <div className="soft-panel rounded-card px-6 py-4">
          <h3 className="text-sm font-semibold mb-2">Review report</h3>
          <pre className="text-xs overflow-auto whitespace-pre-wrap break-words text-muted-foreground">
            {JSON.stringify(req.reviewReport, null, 2)}
          </pre>
        </div>

        <div className="soft-panel rounded-card px-6 py-4">
          <h3 className="text-sm font-semibold mb-2">Proposal snapshot (oas.json)</h3>
          <pre className="text-xs overflow-auto whitespace-pre-wrap break-words text-muted-foreground max-h-96">
            {JSON.stringify(req.proposalSnapshot.oas, null, 2)}
          </pre>
        </div>

        <div className="soft-panel rounded-card px-6 py-4">
          <h3 className="text-sm font-semibold mb-2">Proposal snapshot (package.json)</h3>
          <pre className="text-xs overflow-auto whitespace-pre-wrap break-words text-muted-foreground max-h-64">
            {JSON.stringify(req.proposalSnapshot.packageJson, null, 2)}
          </pre>
        </div>

        {isPending ? (
          <ApprovalDecisionForm requestId={req.id} snapshotHash={req.snapshotHash} />
        ) : req.status === "approved" ? (
          // Stuck-approved state: CAS to approved succeeded but materialize+
          // publish errored. Admin can retry without re-deciding.
          <ApprovalDecisionForm
            requestId={req.id}
            snapshotHash={req.snapshotHash}
            stuckApproved
          />
        ) : (
          <div className="soft-panel rounded-card px-6 py-4 text-sm text-muted-foreground">
            This request is no longer pending (status: {req.status}).
            {req.decidedBy ? <> Decided by {req.decidedBy}.</> : null}
          </div>
        )}
      </PageContent>
    </Main>
  );
}

// ---------------------------------------------------------------------------
// Registry helpers
// ---------------------------------------------------------------------------

/**
 * Test/DI seam for the agent-detail manifest read config. Production leaves
 * these undefined so the real `@/lib/gatekept-install` server-only module is
 * dynamically imported; tests inject in-memory stubs so they never touch the
 * marketplace HTTP client or a real packument read. Mirrors the
 * `ResolveExtensionKindOptions` seam in `packages/extensions/src/utils.ts`.
 */
export interface ResolveDetailReadConfigOptions {
  /** Override the master-flag check (defaults to `isGatekeptInstallEnabled`). */
  isGatekeptInstallEnabled?: () => boolean;
  /** Override the gatekept resolver (defaults to `resolveGatekeptInstallConfig`). */
  resolveGatekeptInstallConfig?: (
    packageName: string,
    version: string,
  ) => Promise<{ config: VerdaccioConfig; authorize: { resolvedVersion: string } }>;
  /** Override the legacy read-config loader (defaults to `loadVerdaccioConfigForReads`). */
  loadVerdaccioConfigForReads?: () => Promise<VerdaccioConfig>;
}

/**
 * The resolved read config plus the EXACT version the manifest read should pin.
 *
 * On the gatekept path `resolvedVersion` is the concrete version the broker
 * authorized (authoritative — it may differ from the raw `listedVersion`); the
 * caller threads it into `getAgentPackage` so pacote fetches that exact version
 * rather than the registry default/latest. On the legacy (flag-OFF) path it is
 * `undefined` so the read is unchanged (no version pinning change).
 */
export interface DetailReadConfigResult {
  config: VerdaccioConfig;
  resolvedVersion?: string;
}

/**
 * Resolve the `VerdaccioConfig` the agent-detail manifest read (`getAgentPackage`)
 * threads to pacote, plus the exact version to pin on the gatekept path.
 *
 * Gatekept install: when `CINATRA_GATEKEPT_INSTALL` is ON, the
 * agent-detail read routes through the marketplace broker via a per-install
 * grant (`resolveGatekeptInstallConfig`) for the EXACT storefront-listed
 * version — the instance never reads `registry.cinatra.ai` directly on the
 * detail path. The authorize response carries the concrete `resolvedVersion`,
 * which is returned so the caller fetches that exact manifest (not the registry
 * default/latest). When OFF, this returns `loadVerdaccioConfigForReads()` with
 * `resolvedVersion: undefined` (exact legacy behavior — no version pinning).
 *
 * `listedVersion` is the storefront-listed version the page already resolved via
 * `extensionGet`; it is what authorize is scoped to. When absent (legacy direct
 * caller), it defaults to `"latest"` so the authorize ability resolves the
 * listed version — only consulted when the flag is ON.
 */
export async function resolveDetailReadConfig(
  packageName: string,
  listedVersion: string | undefined,
  options?: ResolveDetailReadConfigOptions,
): Promise<DetailReadConfigResult> {
  const isEnabled =
    options?.isGatekeptInstallEnabled ??
    (await import("@/lib/gatekept-install")).isGatekeptInstallEnabled;
  if (isEnabled()) {
    const resolve =
      options?.resolveGatekeptInstallConfig ??
      (await import("@/lib/gatekept-install")).resolveGatekeptInstallConfig;
    const { config, authorize } = await resolve(
      packageName,
      listedVersion ?? "latest",
    );
    // Prefer the authorize response's resolvedVersion (authoritative — what the
    // broker actually authorized + serves) over the raw listedVersion.
    return { config, resolvedVersion: authorize.resolvedVersion };
  }
  const loadReads =
    options?.loadVerdaccioConfigForReads ?? loadVerdaccioConfigForReads;
  return { config: await loadReads() };
}

// ---------------------------------------------------------------------------
// RegistryEntryDetailSections
//
// The agent-specific BODY of the marketplace detail view. The page shell —
// <Main>, the marketplace hero header (kind emblem + name + license badge +
// freshness/version meta), and <PageContent> — is owned by the
// /configuration/marketplace/[scope]/[name] route, which renders the same
// shell for every extension kind from the marketplace `ExtensionDetail`.
// This component contributes only the agent sections beneath it, with the
// README block FIRST (the primary-body slot, mirroring the public page's
// Description tab) followed by the admin metadata + install controls.
// ---------------------------------------------------------------------------

export async function RegistryEntryDetailSections({
  packageName,
  listedVersion,
  readmeMarkdown,
}: {
  packageName: string;
  /**
   * The storefront-listed version resolved by the detail page via `extensionGet`.
   * When gatekept install is ON, the manifest read authorizes this EXACT version
   * through the broker. Optional + only consulted under the flag — flag-OFF
   * behavior is unchanged (legacy direct `loadVerdaccioConfigForReads`).
   */
  listedVersion?: string;
  /**
   * The marketplace-sourced README (`ExtensionDetail.readmeMarkdown`) resolved
   * by the detail page via `extensionGet` — the same field the public
   * marketplace Description tab renders. It is the ONLY source for the
   * primary-body README section; Verdaccio's `entry.readme` is intentionally
   * NOT a fallback, so the in-app body always matches the public listing.
   * Empty/absent hides the section cleanly (no empty pane).
   */
  readmeMarkdown?: string | null;
}) {
  const session = await requireAuthSession();
  // Compute role-aware booleans once per render.
  const opts = await buildCanDoOptsFromSession(session);
  const canInstall = canDo(session, "registry.install", undefined, opts);
  const canUninstall = canDo(session, "registry.uninstall", undefined, opts);
  // packageName arrives already reassembled by the [scope]/[name] route file,
  // so no decodeURIComponent is needed here.
  let entry: Awaited<ReturnType<typeof getAgentPackage>>;

  try {
    // getAgentPackage requires an explicit VerdaccioConfig. Gatekept install:
    // when ON, the read config is broker-pointed (per-install grant)
    // for the storefront-listed version so the instance never reads
    // registry.cinatra.ai directly on the detail path; when OFF this is exactly
    // loadVerdaccioConfigForReads() (legacy behavior unchanged).
    const { config: verdaccioConfig, resolvedVersion } =
      await resolveDetailReadConfig(packageName, listedVersion);
    // Gatekept ON: pin the EXACT authorized version so pacote fetches that
    // manifest, not the registry default/latest (getAgentPackage forwards
    // packageVersion into extraction). Gatekept OFF: resolvedVersion is
    // undefined → unchanged legacy call (no packageVersion, no pinning change).
    entry = await getAgentPackage(
      { packageName, packageVersion: resolvedVersion },
      verdaccioConfig,
    );
  } catch (error) {
    if (isRegistryPackageNotFound(error)) {
      notFound();
    }
    throw error;
  }

  // Detail-screen single-key lookup (NOT bulk reader).
  const installedTemplate = await readAgentTemplateByPackageName(entry.packageName);

  // Pre-install "A requires B, C" (cinatra #209 item 2, surface 1): derive the
  // requires summary from the SAME manifest edges the install gates and the
  // dependency planner read (`parseManifestDependencyEdges`), so the surface
  // can never promise an install behavior the saga does not perform. This is a
  // DISPLAY-ONLY read; a malformed-edge manifest must not crash the detail page
  // (the per-member forward install gate stays the real enforcement boundary),
  // so a parse failure degrades to "no requires shown" with a logged warning.
  let requiredDependencies = summarizeRequiredDependencies([]);
  try {
    const { edges } = parseManifestDependencyEdges(entry.manifest, {
      packageName: entry.packageName,
    });
    requiredDependencies = summarizeRequiredDependencies(edges);
  } catch (depErr) {
    console.warn(
      "[registry-detail] could not parse dependency edges for %s (requires surface omitted):",
      entry.packageName,
      depErr instanceof Error ? depErr.message : depErr,
    );
  }

  // -------------------------------------------------------------------------
  // Server-side compute of install picker rows.
  //
  // Single source of truth for enabled/disabled state per target row. The
  // dialog never reads actor.teamRoles — it consumes installTargets as a
  // pre-decided shape. Mirrors the assertCanInstallAtTarget rule grid in
  // actions.ts (parity locked by install-targets-parity.test.ts).
  //
  // NOTE: Production today does NOT load teamRoles from any canonical store
  // (Better Auth's teamMember table has no role column). Team and
  // team-owned-project rows are DISABLED for non-platform_admin actors until
  // team_admin role loading exists. The picker reflects this naturally — no
  // special branch here.
  // -------------------------------------------------------------------------
  const activeOrgId = getActiveOrganizationId(session);
  // currentProjectId is propagation deferred — agent-detail screen does
  // not currently have a project context in scope. Project rows still
  // render whenever the actor owns the project; just no auto-default.
  const currentProjectId: string | undefined = undefined;

  const installActor: InstallActorForTargets = {
    principalId: session.user.id,
    organizationId: activeOrgId ?? "",
    platformRole:
      String(session.user.role ?? "")
        .split(",")
        .map((s) => s.trim())
        .some((r) => r === "admin" || r === "platform_admin")
        ? "platform_admin"
        : "member",
    orgRole: opts.orgRole,
    // teamRoles intentionally omitted — see hand-off note above.
  };

  // Look up org name for the picker label.
  let orgName = "Organization";
  if (activeOrgId) {
    const orgRows = await betterAuthDb
      .select({ name: betterAuthOrganizations.name })
      .from(betterAuthOrganizations)
      .where(eq(betterAuthOrganizations.id, activeOrgId))
      .limit(1);
    if (orgRows[0]?.name) orgName = orgRows[0].name;
  }

  // Teams the actor belongs to in the active org.
  const userTeams = activeOrgId
    ? await readTeamsForUser(session.user.id, activeOrgId)
    : [];

  // Projects in the active org owned by the actor (user-owned or co-owned)
  // OR by a team the actor is a member of. Visibility is intentionally
  // narrower than "all projects in the org" — non-owners should not see
  // projects they have no install authority over.
  const projectsForPicker: {
    id: string;
    name: string;
    ownerUserIds: string[];
    owningTeamId: string | null;
  }[] = [];
  if (activeOrgId) {
    const teamIds = userTeams.map((t) => t.id);
    const ownClause = and(
      eq(projectsTable.ownerLevel, "user"),
      eq(projectsTable.ownerId, session.user.id),
    );
    const teamClause =
      teamIds.length > 0
        ? and(
            eq(projectsTable.ownerLevel, "team"),
            inArray(projectsTable.ownerId, teamIds),
          )
        : undefined;
    const orClauses = [ownClause, ...(teamClause ? [teamClause] : [])];
    const rows = await projectsDb
      .select({
        id: projectsTable.id,
        name: projectsTable.name,
        ownerLevel: projectsTable.ownerLevel,
        ownerId: projectsTable.ownerId,
      })
      .from(projectsTable)
      .where(orClauses.length > 1 ? or(...orClauses) : ownClause)
      .orderBy(projectsTable.name);

    for (const row of rows) {
      // ownerUserIds union: project owner (when user-owned) + co-owners.
      const ownerUserIds: string[] = [];
      if (row.ownerLevel === "user") ownerUserIds.push(row.ownerId);
      const coOwners = await readProjectCoOwners(row.id);
      for (const co of coOwners) ownerUserIds.push(co.userId);
      projectsForPicker.push({
        id: row.id,
        name: row.name,
        ownerUserIds,
        owningTeamId: row.ownerLevel === "team" ? row.ownerId : null,
      });
    }
  }

  const installTargets = buildInstallTargets({
    actor: installActor,
    activeOrgId: activeOrgId ?? "",
    orgName,
    teams: userTeams,
    projects: projectsForPicker,
    currentProjectId,
  });
  const ownerEntityNames: Record<string, string> = {
    org: orgName,
    ...Object.fromEntries(userTeams.map((t) => [`team:${t.id}`, t.name])),
    ...Object.fromEntries(
      projectsForPicker.map((p) => [`project:${p.id}`, p.name]),
    ),
  };
  const installDefaultValue = pickDefaultPickerValue(
    installTargets,
    currentProjectId,
  );

  // New installs go through InstallScopeDialog →
  // installRegistryPackageAtScope. Update + Uninstall actions remain
  // unchanged below.
  // Update action — surfaces only when registry has a newer version than the
  // installed template (update-available state).
  const updateAction = updateRegistryPackage.bind(null, {
    packageName: entry.packageName,
    packageVersion: entry.packageVersion,
  });
  // Compute install state from installedTemplate vs entry.packageVersion.
  // - notInstalled: no row → show Install
  // - updateAvailable: installed version < registry version → show Update
  // - current OR installed-newer: hide Install/Update; show Uninstall only.
  const isUpdateAvailable =
    installedTemplate?.packageVersion != null &&
    semver.valid(installedTemplate.packageVersion) != null &&
    semver.valid(entry.packageVersion) != null &&
    semver.lt(installedTemplate.packageVersion, entry.packageVersion);
  const showInstallButton = !installedTemplate;
  const showUpdateButton = installedTemplate != null && isUpdateAvailable;

  const uninstallAction = installedTemplate
    ? uninstallRegistryPackage.bind(null, {
        packageName: entry.packageName,
        templateId: installedTemplate.id,
      })
    : null;

  return (
    <>
      {entry.deprecated ? (
        <section className="soft-panel rounded-card px-6 py-5">
          <p className="text-sm text-muted-foreground">
            This extension version has been deprecated. It stays available for auditability, but new installs should usually prefer a newer version.
          </p>
        </section>
      ) : null}

      {/* PRIMARY BODY — the README occupies the first content slot
          (only the deprecation status notice above may precede it),
          mirroring the public marketplace's Description tab. The content is
          the marketplace-sourced `readmeMarkdown` (the SAME field the public
          page renders — NOT Verdaccio's `entry.readme`), rendered through the
          sanitizing `renderReadmeMarkdown` helper with headings demoted one
          level (the hero owns the page <h1>) and the scoped editorial
          typography. Empty/absent README → no section at all. */}
      <MarketplaceReadmeMarkdownSection markdown={readmeMarkdown} />

      <section className="soft-panel rounded-card px-6 py-5">
        <h2 className="text-sm font-semibold text-foreground mb-3">Extension Details</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">Package</p>
            <p className="mt-1 font-mono text-sm text-foreground">{entry.packageName}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">Version</p>
            <p className="mt-1 font-mono text-sm text-foreground">v{entry.packageVersion}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">Published</p>
            <p className="mt-1 text-sm text-foreground">{formatDate(entry.publishedAt)}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">Registry</p>
            <p className="mt-1 text-sm text-foreground">{entry.registryUrl}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">Risk Level</p>
            <p className="mt-1 text-sm text-foreground">
              {/* Shared semantic badge — the catalog list view renders the
                  SAME component, so list and detail presentation never drift. */}
              <RiskBadge riskLevel={entry.riskLevel} />
            </p>
          </div>
        </div>
      </section>

      <section className="soft-panel rounded-card px-6 py-5">
        <h2 className="text-sm font-semibold text-foreground mb-3">Tool Access</h2>
        {entry.toolAccess.filter(Boolean).length === 0 ? (
          <p className="text-sm text-muted-foreground">No tool access defined.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {entry.toolAccess.filter(Boolean).map((tool) => (
              <Badge key={tool} variant="outline" className="rounded-chip">
                {tool}
              </Badge>
            ))}
          </div>
        )}
      </section>

      <section className="soft-panel rounded-card px-6 py-5">
        <h2 className="text-sm font-semibold text-foreground mb-3">Approval Gates</h2>
        {entry.hasApprovalGates ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <TriangleAlert className="h-4 w-4 shrink-0" />
            This agent includes steps that require human approval.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">No approval gates required.</p>
        )}
      </section>

      {/* Pre-install "A requires B, C" — surfaced immediately above the install
          controls so the operator sees what an install pulls in BEFORE they
          commit. Renders nothing when the package declares no dependencies. */}
      <RequiredDependenciesSection summary={requiredDependencies} />

      <section className="soft-panel rounded-card px-6 py-5">
        <h2 className="text-sm font-semibold text-foreground mb-4">Install</h2>
        {canInstall || canUninstall ? (
          <div className="flex items-center gap-3">
            {showInstallButton && canInstall && (
              <InstallScopeDialog
                packageName={entry.packageName}
                packageVersion={entry.packageVersion}
                installTargets={installTargets}
                ownerEntityNames={ownerEntityNames}
                currentProjectId={currentProjectId}
                activeOrgId={activeOrgId ?? ""}
                defaultValue={installDefaultValue}
                installAction={installRegistryPackageAtScope}
              />
            )}
            {showUpdateButton && canInstall && (
              <form action={updateAction}>
                <Button type="submit">Update</Button>
              </form>
            )}
            {installedTemplate && canUninstall && uninstallAction ? (
              <RegistryUninstallForm
                action={uninstallAction}
                packageTitle={entry.title}
              />
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Install requires admin role.</p>
        )}
      </section>

      <section className="soft-panel rounded-card px-6 py-5">
        <h2 className="text-sm font-semibold text-foreground mb-3">Version History</h2>
        <RegistryVersionHistoryList
          packageName={entry.packageName}
          items={entry.availableVersions.map<RegistryVersionRow>((v) => ({
            version: v.version,
            deprecated: v.deprecated,
            isCurrent: v.version === (entry.distTags["latest"] ?? entry.packageVersion),
          }))}
          orderedVersions={entry.availableVersions.map((v) => v.version)}
        />
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// RegistryPermissionsScreen — Registry access info
// ---------------------------------------------------------------------------

export async function RegistryPermissionsScreen() {
  const session = await requireAdminSession();
  const orgId = getActiveOrganizationId(session);

  return (
    <Main className="min-h-screen">
      <PageHeader
        label="Agent Registry"
        title="Access"
        description="Published agents are installed locally before editing or running — access is controlled at the registry level."
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <section className="soft-panel rounded-card px-6 py-5">
          <h2 className="text-sm font-semibold text-foreground mb-3">How Access Works</h2>
          <p className="text-sm text-muted-foreground leading-6">
            Cinatra does not manage published-agent visibility through per-entry share bindings.
            Published versions live in the registry, and users install them into local drafts before editing or running them.
          </p>
        </section>

        <section className="soft-panel rounded-card px-6 py-5">
          <h2 className="text-sm font-semibold text-foreground mb-3">What To Use Instead</h2>
          <div className="flex flex-col gap-3 text-sm text-muted-foreground leading-6">
            <p>
              Browse published extensions in <Link href="/configuration/extensions" className="text-foreground hover:underline">Extensions</Link>,
              then use <span className="text-foreground">Install</span> or <span className="text-foreground">Install &amp; Open Run</span> to bring an extension into the local workspace.
            </p>
            <p>
              Manage publish/unpublish access through the registry credentials configured for this environment, not through in-app per-entry ACL toggles.
            </p>
            {orgId ? (
              <p>
                Active organization: <span className="font-mono text-foreground">{orgId}</span>
              </p>
            ) : (
              <p>No active organization is selected for this session.</p>
            )}
          </div>
        </section>
      </PageContent>
    </Main>
  );
}

// ---------------------------------------------------------------------------
// agentPluginScreens — generic agent configuration workspace
// ---------------------------------------------------------------------------

import {
  SetupScreen as InstanceSetupScreen,
  RunScreen as InstanceRunScreen,
  DataScreen as InstanceDataScreen,
  PermissionsScreen as InstancePermissionsScreen,
  TriggerScreen as InstanceTriggerScreen,
} from "./instance-screens";

type AgentScreenProps = {
  agentId: string;
  instanceId: string;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

async function withResolvedProps<T>(
  render: (resolved: {
    agentId: string;
    instanceId: string;
    searchParams?: Record<string, string | string[] | undefined>;
  }) => Promise<T> | T,
  props: AgentScreenProps,
) {
  const searchParams = props.searchParams ? await props.searchParams : undefined;
  return render({
    agentId: props.agentId,
    instanceId: props.instanceId,
    searchParams,
  });
}

// ---------------------------------------------------------------------------
// AgentBuilderImportScreen
// ---------------------------------------------------------------------------

export async function AgentBuilderImportScreen() {
  // Resolve availableScopes server-side so the GitHub upload form's
  // PermissionsFormDraft (collapsed by default) has the org / team / project
  // tree to render its access combobox without a separate client roundtrip.
  // Mirrors the agent-run /permissions and skill-package page-data patterns.
  const session = await requireAuthSession();
  const actorUserId = session.user?.id ?? null;
  const isAdmin = isPlatformAdmin(session);
  const orgs = actorUserId ? await readOrgsWithTeamsForUser(actorUserId) : [];
  const activeOrgId = session.session?.activeOrganizationId ?? null;
  const projects =
    actorUserId && activeOrgId
      ? await readProjectsForUser(actorUserId, activeOrgId)
      : [];
  const orgRole = actorUserId
    ? await resolveOrgRoleForSession({
        user: { id: actorUserId },
        session: session.session,
      })
    : undefined;
  const canGrantWorkspace =
    isAdmin || orgRole === "org_owner" || orgRole === "org_admin";
  const uploadScopes = { orgs, projects, canGrantWorkspace };

  return (
    <Main className="min-h-screen">
      <PageHeader
        label="Extensions"
        title="Upload Extension"
        actions={
          <Button asChild variant="outline">
            <Link href="/configuration/marketplace">Back to Marketplace</Link>
          </Button>
        }
        divider={false}
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <Tabs defaultValue="agent" className="max-w-2xl">
          <TabsListRow>
            <TabsTrigger value="agent">File</TabsTrigger>
            <TabsTrigger value="skill">GitHub</TabsTrigger>
          </TabsListRow>
          <TabsContent value="agent">
            <div className="soft-panel rounded-card px-6 py-5 max-w-xl">
              <ImportAgentForm availableScopes={uploadScopes} />
            </div>
          </TabsContent>
          <TabsContent value="skill">
            <div className="soft-panel rounded-card px-6 py-5">
              <ImportSkillFromGitHubForm availableScopes={uploadScopes} />
            </div>
          </TabsContent>
        </Tabs>
      </PageContent>
    </Main>
  );
}

export const agentPluginScreens = {
  agentDetail: undefined,
  agentNew: undefined,
  agentConfiguration: undefined,
  agentData: undefined,
  agentAccounts: undefined,
  agentContacts: undefined,
  sourceRuns: undefined,
  agentOptimization: undefined,
  instanceSetup: (props: AgentScreenProps) => withResolvedProps(InstanceSetupScreen, props),
  instanceRun: (props: AgentScreenProps) => withResolvedProps(InstanceRunScreen, props),
  instanceData: (props: AgentScreenProps) => withResolvedProps(InstanceDataScreen, props),
  instanceResults: undefined,
  instanceOptimization: undefined,
  instanceTrigger: (props: AgentScreenProps) => withResolvedProps(InstanceTriggerScreen, props),
  instancePermissions: (props: AgentScreenProps) => withResolvedProps(InstancePermissionsScreen, props),
};
