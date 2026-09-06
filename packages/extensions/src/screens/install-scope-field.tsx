"use client";

// ---------------------------------------------------------------------------
// install-scope-field.tsx — the install-scope PICKER, extracted so there is
// exactly one of it (cinatra#3204, acceptance criterion 11).
//
// The marketplace's in-card install panel owned this: the derivation of the
// combobox props from the server-computed rows, the committability gate, and
// the three availability states in their fixed order. The Upload screen needs
// the same question asked the same way — and a SECOND implementation of "which
// rows exist", "which are disabled and why", "which selection may be
// submitted" is exactly how two surfaces that ask the same question end up
// giving different answers.
//
// So the panel keeps its own chrome (the spec-pinned heading, the scroll
// geometry, the action row) and the three pieces below are shared with the
// Upload screen verbatim. Nothing about the marketplace panel's rendered DOM
// changes: this file is where its inner region moved to, not a rewrite of it.
// ---------------------------------------------------------------------------

import type { ReactNode } from "react";

import { AccessCombobox, resolveFlatAccessOption } from "@/components/access-combobox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { InstallTarget } from "@cinatra-ai/agents/install-targets";

import {
  pickerValueToInstallTarget,
  type InstallTargetLevel,
  type ResolvedInstallTarget,
} from "./install-picker-target";
import type { InstallPanelAvailability } from "./install-panel-availability";

/**
 * The SERVER-COMPUTED inputs the picker reads. Identical on both surfaces:
 * the marketplace resolves them once for the whole grid, the Upload screen once
 * for the page.
 */
export type InstallScopeFieldContext = {
  /** SERVER-COMPUTED picker rows — the single source of truth for enabled state. */
  installTargets: InstallTarget[];
  /** value → display name lookup (e.g. "team:abc" → "Engineering"). */
  ownerEntityNames: Record<string, string>;
  activeOrgId: string;
  /** Discriminated availability state, resolved server-side in fixed order. */
  availability: InstallPanelAvailability;
};

export type InstallScopePickerProps = {
  availableScopes: {
    teams: { id: string; name: string }[];
    projects: { id: string; name: string }[];
    orgName: string;
    orgId: string;
    workspaceExposed: boolean;
  };
  installWorkspaceScopes: boolean;
  disabledScopes: string[];
  disabledReasons: Record<string, string>;
};

/**
 * Derive the combobox's props from the server-computed rows. A row can never
 * appear without the disabled state and the reason the SERVER decided for it.
 */
export function deriveInstallScopePickerProps(
  ctx: Pick<InstallScopeFieldContext, "installTargets" | "ownerEntityNames" | "activeOrgId">,
): InstallScopePickerProps {
  const { installTargets, ownerEntityNames, activeOrgId } = ctx;
  return {
    availableScopes: {
      teams: installTargets
        .filter((t) => t.level === "team")
        .map((t) => ({ id: t.id, name: ownerEntityNames[t.value] ?? t.label })),
      projects: installTargets
        .filter((t) => t.level === "project")
        .map((t) => ({ id: t.id, name: ownerEntityNames[t.value] ?? t.label })),
      orgName: ownerEntityNames[`org:${activeOrgId}`] ?? "",
      orgId: activeOrgId,
      workspaceExposed: false,
    },
    installWorkspaceScopes: installTargets.some(
      (t) => t.level === "workspace" || t.level === "admin",
    ),
    disabledScopes: installTargets.filter((t) => t.disabled).map((t) => t.value),
    disabledReasons: Object.fromEntries(
      installTargets.filter((t) => t.disabled).map((t) => [t.value, t.reason ?? "Not available"]),
    ),
  };
}

/**
 * COMMITTABILITY — the one gate every install consumer reads instead of bare
 * value-truthiness. A synthetic or degenerate row (a mismatched or empty-tail
 * org token, an unhydrated team/project id) and any server-disabled target are
 * never committable, and the adapter fails closed on any value that is not a
 * real target.
 */
