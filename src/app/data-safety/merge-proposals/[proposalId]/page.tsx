import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import Link from "next/link";
import { ArrowLeft, GitMerge } from "lucide-react";

import {
  requireAuthSession,
  resolveOrgRoleForSession,
} from "@/lib/auth-session";
import { readMergeProposalById } from "@/lib/object-history";
import { actorFromSession } from "@/lib/authz/build-actor-context";
import { enforceResourceAccess } from "@/lib/authz/enforce-resource-access";
import { AuthzError } from "@/lib/authz/errors";
import { getObjectById } from "@/lib/objects-store";
import { normalizeOwnerLevel } from "@/lib/authz/resource-ref";
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MergeProposalActions } from "@/components/data-safety/merge-proposal-actions";

export const metadata: Metadata = { title: "Merge proposal" };

type Props = {
  params: Promise<{ proposalId: string }>;
};

export default async function MergeProposalDetailPage({ params }: Props) {
  const session = await requireAuthSession();
  const orgId = session.session?.activeOrganizationId ?? null;
  const { proposalId } = await params;

  // Fail-closed when no active org.
  if (!orgId) notFound();
  const proposal = readMergeProposalById(proposalId, { orgId });
  if (!proposal) notFound();

  // Enforce object.read on the target object BEFORE rendering proposal
  // field values. Otherwise an active-
  // org user can read proposal contents for objects they have no
  // object.read on (proposals carry full proposed values).
  const target = getObjectById(proposal.objectId, { orgId });
  if (!target) notFound();
  try {
    await enforceResourceAccess(
      {
        resourceType: "object",
        resourceId: target.id,
        organizationId: target.orgId,
        ownerLevel: normalizeOwnerLevel(target.ownerLevel ?? "organization"),
        ownerId: target.ownerId ?? "",
        visibility:
          (target.visibility as "private" | "team" | "organization" | "public") ??
          "organization",
      },
      actorFromSession(session),
      "object.read",
      (await resolveOrgRoleForSession(session))
        ? { orgRole: (await resolveOrgRoleForSession(session))! }
        : undefined,
    );
  } catch (e) {
    if (e instanceof AuthzError) notFound();
    throw e;
  }

  const fieldEntries = Object.entries(proposal.proposedFields);

  return (
    <Main className="min-h-screen">
      <PageHeader
        title={`Merge proposal ${proposalId.slice(0, 16)}…`}
        description={`${proposal.sourceKind} → ${proposal.objectType} (v${proposal.baseVersion})`}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link href="/data-safety/merge-proposals">
                <ArrowLeft className="size-4 mr-1.5" />
                Back
              </Link>
            </Button>
            {proposal.status === "pending" ? (
              <MergeProposalActions
                proposalId={proposal.id}
                objectId={proposal.objectId}
                baseVersion={proposal.baseVersion}
                proposedFieldKeys={Object.keys(proposal.proposedFields)}
              />
            ) : null}
          </div>
        }
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <Card className="border-line bg-surface backdrop-blur-none">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <GitMerge className="size-4" />
              Status
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Row label="Status" value={<StatusBadge status={proposal.status} />} />
            <Row label="Object" value={
              <span className="font-mono text-xs">{proposal.objectId}</span>
            } />
            <Row label="Object type" value={proposal.objectType} />
            <Row label="Base version" value={`v${proposal.baseVersion}`} />
            <Row label="Source" value={proposal.sourceKind} />
            <Row label="Proposed by" value={
              <span className="font-mono text-xs">
                {proposal.proposingActorKind ?? "system"}
                {proposal.proposingActorId
                  ? ` · ${proposal.proposingActorId.slice(0, 12)}`
                  : ""}
              </span>
            } />
            <Row label="Submitted" value={format(new Date(proposal.createdAt), "PPp")} />
            {proposal.reviewedAt ? (
              <Row
                label="Reviewed"
                value={format(new Date(proposal.reviewedAt), "PPp")}
              />
            ) : null}
            {proposal.appliedChangeEventId ? (
              <Row
                label="Applied change-event"
                value={
                  <span className="font-mono text-xs">
                    {proposal.appliedChangeEventId.slice(0, 16)}…
                  </span>
                }
              />
            ) : null}
          </CardContent>
        </Card>

        <Card className="border-line bg-surface backdrop-blur-none">
          <CardHeader>
            <CardTitle>Proposed fields ({fieldEntries.length})</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {fieldEntries.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No fields proposed.
              </p>
            ) : (
              fieldEntries.map(([key, field]) => (
                <div key={key} className="soft-panel p-4 flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="font-mono text-xs">
                      {key}
                    </Badge>
                    <span className="text-xs text-muted-foreground ml-auto">
                      source: {field.provenance.source}
                      {field.provenance.confidence !== undefined
                        ? ` · confidence ${field.provenance.confidence}`
                        : ""}
                    </span>
                  </div>
                  <pre className="text-xs text-foreground bg-surface-muted p-2 rounded-control overflow-x-auto">
                    {JSON.stringify(field.value, null, 2)}
                  </pre>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </PageContent>
    </Main>
  );
}

function StatusBadge({ status }: { status: string }) {
  const variant: "default" | "secondary" | "destructive" =
    status === "applied"
      ? "default"
      : status === "rejected"
        ? "destructive"
        : "secondary";
  return <Badge variant={variant}>{status}</Badge>;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground">{value}</span>
    </div>
  );
}
