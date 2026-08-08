"use client";

/**
 * ExtensionInstallScopePanel (cinatra#2373) — the in-card install panel body.
 *
 * Design spec §I.1 ("The in-card install panel"): clicking Install now keeps
 * the card's header band (icon, name, byline) exactly as it was and replaces
 * only the BODY with this panel — the access-scope picker preselected to
 * `Workspace: All`, plus Cancel / Install now. There is NO popup on this path.
 *
 * Shape contract (issue #2373): this component receives the UNBOUND scoped
 * server action plus `packageName` / `packageVersion` and the SERVER-COMPUTED
 * picker context — the same shape the pre-install popup this replaced used to
 * receive (that component was deleted in cinatra#2374, once the §II detail
 * modal — its last consumer — became details-only by owner ruling).
 * Zero-argument BOUND actions stay where they always were: on the direct
 * agent/skill install forms, which have no access target and never mount this.
 *
 * Errors are a TOAST, never inline (spec §I.1: "a failed install neither
 * redraws the panel with an error state nor grows its height"). The same
 * classified copy is ALSO mirrored into a visually hidden `role="alert"` live
 * region inside the panel, so a screen-reader user is not left with a silent
 * failure. The classified no-raw-detail contract (#685/#1539) is unchanged:
 * the panel only ever renders the mapped category copy plus the opaque
 * diagnostic reference.
 *
 * Geometry: the panel's flex chain is `min-h-0` throughout and ONLY the middle
 * region scrolls, so the header band and the action row are fixed. The face's
 * own block size is the card's shared spec constant — see
 * `MarketplaceListingCardInstallFace`.
 */

import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { AccessCombobox, resolveFlatAccessOption } from "@/components/access-combobox";
import { toast } from "@/lib/cinatra-toast";
import type { InstallTarget } from "@cinatra-ai/agents/install-targets";
import { useCardFace, InstallPanelCancelButton } from "./card-face-switcher";
import { isRedirectError } from "./is-redirect-error";
import {
  pickerValueToInstallTarget,
  type InstallTargetLevel,
} from "./install-picker-target";
import type { InstallPanelAvailability } from "./install-panel-availability";
import {
  appendDiagnosticReference,
  installAccessStageFailureCopy,
  type MarketplaceFailureCategory,
  type MarketplaceInstallActionResult,
} from "./marketplace-failure-copy";

/**
 * The UNBOUND scoped install action. The server component passes the action
 * itself (importing "../actions" here would pull server-only modules into the
 * client bundle); the identifiers travel as arguments.
 */
export type ExtensionScopedInstallAction = (input: {
  packageName: string;
  packageVersion: string;
  accessTarget: { level: InstallTargetLevel; id: string };
}) => Promise<MarketplaceInstallActionResult | void>;

export type ExtensionInstallScopePanelProps = {
  packageName: string;
  packageVersion: string;
  /** Display name for panel copy + toasts (falls back to packageName). */
  displayName: string;
  /** SERVER-COMPUTED — single source of truth for enabled/disabled state. */
  installTargets: InstallTarget[];
  /** value → display name lookup (e.g. "team:abc" → "Engineering"). */
  ownerEntityNames: Record<string, string>;
  activeOrgId: string;
  /** Discriminated availability state, resolved server-side in fixed order. */
  availability: InstallPanelAvailability;
  /** Per-category NON-technical failure copy (built server-side). */
  failureCopyByCategory: Record<MarketplaceFailureCategory, string>;
  /** Last-resort copy when the action throws / returns an unknown shape. */
  defaultFailureMessage: string;
  installAction: ExtensionScopedInstallAction;
};

/**
 * Human-readable AUDIENCE fragment for the success toast. Workspace rows read
 * exactly as their dropdown rows do — the canonical audience vocabulary
 * (`Workspace: All` = every workspace user; `Workspace: Admins only` = admins).
 * Installer AUTHORITY copy is a different dimension and is not touched here.
 */
function audienceLabelFor(
  target: { level: InstallTargetLevel },
  pickerValue: string,
  ownerEntityNames: Record<string, string>,
): string {
  const entityName = ownerEntityNames[pickerValue];
  if (target.level === "workspace") return "Workspace: All";
  if (target.level === "admin") return "Workspace: Admins only";
  if (target.level === "team") return entityName ? `team ${entityName}` : "team";
  if (target.level === "project") {
    return entityName ? `project ${entityName}` : "project";
  }
  return entityName ? `everyone in ${entityName}` : "your organization";
}

