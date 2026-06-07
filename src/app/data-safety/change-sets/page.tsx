import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import { History } from "lucide-react";

import { requireAuthSession } from "@/lib/auth-session";
import { listChangeSets } from "@/lib/object-history";
import { ChangeSetFilterBar } from "@/components/data-safety/change-set-filter-bar";
import type { HistoryEffect } from "@/lib/object-history";
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Table,
} from "@/components/ui/table";

export const metadata: Metadata = { title: "Change history" };

type PageProps = {
  searchParams?: Promise<{
    objectId?: string;
    actorId?: string;
    runId?: string;
    effectRollup?: string;
    restorable?: string;
    createdAfter?: string;
    createdBefore?: string;
  }>;
};

const EFFECT_VALUES = new Set([
  "reversible-internal",
  "irreversible-logged",
  "compensating-action",
]);

export default async function DataSafetyChangeSetsPage({ searchParams }: PageProps) {
  const session = await requireAuthSession();
  const orgId = session.session?.activeOrganizationId ?? null;
  const sp = (await searchParams) ?? {};
  // Apply filter/search from the URL (all optional; omitted = no filter).
  // effectRollup/restorable are validated before use.
  const effectRollup =
    sp.effectRollup && EFFECT_VALUES.has(sp.effectRollup)
      ? (sp.effectRollup as HistoryEffect)
      : undefined;
  const restorable =
    sp.restorable === "true" ? true : sp.restorable === "false" ? false : undefined;
  // Fail-closed when no active org. listChangeSets without orgId is unscoped;
  // we render an explicit empty state instead.
  const items = orgId
    ? listChangeSets({
        orgId,
        limit: 100,
        objectId: sp.objectId || undefined,
        actorId: sp.actorId || undefined,
        runId: sp.runId || undefined,
        effectRollup,
        restorable,
        createdAfter: sp.createdAfter || undefined,
        createdBefore: sp.createdBefore || undefined,
      })
    : [];

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Change history"
        description="Append-only log of every object mutation, restorable via the canonical history-aware writer."
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        {/* Filter/search bar (URL search-param state). */}
        <Card className="border-line bg-surface backdrop-blur-none">
          <CardContent className="p-6">
            <ChangeSetFilterBar
              current={{
                objectId: sp.objectId,
                actorId: sp.actorId,
                runId: sp.runId,
                effectRollup: sp.effectRollup,
                restorable: sp.restorable,
                createdAfter: sp.createdAfter,
                createdBefore: sp.createdBefore,
              }}
            />
          </CardContent>
        </Card>

        <Card className="border-line bg-surface backdrop-blur-none">
          <CardContent className="p-0">
            {items.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
                <History className="size-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  No change-sets yet. Object mutations will appear here as
                  they happen.
                </p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Change-set</TableHead>
                    <TableHead>Opened</TableHead>
                    <TableHead>Effect</TableHead>
                    <TableHead>Restorable</TableHead>
                    <TableHead>Actor</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((cs) => (
                    <TableRow key={cs.id}>
                      <TableCell className="font-mono text-xs">
                        <Link
                          href={`/data-safety/change-sets/${cs.id}`}
                          className="text-primary hover:underline"
                        >
                          {cs.id.slice(0, 16)}…
                        </Link>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {cs.openedAt
                          ? format(new Date(cs.openedAt), "PPp")
                          : "—"}
                      </TableCell>
                      <TableCell>
                        <EffectBadge effect={cs.effectRollup} />
                      </TableCell>
                      <TableCell>
                        {cs.restorable ? (
                          <Badge variant="secondary">restorable</Badge>
                        ) : (
                          <Badge variant="destructive">non-restorable</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {cs.actorKind ?? "system"}
                        {cs.actorId ? ` · ${cs.actorId.slice(0, 8)}` : ""}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </PageContent>
    </Main>
  );
}

function EffectBadge({ effect }: { effect: string }) {
  const label =
    effect === "reversible-internal"
      ? "reversible"
      : effect === "compensating-action"
        ? "compensating"
        : effect === "irreversible-logged"
          ? "irreversible"
          : effect;
  const variant: "default" | "secondary" | "destructive" =
    effect === "irreversible-logged"
      ? "destructive"
      : effect === "compensating-action"
        ? "default"
        : "secondary";
  return <Badge variant={variant}>{label}</Badge>;
}
