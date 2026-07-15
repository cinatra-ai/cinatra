"use client";

// ---------------------------------------------------------------------------
// Project permissions tab client.
//
// Single border-line rounded-card card with the Ownership section on top and
// the Project access (N:M grants) section below. shadcn primitives + semantic
// tokens only — no inline palette, no parallel layout.
//
// The legacy ownership-ratchet "Access" section is REMOVED (owner ratified
// Open Decision 3 = Remove, cinatra#1509): visibility is managed exclusively
// through the Project access grants below.
// ---------------------------------------------------------------------------

import { useEffect, useState, useTransition } from "react";

import { toast } from "@/lib/cinatra-toast";
import { Button } from "@/components/ui/button";
import {
  ResourceOwnershipPanel,
  type OwnerView,
  type ResourceMutationResult,
  type SharingSearchResult,
} from "@/components/resource-ownership-panel";

import {
  addProjectCoOwnerAction,
  removeProjectCoOwnerAction,
  searchWorkspaceUsersForProject,
  grantProjectAccessAction,
  revokeProjectAccessAction,
  type ProjectAccessRow,
} from "./actions";
import { ScopeBadge, type ScopeLevel } from "@/components/scope-badge";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EntitySearchCombobox } from "@/components/entity-search-combobox";
import {
  listProjectGrantTeamCandidates,
  readProjectGrantOrgCandidate,
  searchProjectGrantUserCandidates,
  type GrantOrgCandidate,
  type GrantTeamCandidate,
} from "./actions";
import {
  PRINCIPAL_LEVEL_LABELS,
  WORKSPACE_PRINCIPAL_ID,
  alreadyGrantedRole,
  grantedPrincipalIds,
  withoutGrantedPrincipal,
  type GrantPrincipalLevel,
} from "./grant-candidates";

// ---------------------------------------------------------------------------
// Public prop types
// ---------------------------------------------------------------------------