export function ExtensionInstallScopePanel({
  packageName,
  packageVersion,
  displayName,
  installTargets,
  ownerEntityNames,
  activeOrgId,
  availability,
  failureCopyByCategory,
  defaultFailureMessage,
  installAction,
}: ExtensionInstallScopePanelProps) {
  const { idPrefix, closePanel } = useCardFace();
  const pickerId = `${idPrefix}-install-scope-picker`;
  const labelId = `${idPrefix}-install-scope-label`;
  const alertId = `${idPrefix}-install-scope-alert`;

  const ready = availability.state === "ready";
  const [value, setValue] = useState<string>(
    availability.state === "ready" ? availability.defaultValue : "",
  );
  /**
   * Mirrored (visually hidden) failure copy. NOT an inline error render — the
   * visible surface is the toast; this exists so the failure is ANNOUNCED.
   *
   * Carries a monotonic `seq` alongside the text so the alert node is KEYED by
   * it. Two identical consecutive failures produce identical text, and a
   * `role="alert"` whose text node never changes is never re-announced —
   * clearing-then-setting in one handler does not help, because React batches
   * both updates into a single commit and the empty state never reaches the
   * DOM. Bumping the key remounts the alert, which is the announcement.
   */
  const [live, setLive] = useState<{ seq: number; message: string }>({
    seq: 0,
    message: "",
  });

  const headingRef = useRef<HTMLDivElement | null>(null);

  const name = displayName || packageName;

  // Focus enters the panel on open: the first ENABLED control when there is
  // one (the picker), otherwise the panel heading, which is programmatically
  // focusable for exactly this reason. The panel only mounts while open, so a
  // mount-effect is the open event.
  useEffect(() => {
    const picker = ready ? document.getElementById(pickerId) : null;
    (picker ?? headingRef.current)?.focus();
    // Mount-only: the panel unmounts on close.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Derive AccessCombobox props from the SERVER-COMPUTED rows (same shape the
  // popup used) — a row can never appear without its server-decided
  // disabled/reason state.
  const availableScopes = {
    teams: installTargets
      .filter((t) => t.level === "team")
      .map((t) => ({ id: t.id, name: ownerEntityNames[t.value] ?? t.label })),
    projects: installTargets
      .filter((t) => t.level === "project")
      .map((t) => ({ id: t.id, name: ownerEntityNames[t.value] ?? t.label })),
    orgName: ownerEntityNames[`org:${activeOrgId}`] ?? "",
    orgId: activeOrgId,
    workspaceExposed: false,
  };
  const installWorkspaceScopes = installTargets.some(
    (t) => t.level === "workspace" || t.level === "admin",
  );
  const disabledScopes = installTargets
    .filter((t) => t.disabled)
    .map((t) => t.value);
  const disabledReasons: Record<string, string> = Object.fromEntries(
    installTargets
      .filter((t) => t.disabled)
      .map((t) => [t.value, t.reason ?? "Not available"]),
  );

  // Committability (cinatra#2372): the ONE gate every single-mode install
  // consumer reads instead of bare value-truthiness. This panel is the newest
  // such consumer — it landed (cinatra#2373) while the model was parked, so it
  // shipped with a `!value` gate; the model supersedes that here, exactly as it
  // does in both install dialogs. Synthetic/degenerate rows (a mismatched or
  // empty-tail org token, an unhydrated team/project id) and any
  // server-disabled target are never committable. The context mirrors the
  // AccessCombobox props below so the gate and the rendered rows can never
  // disagree about what is offered.
  const selectedOption = resolveFlatAccessOption(value, availableScopes, {
    disabledScopes,
    ownerOffered: false,
    workspaceOffered: installWorkspaceScopes,
    adminOffered: installWorkspaceScopes,
  });

  const failureMessageForResult = (
    result: MarketplaceInstallActionResult,
  ): string => {
    if (
      result.stage === "access" ||
      result.stage === "access-partial" ||
      result.stage === "access-required"
    ) {
      return installAccessStageFailureCopy(result.stage, name);
    }
    return appendDiagnosticReference(
      failureCopyByCategory[result.category] ?? defaultFailureMessage,
      result.reference,
    );
  };

  /** Toast + announce. The panel STAYS open and keeps the selection. */
  const reportFailure = (message: string) => {
    toast.error(message);
    setLive((prev) => ({ seq: prev.seq + 1, message }));
  };

  async function handleSubmit() {
    // Defense in depth: `ready` gates the submit control's existence, the
    // committability gate rejects synthetic/degenerate and server-disabled
    // selections, and the adapter fails closed on any value that is not a real
    // target.
    if (!ready) return;
    const target = pickerValueToInstallTarget(value, activeOrgId);
    if (!target || !selectedOption.committable) {
      reportFailure(
        "Pick who can access this extension before installing — the current selection is not an installable audience.",
      );
      return;
    }
    try {
      const result = await installAction({
        packageName,
        packageVersion,
        accessTarget: target,
      });
      if (result && result.ok === false) {
        reportFailure(failureMessageForResult(result));
      }
      // Success returns nothing (the action redirect()s, which throws below).
    } catch (error) {
      if (isRedirectError(error)) {
        // SUCCESS — toast, return the card to idle, re-throw so Next navigates.
        toast.success(
          `Installed ${name} for ${audienceLabelFor(target, value, ownerEntityNames)}`,
        );
        closePanel();
        throw error;
      }
      // Unexpected THROWN failure (message masked in production).
      reportFailure(defaultFailureMessage);
    }
  }

  return (
    <div
      data-testid="extension-install-panel-body"
      data-availability={availability.state}
      role="group"
      aria-labelledby={labelId}
      className="flex min-h-0 flex-1 flex-col gap-2.5"
    >
      {/* Fixed panel heading (spec §I.1: the mono "Install for" eyebrow). */}
      <div
        id={labelId}
        ref={headingRef}
        tabIndex={-1}
        className="flex-none font-mono text-badge-xs font-bold tracking-wider uppercase text-muted-foreground outline-none"
      >
        {ready ? (
          <Label htmlFor={pickerId} className="cursor-default text-inherit">
            Install for
          </Label>
        ) : (
          "Install for"
        )}
      </div>

      {/* ONLY the middle region scrolls; the heading above and the action row
          below stay fixed, so the face never grows past the card's box. The
          picker's popover is PORTALLED, so it is never clipped by this. */}
      <div className="flex min-h-0 flex-1 flex-col justify-center overflow-y-auto">
        {availability.state === "no-active-organization" ? (
          // Names the ACTUAL problem — a session without an active
          // organization has no audience to install for, whatever the
          // viewer's roles are. No picker, no submit, action not invocable.
          <p className="text-sm text-muted-foreground">
            Installing needs an active organization. Switch to one of your
            organizations, then install {name}.
          </p>
        ) : availability.state === "no-installable-scope" ? (
          // Existing role-oriented empty state — copy unchanged.
          <Alert variant="destructive">
            <AlertDescription>
              You need org admin, team admin, or project ownership to install
              extensions.
            </AlertDescription>
          </Alert>
        ) : (
          // Stable picker hook on a wrapper (the shared AccessCombobox owns its
          // own prop contract and does not spread unknown attributes).
          <div data-testid="extension-install-panel-picker">
            <AccessCombobox
              id={pickerId}
              value={value}
              onValueChange={setValue}
              availableScopes={availableScopes}
              isAdmin={false}
              disabledScopes={disabledScopes}
              disabledReasons={disabledReasons}
              // Hide the "owner" row (not an install target). The two workspace
              // AUDIENCE rows are offered with their server-decided state.
              installMode
              installWorkspaceScopes={installWorkspaceScopes}
            />
          </div>
        )}
      </div>

      {/* Visually hidden failure mirror. The VISIBLE failure surface is the
          toast; this only announces the SAME safe copy. */}
      <span
        // Keyed by the announcement sequence: a repeat of the SAME failure
        // remounts this node, so a screen reader re-reads it.
        key={live.seq}
        id={alertId}
        role="alert"
        data-testid="extension-install-panel-error"
        className="sr-only"
      >
        {live.message}
      </span>

      {/* Fixed action row (spec §I.1: Cancel / Install now, right-aligned). */}
      <form action={handleSubmit} className="flex flex-none justify-end gap-2">
        <InstallPanelCancelButton />
        {ready ? <InstallPanelSubmitButton disabled={!selectedOption.committable} /> : null}
      </form>
    </div>
  );
}

/**
 * Pending-aware submit — `useFormStatus` reads the enclosing <form>, so the
 * "Installing…" busy label lives on the panel's own action row.
 */
function InstallPanelSubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      size="sm"
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      data-testid="extension-install-panel-submit"
      data-pending={pending ? "" : undefined}
      className="disabled:opacity-70"
    >
      {pending ? "Installing…" : "Install now"}
    </Button>
  );
}
