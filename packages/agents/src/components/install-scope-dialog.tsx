"use client";

/**
 * InstallScopeDialog.
 *
 * Client-side wrapper that opens a Dialog containing the AccessCombobox,
 * lets the user pick an install target (org / team / project), and submits
 * to `installRegistryPackageAtScope`.
 *
 * Auth contract:
 *  - `installTargets` is computed SERVER-SIDE in screens.tsx via
 *    `buildInstallTargets`. The client never reads `actor.teamRoles` to
 *    decide enabled/disabled state. The picker's disabled rows are a UX
 *    affordance only; the actual security boundary is the server action's
 *    assertCanInstallAtTarget gate.
 *  - The picker hides "owner", "admin", "workspace" AccessCombobox rows
 *    (those exist for the permissions tab but are not package install
 *    targets). Implementation: we pass workspaceExposed: false, and the
 *    pickerValueToTarget adapter returns null for those three values as a
 *    defensive guard. (AccessCombobox still renders owner/admin rows by
 *    design — see "owner/admin/workspace excluded" note below.)
 *  - Loading uses an explicit text swap ("Install" → "Installing...") plus
 *    `disabled`. The local shadcn Button has NO `isLoading` prop; do not
 *    add one.
 */

import { useState } from "react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { AccessCombobox } from "@/components/access-combobox";
import { toast } from "@/lib/cinatra-toast";
import type { InstallTarget } from "../install-targets";

// Server-action prop type — the dialog accepts the action as a prop instead
// of importing it directly. Importing from "../actions" pulls "server-only"
// modules (bullmq, node:crypto, etc.) into the client bundle and breaks the
// Turbopack/webpack client compile. The server component (screens.tsx) passes
// the action down — Next.js handles the RSC boundary correctly.
type InstallScopeAction = (input: {
  packageName: string;
  packageVersion?: string;
  target: { level: "organization" | "team" | "project"; id: string };
}) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Value → target adapter.
//
// Maps the AccessCombobox value string to the {level, id} shape the server
// action expects. owner / admin / workspace are NOT package install targets —
// defensive guard returns null so a stray click cannot reach the server action
// with a malformed target.
// ---------------------------------------------------------------------------
function pickerValueToTarget(
  value: string,
  activeOrgId: string,
): { level: "organization" | "team" | "project"; id: string } | null {
  if (value === "org") return { level: "organization", id: activeOrgId };
  if (value.startsWith("team:")) {
    return { level: "team", id: value.slice("team:".length) };
  }
  if (value.startsWith("project:")) {
    return { level: "project", id: value.slice("project:".length) };
  }
  // owner / admin / workspace — not an install target. Defensive guard.
  return null;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type InstallScopeDialogProps = {
  packageName: string;
  packageVersion?: string;
  /** SERVER-COMPUTED — single source of truth for enabled/disabled state. */
  installTargets: InstallTarget[];
  /** value → display name lookup (e.g. "team:abc" → "Engineering"). */
  ownerEntityNames: Record<string, string>;
  currentProjectId?: string;
  activeOrgId: string;
  /** null → no installable scope; the dialog renders the empty-state Alert. */
  defaultValue: string | null;
  triggerLabel?: string;
  /** Server action passed by the server-component caller — keeps "../actions" out of the client bundle. */
  installAction: InstallScopeAction;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function InstallScopeDialog({
  packageName,
  packageVersion,
  installTargets,
  ownerEntityNames,
  activeOrgId,
  defaultValue,
  triggerLabel,
  installAction,
}: InstallScopeDialogProps) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<string>(defaultValue ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // -------------------------------------------------------------------------
  // Derive AccessCombobox props from installTargets. Workspace is explicitly
  // gated off; owner / admin rows exist in AccessCombobox by design but are
  // ignored by pickerValueToTarget (defensive guard returns null).
  // -------------------------------------------------------------------------
  const availableScopes = {
    teams: installTargets
      .filter((t) => t.level === "team")
      .map((t) => ({ id: t.id, name: ownerEntityNames[t.value] ?? t.label })),
    projects: installTargets
      .filter((t) => t.level === "project")
      .map((t) => ({ id: t.id, name: ownerEntityNames[t.value] ?? t.label })),
    orgName: ownerEntityNames["org"] ?? "Organization",
    workspaceExposed: false,
  };
  const disabledScopes = installTargets
    .filter((t) => t.disabled)
    .map((t) => t.value);
  const disabledReasons: Record<string, string> = Object.fromEntries(
    installTargets
      .filter((t) => t.disabled)
      .map((t) => [t.value, t.reason ?? "Not available"]),
  );

  const noInstallableScope = defaultValue === null;

  // -------------------------------------------------------------------------
  // Submit handler.
  // -------------------------------------------------------------------------
  const handleSubmit = async () => {
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const target = pickerValueToTarget(value, activeOrgId);
      if (!target) {
        setErrorMessage(
          "Selected value is not a valid install target. Please pick organization, team, or project.",
        );
        setSubmitting(false);
        return;
      }
      await installAction({
        packageName,
        packageVersion,
        target,
      });
      // Compose human-readable success toast — names from ownerEntityNames.
      const entityName = ownerEntityNames[value];
      const scopeLabel =
        target.level === "team"
          ? entityName
            ? `team ${entityName}`
            : "team"
          : target.level === "project"
            ? entityName
              ? `project ${entityName}`
              : "project"
            : entityName ?? "organization";
      toast.success(`Installed ${packageName} at ${scopeLabel}`);
      setOpen(false);
      setSubmitting(false);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Install failed. Please try again.";
      setErrorMessage(message);
      setSubmitting(false);
      // Dialog stays open on error.
    }
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      // Reset transient state on close.
      setErrorMessage(null);
      setSubmitting(false);
      setValue(defaultValue ?? "");
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button type="button">{triggerLabel ?? "Install"}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Install {packageName}</DialogTitle>
        </DialogHeader>

        {noInstallableScope ? (
          <div className="flex flex-col gap-3">
            <Alert variant="destructive">
              <AlertDescription>
                You need org admin, team admin, or project ownership to install registry packages.
              </AlertDescription>
            </Alert>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <Label htmlFor="install-scope-picker">
              Where should this agent be installed?
            </Label>
            <AccessCombobox
              id="install-scope-picker"
              value={value}
              onValueChange={setValue}
              availableScopes={availableScopes}
              isAdmin={false}
              disabledScopes={disabledScopes}
              disabledReasons={disabledReasons}
              // Hide owner / admin / workspace rows; only org / team:* /
              // project:* are valid install targets.
              installMode
            />
            <p className="text-sm text-muted-foreground">
              Targets you cannot install at are disabled.
            </p>
            {errorMessage ? (
              <Alert variant="destructive">
                <AlertDescription>{errorMessage}</AlertDescription>
              </Alert>
            ) : null}
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            type="button"
            onClick={() => handleOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          {!noInstallableScope ? (
            <Button
              type="button"
              onClick={handleSubmit}
              disabled={!value || submitting}
              aria-busy={submitting || undefined}
            >
              {submitting ? "Installing..." : "Install"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
