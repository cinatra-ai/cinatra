import "server-only";
import Link from "next/link";
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { ChevronLeft } from "lucide-react";
import { requireAdminSession, resolveOrgRoleForSession } from "@/lib/auth-session";
import { actorFromSession } from "@/lib/authz/build-actor-context";
import { enforceResourceAccess } from "@/lib/authz/enforce-resource-access";
import { AuthzError } from "@/lib/authz/errors";
import { normalizeOwnerLevel } from "@/lib/authz/resource-ref";
import { getObjectById } from "@/lib/objects-store";
import { ScopeBadge, type ScopeLevel } from "@/components/scope-badge";
import { buildScopeReason } from "@cinatra-ai/agents/auth-policy";
import type { AgentAuthPolicyVisibility } from "@cinatra-ai/agents/auth-policy";
import { ObjectHistoryPanel } from "@/components/data-safety/object-history-panel";
import { UndoLastAction } from "@/components/data-safety/undo-last-action";
import { RetentionBadge } from "@/components/data-safety/retention-badge";
import { SyncAdapterSettingsTab } from "./sync-adapter-settings-tab";
import { ConfidenceBadge } from "./confidence-badge";

// ---------------------------------------------------------------------------
// Visibility → policy mapper
// ---------------------------------------------------------------------------