export function resolveInstallScopeSelection(
  ctx: Pick<InstallScopeFieldContext, "installTargets" | "ownerEntityNames" | "activeOrgId">,
  value: string,
): { target: ResolvedInstallTarget | null; committable: boolean } {
  const props = deriveInstallScopePickerProps(ctx);
  const target = pickerValueToInstallTarget(value, ctx.activeOrgId);
  const option = resolveFlatAccessOption(value, props.availableScopes, {
    disabledScopes: props.disabledScopes,
    ownerOffered: false,
    workspaceOffered: props.installWorkspaceScopes,
    adminOffered: props.installWorkspaceScopes,
  });
  return { target, committable: Boolean(target) && option.committable };
}

/** Human-readable AUDIENCE fragment — the canonical audience vocabulary. */
export function installAudienceLabel(
  target: { level: InstallTargetLevel },
  pickerValue: string,
  ownerEntityNames: Record<string, string>,
): string {
  const entityName = ownerEntityNames[pickerValue];
  if (target.level === "workspace") return "Workspace: All";
  if (target.level === "admin") return "Workspace: Admins only";
  if (target.level === "team") return entityName ? `team ${entityName}` : "team";
  if (target.level === "project") return entityName ? `project ${entityName}` : "project";
  return entityName ? `everyone in ${entityName}` : "your organization";
}

export type InstallScopePickerBodyProps = {
  context: InstallScopeFieldContext;
  value: string;
  onValueChange: (next: string) => void;
  /** DOM id of the combobox — the field's label points at it. */
  pickerId: string;
  /** Names the thing being installed, for the two empty states. */
  subjectName: string;
  /** Test hook on the DEFAULT picker wrapper. Ignored when `wrapPicker` is given. */
  testId?: string;
  /**
   * Wraps the combobox — and ONLY the combobox, never the two empty states.
   *
   * The wrapper is caller-owned because a covered surface's stable test id is a
   * CONTRACT ATTRIBUTE: the conformance check reads the covered component's own
   * source for the attribute verbatim, so an id that a shared module spells on
   * the caller's behalf is an id the contract can no longer see. The derivation
   * below stays shared; only the one line that carries the id belongs to the
   * surface that the contract pins.
   */
  wrapPicker?: (picker: ReactNode) => ReactNode;
  disabled?: boolean;
};

/**
 * The picker itself, with the three availability states in their fixed order.
 * Renders NO heading and NO action row: both surfaces own their own chrome.
 */
export function InstallScopePickerBody({
  context,
  value,
  onValueChange,
  pickerId,
  subjectName,
  testId = "install-scope-picker",
  wrapPicker,
  disabled,
}: InstallScopePickerBodyProps) {
  const { availability } = context;
  if (availability.state === "no-active-organization") {
    // Names the ACTUAL problem — a session without an active organization has
    // no audience to install for, whatever the viewer's roles are.
    return (
      <p className="text-sm text-muted-foreground">
        Installing needs an active organization. Switch to one of your organizations, then install{" "}
        {subjectName}.
      </p>
    );
  }
  if (availability.state === "no-installable-scope") {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          You need org admin, team admin, or project ownership to install extensions.
        </AlertDescription>
      </Alert>
    );
  }
  const props = deriveInstallScopePickerProps(context);
  const picker = (
    <AccessCombobox
      id={pickerId}
      value={value}
      onValueChange={onValueChange}
      availableScopes={props.availableScopes}
      isAdmin={false}
      disabledScopes={props.disabledScopes}
      disabledReasons={props.disabledReasons}
      // Hide the "owner" row (not an install target). The two workspace
      // AUDIENCE rows are offered with their server-decided state.
      installMode
      installWorkspaceScopes={props.installWorkspaceScopes}
      {...(disabled ? { disabled: true } : {})}
    />
  );
  if (wrapPicker) return <>{wrapPicker(picker)}</>;
  return <div data-testid={testId}>{picker}</div>;
}
