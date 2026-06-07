import "server-only";

import Link from "next/link";
import { format } from "date-fns";

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { buildWorkflowActorFromSession } from "@/lib/workflow-actor";
import { listPendingApprovalsForOrg } from "@cinatra-ai/workflows/store";

// — body-only renderer for the Workflows tab of the unified
// /configuration/approvals page. No Main / PageHeader chrome (the tabbed
// page owns those).

export async function WorkflowApprovalsBody() {
  const { orgId } = await buildWorkflowActorFromSession();
  const rows = orgId ? await listPendingApprovalsForOrg(orgId) : [];

  if (rows.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No pending approvals</EmptyTitle>
          <EmptyDescription>
            Approvals appear here when a workflow has an approval gate awaiting a decision.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <Card className="border-line bg-surface backdrop-blur-none">
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Workflow</TableHead>
              <TableHead>Task</TableHead>
              <TableHead>Required scope</TableHead>
              <TableHead>Deadline</TableHead>
              <TableHead>Waiting since</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const scope = row.requiredScope as { level?: string } | null;
              return (
                <TableRow key={row.approvalId}>
                  <TableCell>
                    <Link
                      href={`/workflows/${row.workflowId}`}
                      className="text-foreground hover:text-primary"
                    >
                      {row.workflowName}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <span className="font-semibold text-foreground">{row.taskTitle}</span>
                    <Badge variant="secondary" className="ml-2 font-mono text-xs">{row.taskKey}</Badge>
                  </TableCell>
                  <TableCell>
                    {scope?.level ? (
                      <Badge variant="outline" className="text-xs">{scope.level}</Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {row.deadlineUtc ? format(row.deadlineUtc, "MMM d, yyyy") : "—"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {format(row.createdAt, "MMM d, yyyy")}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
