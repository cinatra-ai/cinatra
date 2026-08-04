// ---------------------------------------------------------------------------
// Pure model logic for the per-extension Settings page (design §V).
//
// Extracted from the screen loader so the load-bearing §V rules — update
// gating, the locked / system disabled-in-place affordances (honoring the
// #1036 disabledActionReason mechanism), the complementary Archive/Activate
// pair, and the marketplace vendor gating — are unit-testable without a DB.
// ---------------------------------------------------------------------------

import type { ExtensionKind, InstalledExtension } from "../canonical-types";
import { lifecycleInvariantReason } from "../lifecycle-ui";
import type { InstalledUpdateChipState } from "./installed-update-chip";
// TYPE-only (erased at compile time) — `lifecycle-target-resolver` is
// `server-only` and must never be pulled into a client graph by this module.
import type { LifecycleCapabilityMap } from "../lifecycle-target-resolver";

/** The kinds whose access policy is keyed by the canonical install row — the
 * identity install (setExtensionInstallAccess) and enforcement both use. Agent
 * / skill access lives on their own dedicated surfaces. The removed "workflow"
 * kind is gone (cinatra#1035). */
export const ACCESS_POLICY_KINDS: readonly ExtensionKind[] = [
  "connector",
  "artifact",
];

export const VALID_SETTINGS_KINDS: readonly ExtensionKind[] = [
  "agent",
  "skill",
  "connector",
  "artifact",
];

/**
 * The Settings action opens the per-extension Settings page (design §V) — one
 * route for every kind, keyed by `kind` + the package name. The name's own `/`
 * (a scoped `@vendor/name`) maps onto the catch-all `[...pkg]` route segments,
 * which the page re-joins; npm package names carry no other path-unsafe
 * characters, so no per-segment encoding is needed.
 */
export function settingsHrefFor(kind: ExtensionKind, packageName: string): string {
  return `/configuration/extensions/settings/${kind}/${packageName}`;
}

/**
 * The §V Maintenance · Update row: the update status spelled out in words as
 * the row's description, with the Update button live ONLY when there is an
 * update to run (design §V — "the button greyed out whenever there is nothing
 * to run"). Discriminated on `enabled` so a disabled row always carries its
 * greyed-button reason.
 */
export type SettingsUpdateRow =
  | { enabled: true; description: string }
  | { enabled: false; description: string; disabledReason: string };

/**
 * Map the §III card update state (the SAME `deriveInstalledUpdateChipState`
 * verdict the installed card's chip renders from) to the §V Maintenance ·
 * Update row. Per-state wording from the design spec:
 *   • update-available → "Currently on version X — version Y is available."
 *     (the only live-button state);
 *   • incompatible     → "Newer version needs a newer Cinatra.";
 *   • non-comparable   → "No registry version to compare." (github/dev/local
 *     sources — `installedVersion` may be null here);
 *   • up-to-date / none (fail-quiet stale readout) → the up-to-date line.
 * This row is where the explanation lives — the §III card itself never
 * carries explanatory update text (owner direction 2026-07-12).
 */
export function resolveUpdateRow(input: {
  state: InstalledUpdateChipState;
  installedVersion: string | null;
  latestVersion: string | null;
}): SettingsUpdateRow {
  const { state, installedVersion, latestVersion } = input;
  switch (state) {
    case "update-available":
      return {
        enabled: true,
        description: `Currently on version ${installedVersion} — version ${latestVersion} is available.`,
      };
    case "incompatible":
      return {
        enabled: false,
        description: "Newer version needs a newer Cinatra.",
        disabledReason: "Newer version needs a newer Cinatra",
      };
    case "non-comparable":
      return {
        enabled: false,
        description: "No registry version to compare.",
        disabledReason: "No registry version to compare",
      };
    case "up-to-date":
    case "none":
    default:
      return {
        enabled: false,
        description: `Currently on version ${installedVersion} — up to date.`,
        disabledReason: "Already up to date",
      };
  }
}

/** A registered marketplace vendor is one whose vendor state is approved/active. */
export function isRegisteredMarketplaceVendor(state: string | null | undefined): boolean {
  if (!state) return false;
  return ["approved", "active", "registered"].includes(state.toLowerCase());
}

/**
 * Whether the one-way "Publish on marketplace" action is live. Gated on the
 * instance being a registered vendor AND the extension being private with a
 * known version. The private→public promote path is agent-kind today.
 */
export function canPublishToMarketplace(input: {
  isPublic: boolean;
  isRegisteredVendor: boolean;
  kind: ExtensionKind;
  versionKnown: boolean;
}): boolean {
  return (
    !input.isPublic &&
    input.isRegisteredVendor &&
    input.kind === "agent" &&
    input.versionKnown
  );
}

