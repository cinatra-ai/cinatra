import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { sql } from "drizzle-orm";
import {
  CheckCircle2,
  CircleX,
  Database,
  Download,
  Eye,
  History,
  List,
  MessageSquareReply,
  PackageCheck,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Search,
  Send,
  Settings,
  Share2,
  ShieldCheck,
  Trash2,
  Upload,
  Users,
} from "lucide-react";
import Link from "next/link";
import { requireAuthSession, isPlatformAdmin } from "@/lib/auth-session";
import { auth } from "@/lib/auth";
import { betterAuthDb } from "@/lib/better-auth-db";
import { mcpServerMount } from "@/lib/mcp-server";
import { listServiceAccounts } from "@/lib/service-accounts";
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PaginatedTable } from "@/components/ui/paginated-table";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  buildPermissionMatrix,
  CATEGORIES_IN_ORDER,
  PERMISSIONS_BY_CATEGORY,
  PERMISSION_LABELS,
} from "./permission-matrix";
import type { MatrixDisplayRight } from "./permission-matrix";
import { UserActions } from "./user-actions";
import { InviteMemberDialog } from "@/components/invite-member-dialog";
import { ServiceAccountsTable } from "../a2a/service-accounts-table";
import { Tabs, TabsContent, TabsListRow, TabsTrigger } from "@/components/ui/tabs";
import { Toolbar, ToolbarGroup } from "@/components/ui/toolbar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Permission } from "@/lib/authz/permissions";

export const metadata: Metadata = { title: "Permissions" };

const CINATRA_SCHEMA = process.env.SUPABASE_SCHEMA?.trim() ?? "cinatra";
const PROJECTS_TABLE = sql.raw(`"${CINATRA_SCHEMA.replaceAll('"', '""')}"."projects"`);
const PROJECT_CO_OWNERS_TABLE = sql.raw(`"${CINATRA_SCHEMA.replaceAll('"', '""')}"."project_co_owners"`);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MemberRow = {
  userId: string;
  name: string | null;
  email: string | null;
  image: string | null;
  platformRole: string | null;
  relationKind: "workspace" | "organization" | "team" | "project" | null;
  relationId: string | null;
  relationName: string | null;
  relationParentName: string | null;
  relationRole: string | null;
};

type MemberRelation = {
  kind: "workspace" | "organization" | "team" | "project";
  id: string;
  name: string;
  parentName: string | null;
  role: string;
};

type Member = {
  userId: string;
  name: string | null;
  email: string | null;
  image: string | null;
  platformRole: string | null;
  relations: MemberRelation[];
  isAssistant: boolean;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInitials(name: string | null, email: string | null): string {
  if (name && name.trim()) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return parts[0].slice(0, 2).toUpperCase();
  }
  if (email) {
    return email.slice(0, 2).toUpperCase();
  }
  return "??";
}

