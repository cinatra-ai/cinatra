"use client";

/**
 * Approve / Reject / View-detail buttons for the vendor-application
 * moderator queue. Mirrors the submission admin pattern.
 *
 * Reject uses a Textarea + non-empty client gate; the server action also
 * rejects empty strings.
 */

import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";

import type { MarketplaceVendorApplicationAdminRow } from "@cinatra-ai/marketplace-mcp-client";

import {
  approveVendorApplicationAction,
  rejectVendorApplicationAction,
} from "./actions";

/** Mirrors REJECT_REASON_MAX in actions.ts — keep both in sync. */
const REJECT_REASON_MAX = 2000;

export function ApproveButton({
  applicationId,
  scope,
  returnStatus,
}: {
  applicationId: string;
  scope: string;
  returnStatus: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">Approve</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Approve vendor application?</DialogTitle>
          <DialogDescription>
            This grants vendor-publish access on the marketplace for{" "}
            <span className="font-mono">{scope}</span>. The applicant retrieves
            their publish token via a separate self-service rotate call after
            this approval lands.
          </DialogDescription>
        </DialogHeader>
        <form action={approveVendorApplicationAction}>
          <Input type="hidden" name="application_id" value={applicationId} />
          <Input type="hidden" name="return_status" value={returnStatus} />
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="ghost">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit">Approve</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RejectButton({
  applicationId,
  scope,
  returnStatus,
}: {
  applicationId: string;
  scope: string;
  returnStatus: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const isReasonValid =
    reason.trim().length > 0 && reason.length <= REJECT_REASON_MAX;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setReason("");
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Reject
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reject vendor application</DialogTitle>
          <DialogDescription>
            Rejecting <span className="font-mono">{scope}</span> requires a
            reason. The applicant sees this in their vendor-application
            status view.
          </DialogDescription>
        </DialogHeader>
        <form action={rejectVendorApplicationAction}>
          <Input type="hidden" name="application_id" value={applicationId} />
          <Input type="hidden" name="return_status" value={returnStatus} />
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="vendor-reject-reason">
                Rejection reason (required)
              </FieldLabel>
              <Textarea
                id="vendor-reject-reason"
                name="reason"
                rows={4}
                maxLength={REJECT_REASON_MAX}
                placeholder="Required — e.g. policy violation, scope conflict, incomplete profile."
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                required
              />
            </Field>
          </FieldGroup>
          <DialogFooter className="mt-4">
            <DialogClose asChild>
              <Button type="button" variant="ghost">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" variant="destructive" disabled={!isReasonValid}>
              Reject
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ViewDetailSheet({
  application,
}: {
  application: MarketplaceVendorApplicationAdminRow;
}) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button size="sm" variant="ghost">
          View
        </Button>
      </SheetTrigger>
      <SheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Vendor application</SheetTitle>
          <SheetDescription className="font-mono break-all">
            {application.application_id}
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4 px-4 pb-4">
          <FieldGroup>
            <Field orientation="horizontal">
              <FieldLabel>Display name</FieldLabel>
              <FieldDescription>{application.display_name}</FieldDescription>
            </Field>
            <Field orientation="horizontal">
              <FieldLabel>Scope</FieldLabel>
              <FieldDescription className="font-mono text-xs">
                {application.scope}
              </FieldDescription>
            </Field>
            <Field orientation="horizontal">
              <FieldLabel>Tier</FieldLabel>
              <FieldDescription>{application.tier}</FieldDescription>
            </Field>
            <Field orientation="horizontal">
              <FieldLabel>Status</FieldLabel>
              <FieldDescription>{application.status}</FieldDescription>
            </Field>
            <Field orientation="horizontal">
              <FieldLabel>Applicant user_id</FieldLabel>
              <FieldDescription className="font-mono text-xs">
                {application.applicant_user_id}
              </FieldDescription>
            </Field>
            <Field orientation="horizontal">
              <FieldLabel>Applied at</FieldLabel>
              <FieldDescription>
                {new Date(application.applied_at).toLocaleString()}
              </FieldDescription>
            </Field>
            <Field orientation="horizontal">
              <FieldLabel>Decided at</FieldLabel>
              <FieldDescription>
                {application.decided_at
                  ? new Date(application.decided_at).toLocaleString()
                  : "—"}
              </FieldDescription>
            </Field>
            <Field orientation="horizontal">
              <FieldLabel>Decided by admin_id</FieldLabel>
              <FieldDescription className="font-mono text-xs">
                {application.decided_by_admin_id ?? "—"}
              </FieldDescription>
            </Field>
            <Field orientation="horizontal">
              <FieldLabel>Decision reason</FieldLabel>
              <FieldDescription className="break-words">
                {application.decision_reason ?? "—"}
              </FieldDescription>
            </Field>
            <Field orientation="horizontal">
              <FieldLabel>Terms version</FieldLabel>
              <FieldDescription className="font-mono text-xs">
                {application.terms_version}
              </FieldDescription>
            </Field>
            <Field orientation="horizontal">
              <FieldLabel>Terms digest</FieldLabel>
              <FieldDescription className="font-mono text-xs break-all">
                {application.terms_digest}
              </FieldDescription>
            </Field>
          </FieldGroup>
        </div>
      </SheetContent>
    </Sheet>
  );
}
