"use client";

import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { LinkIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Field, FieldLabel } from "@/components/ui/field";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PaginatedTable } from "@/components/ui/paginated-table";
import type { AssistantUser } from "@/lib/assistant-users";
import { toast } from "@/lib/cinatra-toast";
import {
  createAssistantAction,
  deleteAssistantAction,
  rotateAssistantClientAction,
  setAssistantWebhookAction,
} from "./actions";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CredentialResult = {
  clientId: string;
  clientSecret: string;
};

// ---------------------------------------------------------------------------
// AssistantsTable
// ---------------------------------------------------------------------------

type AssistantsTableProps = {
  assistants: AssistantUser[];
};

export function AssistantsTable({ assistants: initialAssistants }: AssistantsTableProps) {
  const [assistants, setAssistants] = useState(initialAssistants);
  const [credentials, setCredentials] = useState<CredentialResult | null>(null);
  const [credentialLabel, setCredentialLabel] = useState("");
  const [isPending, startTransition] = useTransition();
  const createFormRef = useRef<HTMLFormElement>(null);

  // ---------------------------------------------------------------------------
  // Create
  // ---------------------------------------------------------------------------

  function handleCreate(formData: FormData) {
    startTransition(async () => {
      try {
        const result = await createAssistantAction(formData);
        setCredentials({ clientId: result.clientId ?? "", clientSecret: result.clientSecret });
        setCredentialLabel(`@${result.username}`);
        // Optimistically add the new row (no reload needed)
        setAssistants((prev) => [
          ...prev,
          {
            id: result.id,
            username: result.username,
            email: result.email,
            clientId: result.clientId,
            userType: result.userType,
          },
        ]);
        createFormRef.current?.reset();
      } catch {
        toast.error("Could not create the assistant.");
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Delete
  // ---------------------------------------------------------------------------

  function handleDelete(id: string) {
    if (!window.confirm("Delete this assistant? This cannot be undone.")) return;
    startTransition(async () => {
      const fd = new FormData();
      fd.set("id", id);
      try {
        await deleteAssistantAction(fd);
        setAssistants((prev) => prev.filter((a) => a.id !== id));
      } catch {
        toast.error("Could not delete the assistant.");
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Rotate client
  // ---------------------------------------------------------------------------

  function handleRotate(id: string, username: string | null) {
    if (!window.confirm(`Rotate OAuth client for @${username ?? id}? The old credentials will stop working immediately.`)) return;
    startTransition(async () => {
      const fd = new FormData();
      fd.set("id", id);
      try {
        const result = await rotateAssistantClientAction(fd);
        setCredentials({ clientId: result.clientId, clientSecret: result.clientSecret });
        setCredentialLabel(`@${username ?? id} (rotated)`);
        // Update clientId in local state
        setAssistants((prev) =>
          prev.map((a) => (a.id === id ? { ...a, clientId: result.clientId } : a)),
        );
      } catch {
        toast.error("Could not rotate the OAuth client.");
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Webhook
  // ---------------------------------------------------------------------------

  function handleWebhook(formData: FormData) {
    startTransition(async () => {
      try {
        await setAssistantWebhookAction(formData);
      } catch {
        toast.error("Could not save the webhook URL.");
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex flex-col gap-6">
      {/* Create form */}
      <form ref={createFormRef} action={handleCreate} className="flex items-end gap-3">
        <Field className="w-56">
          <FieldLabel>Username</FieldLabel>
          <Input
            name="username"
            placeholder="e.g. claude-code"
            required
            autoComplete="off"
          />
        </Field>
        <Button type="submit" disabled={isPending}>
          {isPending ? "Creating..." : "Create assistant"}
        </Button>
      </form>

      {/* Table */}
      {assistants.length === 0 ? (
        <p className="text-sm text-muted-foreground">No assistant users registered yet.</p>
      ) : (
        <PaginatedTable>
          <TableHeader>
            <TableRow>
              <TableHead>Username</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Client ID</TableHead>
              <TableHead>Webhook</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {assistants.map((a) => (
              <TableRow key={a.id}>
                <TableCell className="font-medium text-foreground">@{a.username ?? a.id}</TableCell>
                <TableCell className="text-muted-foreground">{a.email ?? "—"}</TableCell>
                <TableCell>
                  <code className="rounded bg-surface-strong px-1.5 py-0.5 font-mono text-xs text-foreground">
                    {a.clientId ? `${a.clientId.slice(0, 8)}…` : "—"}
                  </code>
                </TableCell>
                <TableCell>
                  <form action={handleWebhook} className="flex items-center gap-2">
                    <input type="hidden" name="assistantUserId" value={a.id} />
                    <InputGroup className="w-52">
                      <InputGroupAddon>
                        <LinkIcon aria-hidden="true" />
                      </InputGroupAddon>
                      <InputGroupInput
                        name="webhookUrl"
                        type="url"
                        placeholder="https://..."
                        className="text-xs"
                        autoComplete="off"
                      />
                    </InputGroup>
                    <Input
                      name="webhookSecret"
                      type="password"
                      placeholder="Secret"
                      className="w-24 text-xs"
                      autoComplete="off"
                    />
                    <Button type="submit" variant="outline" size="sm" disabled={isPending}>
                      Save
                    </Button>
                  </form>
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={isPending}
                      onClick={() => handleRotate(a.id, a.username)}
                    >
                      Rotate
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={isPending}
                      onClick={() => handleDelete(a.id)}
                    >
                      Delete
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </PaginatedTable>
      )}

      {/* Credentials dialog — shown once after create or rotate */}
      <Dialog open={!!credentials} onOpenChange={(open) => { if (!open) setCredentials(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>OAuth credentials for {credentialLabel}</DialogTitle>
            <DialogDescription>
              Save these credentials now — the client secret will not be shown again.
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
              Use these with the OAuth client_credentials grant at{" "}
              <code className="font-mono">/api/auth/oauth/token</code> to obtain an access token for MCP calls.
            </p>
            <Button
              onClick={() => {
                if (credentials) {
                  void navigator.clipboard.writeText(
                    `CINATRA_MCP_CLIENT_ID=${credentials.clientId}\nCINATRA_MCP_CLIENT_SECRET=${credentials.clientSecret}`,
                  );
                }
              }}
              variant="outline"
            >
              Copy as env vars
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
