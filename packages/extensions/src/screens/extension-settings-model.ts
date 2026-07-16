// ---------------------------------------------------------------------------
// Pure model logic for the per-extension Settings page (design §V).
//
// Extracted from the screen loader so the load-bearing §V rules — update
// gating, the locked / system disabled-in-place affordances (honoring the
// #1036 disabledActionReason mechanism), the complementary Archive/Activate
// pair, and the marketplace vendor gating — are unit-testable without a DB.
// ---------------------------------------------------------------------------

import type { ExtensionKind, InstalledExtension } from "../canonical-types";
import { disabledActionReason } from "../lifecycle-ui";
import type { InstalledUpdateChipState } from "./installed-update-chip";

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
};

/**
 * Resolve the disabled-in-place reasons for the lifecycle affordances. Honors
 * the #1036 disabledActionReason mechanism first (locked / system extensions),
 * then falls back to the status so the complementary Archive/Activate pair
 * still resolves when there is no canonical row (a grandfathered install), and
 * so version-requiring actions (Archive / Force-delete) are disabled when the
 * installed version is unknown. Update is never disabled here — it stays
 * available for locked / system extensions.
 */
export function resolveSettingsAffordances(input: {
  canonical: InstalledExtension | null;
  isArchived: boolean;
  versionKnown: boolean;
}): SettingsAffordances {
  const { canonical, isArchived, versionKnown } = input;
  const archiveDisabled =
    (canonical ? disabledActionReason(canonical, "archive") : null) ??
    (isArchived ? "Already archived" : !versionKnown ? "Installed version unknown" : null);
  const activateDisabled =
    (canonical ? disabledActionReason(canonical, "activate") : null) ??
    (!isArchived ? "Already active" : null);
  const forceDeleteDisabled =
    (canonical ? disabledActionReason(canonical, "force_delete") : null) ??
    (!versionKnown ? "Installed version unknown" : null);
  const reinstallDisabled = canonical
    ? disabledActionReason(canonical, "uninstall")
    : null;
  return { archiveDisabled, activateDisabled, reinstallDisabled, forceDeleteDisabled };
}
