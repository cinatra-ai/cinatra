// ---------------------------------------------------------------------------
// upload-install-scope.ts — the Upload screen's INSTALL SCOPE (cinatra#3204,
// acceptance criteria 11-16).
//
// THE QUESTION THIS ANSWERS, AND THE THREE IT REPLACES. A store install asks
// one access question before it installs: WHO IS THIS EXTENSION INSTALLED FOR?
// The answer picks the canonical row's anchor and the audience policy, and the
// server is the authority on whether the actor may install at that scope. The
// Upload screen asked three different questions instead, none of them that one:
//
//   - the File tab rendered the agent RUN-VISIBILITY checkbox picker under the
//     heading "Access" (who may list / read / execute the agent's RUNS) and
//     wrote it NON-FATALLY, so a failed write became a toast and the extension
//     stayed at the broader default;
//   - the GitHub tab rendered its own collapsed ownership editor, a third
//     model again;
//   - and the canonical row was anchored by a derivation the operator never
//     saw: `claimantOrgId ? "organization" : "platform"`.
//
// This module is the upload road's half of the STORE's question. It does not
// re-implement the store's rules — it mounts the store's own modules and
// composes them. That is deliberate and it is asserted by module identity in
// the suite: a second implementation of "which levels exist", "which is the
// default" or "which anchor does this target resolve to" is exactly how the two
// roads would drift apart.
//
// PURE (no IO, no server-only), so the mapping is directly unit-testable and
// can be imported by the client form as well as by the server action. The
// server action owns the two things that are NOT pure: the AUTHORITY check
// (`assertCanInstallAtTarget`) and the fail-closed persistence.
//
// THE RECORDED DECISION FOR `agent` AND `skill` (criterion 12). The store's own
// pre-install selector is offered for `connector`, `artifact` and `workflow`
// only — `INSTALL_ACCESS_TARGET_KINDS` excludes agent and skill, whose install
// paths carry their own ownership contract. The decision taken for this issue is
// the SECOND of the two options the issue names, in the shape the requirement
// demands: the UPLOAD road configures the scope through the store's picker for
// ALL FOUR live kinds (an operator uploading an agent is asked the same question
// as one uploading a connector), while the STORE-side set stays exactly as it
// is. Widening the storefront's own selector to agent and skill would change
// store-road behaviour for every existing install and is a named follow-up, not
// a side effect of the upload road.
// ---------------------------------------------------------------------------

import { resolveInstallRowAnchor } from "@cinatra-ai/extensions/canonical-types";
import type { InstallRowOwnership } from "@cinatra-ai/extensions/canonical-types";
import {
  resolveInstallAccessTargetContract,
  type InstallAccessTarget,
} from "@cinatra-ai/extensions/install-access-target";
import { pickerValueToInstallTarget } from "@cinatra-ai/extensions/screens/install-picker-target";
import {
  resolveInstallPanelAvailability,
  type InstallPanelAvailability,
  type ResolveInstallPanelAvailabilityInput,
} from "@cinatra-ai/extensions/screens/install-panel-availability";

import type { AgentAuthPolicy } from "./auth-policy-types";
import type { UploadableExtensionKind } from "./upload-archive";

/**
 * The store modules this road mounts. Exported as a frozen record so the suite
 * can assert IDENTITY — that the Upload screen runs the marketplace's own
 * functions — rather than asserting matching behaviour, which two
 * implementations can share right up until one of them changes.
 */
export const UPLOAD_INSTALL_SCOPE_PRIMITIVES = Object.freeze({
  pickerValueToInstallTarget,
  resolveInstallPanelAvailability,
  resolveInstallAccessTargetContract,
  resolveInstallRowAnchor,
});

/** Every live installable kind configures its install scope on the upload road. */
export const UPLOAD_SCOPE_CONFIGURED_KINDS = [
  "agent",
  "connector",
  "artifact",
  "skill",
] as const;

export function uploadConfiguresInstallScope(kind: string): boolean {
  return (UPLOAD_SCOPE_CONFIGURED_KINDS as readonly string[]).includes(kind);
}

/**
 * The permissions-store resource kind each uploaded extension kind persists its
 * install access against. The uniform install-time access contract
 * (`setExtensionInstallAccess`) is polymorphic over these, which is why all four
 * kinds can be configured through one call.
 */
export function uploadAccessResourceKindFor(
  kind: UploadableExtensionKind,
): "agent_template" | "skill_package" | "connector" | "artifact" {
  switch (kind) {
    case "agent":
      return "agent_template";
    case "skill":
      return "skill_package";
    case "connector":
      return "connector";
    case "artifact":
      return "artifact";
  }
}

/** A picker value that is not an installable scope. Typed so the server action
 *  can refuse it distinctly from an authority denial. */
export class UploadInstallScopeError extends Error {
  readonly code = "UPLOAD_INSTALL_SCOPE_INVALID" as const;
  constructor(message: string) {
    super(message);
    this.name = "UploadInstallScopeError";
  }
}

export type UploadInstallScopeDecision = {
  /** The install target the operator picked — the server re-derives its id. */
  target: InstallAccessTarget;
  /** The canonical row anchor this install writes at (criterion 15). */
  rowAnchor: InstallRowOwnership;
  /** The audience policy to persist; undefined = the kind's install default. */
  policy: AgentAuthPolicy | undefined;
};

/**
 * Resolve the picked scope into the two halves an install needs: the row anchor
 * and the audience policy.
 *
 * Both halves come from the store's own contract, and the anchor goes through
 * `resolveInstallRowAnchor` — the ONE rule that turns an install request into
 * the tuple a canonical row is written at — so the upload road cannot anchor a
 * row anywhere the store road would not.
 */
export function resolveUploadInstallScope(input: {
  pickerValue: string;
  activeOrganizationId: string | null;
}): UploadInstallScopeDecision {
  const activeOrgId = (input.activeOrganizationId ?? "").trim();
  if (activeOrgId === "") {
    throw new UploadInstallScopeError(
      "Installing an uploaded extension needs an active organization: every install target is " +
        "anchored to one, so there is no scope to install at. Switch to one of your organizations " +
        "and upload again.",
    );
  }
  const target = pickerValueToInstallTarget(input.pickerValue, activeOrgId);
  if (!target) {
    throw new UploadInstallScopeError(
      `${JSON.stringify(input.pickerValue)} is not an installable scope. Pick who this extension is ` +
        "installed for before uploading it.",
    );
  }
  const { rowOwnership, policy } = resolveInstallAccessTargetContract(target, activeOrgId);
  return {
    target,
    rowAnchor: resolveInstallRowAnchor(activeOrgId, rowOwnership),
    policy,
  };
}

/**
 * The availability resolver, hung off the scope resolver so the Upload screen
 * reaches the SAME three states, in the same fixed order, that the marketplace
 * install panel resolves. Not a wrapper — the exported function IS the store's.
 */
resolveUploadInstallScope.availability = resolveInstallPanelAvailability as (
  input: ResolveInstallPanelAvailabilityInput,
) => InstallPanelAvailability;