export type ProjectPermissionsTabClientProps = {
  activeOrgId: string | null;
  projectId: string;
  projectName: string;
  /** Whether the viewing actor may edit ownership / co-owners. */
  canEdit: boolean;
  resourceOwner: OwnerView | null;
  coOwners: OwnerView[];
  currentUserId: string | null;
  /**
   * Current effective access rows for this project, resolved via the
   * `project_access_list` MCP primitive. The owner row is synthesised by the
   * handler because the owner is implicit and never stored.
   */
  projectAccessRows: ProjectAccessRow[];
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ProjectPermissionsTabClient({
  activeOrgId,
  projectId,
  // `projectName` stays in the props type (the page passes it; useful to any
  // future copy) but is not destructured — nothing renders it today.
  canEdit,
  resourceOwner,
  coOwners,
  currentUserId,
  projectAccessRows,
}: ProjectPermissionsTabClientProps) {
  // Defer mounting the ownership panel until after hydration. The panel
  // calls `useRouter()` which requires the App Router context — that
  // context isn't present in pure server-side `renderToStaticMarkup`
  // unit tests, so SSR-only rendering would crash. The wrapper div
  // (with `data-testid="project-sharing-panel"`) is always emitted so
  // sentinels stay stable.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <div className="rounded-card border border-line px-6 py-5 flex flex-col gap-6 bg-surface">
      {/* Ownership section --------------------------------------------- */}
      <div data-testid="project-sharing-panel">
        {mounted ? (
        <ResourceOwnershipPanel
          resourceType="project"
          resourceId={projectId}
          allowSharing={true}
          canEdit={canEdit}
          resourceOwner={resourceOwner}
          coOwners={coOwners}
          currentUserId={currentUserId}
          onSearch={async (rid, query): Promise<SharingSearchResult> => {
            const r = await searchWorkspaceUsersForProject(rid, query);
            return r.ok ? { ok: true, results: r.results } : { ok: false };
          }}
          onAddCoOwner={async (rid, userId): Promise<ResourceMutationResult> => {
            const r = await addProjectCoOwnerAction(rid, userId);
            return r.ok ? { ok: true } : { ok: false, error: r.error };
          }}
          onRemoveCoOwner={async (rid, userId): Promise<ResourceMutationResult> => {
            const r = await removeProjectCoOwnerAction(rid, userId);
            return r.ok ? { ok: true } : { ok: false, error: r.error };
          }}
          selfRemoveRedirect="/projects"
        />
        ) : null}
      </div>

      {/* Project access (N:M grants) --------------------------------------- */}
      <ProjectAccessSection
        projectId={projectId}
        canEdit={canEdit}
        rows={projectAccessRows}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Project access section.
//
// Surfaces the `project_access_list` rows plus the principal-level and role
// pickers backed by `project_access_grant` / `project_access_revoke`. The
// owner row is rendered read-only because the owner is implicit, never stored,
// and synthesised by the handler for display.
// ---------------------------------------------------------------------------

type ProjectAccessSectionProps = {
  projectId: string;
  canEdit: boolean;
  rows: ProjectAccessRow[];
};

// Lazily-fetched candidate state for the team / organization pickers. The
// candidates come from the dedicated grant-candidate server actions (never
// from the viewer's own memberships — cinatra#1509 §4.2, codex F6).
type TeamCandidatesState = {
  status: "idle" | "loading" | "ready" | "error";
  items: GrantTeamCandidate[];
};
type OrgCandidateState = {
  status: "idle" | "loading" | "ready" | "error";
  item: GrantOrgCandidate | null;
};

/** A picked user candidate (name-first display; email secondary). */
type PickedUser = { id: string; name: string; email: string };

function ProjectAccessSection({ projectId, canEdit, rows }: ProjectAccessSectionProps) {
  const [pending, startTransition] = useTransition();
  const [principalLevel, setPrincipalLevel] = useState<GrantPrincipalLevel>("user");
  // Raw principal id — only used by the "Enter ID manually" escape hatch
  // (admin/debug; same validation path as the pickers).
  const [principalId, setPrincipalId] = useState("");
  const [manualMode, setManualMode] = useState(false);
  const [role, setRole] = useState<"read" | "write" | "admin">("read");

  const [selectedUser, setSelectedUser] = useState<PickedUser | null>(null);
  const [selectedTeamId, setSelectedTeamId] = useState("");
  const [teams, setTeams] = useState<TeamCandidatesState>({ status: "idle", items: [] });
  const [org, setOrg] = useState<OrgCandidateState>({ status: "idle", item: null });

  // Grants issued in THIS session — the server-provided `rows` prop is only
  // refreshed on navigation, so the already-granted marking below would go
  // stale right after a successful grant without this local echo.
  const [sessionGrants, setSessionGrants] = useState<
    Array<{ principalLevel: GrantPrincipalLevel; principalId: string; role: string }>
  >([]);
  const effectiveRows = [
    ...rows.map((r) => ({
      principalLevel: r.principalLevel,
      principalId: r.principalId,
      role: r.role as string,
    })),
    ...sessionGrants,
  ];

  const loadTeamCandidates = () => {
    setTeams({ status: "loading", items: [] });
    void listProjectGrantTeamCandidates(projectId)
      .then((r) =>
        setTeams(
          r.ok ? { status: "ready", items: r.teams } : { status: "error", items: [] },
        ),
      )
      .catch(() => setTeams({ status: "error", items: [] }));
  };
  const loadOrgCandidate = () => {
    setOrg({ status: "loading", item: null });
    void readProjectGrantOrgCandidate(projectId)
      .then((r) =>
        setOrg(
          r.ok
            ? { status: "ready", item: r.organization }
            : { status: "error", item: null },
        ),
      )
      .catch(() => setOrg({ status: "error", item: null }));
  };
  const ensureCandidatesLoaded = (level: GrantPrincipalLevel) => {
    if (level === "team" && teams.status === "idle") loadTeamCandidates();
    if (level === "organization" && org.status === "idle") loadOrgCandidate();
  };

  const clearPrincipalSelection = () => {
    setPrincipalId("");
    setSelectedUser(null);
    setSelectedTeamId("");
  };

  const handleLevelChange = (v: string) => {
    const level = v as GrantPrincipalLevel;
    setPrincipalLevel(level);
    clearPrincipalSelection();
    if (!manualMode) ensureCandidatesLoaded(level);
  };

  const toggleManualMode = () => {
    const next = !manualMode;
    setManualMode(next);
    clearPrincipalSelection();
    if (!next) ensureCandidatesLoaded(principalLevel);
  };

  // Fixed-row levels (organization / workspace) get the visible
  // "Already granted" marking instead of exclusion (§4.2 exclude-or-mark).
  const workspaceGrantedRole = alreadyGrantedRole(
    effectiveRows,
    "workspace",
    WORKSPACE_PRINCIPAL_ID,
  );
  const orgGrantedRole = org.item
    ? alreadyGrantedRole(effectiveRows, "organization", org.item.id)
    : null;
  const fixedRowGrantedRole = manualMode
    ? null
    : principalLevel === "workspace"
      ? workspaceGrantedRole
      : principalLevel === "organization"
        ? orgGrantedRole
        : null;

  const grantDisabled =
    pending ||
    fixedRowGrantedRole !== null ||
    (!manualMode &&
      principalLevel === "organization" &&
      org.status === "ready" &&
      org.item === null);

  const handleGrant = () => {
    // Resolve the staged principal per level; the pickers are affordances —
    // final authority stays server-side in `grantProjectAccessAction`.
    let principal: { id: string; label: string } | null = null;
    if (principalLevel === "workspace") {
      principal = { id: WORKSPACE_PRINCIPAL_ID, label: "the whole workspace" };
    } else if (manualMode) {
      const trimmed = principalId.trim();
      if (!trimmed) {
        toast.error("Enter a principal ID.");
        return;
      }
      principal = { id: trimmed, label: `${principalLevel}:${trimmed}` };
    } else if (principalLevel === "user") {
      if (!selectedUser) {
        toast.error("Select a user to grant access to.");
        return;
      }
      principal = { id: selectedUser.id, label: selectedUser.name };
    } else if (principalLevel === "team") {
      const team = teams.items.find((t) => t.id === selectedTeamId) ?? null;
      if (!team) {
        toast.error("Select a team to grant access to.");
        return;
      }
      principal = { id: team.id, label: team.name };
    } else {
      if (!org.item) {
        toast.error("This project has no organization to grant to.");
        return;
      }
      principal = { id: org.item.id, label: org.item.name };
    }
    const { id: grantedId, label } = principal;
    startTransition(async () => {
      const r = await grantProjectAccessAction(
        projectId,
        principalLevel,
        grantedId,
        role,
      );
      if (r.ok) {
        toast.success(`Granted ${role} to ${label}.`);
        setSessionGrants((prev) => [
          ...prev,
          { principalLevel, principalId: grantedId, role },
        ]);
        clearPrincipalSelection();
      } else {
        toast.error(`Could not grant access: ${r.error}`);
      }
    });
  };

  const handleRevoke = (lvl: GrantPrincipalLevel, pid: string) => {
    startTransition(async () => {
      const r = await revokeProjectAccessAction(projectId, lvl, pid);
      if (r.ok) {
        toast.success(`Revoked ${lvl}:${pid}.`);
        // Keep the session echo symmetric: a revoked principal must become
        // grantable again immediately (not stay excluded/disabled until a
        // reload).
        setSessionGrants((prev) => withoutGrantedPrincipal(prev, lvl, pid));
      } else {
        toast.error(`Could not revoke access: ${r.error}`);
      }
    });
  };

  // The principal control per level (§4.2): user → server-searched
  // EntitySearchCombobox; team → server-listed Select; organization /
  // workspace → fixed rows. The "Enter ID manually" escape hatch swaps in
  // the raw Input (same validation path).
  let principalControl: React.ReactNode;
  if (manualMode && principalLevel !== "workspace") {
    principalControl = (
      <Input
        id="principal-id"
        value={principalId}
        onChange={(e) => setPrincipalId(e.target.value)}
        disabled={pending}
        placeholder="Enter principal ID"
      />
    );
  } else if (principalLevel === "user") {
    principalControl = selectedUser ? (
      <div className="flex h-8 items-center justify-between gap-2 rounded-[7px] border border-input bg-surface-strong px-2.5 text-sm">
        <span className="truncate text-foreground">
          {selectedUser.name}
          {selectedUser.email ? (
            <span className="ml-2 text-xs text-muted-foreground">
              {selectedUser.email}
            </span>
          ) : null}
        </span>
        {/* The interactive element in the selected state carries the
            `principal-id` id so the field Label stays associated (a11y). */}
        <Button
          id="principal-id"
          type="button"
          variant="link"
          size="xs"
          className="shrink-0 px-0 text-muted-foreground hover:text-foreground"
          onClick={() => setSelectedUser(null)}
          disabled={pending}
        >
          Change
        </Button>
      </div>
    ) : (
      <EntitySearchCombobox
        id="principal-id"
        placeholder="Search users by name or email…"
        disabled={pending}
        excludeIds={grantedPrincipalIds(effectiveRows, "user")}
        onSearch={async (query) => {
          const r = await searchProjectGrantUserCandidates(projectId, query);
          if (!r.ok) throw new Error(r.error);
          return {
            results: r.results.map((u) => ({
              id: u.id,
              name: u.name,
              secondary: u.email,
              email: u.email,
            })),
          };
        }}
        onPick={(u) => setSelectedUser({ id: u.id, name: u.name, email: u.email })}
      />
    );
  } else if (principalLevel === "team") {
    if (teams.status === "error") {
      principalControl = (
        <div className="flex h-8 items-center gap-2 text-xs text-destructive">
          Couldn&apos;t load teams — try again.
          <Button
            type="button"
            variant="link"
            size="xs"
            className="px-0 text-destructive"
            onClick={loadTeamCandidates}
          >
            Retry
          </Button>
        </div>
      );
    } else if (teams.status === "ready" && teams.items.length === 0) {
      principalControl = (
        <p className="flex h-8 items-center text-xs text-muted-foreground">
          No teams in this organization yet.
        </p>
      );
    } else {
      principalControl = (
        <Select
          value={selectedTeamId}
          onValueChange={setSelectedTeamId}
          disabled={pending || teams.status !== "ready"}
        >
          <SelectTrigger id="principal-id" size="sm" className="w-full">
            <SelectValue
              placeholder={
                teams.status === "loading" ? "Loading teams…" : "Select a team"
              }
            />
          </SelectTrigger>
          <SelectContent>
            {teams.items.map((t) => {
              const granted = alreadyGrantedRole(effectiveRows, "team", t.id);
              return (
                <SelectItem key={t.id} value={t.id} disabled={granted !== null}>
                  {t.name}
                  {granted !== null && (
                    <span className="text-xs text-muted-foreground">
                      Already granted — {granted}
                    </span>
                  )}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      );
    }
  } else if (principalLevel === "organization") {
    if (org.status === "error") {
      principalControl = (
        <div className="flex h-8 items-center gap-2 text-xs text-destructive">
          Couldn&apos;t load the organization — try again.
          <Button
            type="button"
            variant="link"
            size="xs"
            className="px-0 text-destructive"
            onClick={loadOrgCandidate}
          >
            Retry
          </Button>
        </div>
      );
    } else if (org.status === "ready" && org.item === null) {
      principalControl = (
        <p className="flex h-8 items-center text-xs text-muted-foreground">
          This project has no organization.
        </p>
      );
    } else {
      principalControl = (
        <Input
          id="principal-id"
          value={org.item?.name ?? ""}
          placeholder={org.status === "loading" ? "Loading organization…" : ""}
          disabled
          readOnly
        />
      );
    }
  } else {
    // Workspace — fixed row; the `__workspace__` sentinel stays the grant
    // value, but the raw id is never the rendering (§3.2).
    principalControl = (
      <Input id="principal-id" value="Whole workspace" disabled readOnly />
    );
  }

  return (
    <div
      data-testid="project-access-section"
      className="flex flex-col gap-4 border-t border-line pt-6"
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-foreground">Project access</h2>
        <p className="text-xs text-muted-foreground">
          Grant roles (read / write / admin) to users, teams, organizations, or the workspace.
          The owner is implicit and cannot be removed through this list. Changes apply
          immediately.
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No access rows yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => {
            const isOwner = row.role === "owner";
            const key = `${row.principalLevel}:${row.principalId}`;
            return (
              <li
                key={key}
                className="soft-panel flex items-center justify-between gap-3 px-4 py-2"
              >
                <div className="flex items-center gap-3">
                  <ScopeBadge level={row.principalLevel as ScopeLevel} />
                  <span className="font-mono text-xs text-foreground">
                    {row.principalId === "__workspace__" ? "workspace" : row.principalId}
                  </span>
                  <Badge variant="outline" className="capitalize">
                    {row.role}
                  </Badge>
                  {isOwner && (
                    <span className="text-xs text-muted-foreground">implicit</span>
                  )}
                </div>
                {canEdit && !isOwner && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={() => handleRevoke(row.principalLevel, row.principalId)}
                  >
                    Revoke
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {canEdit && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor="principal-level">Level</Label>
            {/* size="sm" keeps the Select at the shared h-8 control height so
                Level / principal / Role sit on one line (§3.2). */}
            <Select value={principalLevel} onValueChange={handleLevelChange}>
              <SelectTrigger id="principal-level" size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="user">User</SelectItem>
                <SelectItem value="team">Team</SelectItem>
                <SelectItem value="organization">Organization</SelectItem>
                <SelectItem value="workspace">Workspace</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1 sm:col-span-2">
            <Label htmlFor="principal-id">
              {PRINCIPAL_LEVEL_LABELS[principalLevel]}
            </Label>
            {principalControl}
            {fixedRowGrantedRole !== null && (
              <p className="text-xs text-muted-foreground">
                Already granted — {fixedRowGrantedRole}.
              </p>
            )}
            {principalLevel !== "workspace" && (
              <Button
                type="button"
                variant="link"
                size="xs"
                className="self-start px-0 text-muted-foreground hover:text-foreground"
                onClick={toggleManualMode}
                disabled={pending}
              >
                {manualMode ? "Use picker instead" : "Enter ID manually"}
              </Button>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="role">Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as typeof role)}>
              <SelectTrigger id="role" size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="read">Read</SelectItem>
                <SelectItem value="write">Write</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="sm:col-span-4 flex justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={grantDisabled}
              onClick={handleGrant}
            >
              Grant access
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