export type SettingsAffordances = {
  archiveDisabled: string | null;
  activateDisabled: string | null;
  reinstallDisabled: string | null;
  forceDeleteDisabled: string | null;
  /**
   * cinatra#2416: the subset of the four reasons above that a SERVER-DERIVED
   * capability denial produced. The view renders these as visible muted copy
   * beside the greyed button (§V's own disabled-with-reason rendering) — a
   * scope refusal an administrator cannot otherwise deduce from the page.
   */
  capabilityReasons: Partial<
    Record<"archive" | "activate" | "reinstall" | "forceDelete", string>
  >;
};

/**
 * Resolve the disabled-in-place reasons for the lifecycle affordances.
 *
 * Precedence (cinatra#2416, codex-converged):
 *   1. the #1036 `disabledActionReason` invariant (locked / system) — the
 *      strongest, package-level rule;
 *   2. the SERVER-DERIVED per-affordance capability (`capabilities`) — the
 *      addressability / standing verdict from the SAME resolver the dispatcher
 *      enforces with. It outranks the status reasons because a row the actor
 *      cannot address at all is not usefully described as "Already active": the
 *      status would be describing a row the action will never target;
 *   3. the status / version fallbacks — the complementary Archive/Activate pair
 *      (which still resolves when there is no canonical row, a grandfathered
 *      install) and the version-requiring actions.
 * Update is never disabled here — it stays available for locked / system
 * extensions.
 *
 * `capabilities` is REQUIRED. An optional capability field would leave the
 * pre-#2416 enabled-by-default behavior reachable by a production caller, which
 * is precisely the defect: every caller must supply a server-derived verdict.
 *
 * `canonical` should be the row the dispatcher will TARGET (the resolver's
 * resolved row) when one resolved — not the collapsed card row, which for a
 * package installed at BOTH platform and org scope can carry a different
 * status than the row the action acts on.
 */
export function resolveSettingsAffordances(input: {
  canonical: InstalledExtension | null;
  isArchived: boolean;
  versionKnown: boolean;
  capabilities: LifecycleCapabilityMap;
}): SettingsAffordances {
  const { canonical, isArchived, versionKnown, capabilities } = input;
  // Tier 1 — the #1036 locked / system INVARIANT only. Deliberately NOT the
  // whole `disabledActionReason`: its status half ("Already archived" /
  // "Already active") is a weak, descriptive reason that must rank BELOW the
  // capability, or an unaddressable row would read "Already active" — a
  // statement about a row the action will never target.
  const invariant = (
    action: "archive" | "activate" | "uninstall" | "force_delete",
  ): string | null => (canonical ? lifecycleInvariantReason(canonical, action) : null);
  // Tier 2 — the SERVER-DERIVED capability.
  const capabilityReason = (
    op: "archive" | "activate" | "uninstall" | "force_delete",
  ): string | null => (capabilities[op].allowed ? null : capabilities[op].reason);
  // Tier 3 — the status / version fallbacks (below).

  const archiveDisabled =
    invariant("archive") ??
    capabilityReason("archive") ??
    (isArchived ? "Already archived" : !versionKnown ? "Installed version unknown" : null);
  const activateDisabled =
    invariant("activate") ??
    capabilityReason("activate") ??
    (!isArchived ? "Already active" : null);
  const forceDeleteDisabled =
    invariant("force_delete") ??
    capabilityReason("force_delete") ??
    (!versionKnown ? "Installed version unknown" : null);
  const reinstallDisabled = invariant("uninstall") ?? capabilityReason("uninstall");

  // Which of the four are showing a CAPABILITY reason (i.e. the #1036 rule did
  // not already claim them). Keyed by AFFORDANCE name, not op name.
  const capabilityReasons: SettingsAffordances["capabilityReasons"] = {};
  if (archiveDisabled && archiveDisabled === capabilityReason("archive")) {
    capabilityReasons.archive = archiveDisabled;
  }
  if (activateDisabled && activateDisabled === capabilityReason("activate")) {
    capabilityReasons.activate = activateDisabled;
  }
  if (reinstallDisabled && reinstallDisabled === capabilityReason("uninstall")) {
    capabilityReasons.reinstall = reinstallDisabled;
  }
  if (forceDeleteDisabled && forceDeleteDisabled === capabilityReason("force_delete")) {
    capabilityReasons.forceDelete = forceDeleteDisabled;
  }

  return {
    archiveDisabled,
    activateDisabled,
    reinstallDisabled,
    forceDeleteDisabled,
    capabilityReasons,
  };
}
