import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import { GitMerge } from "lucide-react";

import { requireAuthSession } from "@/lib/auth-session";
import { listPendingMergeProposals } from "@/lib/object-history";
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

export const metadata: Metadata = { title: "Merge proposals" };

export default async function MergeProposalsPage() {
  const session = await requireAuthSession();
  const orgId = session.session?.activeOrganizationId ?? null;
  // Fail-closed on missing active org. Without an org filter,
  // listPendingMergeProposals omits the org predicate.
  const items = orgId
    ? listPendingMergeProposals({ orgId, limit: 100 })
    : [];

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Merge proposals"
        description="Enrichment-agent proposals awaiting review. Approved proposals apply via the MERGE policy with the captured baseVersion."
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <Card className="border-line bg-surface backdrop-blur-none">
          <CardContent className="p-0">
            {items.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
                <GitMerge className="size-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  No pending merge proposals.
                </p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Proposal</TableHead>
                    <TableHead>Object</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Base version</TableHead>
                    <TableHead>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="font-mono text-xs">
                        <Link
                          href={`/data-safety/merge-proposals/${p.id}`}
                          className="text-primary hover:underline"
                        >
                          {p.id.slice(0, 16)}…
                        </Link>
                      </TableCell>
                      <TableCell className="text-sm">
                        <span className="font-mono text-xs">
                          {p.objectId.slice(0, 12)}…
                        </span>
                        <span className="text-muted-foreground ml-1">
                          {p.objectType}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{p.sourceKind}</Badge>
                      </TableCell>
                      <TableCell className="text-sm">v{p.baseVersion}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {format(new Date(p.createdAt), "PP p")}
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
