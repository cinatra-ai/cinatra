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

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  InstallScopePickerBody,
  installAudienceLabel,
  resolveInstallScopeSelection,
} from "./install-scope-field";
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
  buildMarketplaceFailureCopy,
  installAccessStageFailureCopy,
  type MarketplaceInstallActionResult,
  marketplaceFailureCopy,
  type MarketplaceInstallFailureResult,
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

/**
 * The CARD-INVARIANT half of the panel's inputs (cinatra#2539).
 *
 * The picker rows, the entity-name lookup, the active org and the availability
 * verdict are ONE server computation for the whole grid — they do not vary by
 * card — and the install action is a single unbound reference. Every card used
 * to carry its own copy of all five as props, so the browse route's RSC payload
 * repeated the same ~1.4 KiB once per install-capable card (measured: 61.9 KiB
 * of an 88-card catalog's 742.7 KiB). They travel ONCE through this context
 * instead. The values are unchanged, so every rendered row, its enabled state
 * and its tooltip are identical.
 */
export type InstallPanelScopeContextValue = {
  /** SERVER-COMPUTED — single source of truth for enabled/disabled state. */
  installTargets: InstallTarget[];
  /** value → display name lookup (e.g. "team:abc" → "Engineering"). */
  ownerEntityNames: Record<string, string>;
  activeOrgId: string;
  /** Discriminated availability state, resolved server-side in fixed order. */
  availability: InstallPanelAvailability;
  installAction: ExtensionScopedInstallAction;
};

const InstallPanelScopeContext = createContext<InstallPanelScopeContextValue | null>(null);

/**
 * Publishes the card-invariant install context to every panel below it. The
 * provider renders NO DOM of its own — it is a serialization boundary, not a
 * layout element.
 */
export function InstallPanelScopeProvider({
  value,
  children,
}: {
  value: InstallPanelScopeContextValue;
  children: ReactNode;
}) {
  return (
    <InstallPanelScopeContext.Provider value={value}>{children}</InstallPanelScopeContext.Provider>
  );
}

export function useInstallPanelScope(): InstallPanelScopeContextValue {
  const ctx = useContext(InstallPanelScopeContext);
  if (!ctx) {
    throw new Error(
      "useInstallPanelScope must be used inside an <InstallPanelScopeProvider> — the install panel reads its picker rows, availability and install action from the grid-level context.",
    );
  }
  return ctx;
}

export type ExtensionInstallScopePanelProps = {
  packageName: string;
  packageVersion: string;
  /** Display name for panel copy + toasts (falls back to packageName). */
  displayName: string;
};

export function ExtensionInstallScopePanel({
  packageName,
  packageVersion,
  displayName,
}: ExtensionInstallScopePanelProps) {
  const { installTargets, ownerEntityNames, activeOrgId, availability, installAction } =
    useInstallPanelScope();
  // The classified copy is a PURE function of the failure taxonomy and this
  // card's display name (#685/#1539). Building it here produces the identical
  // strings the server used to build and ship per card — the copy contract is
  // unchanged; only its ~1 KiB-per-card place in the payload is gone.
  const failureCopyByCategory = buildMarketplaceFailureCopy("install", displayName);
  const defaultFailureMessage = marketplaceFailureCopy("unrecoverable", "install", displayName);
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

  // The picker's props and the committability gate come from the SHARED field
  // (./install-scope-field), which the Upload screen mounts too — one
  // derivation of "which rows exist, which are disabled, which selection may be
  // submitted", not two that agree until one of them changes.
  const selection = resolveInstallScopeSelection(
    { installTargets, ownerEntityNames, activeOrgId },
    value,
  );

  const failureMessageForResult = (
    result: MarketplaceInstallFailureResult,
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
    if (!target || !selection.committable) {
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
          `Installed ${name} for ${installAudienceLabel(target, value, ownerEntityNames)}`,
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
        <InstallScopePickerBody
          context={{ installTargets, ownerEntityNames, activeOrgId, availability }}
          value={value}
          onValueChange={setValue}
          pickerId={pickerId}
          subjectName={name}
          testId="extension-install-panel-picker"
        />
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
        {ready ? <InstallPanelSubmitButton disabled={!selection.committable} /> : null}
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
