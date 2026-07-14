"use client";

/**
 * ExtensionInstallScopeDialog (cinatra#805).
 *
 * Pre-install access selector for the connector / artifact / workflow
 * marketplace install CTA — parity with the agent InstallScopeDialog
 * (packages/agents/src/components/install-scope-dialog.tsx): the SAME
 * AccessCombobox in installMode over the SAME server-computed InstallTarget
 * rows (org / team / project). Kept as a separate component because the two
 * flows have different submit contracts: the marketplace lifecycle action
 * returns a CLASSIFIED failure ({ ok:false, category, stage? } — production
 * masks thrown messages, cinatra#685) and redirect()s on success, while the
 * agent action throws/relies on message text. (Full dialog consolidation is a
 * follow-on; the server-side pieces — target rows, authz gates — are already
 * shared.)
 *
 * Auth contract (identical to the agent dialog):
 *  - `installTargets` is computed SERVER-SIDE via buildInstallTargetPickerContext.
 *    The picker's disabled rows are a UX affordance only; the security
 *    boundary is the server action's install-target-authz gate.
 *  - owner / admin / workspace AccessCombobox rows are hidden (installMode)
 *    and defensively rejected by the value→target adapter.
 *
 * Submit contract:
 *  - Success: the action redirect()s → NEXT_REDIRECT sentinel is re-thrown
 *    from the internal <form action> (the proven MarketplaceInstallForm
 *    idiom) so Next.js performs the navigation; a success toast fires first.
 *  - Failure: the returned { ok:false, category, stage? } maps to the
 *    non-technical copy (stage "access"/"access-partial" gets its own copy);
 *    the dialog stays open with an inline Alert.
 */

import { useState } from "react";
import { useFormStatus } from "react-dom";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { AccessCombobox } from "@/components/access-combobox";
import { toast } from "@/lib/cinatra-toast";
import type { InstallTarget } from "@cinatra-ai/agents/install-targets";
import { isRedirectError } from "./is-redirect-error";
import {
  installAccessStageFailureCopy,
  type MarketplaceFailureCategory,
  type MarketplaceInstallActionResult,
} from "./marketplace-failure-copy";

// Server-action prop type — the dialog accepts the action as a prop instead
// of importing it directly (importing "../actions" would pull server-only
// modules into the client bundle). The server component passes it down.
type ExtensionInstallAction = (input: {
  packageName: string;
  packageVersion: string;
  accessTarget: { level: "organization" | "team" | "project"; id: string };
}) => Promise<MarketplaceInstallActionResult | void>;

// ---------------------------------------------------------------------------
// Value → target adapter (same rules as the agent dialog's
// pickerValueToTarget). owner / admin / workspace are NOT install targets —
// the defensive guard returns null so a stray value cannot reach the server
// action with a malformed target.
// ---------------------------------------------------------------------------
function pickerValueToTarget(
  value: string,
  activeOrgId: string,
): { level: "organization" | "team" | "project"; id: string } | null {
  // Multi-scope W1: the picker now emits the id-carrying "org:<id>" token; the
  // bare "org" branch is kept as a defensive fallback (matchers still accept it).
  // An empty tail ("org:" / "team:" / "project:") is NOT a target — the guard
  // returns null so a stray value cannot reach the server action with an empty
  // id (matches the canonical adapter in auth-policy-types.ts).
  if (value.startsWith("org:")) {
    const id = value.slice("org:".length);
    return id ? { level: "organization", id } : null;
  }
  if (value === "org")
    return activeOrgId ? { level: "organization", id: activeOrgId } : null;
  if (value.startsWith("team:")) {
    const id = value.slice("team:".length);
    return id ? { level: "team", id } : null;
  }
  if (value.startsWith("project:")) {
    const id = value.slice("project:".length);
    return id ? { level: "project", id } : null;
  }
  return null;
}

export type ExtensionInstallScopeDialogProps = {
  packageName: string;
  packageVersion: string;
  /** Display name for dialog copy + toasts (falls back to packageName). */
  displayName: string;
  /** SERVER-COMPUTED — single source of truth for enabled/disabled state. */
  installTargets: InstallTarget[];
  /** value → display name lookup (e.g. "team:abc" → "Engineering"). */
  ownerEntityNames: Record<string, string>;
  activeOrgId: string;
  /** null → no installable scope; the dialog renders the empty-state Alert. */
  defaultValue: string | null;
  /** Per-category NON-technical failure copy (built server-side). */
  failureCopyByCategory: Record<MarketplaceFailureCategory, string>;
  /** Last-resort copy when the action throws / returns an unknown shape. */
  defaultFailureMessage: string;
  /** Server action passed by the server-component caller. */
  installAction: ExtensionInstallAction;
  triggerClassName?: string;
};

