"use client";

import { useState, useTransition } from "react";
import { toast } from "@/lib/cinatra-toast";
import { Trash2, UserPlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { inviteCustomerAction, revokeCustomerAction } from "./actions";

export type CustomerGrant = {
  subjectUserId: string;
  grantedAt: string;
  expiresAt: string | null;
};

type Props = {
  projectId: string;
  initialGrants: CustomerGrant[];
};

/**
 * Customer / external grant management surface. Lists the
 * project's customer grants and lets a project admin invite (by user id, with
 * an optional expiry) or revoke. Project-scoped grants reuse the role_grant +
 * project_access substrate.
 */
export function CustomersClient({ projectId, initialGrants }: Props) {
  const [grants, setGrants] = useState(initialGrants);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [subjectUserId, setSubjectUserId] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [pending, startTransition] = useTransition();

  function invite() {
    startTransition(async () => {
      try {
        const fd = new FormData();
        fd.set("projectId", projectId);
        fd.set("subjectUserId", subjectUserId.trim());
        if (expiresAt) fd.set("expiresAt", new Date(expiresAt).toISOString());
        await inviteCustomerAction(fd);
        setGrants((g) => [
          ...g.filter((x) => x.subjectUserId !== subjectUserId.trim()),
          { subjectUserId: subjectUserId.trim(), grantedAt: new Date().toISOString(), expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null },
        ]);
        toast.success("Customer invited.");
        setDialogOpen(false);
        setSubjectUserId("");
        setExpiresAt("");
      } catch {
        toast.error("Could not invite customer (project admin required).");
      }
    });
  }

  function revoke(id: string) {
    startTransition(async () => {
      try {
        const fd = new FormData();
        fd.set("projectId", projectId);
        fd.set("subjectUserId", id);
        await revokeCustomerAction(fd);
        setGrants((g) => g.filter((x) => x.subjectUserId !== id));
        toast.success("Customer access revoked.");
      } catch {
        toast.error("Could not revoke customer access.");
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-end">
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button>
              <UserPlus data-icon="inline-start" />
              Invite customer
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Invite a customer</DialogTitle>
              <DialogDescription>
                Grant a customer/external user read-mostly access to this project&apos;s shared
                resources. Access is time-bounded if you set an expiry and revocable any time.
              </DialogDescription>
            </DialogHeader>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="customer-user-id">Customer user ID</FieldLabel>
                <Input
                  id="customer-user-id"
                  value={subjectUserId}
                  onChange={(e) => setSubjectUserId(e.target.value)}
                  placeholder="usr_…"
                />
                <FieldDescription>The user is granted the customer role scoped to this project.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="customer-expiry">Expiry (optional)</FieldLabel>
                <Input
                  id="customer-expiry"
                  type="date"
                  value={expiresAt}
                  onChange={(e) => setExpiresAt(e.target.value)}
                  className="max-w-52"
                />
                <FieldDescription>Leave blank for no expiry.</FieldDescription>
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={pending}>
                Cancel
              </Button>
              <Button onClick={invite} disabled={pending || !subjectUserId.trim()}>
                Invite
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {grants.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <UserPlus />
            </EmptyMedia>
            <EmptyTitle>No customers yet</EmptyTitle>
            <EmptyDescription>
              Invite a customer to give them scoped, read-mostly access to this project.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Customer</TableHead>
              <TableHead>Granted</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {grants.map((g) => (
              <TableRow key={g.subjectUserId}>
                <TableCell className="font-mono">{g.subjectUserId}</TableCell>
                <TableCell className="text-muted-foreground">{new Date(g.grantedAt).toLocaleDateString()}</TableCell>
                <TableCell className="text-muted-foreground">
                  {g.expiresAt ? new Date(g.expiresAt).toLocaleDateString() : "—"}
                </TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm" onClick={() => revoke(g.subjectUserId)} disabled={pending}>
                    <Trash2 data-icon="inline-start" />
                    Revoke
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
