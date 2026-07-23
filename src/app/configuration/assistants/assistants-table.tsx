"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PencilIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { AccessCombobox, type AvailableScopes } from "@/components/access-combobox";
import type { AssistantAdminRow } from "@/lib/assistant-admin-registry";
import { toast } from "@/lib/cinatra-toast";
import {
  renameAssistantTagAction,
  setAssistantAudienceAction,
  pauseAssistantAction,
  resumeAssistantAction,
  deleteAssistantAction,
  type AssistantActionResult,
} from "./actions";

// ---------------------------------------------------------------------------
// Owner ruling 2026-07-23 (groganz): this surface shows ONE mutable tag per
// assistant (the resolving handle — editable inline, no lock, built-in included),
// the audience as the shipped access picker, and NO metadata badges / delivery
// endpoint config. Collisions and failures surface as TOASTS.
// ---------------------------------------------------------------------------

/** Map the persisted audience grants → access-picker scope tokens (the value the
 *  multi-select `AccessCombobox` renders). Grants with no picker token (none, in
 *  the current vocabulary) are dropped. */
function audienceToTokens(
  audience: ReadonlyArray<{ subjectKind: string; subjectId: string | null }>,
): string[] {
  const out: string[] = [];
  for (const g of audience) {
    if (g.subjectKind === "workspace") out.push("workspace");
    else if (g.subjectKind === "admin") out.push("admin");
    else if (g.subjectKind === "organization" && g.subjectId) out.push(`org:${g.subjectId}`);
    else if (g.subjectKind === "team" && g.subjectId) out.push(`team:${g.subjectId}`);
    else if (g.subjectKind === "project" && g.subjectId) out.push(`project:${g.subjectId}`);
  }
  return out;
}

/** Do any of the selected picker tokens map to a real audience grant? (`owner` /
 *  a bare `org` do not.) An assistant with no effective grant is visible to no
 *  one — the editor surfaces that as a warning. */
function hasEffectiveAudience(tokens: readonly string[]): boolean {
  return tokens.some(
    (t) =>
      t === "workspace" ||
      t === "admin" ||
      t.startsWith("org:") ||
      t.startsWith("team:") ||
      t.startsWith("project:"),
  );
}

// ---------------------------------------------------------------------------
// Top-level surface
// ---------------------------------------------------------------------------