export function ExtensionInstallScopeDialog({
  packageName,
  packageVersion,
  displayName,
  installTargets,
  ownerEntityNames,
  activeOrgId,
  defaultValue,
  failureCopyByCategory,
  defaultFailureMessage,
  installAction,
  triggerClassName,
}: ExtensionInstallScopeDialogProps) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<string>(defaultValue ?? "");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const name = displayName || packageName;

  // Derive AccessCombobox props from installTargets (same shape as the agent
  // dialog). Workspace is gated off via installMode/workspaceExposed.
  const availableScopes = {
    teams: installTargets
      .filter((t) => t.level === "team")
      .map((t) => ({ id: t.id, name: ownerEntityNames[t.value] ?? t.label })),
    projects: installTargets
      .filter((t) => t.level === "project")
      .map((t) => ({ id: t.id, name: ownerEntityNames[t.value] ?? t.label })),
    // Multi-scope W1: ownerEntityNames is keyed by the id-carrying `org:<id>`
    // token (the bare "org" key was retired). Fall through to the empty string
    // so the combobox renders its own "Your organization" fallback ONLY when
    // the org genuinely has no name — no hardcoded "Organization".
    orgName: ownerEntityNames[`org:${activeOrgId}`] ?? "",
    orgId: activeOrgId,
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

  // Human-readable scope fragment for the success toast.
  const scopeLabelFor = (
    target: { level: "organization" | "team" | "project" },
    pickerValue: string,
  ): string => {
    const entityName = ownerEntityNames[pickerValue];
    if (target.level === "team") return entityName ? `team ${entityName}` : "team";
    if (target.level === "project") {
      return entityName ? `project ${entityName}` : "project";
    }
    return entityName ? `everyone in ${entityName}` : "your organization";
  };

  const failureMessageForResult = (
    result: MarketplaceInstallActionResult,
  ): string => {
    if (result.stage === "access" || result.stage === "access-partial") {
      return installAccessStageFailureCopy(result.stage, name);
    }
    return failureCopyByCategory[result.category] ?? defaultFailureMessage;
  };

  // Internal <form action> — the NEXT_REDIRECT sentinel is re-thrown so
  // Next.js performs the success navigation (MarketplaceInstallForm idiom).
  async function handleSubmit() {
    const target = pickerValueToTarget(value, activeOrgId);
    if (!target) {
      setErrorMessage(
        "Selected value is not a valid install target. Please pick organization, team, or project.",
      );
      return;
    }
    setErrorMessage(null);
    try {
      const result = await installAction({
        packageName,
        packageVersion,
        accessTarget: target,
      });
      if (result && result.ok === false) {
        setErrorMessage(failureMessageForResult(result));
      }
      // Success returns nothing (the action redirect()s, which throws below).
    } catch (error) {
      if (isRedirectError(error)) {
        // SUCCESS — toast, close, re-throw so Next.js navigates.
        toast.success(`Installed ${name} for ${scopeLabelFor(target, value)}`);
        setOpen(false);
        throw error;
      }
      // Unexpected THROWN failure (message masked in production) — show the
      // non-technical default instead of crashing.
      setErrorMessage(defaultFailureMessage);
    }
  }

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      // Reset transient state on close.
      setErrorMessage(null);
      setValue(defaultValue ?? "");
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" size="sm" className={triggerClassName}>
          Install now
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Install {name}</DialogTitle>
        </DialogHeader>

        {noInstallableScope ? (
          <div className="flex flex-col gap-3">
            <Alert variant="destructive">
              <AlertDescription>
                You need org admin, team admin, or project ownership to install extensions.
              </AlertDescription>
            </Alert>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <Label htmlFor="extension-install-scope-picker">
              Who can access this extension?
            </Label>
            <AccessCombobox
              id="extension-install-scope-picker"
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
          >
            Cancel
          </Button>
          {!noInstallableScope ? (
            <form action={handleSubmit}>
              <InstallSubmitButton disabled={!value} />
            </form>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Pending-aware submit — useFormStatus reads the enclosing <form> submission
// state (explicit text swap + disabled; the local shadcn Button has NO
// isLoading prop).
function InstallSubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={disabled || pending} aria-busy={pending || undefined}>
      {pending ? "Installing..." : "Install"}
    </Button>
  );
}
