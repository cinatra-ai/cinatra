// ---------------------------------------------------------------------------
// Pure model logic for the per-extension Settings page (design §V).
//
// Extracted from the screen loader so the load-bearing §V rules — update
// gating, the locked / system disabled-in-place affordances (honoring the
// #1036 disabledActionReason mechanism), the complementary Archive/Activate
// pair, and the marketplace vendor gating — are unit-testable without a DB.
// ---------------------------------------------------------------------------

import { comparePluginVersions } from "@cinatra-ai/registries/src/version-compare";
import type { ExtensionKind, InstalledExtension } from "../canonical-types";
import { disabledActionReason } from "../lifecycle-ui";

/** The kinds whose access policy is keyed by the canonical install row — the
 * identity install (setExtensionInstallAccess) and enforcement both use. Agent
 * / skill access lives on their own dedicated surfaces. */
export const ACCESS_POLICY_KINDS: readonly ExtensionKind[] = [
  "connector",
  "artifact",
  "workflow",
];

export const VALID_SETTINGS_KINDS: readonly ExtensionKind[] = [
  "agent",
  "skill",
  "connector",
  "artifact",
  "workflow",
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

/** True when the installed version is strictly behind the newest published one. */
export function resolveUpdateAvailable(
  rawVersion: string | null,
  newestVersion: string | null,
): boolean {
  return Boolean(
    rawVersion &&
      newestVersion &&
      comparePluginVersions(rawVersion, newestVersion) === "update-available",
  );
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
