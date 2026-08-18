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
 *
 * `servingVersion` (cinatra#2762) — set ONLY when the installed version is NOT
 * the one in service, and then it is the version that IS. It exists because
 * every line above says "CURRENTLY on version X", and X is read off the install
 * ROW: for a live row that never registered, that sentence names a version no
 * request has ever reached. The reviewer's capture is exactly this — "Currently
 * on version 0.1.5 — up to date" while 0.1.0 served. When it is set the row says
 * BOTH versions and stops calling the unserved one current; the update verdict
 * itself is untouched, because "is there a newer version to install?" is a
 * question about the install, not about what is running.
 */
export function resolveUpdateRow(input: {
  state: InstalledUpdateChipState;
  installedVersion: string | null;
  latestVersion: string | null;
  servingVersion?: string | null;
}): SettingsUpdateRow {
  const { state, installedVersion, latestVersion } = input;
  const servingVersion = input.servingVersion ?? null;
  // The installed version is not in service: never call it "current".
  const installedLabel = servingVersion
    ? `Version ${installedVersion} is installed but not in service (version ${servingVersion} is serving)`
    : `Currently on version ${installedVersion}`;
  switch (state) {
    case "update-available":
      return {
        enabled: true,
        description: `${installedLabel} — version ${latestVersion} is available.`,
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
        description: servingVersion
          ? `${installedLabel} — no newer version to install.`
          : `${installedLabel} — up to date.`,
        disabledReason: servingVersion
          ? "Installed version isn't in service"
          : "Already up to date",
      };
  }
}

// ---------------------------------------------------------------------------
// THE INSTALLED-BUT-NOT-ACTIVE STATE (cinatra#2762 — the issue's own title).
//
// A marketplace install can be LIVE and serving NOTHING: the bytes are
// materialized, the canonical row says `active`, and activation was refused (an
// untrusted registry, a missing signing key, a module that threw). The
// implementation bundled in the image keeps serving every request. The product
// had no name for that: `installed_extension.status` is the LIFECYCLE fact, so
// the page read "active" off the row and reported the installed version as
// current with Activate greyed "Already active" — three statements about a
// version no request had reached.
//
// The runtime fact comes from the serving-provenance record the activation seams
// write (`extension-capabilities-registry`): which implementation put the package's
// live registrations in place, and at which version. This function turns that
// into the state's NAME plus the copy for the two places that were lying.
//
// FAIL-QUIET BY CONSTRUCTION. Every uncertainty resolves to `inService: true`
// (say nothing) rather than to an accusation, because a missing record is
// AMBIGUOUS: a metadata-only package registers no server module at all, a
// process that never ran a loader has nothing to report, and a record written
// before a restart is gone. Claiming "not in service" on absence would put a
// false alarm on every healthy skill and agent.
// ---------------------------------------------------------------------------

/** What the activation seams recorded about a package, or null when nothing did. */
export type ServingProvenance = {
  /** `bundled` = the copy in the image; `install` = a marketplace install. */
  origin: "bundled" | "install";
  /** The version that registered, or null when the seam could not name one. */
  version: string | null;
};

export type ExtensionServingState =
  | { named: false }
  | {
      named: true;
      installedVersion: string | null;
      /** The version actually serving, or null when only the ORIGIN is known. */
      servingVersion: string | null;
      /** The §V row title — the state's name. */
      title: string;
      description: string;
      /** The honest reason the Activate affordance is greyed. */
      activateReason: string;
    };

/**
 * Name the installed-but-not-active state, or decline to.
 *
 * Named ONLY when all of these hold:
 *   - the addressed row is a PRODUCT INSTALL. A bundled anchor IS the image's
 *     copy, so it can never disagree with what the image is serving;
 *   - the row is LIVE. An archived row is not expected to serve, and the page
 *     already says "Already archived" — naming it here would be noise;
 *   - something RECORDED what is serving. Absence is unknown, not a failure;
 *   - and what is serving is NOT this install at this version — either the
 *     image's copy is serving (the #2762 state), or a different version of the
 *     install is (a stale default, equally worth naming).
 * Anything else is `{ named: false }` and every surface behaves exactly as it
 * did before this slice.
 */
export function resolveServingState(input: {
  installedVersion: string | null;
  serving: ServingProvenance | null;
  isProductInstall: boolean;
  isArchived: boolean;
}): ExtensionServingState {
  const { installedVersion, serving, isProductInstall, isArchived } = input;
  if (!isProductInstall || isArchived || !serving) return { named: false };
  const servingThisInstall =
    serving.origin === "install" &&
    // A record that could not name a version cannot contradict one either.
    (serving.version === null ||
      installedVersion === null ||
      serving.version === installedVersion);
  if (servingThisInstall) return { named: false };

  const installedLabel = installedVersion ? `Version ${installedVersion}` : "This version";
  const servingClause =
    serving.origin === "bundled"
      ? serving.version
        ? `Version ${serving.version}, the version bundled with the app, is serving it instead.`
        : "The version bundled with the app is serving it instead."
      : serving.version
        ? `Version ${serving.version} is serving it instead.`
        : "A different version is serving it instead.";
  return {
    named: true,
    installedVersion,
    servingVersion: serving.version,
    title: "Installed but not in service",
    description:
      `${installedLabel} is installed and its files are in place, but it did not ` +
      `start in the running app, so nothing it provides is being used. ` +
      `${servingClause} Retry activation to try starting it again, or roll back ` +
      `to the bundled version to archive this install.`,
    // "Already active" was the old reason, and it is a statement about the
    // lifecycle row, not about what is running. Activate (restore) genuinely
    // cannot help a row that is already live, so the honest reason also points
    // at the affordance that CAN.
    activateReason: "Installed but not in service — use Retry activation",
  };
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
 * The two row inputs are DIFFERENT rows on purpose (codex-found, cinatra#2416):
 *   • `canonical` is the row the dispatcher will TARGET — the resolver's
 *     resolved row, not the collapsed card row, which for a package installed
 *     at BOTH platform and org scope can carry a different status than the row
 *     the action acts on. It supplies the STATUS/version reasons.
 *   • `lockedRow` carries the PACKAGE-WIDE locked/system invariant. The
 *     dispatcher's `assertNoLockedCanonicalRow` refuses when ANY canonical row
 *     for the package is locked, in any scope — so reading the lock off the
 *     target row alone would render an affordance live that a locked SIBLING
 *     deterministically refuses: the very defect this issue fixes.
 */
export function resolveSettingsAffordances(input: {
  canonical: InstalledExtension | null;
  lockedRow: InstalledExtension | null;
  isArchived: boolean;
  versionKnown: boolean;
  capabilities: LifecycleCapabilityMap;
  /**
   * cinatra#2762 — the honest reason for Activate when the addressed row is
   * live but NOT what is serving, from {@link resolveServingState}. It replaces
   * the "Already active" status fallback, which described the lifecycle row
   * while a different implementation served every request. Tier 3 only: the
   * locked/system invariant and the server-derived capability both still
   * outrank it, because a row the actor cannot address at all is not usefully
   * described by ANY statement about its runtime state. Absent ⇒ "Already
   * active", unchanged.
   */
  activateNotInServiceReason?: string | null;
}): SettingsAffordances {
  const { canonical, lockedRow, isArchived, versionKnown, capabilities } = input;
  const activateNotInServiceReason = input.activateNotInServiceReason ?? null;
  // Tier 1 — the #1036 locked / system INVARIANT only, from the PACKAGE-WIDE
  // locked row. Deliberately NOT the whole `disabledActionReason`: its status
  // half ("Already archived" / "Already active") is a weak, descriptive reason
  // that must rank BELOW the capability, or an unaddressable row would read
  // "Already active" — a statement about a row the action will never target.
  const invariant = (
    action: "archive" | "activate" | "uninstall" | "force_delete",
  ): string | null => (lockedRow ? lifecycleInvariantReason(lockedRow, action) : null);
  // Tier 2 — the SERVER-DERIVED capability.
  const capabilityReason = (
    op: "archive" | "activate" | "uninstall" | "force_delete",
  ): string | null => (capabilities[op].allowed ? null : capabilities[op].reason);
  // Tier 3 — the status / version fallbacks.

  const capabilityReasons: SettingsAffordances["capabilityReasons"] = {};

  /** Resolve one affordance through the three tiers, recording STRUCTURALLY
   *  (never by comparing the resolved copy) whether tier 2 is what claimed it. */
  const resolve = (
    affordance: "archive" | "activate" | "reinstall" | "forceDelete",
    op: "archive" | "activate" | "uninstall" | "force_delete",
    statusFallback: string | null,
  ): string | null => {
    const invariantReason = invariant(op);
    if (invariantReason) return invariantReason;
    const capReason = capabilityReason(op);
    if (capReason) {
      capabilityReasons[affordance] = capReason;
      return capReason;
    }
    return statusFallback;
  };

  const archiveDisabled = resolve(
    "archive",
    "archive",
    isArchived ? "Already archived" : !versionKnown ? "Installed version unknown" : null,
  );
  const activateDisabled = resolve(
    "activate",
    "activate",
    !isArchived ? (activateNotInServiceReason ?? "Already active") : null,
  );
  const reinstallDisabled = resolve("reinstall", "uninstall", null);
  const forceDeleteDisabled = resolve(
    "forceDelete",
    "force_delete",
    !versionKnown ? "Installed version unknown" : null,
  );

  return {
    archiveDisabled,
    activateDisabled,
    reinstallDisabled,
    forceDeleteDisabled,
    capabilityReasons,
  };
}