export function AssistantsTable({
  rows,
  availableScopes,
}: {
  rows: AssistantAdminRow[];
  availableScopes: AvailableScopes;
}) {
  return (
    <div className="flex flex-col gap-4">
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No assistants registered yet.</p>
      ) : (
        rows.map((row) => (
          <AssistantCard key={row.assistantUserId} row={row} availableScopes={availableScopes} />
        ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-assistant card
// ---------------------------------------------------------------------------

function AssistantCard({
  row,
  availableScopes,
}: {
  row: AssistantAdminRow;
  availableScopes: AvailableScopes;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // The single editable tag (the resolving handle) — inline edit.
  const [editingTag, setEditingTag] = useState(false);
  const [tagValue, setTagValue] = useState(row.handle ?? "");

  // The RESOLVING tag is the registry handle — NEVER the raw Better-Auth
  // username. When a principal has no registered handle (a degenerate/partial
  // registration) there is no resolving tag to show or edit, so the chip renders
  // a neutral placeholder. `label` is a human identifier for confirm dialogs only.
  const resolvingTag = row.handle ? `@${row.handle}` : null;
  const label = resolvingTag ?? row.displayName;
  const deletable = !row.isBuiltin && !row.isExtensionOwned;
  // The audience is enforced only for an INSTALLED, non-builtin assistant (the
  // reader audience-filters installed extensions); the builtin is always visible
  // to everyone, and a standalone principal with no install row has no enforced
  // audience.
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

  function submitTag() {
    setEditingTag(false);
    run(
      () => renameAssistantTagAction({ assistantUserId: row.assistantUserId, tag: tagValue }),
      (msg) => toast.error(msg),
    );
  }

  return (
    <section className="rounded-card border border-line bg-surface-strong/40 p-5">
      {/* Header ---------------------------------------------------------- */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-base font-semibold text-foreground">{row.displayName}</span>
            {/* The ONE editable tag (the resolving handle). No lock; editable for
                every assistant, built-in included. */}
            {editingTag ? (
              <form
                className="flex items-center gap-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  submitTag();
                }}
              >
                <span className="font-mono text-xs text-muted-foreground">@</span>
                <Input
                  autoFocus
                  value={tagValue}
                  onChange={(e) => setTagValue(e.target.value)}
                  className="h-6 w-32 text-xs"
                  aria-label="Edit tag"
                />
                <Button type="submit" size="sm" variant="outline" disabled={isPending || !tagValue.trim()}>
                  Save
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={isPending}
                  onClick={() => {
                    setEditingTag(false);
                    setTagValue(row.handle ?? "");
                  }}
                >
                  Cancel
                </Button>
              </form>
            ) : resolvingTag ? (
              <span className="flex items-center gap-1">
                <code className="rounded bg-surface-strong px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                  {resolvingTag}
                </code>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Edit tag"
                  className="size-5 opacity-60 hover:opacity-100"
                  disabled={isPending}
                  onClick={() => {
                    setTagValue(row.handle ?? "");
                    setEditingTag(true);
                  }}
                >
                  <PencilIcon className="size-3" />
                </Button>
              </span>
            ) : (
              <span className="text-xs italic text-muted-foreground">no resolving tag</span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            The tag people @-mention this assistant by — e.g. @wordpress. Change it any time.
          </p>
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

      {/* Access (audience) — the shipped access picker, per assistant --------- */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Access
          </span>
          <span className="text-xs text-muted-foreground">— who can see and use this assistant</span>
        </div>
        {row.isBuiltin ? (
          <p className="text-xs text-muted-foreground">
            The built-in Cinatra assistant is available to everyone.
          </p>
        ) : canEditAudience ? (
          <AssistantAccessControl row={row} availableScopes={availableScopes} />
        ) : (
          <p className="text-xs text-muted-foreground">
            Audience is managed where this assistant is installed.
          </p>
        )}
      </div>

      <Separator className="my-4" />

      {/* Lifecycle — delete only (no delivery/endpoint config on this page). --- */}
      <div className="flex justify-end">
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
    </section>
  );
}

// ---------------------------------------------------------------------------
// Per-assistant audience editor — the shipped `AccessCombobox` (multiple mode),
// mirroring the extension "Who can access this?" control. The selected scope
// tokens are reconciled onto the assistant's audience grants by
// `setAssistantAudienceAction`. Failures surface as TOASTS.
// ---------------------------------------------------------------------------

function AssistantAccessControl({
  row,
  availableScopes,
}: {
  row: AssistantAdminRow;
  availableScopes: AvailableScopes;
}) {
  const router = useRouter();
  const initial = audienceToTokens(row.audience);
  const [value, setValue] = useState<string[]>(initial);
  const [pending, startSave] = useTransition();

  // Order-insensitive dirty check.
  const dirty = [...value].sort().join(" ") !== [...initial].sort().join(" ");

  return (
    <div className="flex flex-col gap-2">
      <AccessCombobox
        selectionMode="multiple"
        id={`audience-${row.assistantUserId}`}
        value={value}
        onChange={setValue}
        scopes={availableScopes}
      />
      {!hasEffectiveAudience(value) && (
        <p className="text-xs text-warning">No audience selected — visible to no one.</p>
      )}
      {dirty && (
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() =>
              startSave(async () => {
                const res = await setAssistantAudienceAction({
                  packageName: row.packageName ?? "",
                  tokens: value,
                });
                if (res.ok) {
                  toast.success("Access updated.");
                  router.refresh();
                } else {
                  toast.error(res.error);
                }
              })
            }
          >
            {pending ? "Saving…" : "Save access"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => setValue(initial)}
          >
            Reset
          </Button>
        </div>
      )}
    </div>
  );
}
