"use client";

import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { LifecycleBadge } from "@/components/lifecycle-badge";
import { StatusPill } from "@/components/ui/status-pill";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PaginatedTable } from "@/components/ui/paginated-table";
import type { ServiceAccountRecord } from "@/lib/service-accounts";
import {
  createServiceAccountAction,
  deleteServiceAccountAction,
  rotateServiceAccountAction,
  revokeServiceAccountAction,
} from "./actions";
import {
  DeleteConfirmDialog,
  RotateConfirmDialog,
  type DeleteConfirmTarget,
  type RotateConfirmTarget,
} from "./confirm-dialogs";
import { CreateServiceAccountForm } from "./create-form";
import { toast } from "@/lib/cinatra-toast";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CredentialResult = {
  clientId: string;
  clientSecret: string;
};

type ServiceAccountsTableProps = {
  initialAccounts: ServiceAccountRecord[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatScopes(scopes: string): string[] {
  return scopes
    .trim()
    .split(/\s+/)
    .filter((s) => s.length > 0);
}

function formatDate(d: Date): string {
  try {
    return d.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return String(d);
  }
}

// ---------------------------------------------------------------------------
// ServiceAccountsTable
// ---------------------------------------------------------------------------

export function ServiceAccountsTable({ initialAccounts }: ServiceAccountsTableProps) {
  const [accounts, setAccounts] = useState(initialAccounts);
  const [credentials, setCredentials] = useState<CredentialResult | null>(null);
  const [credentialLabel, setCredentialLabel] = useState("");
  const [rotateConfirm, setRotateConfirm] = useState<RotateConfirmTarget | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmTarget | null>(null);
  const [isPending, startTransition] = useTransition();
  const createFormRef = useRef<HTMLFormElement>(null);

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  function handleCreate(formData: FormData) {
    startTransition(async () => {
      try {
        const result = await createServiceAccountAction(formData);
        setCredentials({ clientId: result.clientId, clientSecret: result.clientSecret });
        setCredentialLabel(result.name);
        // Optimistically prepend the new row
        setAccounts((prev) => [
          {
            id: result.id,
            name: result.name,
            orgId: result.orgId,
            clientId: result.clientId,
            scopes: result.scopes,
            revokedAt: null,
            rotatedAt: null,
            previousClientId: null,
            gracePeriodSeconds: 900,
            createdBy: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          ...prev,
        ]);
        createFormRef.current?.reset();
      } catch (err) {
        toast.error(
          `Failed to create service account: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }

  // -------------------------------------------------------------------------
  // Rotate (with confirm dialog warning about grace period)
  // -------------------------------------------------------------------------

  function handleRotateConfirm() {
    if (!rotateConfirm) return;
    const target = rotateConfirm;
    setRotateConfirm(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("id", target.id);
      try {
        const result = await rotateServiceAccountAction(fd);
        setCredentials({ clientId: result.clientId, clientSecret: result.clientSecret });
        setCredentialLabel(`${target.name} (rotated)`);
        setAccounts((prev) =>
          prev.map((a) =>
            a.id === target.id
              ? {
                  ...a,
                  previousClientId: a.clientId,
                  clientId: result.clientId,
                  rotatedAt: new Date(),
                  updatedAt: new Date(),
                }
              : a,
          ),
        );
      } catch (err) {
        toast.error(
          `Failed to rotate service account: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }

  // -------------------------------------------------------------------------
  // Revoke (single-click, no confirm — already-issued tokens fail next call)
  // -------------------------------------------------------------------------

  function handleRevoke(id: string) {
    startTransition(async () => {
      const fd = new FormData();
      fd.set("id", id);
      try {
        await revokeServiceAccountAction(fd);
        // Optimistic UI: set revokedAt immediately so the
        // badge changes before revalidatePath resolves.
        setAccounts((prev) =>
          prev.map((a) => (a.id === id ? { ...a, revokedAt: new Date() } : a)),
        );
      } catch (err) {
        toast.error(
          `Failed to revoke service account: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }

  // -------------------------------------------------------------------------
  // Delete (with confirm dialog warning about permanent removal)
  // -------------------------------------------------------------------------

  function handleDeleteConfirm() {
    if (!deleteConfirm) return;
    const target = deleteConfirm;
    setDeleteConfirm(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("id", target.id);
      try {
        await deleteServiceAccountAction(fd);
        setAccounts((prev) => prev.filter((a) => a.id !== target.id));
      } catch (err) {
        toast.error(
          `Failed to delete service account: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="flex flex-col gap-6">
      {/* Create form */}
      <CreateServiceAccountForm
        formRef={createFormRef}
        isPending={isPending}
        onSubmit={handleCreate}
      />

      {/* Service accounts table */}
      {accounts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No service accounts registered yet.</p>
      ) : (
        <PaginatedTable>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Org</TableHead>
              <TableHead>Client ID</TableHead>
              <TableHead>Scopes</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.map((a) => {
              const isRevoked = a.revokedAt !== null;
              const scopeList = formatScopes(a.scopes);
              return (
                <TableRow key={a.id}>
                  <TableCell className="font-medium text-foreground">{a.name}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {a.orgId ? (
                      <code className="rounded bg-surface-strong px-1.5 py-0.5 font-mono text-xs text-foreground">
                        {a.orgId.slice(0, 8)}…
                      </code>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    <code className="rounded bg-surface-strong px-1.5 py-0.5 font-mono text-xs text-foreground">
                      {a.clientId.slice(0, 8)}…
                    </code>
                  </TableCell>
                  <TableCell>
                    {scopeList.length === 0 ? (
                      <span className="text-xs text-muted-foreground">none</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {scopeList.map((scope) => (
                          <Badge key={scope} variant="secondary" className="font-mono text-xs">
                            {scope}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    {isRevoked ? (
                      <StatusPill status="declined">Revoked</StatusPill>
                    ) : (
                      <LifecycleBadge status="active" />
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {formatDate(a.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={isPending}
                        onClick={() =>
                          setRotateConfirm({
                            id: a.id,
                            name: a.name,
                            gracePeriodSeconds: a.gracePeriodSeconds,
                          })
                        }
                      >
                        Rotate
                      </Button>
                      {!isRevoked && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={isPending}
                          onClick={() => handleRevoke(a.id)}
                        >
                          Revoke
                        </Button>
                      )}
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={isPending}
                        onClick={() => setDeleteConfirm({ id: a.id, name: a.name })}
                      >
                        Delete
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </PaginatedTable>
      )}

      {/* One-time credential reveal dialog (secret shown once, never persisted) */}
      <Dialog
        open={!!credentials}
        onOpenChange={(open) => {
          // CRITICAL: setCredentials(null) removes the secret from React state on close.
          if (!open) setCredentials(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save these credentials — {credentialLabel}</DialogTitle>
            <DialogDescription>
              The client secret will not be shown again. Store it in a password manager or secure
              secret store immediately.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 pt-2">
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">Client ID</Label>
              <code className="block rounded bg-surface-strong px-3 py-2 font-mono text-sm text-foreground break-all">
                {credentials?.clientId}
              </code>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">Client Secret</Label>
              <code className="block rounded bg-surface-strong px-3 py-2 font-mono text-sm text-foreground break-all">
                {credentials?.clientSecret}
              </code>
            </div>
            <p className="text-xs text-muted-foreground">
              Use these with the OAuth <code className="font-mono">client_credentials</code> grant
              at <code className="font-mono">/api/auth/oauth2/token</code> to obtain an access
              token for A2A calls.
            </p>
            <Button
              onClick={() => {
                if (credentials) {
                  void navigator.clipboard.writeText(
                    `CINATRA_A2A_CLIENT_ID=${credentials.clientId}\nCINATRA_A2A_CLIENT_SECRET=${credentials.clientSecret}`,
                  );
                }
              }}
              variant="outline"
            >
              Copy as env vars
            </Button>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCredentials(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rotate + Delete confirm dialogs — sub-component to keep this file focused */}
      <RotateConfirmDialog
        target={rotateConfirm}
        isPending={isPending}
        onCancel={() => setRotateConfirm(null)}
        onConfirm={handleRotateConfirm}
      />
      <DeleteConfirmDialog
        target={deleteConfirm}
        isPending={isPending}
        onCancel={() => setDeleteConfirm(null)}
        onConfirm={handleDeleteConfirm}
      />
    </div>
  );
}