function formatRole(role: string | null): string {
  if (!role) return "—";
  if (role === "platform_admin") return "Workspace Admin";
  if (role === "org_owner") return "Organization Owner";
  if (role === "org_admin") return "Organization Admin";
  if (role === "co_owner") return "Co-owner";
  return role
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function getRelationOrder(relation: MemberRelation): number {
  switch (relation.kind) {
    case "project":
      return 0;
    case "team":
      return 1;
    case "organization":
      return 2;
    case "workspace":
      return 3;
  }
}

function addRelation(member: Member, row: MemberRow): void {
  if (!row.relationKind || !row.relationId || !row.relationName || !row.relationRole) {
    return;
  }

  const exists = member.relations.some((relation) => (
    relation.kind === row.relationKind
    && relation.id === row.relationId
    && relation.role === row.relationRole
  ));
  if (exists) return;

  member.relations.push({
    kind: row.relationKind,
    id: row.relationId,
    name: row.relationName,
    parentName: row.relationParentName,
    role: row.relationRole,
  });
}

function sortRelations(relations: MemberRelation[]): MemberRelation[] {
  return [...relations].sort((a, b) => {
    const order = getRelationOrder(a) - getRelationOrder(b);
    if (order !== 0) return order;
    return `${a.parentName ?? ""} ${a.name}`.localeCompare(`${b.parentName ?? ""} ${b.name}`);
  });
}

function formatRelationKind(kind: MemberRelation["kind"]): string {
  switch (kind) {
    case "workspace":
      return "Workspace";
    case "organization":
      return "Organization";
    case "team":
      return "Team";
    case "project":
      return "Project";
  }
}

function AccessList({ relations }: { relations: MemberRelation[] }) {
  return (
    <div className="flex flex-col gap-2">
      {sortRelations(relations).map((relation) => (
        <div key={`${relation.kind}:${relation.id}:${relation.role}`} className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="text-xs uppercase text-muted-foreground">
            {formatRelationKind(relation.kind)}:
          </span>
          {relation.kind !== "workspace" ? (
            <span className="min-w-0 break-words text-foreground">
              {relation.parentName ? `${relation.parentName} - ` : ""}
              {relation.name}
            </span>
          ) : null}
          <Badge variant="outline" className="shrink-0 whitespace-normal text-xs">
            {formatRole(relation.role)}
          </Badge>
        </div>
      ))}
    </div>
  );
}

const CATEGORY_LABELS: Record<(typeof CATEGORIES_IN_ORDER)[number], string> = {
  agents: "Agents",
  objects: "Objects",
  projects: "Projects",
  teams: "Teams",
  organizations: "Organizations",
  skills: "Skills",
  connectors: "Connectors",
  registry: "Registry",
  administration: "Administration",
};

const CATEGORY_ANCHORS: Record<(typeof CATEGORIES_IN_ORDER)[number], string> = {
  agents: "rights-agents",
  objects: "rights-objects",
  projects: "rights-projects",
  teams: "rights-teams",
  organizations: "rights-organizations",
  skills: "rights-skills",
  connectors: "rights-connectors",
  registry: "rights-registry",
  administration: "rights-administration",
};

const PERMISSION_ICONS: Record<Permission, React.ComponentType<{ className?: string }>> = {
  "agent.read": Eye,
  "agent.list": List,
  "agent.execute": Play,
  "agent.update": Pencil,
  "agent.delete": Trash2,
  "agent.share": Share2,
  "agent.managePermissions": ShieldCheck,
  "run.read": Eye,
  "run.list": List,
  "run.readData": Database,
  "run.cancel": CircleX,
  "run.share": Share2,
  "run.approveHitl": CheckCircle2,
  "run.respondToHitl": MessageSquareReply,
  "run.resume": RotateCcw,
  "run.editOutput": Pencil,
  "object.read": Eye,
  "object.list": List,
  "object.search": Search,
  "object.create": Plus,
  "object.update": Pencil,
  "object.delete": Trash2,
  "object.promoteScope": Upload,
  "project.read": Eye,
  "project.list": List,
  "project.create": Plus,
  "project.update": Pencil,
  "project.delete": Trash2,
  "project.manageMembers": Users,
  "team.read": Eye,
  "team.list": List,
  "team.create": Plus,
  "team.update": Pencil,
  "team.delete": Trash2,
  "team.manageMembers": Users,
  "organization.read": Eye,
  "organization.list": List,
  "organization.create": Plus,
  "organization.update": Pencil,
  "organization.delete": Trash2,
  "organization.manageMembers": Users,
  "skill.read": Eye,
  "skill.list": List,
  "skill.assign": Send,
  "skill.create": Plus,
  "skill.update": Pencil,
  "skill.delete": Trash2,
  "skill.install": Download,
  "skill.manageVisibility": Eye,
  "connector.read": Eye,
  "connector.use": Play,
  "connector.create": Plus,
  "connector.update": Pencil,
  "connector.delete": Trash2,
  "registry.read": Eye,
  "registry.install": Download,
  "registry.update": PackageCheck,
  "registry.uninstall": Trash2,
  // Default icon mapping grouped by permission family; the admin UI uses
  // these entries for the matrix.
  "artifact.read": Eye,
  "artifact.list": List,
  "artifact.create": Pencil,
  "artifact.update": Pencil,
  "artifact.delete": Trash2,
  "workflow_template.read": Eye,
  "workflow_template.list": List,
  "workflow_template.create": Pencil,
  "workflow_template.update": Pencil,
  "workflow_template.delete": Trash2,
  "workflow.read": Eye,
  "workflow.list": List,
  "workflow.create": Pencil,
  "workflow.update": Pencil,
  "workflow.cancel": CircleX,
  "workflow.approve": CheckCircle2,
  "workflow.execute": Play,
  "workflow_draft.read": Eye,
  "workflow_draft.write": Pencil,
  "workflow_draft.update": Pencil,
  "workflow_run.read": Eye,
  "workflow_run.list": List,
  "workflow_run.cancel": CircleX,
  "workflow_extension.read": Eye,
  "workflow_extension.publish": Share2,
  "dashboard.read": Eye,
  "dashboard.list": List,
  "dashboard.create": Pencil,
  "dashboard.update": Pencil,
  "dashboard.delete": Trash2,
  "list.read": Eye,
  "list.list": List,
  "list.create": Pencil,
  "list.update": Pencil,
  "list.delete": Trash2,
  "entity.read": Eye,
  "entity.list": List,
  "entity.create": Pencil,
  "entity.update": Pencil,
  "entity.delete": Trash2,
  "trigger.read": Eye,
  "trigger.list": List,
  "trigger.create": Pencil,
  "trigger.update": Pencil,
  "trigger.delete": Trash2,
  "trigger.fire": Play,
  "notification.read": Eye,
  "notification.list": List,
  "notification.update": Pencil,
  "metric.read": Eye,
  "metric.list": List,
  "marketplace_template.read": Eye,
  "marketplace_template.list": List,
  "marketplace_template.publish": Share2,
  "extension_registry.read": Eye,
  "extension_registry.list": List,
  "extension_registry.install": Pencil,
  "extension_registry.uninstall": Trash2,
  "settings.read": Eye,
  "settings.update": Settings,
  "audit.read": History,
};

function PermissionChips({
  rights,
}: {
  rights: MatrixDisplayRight[];
}) {
  return (
    <div className="flex flex-col items-stretch gap-1">
      {rights.map((right) => {
        const Icon = PERMISSION_ICONS[right.permissions[0]];
        const stateLabel =
          right.state === "granted"
            ? "Granted"
            : right.state === "partial"
              ? `Partial (${right.granted}/${right.total})`
              : "Not granted";
        const chipClassName =
          right.state === "granted"
            ? "border-success/30 bg-success/10 text-success"
            : right.state === "partial"
              ? "border-warning/35 bg-warning/10 text-warning-foreground"
              : "border-destructive/20 bg-destructive/5 text-destructive/60";
        return (
          <Tooltip key={right.key}>
            <TooltipTrigger asChild>
              <span
                aria-label={`${right.label}: ${stateLabel}`}
                className={`inline-flex min-w-0 items-center gap-1 rounded-chip border px-1.5 py-0.5 text-[10px] font-medium leading-4 ${chipClassName}`}
              >
                <Icon className="size-2.5 shrink-0" />
                <span className="truncate">{right.label}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              <div className="max-w-64 space-y-1">
                <p className="font-medium">{right.label} · {stateLabel}</p>
                <p className="text-muted-foreground">
                  {right.permissions.map((permission) => PERMISSION_LABELS[permission]).join(", ")}
                </p>
              </div>
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

const VALID_TABS = new Set(["users", "roles", "rights", "mcp", "a2a"]);

function PermissionsTabs({ activeTab }: { activeTab: string }) {
  return (
    <Tabs value={activeTab} className="gap-6">
      <TabsListRow>
        <TabsTrigger value="users" asChild>
          <Link href="/configuration/permissions?tab=users">Users</Link>
        </TabsTrigger>
        <TabsTrigger value="roles" asChild>
          <Link href="/configuration/permissions?tab=roles">Roles</Link>
        </TabsTrigger>
        <TabsTrigger value="rights" asChild>
          <Link href="/configuration/permissions?tab=rights">Rights</Link>
        </TabsTrigger>
        <TabsTrigger value="mcp" asChild>
          <Link href="/configuration/permissions?tab=mcp">MCP</Link>
        </TabsTrigger>
        <TabsTrigger value="a2a" asChild>
          <Link href="/configuration/permissions?tab=a2a">A2A</Link>
        </TabsTrigger>
      </TabsListRow>
    </Tabs>
  );
}

function UsersTab(props: {
  members: Member[];
  currentUserId: string;
  canInvite: boolean;
  organizationId: string | null;
}) {
  return (
    <Tabs value="users">
      <TabsContent value="users" className="space-y-4">
        {props.canInvite && props.organizationId ? (
          <Toolbar>
            <ToolbarGroup className="ms-auto">
              <InviteMemberDialog organizationId={props.organizationId} />
            </ToolbarGroup>
          </Toolbar>
        ) : null}
        {props.members.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No platform members are visible to your account.
          </p>
        ) : (
          <div className="max-lg:overflow-x-auto lg:overflow-x-visible">
            <PaginatedTable className="w-full table-fixed max-lg:min-w-[760px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[32%] whitespace-normal">User</TableHead>
                  <TableHead className="w-[52%] whitespace-normal">Access</TableHead>
                  <TableHead className="w-[16%] whitespace-normal text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {props.members.map((member) => (
                  <TableRow key={member.userId}>
                    <TableCell className="whitespace-normal break-words">
                      <Link
                        href={`/users/${member.userId}`}
                        className="flex min-w-0 items-center gap-3 rounded-control outline-none transition hover:text-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      >
                        <Avatar className="size-8">
                          {member.image && <AvatarImage src={member.image} alt={member.name ?? ""} />}
                          <AvatarFallback className="text-xs">
                            {getInitials(member.name, member.email)}
                          </AvatarFallback>
                        </Avatar>
                        <div className="flex min-w-0 flex-col">
                          <span className="min-w-0 break-words font-medium text-foreground">
                            {member.name ?? "—"}
                          </span>
                          {member.email ? (
                            <span className="min-w-0 break-all text-xs text-muted-foreground">
                              {member.email}
                            </span>
                          ) : null}
                        </div>
                      </Link>
                    </TableCell>
                    <TableCell className="whitespace-normal break-words text-sm text-muted-foreground">
                      {member.relations.length > 0 ? (
                        <AccessList relations={member.relations} />
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="whitespace-normal text-right">
                      <UserActions
                        userId={member.userId}
                        currentUserId={props.currentUserId}
                        canImpersonate={member.userId !== props.currentUserId && !member.isAssistant}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </PaginatedTable>
          </div>
        )}
      </TabsContent>
    </Tabs>
  );
}

function RolesTab(props: {
  matrixRows: ReturnType<typeof buildPermissionMatrix>;
}) {
  const ROLE_LABELS: Record<string, string> = {
    platform_admin: "Workspace Admin",
    org_owner: "Organization Owner",
    org_admin: "Organization Admin",
    team_admin: "Team Admin",
    member: "Member",
    service_account: "Service Account",
    external_agent: "External Agent",
  };

  return (
    <Tabs value="roles">
      <TabsContent value="roles">
        <div className="mb-4 space-y-1">
          <h2 className="text-xl font-semibold tracking-normal text-foreground">Role Permissions</h2>
          <p className="max-w-[64ch] text-sm leading-[1.55] text-pretty text-muted-foreground">
            Green chips are granted, amber chips are partial, and red chips are not granted. This matrix shows business actions; CRUD appears where it maps cleanly, while run, install, approval, visibility, and audit rights stay explicit.
          </p>
        </div>
        <div className="overflow-x-auto md:overflow-x-visible">
          <PaginatedTable className="min-w-[760px] table-fixed md:min-w-0">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[8.5rem] whitespace-normal break-words border-r border-line px-3 py-3 align-top">
                  <span className="text-xs font-medium text-muted-foreground">Role / rights</span>
                </TableHead>
                {CATEGORIES_IN_ORDER.map((cat) => (
                  <TableHead key={cat} className="border-r border-line px-2 py-3 whitespace-normal break-words text-center text-xs last:border-r-0 align-top">
                    <Link
                      href={`/configuration/permissions?tab=rights#${CATEGORY_ANCHORS[cat]}`}
                      className="text-foreground underline-offset-4 hover:text-primary hover:underline"
                    >
                      {CATEGORY_LABELS[cat]}
                    </Link>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {props.matrixRows.map((row) => (
                <TableRow key={row.role}>
                  <TableCell className="whitespace-normal break-words border-r border-line px-3 py-3 align-top text-sm font-medium text-foreground">
                    {ROLE_LABELS[row.role]}
                  </TableCell>
                  {CATEGORIES_IN_ORDER.map((cat) => (
                    <TableCell key={cat} className="border-r border-line px-2 py-3 align-top last:border-r-0">
                      <PermissionChips rights={row.displayRights[cat]} />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </PaginatedTable>
        </div>
      </TabsContent>
    </Tabs>
  );
}

function RightsTab() {
  return (
    <Tabs value="rights">
      <TabsContent value="rights" className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-xl font-semibold tracking-normal text-foreground">Permission Reference</h2>
          <p className="max-w-[64ch] text-sm leading-[1.55] text-pretty text-muted-foreground">
            The compact chips above are calculated from these rights. Agent rights include both agent definitions and started agent runs, because users usually think about them as one operational area.
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {CATEGORIES_IN_ORDER.map((category) => (
            <div
              key={category}
              id={CATEGORY_ANCHORS[category]}
              className="scroll-mt-24 rounded-card border border-line bg-surface-muted p-4"
            >
              <p className="text-sm font-semibold text-foreground">{CATEGORY_LABELS[category]}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {PERMISSIONS_BY_CATEGORY[category].map((permission) => (
                  <Badge key={permission} variant="outline" className="gap-1.5 text-[11px]">
                    {(() => {
                      const Icon = PERMISSION_ICONS[permission];
                      return <Icon className="size-3" />;
                    })()}
                    <span>{PERMISSION_LABELS[permission]}</span>
                  </Badge>
                ))}
              </div>
            </div>
          ))}
        </div>
      </TabsContent>
    </Tabs>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function PermissionsPage({
  searchParams,
}: {
  searchParams?: Promise<{ tab?: string }>;
}) {
  const session = await requireAuthSession();
  if (!isPlatformAdmin(session)) redirect("/configuration");
  const requestedTab = (await searchParams)?.tab ?? "users";
  const activeTab = VALID_TABS.has(requestedTab) ? requestedTab : "users";

  // The Invite-member toolbar is gated on the actor holding Better Auth's
  // `invitation:create` permission on their active organization — the same
  // fail-closed posture the workspace-members widget applies. We resolve this
  // server-side so the button never flickers in for unprivileged admins;
  // `hasPermission` throws when there is no active org / membership, which we
  // treat as "cannot invite".
  const activeOrganizationId = session.session?.activeOrganizationId ?? null;
  let canInvite = false;
  if (activeOrganizationId) {
    try {
      const result = await auth.api.hasPermission({
        headers: await headers(),
        body: { permissions: { invitation: ["create"] } },
      });
      canInvite = result?.success === true;
    } catch {
      canInvite = false;
    }
  }

  // Fetch all platform members with their org and team memberships.
  const result = await betterAuthDb.execute<MemberRow>(sql`
    WITH relation_rows AS (
      SELECT
        u.id AS "userId",
        'workspace'::text AS "relationKind",
        'workspace'::text AS "relationId",
        'Workspace'::text AS "relationName",
        NULL::text AS "relationParentName",
        u.role AS "relationRole",
        0 AS "relationOrder"
      FROM public."user" u
      WHERE u.role IS NOT NULL

      UNION ALL

      SELECT
        m."userId" AS "userId",
        'organization'::text AS "relationKind",
        o.id AS "relationId",
        o.name AS "relationName",
        NULL::text AS "relationParentName",
        COALESCE(m.role, 'member') AS "relationRole",
        1 AS "relationOrder"
      FROM public."member" m
      JOIN public.organization o ON o.id = m."organizationId"

      UNION ALL

      SELECT
        tm."userId" AS "userId",
        'team'::text AS "relationKind",
        t.id AS "relationId",
        t.name AS "relationName",
        o.name AS "relationParentName",
        'member'::text AS "relationRole",
        2 AS "relationOrder"
      FROM public."teamMember" tm
      JOIN public.team t ON t.id = tm."teamId"
      JOIN public.organization o ON o.id = t."organizationId"

      UNION ALL

      SELECT
        p.owner_id AS "userId",
        'project'::text AS "relationKind",
        p.id AS "relationId",
        p.name AS "relationName",
        o.name AS "relationParentName",
        'owner'::text AS "relationRole",
        3 AS "relationOrder"
      FROM ${PROJECTS_TABLE} p
      LEFT JOIN public.organization o ON o.id = p.organization_id
      WHERE p.owner_level = 'user'

      UNION ALL

      SELECT
        pco.user_id AS "userId",
        'project'::text AS "relationKind",
        p.id AS "relationId",
        p.name AS "relationName",
        o.name AS "relationParentName",
        'co_owner'::text AS "relationRole",
        3 AS "relationOrder"
      FROM ${PROJECT_CO_OWNERS_TABLE} pco
      JOIN ${PROJECTS_TABLE} p ON p.id = pco.project_id
      LEFT JOIN public.organization o ON o.id = p.organization_id
    )
    SELECT
      u.id          AS "userId",
      u.name        AS "name",
      u.email       AS "email",
      u.image       AS "image",
      u.role        AS "platformRole",
      rr."relationKind" AS "relationKind",
      rr."relationId" AS "relationId",
      rr."relationName" AS "relationName",
      rr."relationParentName" AS "relationParentName",
      rr."relationRole" AS "relationRole"
    FROM public."user" u
    LEFT JOIN relation_rows rr ON rr."userId" = u.id
    ORDER BY
      (u.role = 'platform_admin') DESC,
      LOWER(u.name) ASC,
      rr."relationOrder" ASC,
      LOWER(COALESCE(rr."relationParentName", '')) ASC,
      LOWER(COALESCE(rr."relationName", '')) ASC
  `);

  // Collapse rows so each user appears once with aggregated relationships.
  const memberMap = new Map<string, Member>();
  for (const row of result.rows) {
    const existing = memberMap.get(row.userId);
    if (existing) {
      addRelation(existing, row);
    } else {
      const member: Member = {
        userId: row.userId,
        name: row.name,
        email: row.email,
        image: row.image,
        platformRole: row.platformRole,
        relations: [],
        isAssistant: (row.email ?? "").endsWith("@system.local") || row.platformRole == null,
      };
      addRelation(member, row);
      memberMap.set(row.userId, member);
    }
  }
  const members = Array.from(memberMap.values());

  const matrixRows = buildPermissionMatrix();
  const accounts = activeTab === "a2a" ? await listServiceAccounts() : [];
  const { ClientsPage } = mcpServerMount;

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Permissions"
        description="Platform members, their roles, and what each role can do."
        divider={false}
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <PermissionsTabs activeTab={activeTab} />
        {activeTab === "users" ? (
          <UsersTab
            members={members}
            currentUserId={session.user.id}
            canInvite={canInvite}
            organizationId={activeOrganizationId}
          />
        ) : null}
        {activeTab === "roles" ? <RolesTab matrixRows={matrixRows} /> : null}
        {activeTab === "rights" ? <RightsTab /> : null}
        {activeTab === "mcp" ? <ClientsPage /> : null}
        {activeTab === "a2a" ? (
          <Card>
            <CardHeader>
              <CardTitle>A2A Access</CardTitle>
              <CardDescription>Grant external apps OAuth credentials to call Cinatra&apos;s agent API.</CardDescription>
            </CardHeader>
            <CardContent>
              <ServiceAccountsTable initialAccounts={accounts} />
            </CardContent>
          </Card>
        ) : null}
      </PageContent>
    </Main>
  );
}
