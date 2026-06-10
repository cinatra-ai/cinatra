"use client";

// Pending-approval review panel for a workflow.
// Renders inline above the Gantt on the workflow detail page. Each pending
// approval shows the task it gates + Approve / Reject buttons. Reject opens a
// dialog with an optional reason field. The server action re-checks canManage
// and CAS-guards on status='pending'.

import { useState, useTransition } from "react";
import { CheckIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/lib/cinatra-toast";
import type { ApprovalDecision } from "@cinatra-ai/workflows/store";

export type PendingApprovalItem = {
  approvalId: string;
  taskKey: string;
  taskTitle: string;
  scopeLevel: string | null;
  createdAtIso: string;
};

type Props = {
  approvals: PendingApprovalItem[];
  canManage: boolean;
  decide: (approvalId: string, decision: ApprovalDecision, reason?: string) => Promise<{ ok: boolean; reason?: string }>;
};

export function WorkflowApprovalsPanel({ approvals, canManage, decide }: Props) {
  if (approvals.length === 0) return null;
  return (
    <Card className="border-line bg-surface backdrop-blur-none">
      <CardHeader>
        <CardTitle>Pending approvals ({approvals.length})</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {approvals.map((a) => (
          <ApprovalRow key={a.approvalId} approval={a} canManage={canManage} decide={decide} />
        ))}
      </CardContent>
    </Card>
  );
}

function ApprovalRow({
  approval,
  canManage,
  decide,
}: {
  approval: PendingApprovalItem;
  canManage: boolean;
  decide: Props["decide"];
}) {
  const [pending, startTransition] = useTransition();
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState("");

  function run(decision: ApprovalDecision, reasonValue?: string, successMsg = "Decision recorded") {
    startTransition(async () => {
      try {
        const r = await decide(approval.approvalId, decision, reasonValue);
        if (r.ok) toast.success(successMsg);
        else toast.error(`Decision rejected${r.reason ? `: ${r.reason}` : ""}`);
      } catch {
        toast.error("Could not record your approval decision.");
      } finally {
        setRejectOpen(false);
        setReason("");
      }
    });
  }

  return (
    <div className="soft-panel rounded-card flex items-center justify-between gap-4 p-4">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-foreground">{approval.taskTitle}</span>
          <Badge variant="secondary" className="font-mono text-xs">{approval.taskKey}</Badge>
          {approval.scopeLevel && (
            <Badge variant="outline" className="text-xs">Required: {approval.scopeLevel}</Badge>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          Approve to dispatch this task; reject to apply its rejection policy.
        </p>
      </div>
      {canManage && (
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            data-testid={`approval-approve-${approval.taskKey}`}
            disabled={pending}
            onClick={() => run("approved", undefined, `Approved ${approval.taskKey}`)}
          >
            <CheckIcon data-icon="inline-start" />
            Approve
          </Button>
          <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
            <DialogTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                data-testid={`approval-reject-trigger-${approval.taskKey}`}
                disabled={pending}
              >
                <XIcon data-icon="inline-start" />
                Reject
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Reject &quot;{approval.taskTitle}&quot;?</DialogTitle>
                <DialogDescription>
                  Recording a reason helps the workflow author understand the rejection.
                </DialogDescription>
              </DialogHeader>
              <Field>
                <FieldLabel htmlFor="reject-reason">Reason (optional)</FieldLabel>
                <Textarea
                  id="reject-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Why is this rejected?"
                  rows={3}
                />
                <FieldDescription>Stored on the approval for audit.</FieldDescription>
              </Field>
              <DialogFooter>
                <Button variant="outline" onClick={() => setRejectOpen(false)} disabled={pending}>
                  Keep pending
                </Button>
                <Button
                  variant="outline"
                  data-testid={`approval-reject-confirm-${approval.taskKey}`}
                  disabled={pending}
                  onClick={() => run("rejected", reason.trim() || undefined, `Rejected ${approval.taskKey}`)}
                >
                  Reject
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      )}
    </div>
  );
}
