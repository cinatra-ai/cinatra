"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LinkIcon, PencilIcon, XIcon, LockIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { NativeSelect } from "@/components/ui/native-select";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import type { AssistantAdminRow, AssistantPreferredTagState } from "@/lib/assistant-admin-registry";
import { toast } from "@/lib/cinatra-toast";
import {
  addAssistantAliasAction,
  renameAssistantAliasAction,
  removeAssistantAliasAction,
  addAssistantAudienceAction,
  removeAssistantAudienceAction,
  pauseAssistantAction,
  resumeAssistantAction,
  deleteAssistantAction,
  rotateAssistantClientAction,
  setAssistantWebhookAction,
  type AssistantActionResult,
} from "./actions";

// ---------------------------------------------------------------------------
// The audience subject kinds (mirrors ASSISTANT_AUDIENCE_SUBJECT_KINDS). The two
// GLOBAL kinds carry no subject id; the three SCOPED kinds require one.
// ---------------------------------------------------------------------------
const AUDIENCE_KINDS = ["workspace", "admin", "organization", "team", "project"] as const;
const SCOPED_KINDS = new Set(["organization", "team", "project"]);

type CredentialResult = { clientId: string; clientSecret: string };

// ---------------------------------------------------------------------------
// Top-level surface
// ---------------------------------------------------------------------------

