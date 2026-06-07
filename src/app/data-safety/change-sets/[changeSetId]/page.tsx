import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import {
  requireAuthSession,
  resolveOrgRoleForSession,
  isPlatformAdmin,
} from "@/lib/auth-session";
import { actorFromSession } from "@/lib/authz/build-actor-context";
import {
  loadChangeSet,
  summarizeChangeSetEligibility,
  diffSnapshotFields,
  listRemoteEffectAttemptsForChangeSet,
} from "@/lib/object-history";
import {
  partitionEventsByReadAccess,
  canActorRestoreChangeSet,
} from "@/lib/object-history/server-views";
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RestoreModal } from "@/components/data-safety/restore-modal";
import { FreshnessProbe } from "@/components/data-safety/freshness-probe";
import { RemoteEffectAttemptsPanel } from "@/components/data-safety/remote-effect-attempts-panel";

import { restoreChangeSetAction } from "./actions";

export const metadata: Metadata = { title: "Change-set detail" };

type Props = {
  params: Promise<{ changeSetId: string }>;
  searchParams?: Promise<{ openRestore?: string }>;
};

export default async function ChangeSetDetailPage({ params, searchParams }: Props) {
  const session = await requireAuthSession();
  const orgId = session.session?.activeOrganizationId ?? null;
  const { changeSetId } = await params;
  const sp = (await searchParams) ?? {};

  // Fail-closed when no active org. Without an org filter, loadChangeSet
  // would return cross-tenant rows.
  if (!orgId) notFound();
  const loaded = loadChangeSet(changeSetId, { orgId });
  if (!loaded) notFound();

  // Per-event read-access filter. Events on objects the current actor can't
  // read are redacted (snapshots + actor/run/audit/remoteRef scrubbed;
  // timeline shape preserved).
  // Build a PrimitiveActorContext + resolve orgRole hints so the RBAC kernel
  // sees the user's full role grants (org_admin / member / etc.). Without
  // this, org-owned events would be over-denied (silent redaction even for
  // legitimate access).
  const primitiveActor = actorFromSession(session);
  const orgRole = await resolveOrgRoleForSession(session);
  const partitioned = await partitionEventsByReadAccess(
    loaded.events,
    primitiveActor,
    orgRole ? { orgRole } : undefined,
  );
  const filteredEvents = partitioned.map((p) => p.event);
  // Per-event read verdict — keyed by event id so the timeline can OMIT
  // deep-links to objects the actor can't read (omitted, never a broken
  // link). Redacted events keep their shape but lose the link.
  const canReadByEventId = new Map(
    partitioned.map((p) => [p.event.id, p.canRead]),
  );
  const view = { changeSet: loaded.changeSet, events: filteredEvents };
  // Connector attempts, restricted to events the actor can read.
  const readableEventIds = new Set(
    partitioned.filter((p) => p.canRead).map((p) => p.event.id),
  );
  const remoteEffectAttempts = listRemoteEffectAttemptsForChangeSet({
    changeSetId,
    orgId,
  }).filter((a) => readableEventIds.has(a.changeEventId));
  const actorIsPlatformAdmin = isPlatformAdmin(session);
  // The ?openRestore=1 deep-link may auto-open the modal ONLY when the actor
  // can actually restore — the SAME per-event write-authz the confirm path
  // enforces (checked on the unfiltered events, like the action).
  const actorCanRestore = await canActorRestoreChangeSet(
    loaded.events,
    primitiveActor,
    orgRole ? { orgRole } : undefined,
  );
  const eligibility = summarizeChangeSetEligibility(view);
  const diffLines = view.events.map((event) => {
    const fields = diffSnapshotFields(event.beforeSnapshot, event.afterSnapshot);
    return {
      objectId: event.objectId,
      objectType: event.objectType,
      description:
        event.operation === "create"
          ? `created ${event.objectId.slice(0, 8)}…`
          : event.operation === "soft-delete" || event.operation === "tombstone"
            ? `deleted ${event.objectId.slice(0, 8)}…`
            : event.operation === "restore"
              ? `restored ${event.objectId.slice(0, 8)}…`
              : `updated fields: ${fields.length > 0 ? fields.join(", ") : "(no diff captured)"}`,
    };
  });

  return (
    <Main className="min-h-screen">
      <PageHeader
        title={`Change-set ${changeSetId.slice(0, 16)}…`}
        description={
          loaded.changeSet.closureReason
            ? `Closed: ${loaded.changeSet.closureReason}`
            : "Open change-set"
        }
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link href="/data-safety/change-sets">
                <ArrowLeft data-icon="inline-start" />
                Back
              </Link>
            </Button>
            <RestoreModal
              changeSetId={changeSetId}
              restorable={loaded.changeSet.restorable && eligibility.eligible}
              restorableReason={
                !eligibility.eligible
                  ? eligibility.details.join("; ")
                  : (loaded.changeSet.restorableReason ?? null)
              }
              affectedObjectCount={
                new Set(view.events.map((e) => e.objectId)).size
              }
              diffLines={diffLines}
              action={restoreChangeSetAction}
              // Deep-link auto-open. Only when the change-set is genuinely
              // restorable for this actor — restorable + eligible + the actor
              // passes per-event restore authz (the same check the confirm
              // path runs). Never auto-open a modal whose confirm would be
              // denied.
              defaultOpen={
                sp.openRestore === "1" &&
                loaded.changeSet.restorable &&
                eligibility.eligible &&
                actorCanRestore
              }
            />
          </div>
        }
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <Card className="border-line bg-surface backdrop-blur-none">
          <CardHeader>
            <CardTitle>Summary</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Row label="Effect rollup" value={loaded.changeSet.effectRollup} />
            <Row
              label="Restorable"
              value={
                <Badge
                  variant={loaded.changeSet.restorable ? "secondary" : "destructive"}
                >
                  {loaded.changeSet.restorable ? "yes" : "no"}
                </Badge>
              }
            />
            {!eligibility.eligible ? (
              <Row
                label="Block reason"
                value={
                  <span className="text-sm text-destructive">
                    {eligibility.details.join("; ")}
                  </span>
                }
              />
            ) : null}
            <Row
              label="Events"
              value={`${view.events.length} event${view.events.length === 1 ? "" : "s"}`}
            />
          </CardContent>
        </Card>

        {/* Freshness probe, only when a READABLE event is CMS-tagged.
            Gating on the redacted `view.events` (not raw loaded.events) avoids
            leaking that a hidden remote-source event exists. */}
        {view.events.some((e) => e.remoteRevisionRef) ? (
          <Card className="border-line bg-surface backdrop-blur-none">
            <CardHeader>
              <CardTitle>Remote freshness</CardTitle>
            </CardHeader>
            <CardContent>
              <FreshnessProbe changeSetId={changeSetId} />
            </CardContent>
          </Card>
        ) : null}

        {/* Connector restore attempts (empty until CMS restore is wired). */}
        <RemoteEffectAttemptsPanel
          attempts={remoteEffectAttempts}
          isPlatformAdmin={actorIsPlatformAdmin}
        />

        <Card className="border-line bg-surface backdrop-blur-none">
          <CardHeader>
            <CardTitle>Events</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {view.events.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No events in this change-set.
              </p>
            ) : (
              view.events.map((event) => {
                const fields = diffSnapshotFields(
                  event.beforeSnapshot,
                  event.afterSnapshot,
                );
                const perEvent = eligibility.perEvent.find(
                  (e) => e.eventId === event.id,
                );
                return (
                  <div
                    key={event.id}
                    className="soft-panel p-4 flex flex-col gap-2"
                  >
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="font-mono text-xs">
                        seq {event.sequence}
                      </Badge>
                      <Badge variant="secondary">{event.operation}</Badge>
                      <span className="text-xs text-muted-foreground">
                        v{event.baseVersion ?? "—"} → v{event.resultVersion}
                      </span>
                      <span className="text-xs text-muted-foreground ml-auto">
                        {format(new Date(event.createdAt), "PPp")}
                      </span>
                    </div>
                    <div className="text-sm">
                      <span className="text-muted-foreground">object:</span>{" "}
                      <span className="font-mono text-xs">
                        {event.objectId.slice(0, 24)}…
                      </span>{" "}
                      <span className="text-muted-foreground">·</span>{" "}
                      <span>{event.objectType}</span>
                    </div>
                    {/* Bidirectional deep-link to the object's History tab.
                        OMITTED for events the actor can't read (redacted) —
                        never a broken link. */}
                    {canReadByEventId.get(event.id) ? (
                      <Link
                        href={`/data/${event.objectId}?focus=history`}
                        className="w-fit text-xs text-primary hover:underline"
                      >
                        View object history →
                      </Link>
                    ) : null}
                    {fields.length > 0 ? (
                      <div className="text-xs text-muted-foreground">
                        changed: {fields.join(", ")}
                      </div>
                    ) : null}
                    {perEvent && !perEvent.eligible ? (
                      <div className="text-xs text-destructive">
                        eligibility: {perEvent.reason} — {perEvent.details}
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>
      </PageContent>
    </Main>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground">{value}</span>
    </div>
  );
}
