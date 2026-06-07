"use client";

// ---------------------------------------------------------------------------
// Project permissions tab client.
//
// Replicates the canonical Permissions card pattern from
// `packages/agent-builder/src/permissions-tab-client.tsx`:
// single .soft-panel border-line rounded-card cream-bg card with an Access
// section on top, an Ownership section below, and a single Save button at
// the bottom. shadcn primitives + semantic tokens only — no inline palette,
// no parallel layout.
// ---------------------------------------------------------------------------

import { useEffect, useState, useTransition } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import { toast } from "@/lib/cinatra-toast";
import { Button } from "@/components/ui/button";
import {
  AccessCombobox,
  type AccessComboboxProps,
} from "@/components/access-combobox";

type AvailableScopes = AccessComboboxProps["availableScopes"];
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
  updateProjectScopeAction,
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

// ---------------------------------------------------------------------------
// Public prop types
// ---------------------------------------------------------------------------

export type ProjectPermissionsTabClientProps = {
  activeOrgId: string | null;
  projectId: string;
  projectName: string;
  /** Current visibility expression for the AccessCombobox. */
  initialAccess: string;
  /** Whether the viewing actor may edit ownership / co-owners. */
  canEdit: boolean;
  availableScopes: AvailableScopes;
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

// Permissive schema mirroring the runs Permissions tab — the canonical
// validation gate is server-side (assertScopeRatchet + AgentAuthPolicySchema).
const AccessFormSchema = z.object({ access: z.string() });
type AccessFormValues = z.infer<typeof AccessFormSchema>;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ProjectPermissionsTabClient({
  activeOrgId,
  projectId,
  projectName,
  initialAccess,
  canEdit,
  availableScopes,
  resourceOwner,
  coOwners,
  currentUserId,
  projectAccessRows,
}: ProjectPermissionsTabClientProps) {
  const [isPending, startTransition] = useTransition();
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

  const { control, handleSubmit } = useForm<AccessFormValues>({
    resolver: zodResolver(AccessFormSchema),
    defaultValues: { access: initialAccess },
  });

  // The legacy "ratchet" Access form is retired; the server action throws.
  // The combobox stays visible read-only for context; submitting the form is
  // a no-op explanatory toast pointing the user at the project_access section
  // below. The
  // `updateProjectScopeAction` import is kept so the type checker still
  // catches accidental call-site regressions.
  void updateProjectScopeAction;

  const onSubmit = (_values: AccessFormValues) => {
    startTransition(async () => {
      toast.message(
        "Project ownership transfer is retired — use the Project access section to grant or revoke roles.",
      );
    });
  };

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="rounded-card border border-line px-6 py-5 flex flex-col gap-6 bg-surface"
    >
      {/* Access section ------------------------------------------------- */}
      <div data-testid="access-combobox" className="flex flex-col gap-4">
        <h2 className="text-base font-semibold text-foreground">Access</h2>
        <p className="text-xs text-muted-foreground -mt-2">
          Choose who can find and view <span className="font-medium">{projectName}</span>.
        </p>
        {!canEdit && (
          <p className="text-xs text-muted-foreground">
            You can view this project&apos;s access but cannot edit it.
          </p>
        )}
        <Controller
          control={control}
          name="access"
          render={({ field: f }) => (
            <AccessCombobox
              value={f.value}
              onValueChange={f.onChange}
              availableScopes={availableScopes}
              isAdmin={availableScopes.workspaceExposed}
              disabled={!canEdit || isPending}
            />
          )}
        />
      </div>

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

      {/* Save -------------------------------------------------------- */}
      {canEdit && (
        <div className="flex justify-end">
          <Button type="submit" disabled={isPending}>
            {isPending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      )}
    </form>
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

function ProjectAccessSection({ projectId, canEdit, rows }: ProjectAccessSectionProps) {
  const [pending, startTransition] = useTransition();
  const [principalLevel, setPrincipalLevel] = useState<
    "user" | "team" | "organization" | "workspace"
  >("user");
  const [principalId, setPrincipalId] = useState("");
  const [role, setRole] = useState<"read" | "write" | "admin">("read");

  const handleGrant = () => {
    const trimmed = principalId.trim();
    const effectivePrincipalId =
      principalLevel === "workspace" ? "__workspace__" : trimmed;
    if (principalLevel !== "workspace" && !trimmed) {
      toast.error("Enter a principal id.");
      return;
    }
    startTransition(async () => {
      const r = await grantProjectAccessAction(
        projectId,
        principalLevel,
        effectivePrincipalId,
        role,
      );
      if (r.ok) {
        toast.success(`Granted ${role} to ${principalLevel}:${effectivePrincipalId}.`);
        setPrincipalId("");
      } else {
        toast.error(`Could not grant access: ${r.error}`);
      }
    });
  };

  const handleRevoke = (lvl: "user" | "team" | "organization" | "workspace", pid: string) => {
    startTransition(async () => {
      const r = await revokeProjectAccessAction(projectId, lvl, pid);
      if (r.ok) toast.success(`Revoked ${lvl}:${pid}.`);
      else toast.error(`Could not revoke access: ${r.error}`);
    });
  };

  return (
    <div
      data-testid="project-access-section"
      className="flex flex-col gap-4 border-t border-line pt-6"
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-foreground">Project access</h2>
        <p className="text-xs text-muted-foreground">
          Grant roles (read / write / admin) to users, teams, organizations, or the workspace.
          The owner is implicit and cannot be removed through this list.
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
            <Select
              value={principalLevel}
              onValueChange={(v) =>
                setPrincipalLevel(v as typeof principalLevel)
              }
            >
              <SelectTrigger id="principal-level">
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
              {principalLevel === "workspace" ? "Identifier" : `${principalLevel} id`}
            </Label>
            <Input
              id="principal-id"
              value={principalLevel === "workspace" ? "__workspace__" : principalId}
              onChange={(e) => setPrincipalId(e.target.value)}
              disabled={principalLevel === "workspace" || pending}
              placeholder={principalLevel === "workspace" ? "" : `Enter ${principalLevel} id`}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="role">Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as typeof role)}>
              <SelectTrigger id="role">
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
              disabled={pending}
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