export function AssistantsTable({ rows }: { rows: AssistantAdminRow[] }) {
  const [credentials, setCredentials] = useState<CredentialResult | null>(null);
  const [credentialLabel, setCredentialLabel] = useState("");

  return (
    <div className="flex flex-col gap-4">
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No assistants registered yet.</p>
      ) : (
        rows.map((row) => (
          <AssistantCard
            key={row.assistantUserId}
            row={row}
            onCredentials={(c, label) => {
              setCredentials(c);
              setCredentialLabel(label);
            }}
          />
        ))
      )}

      <CredentialsDialog
        credentials={credentials}
        label={credentialLabel}
        onClose={() => setCredentials(null)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-assistant card
// ---------------------------------------------------------------------------

function AssistantCard({
  row,
  onCredentials,
}: {
  row: AssistantAdminRow;
  onCredentials: (c: CredentialResult, label: string) => void;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // Editable-alias flow
  const [newAlias, setNewAlias] = useState("");
  const [aliasError, setAliasError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // Audience flow
  const [audienceKind, setAudienceKind] = useState<string>("workspace");
  const [audienceId, setAudienceId] = useState("");
  const [audienceError, setAudienceError] = useState<string | null>(null);

  // AC#5: the RESOLVING tag is the registry handle — NEVER the raw Better-Auth
  // username (that WAS the bug). When a principal has no registered handle (a
  // degenerate/partial registration) there is no resolving tag to show, so the
  // chip renders a neutral placeholder rather than masquerading a username as a
  // tag. `label` is a human identifier for confirm dialogs only (not a tag claim).
  const resolvingTag = row.handle ? `@${row.handle}` : null;
  const label = resolvingTag ?? row.displayName;
  const deletable = !row.isBuiltin && !row.isExtensionOwned;
  const canEditAliases = !!row.packageName;
  const canEditAudience = !!row.packageName && !row.isBuiltin && row.installStatus !== null;

  function run(fn: () => Promise<AssistantActionResult>, onErr: (msg: string) => void) {
    startTransition(async () => {
      try {
        const res = await fn();
        if (res.ok) {
          router.refresh();
        } else {
          onErr(res.error);
        }
      } catch {
        onErr("Something went wrong. Please try again.");
      }
    });
  }

  return (
    <section className="rounded-card border border-line bg-surface-strong/40 p-5">
      {/* Header ---------------------------------------------------------- */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-base font-semibold text-foreground">{row.displayName}</span>
            {/* AC#5: the RESOLVING tag (handle), not the raw username. */}
            {resolvingTag ? (
              <code className="rounded bg-surface-strong px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                {resolvingTag}
              </code>
            ) : (
              <span className="text-xs italic text-muted-foreground">no resolving tag</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <InstallStatusBadge status={row.installStatus} isBuiltin={row.isBuiltin} />
            <OriginBadge origin={row.origin} isBuiltin={row.isBuiltin} />
            <LaunchBadge launchKind={row.launchKind} instanceCount={row.instanceCount} />
            <DeliveryBadge
              delivery={row.delivery}
              ready={row.deliveryReady}
              webhookConfigured={row.webhookConfigured}
            />
            <PreferredTagBadge state={row.preferredTagState} preferredTag={row.preferredTag} />
            {row.paused && <Badge variant="destructive">Paused</Badge>}
          </div>
        </div>

        {/* Pause control — installation-wide, principal-keyed. */}
        <div className="flex items-center gap-2">
          <Label htmlFor={`pause-${row.assistantUserId}`} className="text-xs text-muted-foreground">
            {row.paused ? "Paused" : "Active"}
          </Label>
          <Switch
            id={`pause-${row.assistantUserId}`}
            checked={!row.paused}
            disabled={isPending || row.isBuiltin}
            aria-label={row.paused ? "Resume assistant" : "Pause assistant"}
            onCheckedChange={(next) => {
              // checked === "active" ⇒ NOT paused. Toggling off pauses.
              const fn = next
                ? () => resumeAssistantAction({ assistantUserId: row.assistantUserId })
                : () => pauseAssistantAction({ assistantUserId: row.assistantUserId });
              run(fn, (msg) => toast.error(msg));
            }}
          />
        </div>
      </div>

      <Separator className="my-4" />

      {/* Tags (aliases) editor — AC#1 --------------------------------------- */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Tags</span>
          <span className="text-xs text-muted-foreground">— @-mention aliases (platform-global)</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {/* The canonical tag is immutable. */}
          <Badge variant="secondary" className="gap-1">
            <LockIcon aria-hidden="true" className="size-3" />
            {row.handle ?? "—"}
          </Badge>
          {row.aliases.map((a) =>
            renaming === a.alias ? (
              <form
                key={a.alias}
                className="flex items-center gap-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  setAliasError(null);
                  run(
                    () =>
                      renameAssistantAliasAction({
                        packageName: row.packageName ?? "",
                        oldAlias: a.alias,
                        newAlias: renameValue,
                      }),
                    (msg) => setAliasError(msg),
                  );
                  setRenaming(null);
                }}
              >
                <Input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  className="h-6 w-28 text-xs"
                  aria-label={`Rename tag ${a.alias}`}
                />
                <Button type="submit" size="sm" variant="outline" disabled={isPending}>
                  Save
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setRenaming(null)}
                  disabled={isPending}
                >
                  Cancel
                </Button>
              </form>
            ) : (
              <Badge key={a.alias} variant={a.source === "builtin" ? "secondary" : "outline"} className="gap-1">
                {a.source === "builtin" && <LockIcon aria-hidden="true" className="size-3" />}
                {a.alias}
                {a.source !== "builtin" && (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Rename tag ${a.alias}`}
                      className="size-4 ml-0.5 opacity-60 hover:opacity-100"
                      disabled={isPending}
                      onClick={() => {
                        setRenaming(a.alias);
                        setRenameValue(a.alias);
                        setAliasError(null);
                      }}
                    >
                      <PencilIcon className="size-3" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Remove tag ${a.alias}`}
                      className="size-4 opacity-60 hover:opacity-100"
                      disabled={isPending}
                      onClick={() =>
                        run(
                          () =>
                            removeAssistantAliasAction({
                              alias: a.alias,
                              source: a.source,
                              packageName: row.packageName ?? "",
                            }),
                          (msg) => setAliasError(msg),
                        )
                      }
                    >
                      <XIcon className="size-3" />
                    </Button>
                  </>
                )}
              </Badge>
            ),
          )}
          {canEditAliases && (
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                setAliasError(null);
                run(
                  () => addAssistantAliasAction({ packageName: row.packageName ?? "", alias: newAlias }),
                  (msg) => setAliasError(msg),
                );
                setNewAlias("");
              }}
            >
              <Input
                value={newAlias}
                onChange={(e) => setNewAlias(e.target.value)}
                placeholder="add tag"
                className="h-6 w-24 text-xs"
                aria-label="Add tag"
              />
              <Button type="submit" size="sm" variant="outline" disabled={isPending || !newAlias.trim()}>
                <PlusIcon className="size-3" />
                Add
              </Button>
            </form>
          )}
        </div>
        {aliasError && <p className="text-xs text-destructive">{aliasError}</p>}
      </div>

      {/* Audience editor — AC#2 -------------------------------------------- */}
      {row.isBuiltin ? (
        <>
          <Separator className="my-4" />
          <p className="text-xs text-muted-foreground">
            <span className="font-semibold uppercase tracking-wide">Audience</span> — the platform
            assistant is always available to everyone.
          </p>
        </>
      ) : canEditAudience ? (
        <>
          <Separator className="my-4" />
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Audience
              </span>
              <span className="text-xs text-muted-foreground">— who may use this assistant</span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {row.audience.length === 0 && (
                <span className="text-xs text-warning">No audience — visible to no one.</span>
              )}
              {row.audience.map((g) => (
                <Badge key={`${g.subjectKind}:${g.subjectId ?? ""}`} variant="info" className="gap-1">
                  {g.subjectKind}
                  {g.subjectId ? `:${g.subjectId}` : ""}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove ${g.subjectKind} grant`}
                    className="size-4 opacity-60 hover:opacity-100"
                    disabled={isPending}
                    onClick={() =>
                      run(
                        () =>
                          removeAssistantAudienceAction({
                            packageName: row.packageName ?? "",
                            subjectKind: g.subjectKind,
                            subjectId: g.subjectId,
                          }),
                        (msg) => setAudienceError(msg),
                      )
                    }
                  >
                    <XIcon className="size-3" />
                  </Button>
                </Badge>
              ))}
            </div>
            <form
              className="flex flex-wrap items-center gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                setAudienceError(null);
                run(
                  () =>
                    addAssistantAudienceAction({
                      packageName: row.packageName ?? "",
                      subjectKind: audienceKind,
                      subjectId: SCOPED_KINDS.has(audienceKind) ? audienceId : null,
                    }),
                  (msg) => setAudienceError(msg),
                );
                setAudienceId("");
              }}
            >
              <NativeSelect
                value={audienceKind}
                onChange={(e) => setAudienceKind(e.target.value)}
                aria-label="Audience subject kind"
                className="h-7 rounded-control border border-line bg-surface px-2 text-xs"
              >
                {AUDIENCE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </NativeSelect>
              {SCOPED_KINDS.has(audienceKind) && (
                <Input
                  value={audienceId}
                  onChange={(e) => setAudienceId(e.target.value)}
                  placeholder={`${audienceKind} id`}
                  className="h-7 w-40 text-xs"
                  aria-label={`${audienceKind} id`}
                />
              )}
              <Button
                type="submit"
                size="sm"
                variant="outline"
                disabled={isPending || (SCOPED_KINDS.has(audienceKind) && !audienceId.trim())}
              >
                <PlusIcon className="size-3" />
                Grant
              </Button>
            </form>
            {audienceError && <p className="text-xs text-destructive">{audienceError}</p>}
          </div>
        </>
      ) : null}

      <Separator className="my-4" />

      {/* Delivery / credentials / lifecycle -------------------------------- */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <form action={setAssistantWebhookAction} className="flex items-center gap-2">
          <Input type="hidden" name="assistantUserId" value={row.assistantUserId} />
          <InputGroup className="w-52">
            <InputGroupAddon>
              <LinkIcon aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              name="webhookUrl"
              type="url"
              placeholder="https://... (delivery webhook)"
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

        <div className="flex items-center gap-2">
          <code className="rounded bg-surface-strong px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
            {row.clientId ? `${row.clientId.slice(0, 8)}…` : "—"}
          </code>
          <Button
            variant="outline"
            size="sm"
            disabled={isPending}
            onClick={() => {
              if (
                !window.confirm(
                  `Rotate OAuth client for ${label}? The old credentials will stop working immediately.`,
                )
              )
                return;
              startTransition(async () => {
                const fd = new FormData();
                fd.set("id", row.assistantUserId);
                try {
                  const result = await rotateAssistantClientAction(fd);
                  onCredentials(result, `${label} (rotated)`);
                  router.refresh();
                } catch {
                  toast.error("Could not rotate the OAuth client.");
                }
              });
            }}
          >
            Rotate
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={isPending || !deletable}
            title={
              deletable
                ? undefined
                : row.isBuiltin
                  ? "The built-in Cinatra assistant cannot be deleted."
                  : "Owned by an installed extension — uninstall the package to remove it."
            }
            onClick={() => {
              if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return;
              run(
                () => deleteAssistantAction({ id: row.assistantUserId }),
                (msg) => toast.error(msg),
              );
            }}
          >
            Delete
          </Button>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

function InstallStatusBadge({ status, isBuiltin }: { status: string | null; isBuiltin: boolean }) {
  if (isBuiltin) return <Badge variant="info">built-in</Badge>;
  if (status === "active") return <Badge variant="success">installed</Badge>;
  if (status === "locked") return <Badge variant="warning">locked</Badge>;
  if (status === "archived") return <Badge variant="secondary">archived</Badge>;
  return <Badge variant="secondary">standalone</Badge>;
}

function OriginBadge({ origin, isBuiltin }: { origin: string | null; isBuiltin: boolean }) {
  if (isBuiltin) return null;
  if (origin === "extension") return <Badge variant="outline">extension-owned</Badge>;
  return <Badge variant="outline">standalone</Badge>;
}

function LaunchBadge({
  launchKind,
  instanceCount,
}: {
  launchKind: string | null;
  instanceCount: number | null;
}) {
  if (!launchKind) return null;
  const label =
    launchKind === "remote" && instanceCount !== null
      ? `remote · ${instanceCount} ${instanceCount === 1 ? "instance" : "instances"}`
      : launchKind;
  return <Badge variant="outline">{label}</Badge>;
}

function DeliveryBadge({
  delivery,
  ready,
  webhookConfigured,
}: {
  delivery: string;
  ready: boolean;
  webhookConfigured: boolean;
}) {
  if (delivery === "webhook" && !ready) {
    return <Badge variant="warning">delivery: webhook — not ready (webhook missing)</Badge>;
  }
  if (delivery === "webhook" && webhookConfigured) {
    return <Badge variant="outline">delivery: webhook</Badge>;
  }
  return <Badge variant="outline">delivery: {delivery}</Badge>;
}

function PreferredTagBadge({
  state,
  preferredTag,
}: {
  state: AssistantPreferredTagState;
  preferredTag: string | null;
}) {
  if (state === "collision" && preferredTag) {
    return <Badge variant="warning">preferred @{preferredTag} — unclaimed (collision)</Badge>;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Credentials dialog (shown once after rotate)
// ---------------------------------------------------------------------------

function CredentialsDialog({
  credentials,
  label,
  onClose,
}: {
  credentials: CredentialResult | null;
  label: string;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!credentials} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>OAuth credentials for {label}</DialogTitle>
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
  );
}