function mapObjectVisibilityToPolicy(
  visibility: string | null | undefined,
  ownerId: string | null | undefined,
): AgentAuthPolicyVisibility {
  switch (visibility) {
    case "organization": return "org";
    case "team": return ownerId ? (`team:${ownerId}` as AgentAuthPolicyVisibility) : "org";
    case "workspace": return "workspace";
    case "public": return "workspace";
    default: return "owner";
  }
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

type ObjectDetailPageProps = {
  id: string;
  /**
   * Optional initial tab focus. `"history"` switches the Tabs default to the
   * History tab so package-specific detail pages can deep-link via
   * `/data/[id]?focus=history` without re-mounting the panel themselves.
   */
  focus?: "history";
};

export async function ObjectDetailPage({ id, focus }: ObjectDetailPageProps) {
  const session = await requireAdminSession();
  const orgId = session.session?.activeOrganizationId ?? null;

  // Actor context for the per-page undo affordance. Mirrors the
  // change-set route: a PrimitiveActorContext + resolved org-role hint so the
  // per-event read redaction sees the user's full role grants.
  const primitiveActor = actorFromSession(session);
  const orgRole = await resolveOrgRoleForSession(session);
  const undoRoleHints = orgRole ? { orgRole } : undefined;

  const row = getObjectById(id, { orgId });

  const objectTitle = row
    ? (() => {
        const d = (row.data as Record<string, unknown> | null) ?? {};
        return (
          (typeof d.name === "string" && d.name) ||
          (typeof d.title === "string" && d.title) ||
          (typeof d.displayName === "string" && d.displayName) ||
          (typeof d.email === "string" && d.email) ||
          `Data ${id}`
        );
      })()
    : "Data not found";

  if (!row) {
    return (
      <Main className="min-h-screen">
        <PageHeader
          title="Data not found"
          description={`No data with id "${id}" exists or it has been deleted.`}
          actions={
            <Button variant="outline" asChild>
              <Link href="/data">
                <ChevronLeft data-icon="inline-start" />
                Back to Data
              </Link>
            </Button>
          }
        />
      </Main>
    );
  }

  const objectData = (row.data as Record<string, unknown> | null) ?? {};
  const classificationConfidence =
    typeof objectData.classificationConfidence === "number"
      ? objectData.classificationConfidence
      : null;

  const policyVisibility = mapObjectVisibilityToPolicy(row.visibility ?? null, row.ownerId ?? null);
  const scopeReason = buildScopeReason(policyVisibility, {});

  // Resolve object.update for the current actor ONCE, server-side,
  // so the per-version restore buttons are hidden (not just disabled) when the
  // actor can't write. enforceResourceAccess throws on denial.
  let canRestoreVersions = false;
  try {
    await enforceResourceAccess(
      {
        resourceType: "object",
        resourceId: row.id,
        organizationId: row.orgId,
        ownerLevel: normalizeOwnerLevel(row.ownerLevel ?? "organization"),
        ownerId: row.ownerId ?? "",
        visibility:
          (row.visibility as "private" | "team" | "organization" | "public") ??
          "organization",
      },
      primitiveActor,
      "object.update",
      undoRoleHints,
    );
    canRestoreVersions = true;
  } catch (e) {
    if (!(e instanceof AuthzError)) throw e;
    canRestoreVersions = false;
  }

  return (
    <Main className="min-h-screen">
      <PageHeader
        title={objectTitle}
        description={row.type}
        actions={
          <Button variant="outline" asChild>
            <Link href="/data">
              <ChevronLeft data-icon="inline-start" />
              Back to Data
            </Link>
          </Button>
        }
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <section className="soft-panel rounded-card px-6 py-6">
          <Tabs defaultValue={focus === "history" ? "history" : "details"}>
            <TabsList>
              <TabsTrigger value="details">Details</TabsTrigger>
              <TabsTrigger value="connectors">Connectors</TabsTrigger>
              <TabsTrigger value="history">History</TabsTrigger>
            </TabsList>

            <TabsContent value="details" className="mt-6 flex flex-col gap-6">
              <section>
                <h3 className="text-sm font-semibold text-foreground mb-2">Ownership</h3>
                <div className="flex items-center gap-2">
                  <ScopeBadge level={(row.ownerLevel ?? "user") as ScopeLevel} />
                </div>
                {scopeReason && (
                  <p className="mt-1 text-xs text-muted-foreground">{scopeReason}</p>
                )}
              </section>
              <Separator />
              <section>
                <h3 className="text-sm font-semibold text-foreground mb-2">Classification</h3>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">Confidence</span>
                  <ConfidenceBadge confidence={classificationConfidence} />
                </div>
              </section>
              <Separator />
              <section>
                <h3 className="text-sm font-semibold text-foreground mb-3">Actor context</h3>
                <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
                  <dt className="font-semibold text-foreground">Agent</dt>
                  <dd className="text-muted-foreground font-mono text-xs truncate">{row.agentId ?? "—"}</dd>
                  <dt className="font-semibold text-foreground">Run</dt>
                  <dd className="text-muted-foreground font-mono text-xs truncate">{row.runId ?? "—"}</dd>
                  <dt className="font-semibold text-foreground">Source</dt>
                  <dd className="text-muted-foreground">{row.source ?? "—"}</dd>
                  <dt className="font-semibold text-foreground">User</dt>
                  <dd className="text-muted-foreground font-mono text-xs truncate">{row.createdBy ?? "—"}</dd>
                </dl>
              </section>
              <Separator />
              <section>
                <h3 className="text-sm font-semibold text-foreground mb-3">Raw data</h3>
                <pre className="soft-panel rounded-control px-4 py-3 text-xs text-foreground overflow-auto">
                  {JSON.stringify(row.data, null, 2)}
                </pre>
              </section>
            </TabsContent>

            <TabsContent value="connectors" className="mt-6">
              <SyncAdapterSettingsTab objectType={row.type} />
            </TabsContent>

            <TabsContent value="history" className="mt-6 flex flex-col gap-4">
              {/* Retention indicator near the History surface. */}
              <div>
                <RetentionBadge objectType={row.type} createdAt={row.createdAt} />
              </div>
              <UndoLastAction
                objectId={id}
                orgId={orgId}
                actorId={session.user.id}
                actor={primitiveActor}
                roleHints={undoRoleHints}
              />
              <ObjectHistoryPanel
                objectId={id}
                orgId={orgId}
                canRestore={canRestoreVersions}
                currentVersion={row.version}
              />
            </TabsContent>
          </Tabs>
        </section>
      </PageContent>
    </Main>
  );
}
