import "server-only";

import type { ActorContext } from "@/lib/authz/actor-context";
import { readInstalledExtensionsByPackageName } from "@cinatra-ai/extensions/canonical-store";
import type { InstalledExtension } from "@cinatra-ai/extensions/canonical-types";
import { loadMarketplaceBrowse } from "@/lib/marketplace-browse";
import { deriveExtensionCompatState } from "@/lib/extension-compat-badge";

// ---------------------------------------------------------------------------
// Connector setup-page marketplace-redirect decision (cinatra#1529).
//
// The connector setup dispatch route 404s when it resolves NO active, trusted,
// addressable runtime install for a package that carries no build-time catalog
// descriptor. That 404 is a dead end for the genuinely-not-installed case. This
// module decides — NARROWLY — when to send the actor to the pre-filtered in-app
// marketplace instead, and returns a plain decision the route acts on. It NEVER
// calls `redirect()` itself: `redirect()` throws `NEXT_REDIRECT` and must be
// invoked OUTSIDE any try/catch (this module's IO is wrapped and fail-closed),
// so the route calls it at the top level (AC5).
//
// THE SECURITY CRUX (AC2 — no enumeration oracle). The redirect target is the
// in-app marketplace the actor can ALREADY browse. So the redirect may fire
// ONLY when redirecting reveals nothing the actor could not already discover:
//   (a) the actor can reach the marketplace at all (platform admin — the
//       `/configuration/marketplace` page is `requireAdminSession`-gated), AND
//   (b) the package is present in the SAME browse catalog that page renders
//       (`loadMarketplaceBrowse`), matched by canonical package name.
// A global registry/catalog match is deliberately NOT sufficient: gating on that
// would let an unauthorized actor probe which packages exist by diffing
// 404-vs-redirect. Every other state fails closed to the route's existing 404.
//
// "No active install" is NOT "not installed" (AC3). The route reaches this
// decision only after confirming there is no active, trusted, addressable
// install for the actor — but that is also empty for a disabled / inactive /
// archived / pending / differently-scoped install in the actor's org. Only a
// GENUINELY ABSENT actor/org installation redirects; an install anchored to the
// actor's org (any status) — or a workspace-level org-less install — is a
// management/reactivation case and keeps the existing 404.
// ---------------------------------------------------------------------------

/** The in-app marketplace browse surface. */
const MARKETPLACE_PATH = "/configuration/marketplace";

/**
 * Build the pre-filtered marketplace URL for a canonical package name (AC4).
 *
 * There is no exact-package deep-link parameter on the marketplace client — its
 * `?q=` is a case-insensitive SUBSTRING filter over title/description/package
 * name, so it does NOT uniquely select the extension (a substring can match
 * several listings, or none). We therefore derive `q` from the canonical catalog
 * `packageName` (leading `@` included) and build the URL with `URLSearchParams`
 * (never a hand-asserted `%2F` encoding). The result narrows the marketplace to
 * this package's listing but is not claimed to be a unique deep link.
 */
export function buildMarketplaceRedirectTarget(canonicalPackageName: string): string {
  const params = new URLSearchParams({ q: canonicalPackageName });
  return `${MARKETPLACE_PATH}?${params.toString()}`;
}

export type ConnectorSetupRedirectSignals = {
  /** The requested subroute is exactly `setup` (scope gate — AC6). */
  isSetupSubroute: boolean;
  /** The actor can browse the in-app marketplace at all (platform admin). */
  actorCanBrowseMarketplace: boolean;
  /**
   * The package is present in the actor-browsable marketplace catalog AND is
   * currently installable there (a valid install identity, not withdrawn, not
   * ABI-incompatible). This is the discovery gate (AC2) fused with the
   * "currently installable" matrix condition.
   */
  discoverableInstallable: boolean;
  /**
   * The actor's org already carries an install row for the package — any
   * lifecycle status (active / locked / archived / pending / disabled) or a
   * workspace-level org-less row. When true, this is NOT a genuinely-absent
   * installation (AC3): it is a management/reactivation/scoping case, never a
   * redirect.
   */
  hasOrgScopedInstall: boolean;
};

export type ConnectorSetupRedirectDecision =
  | { kind: "redirect"; target: string }
  /** The route keeps its existing behaviour (the 404 it was about to emit). */
  | { kind: "none" };

/**
 * The PURE matrix decision (cinatra#1529 AC1). Given the resolved signals, decide
 * whether the setup route redirects to the pre-filtered marketplace or keeps its
 * existing 404. Fail-closed: every gate must pass; any miss returns `none`.
 *
 * Matrix rows (as expressed by the signals):
 *   - unknown / not-discoverable → `discoverableInstallable=false` → none (404)
 *   - policy-denied / non-setup subroute → gated before this / `isSetupSubroute`
 *   - discoverable + installable + genuinely-absent install → REDIRECT
 *   - install exists but inactive/archived/pending/scoped → `hasOrgScopedInstall`
 *     → none (management case)
 *   - not marketplace-sourced / withdrawn / incompatible →
 *     `discoverableInstallable=false` → none
 */
export function decideConnectorSetupRedirect(
  canonicalPackageName: string,
  signals: ConnectorSetupRedirectSignals,
): ConnectorSetupRedirectDecision {
  // Scope: only the `setup` subroute may redirect; every other subroute keeps
  // its current behaviour (AC6).
  if (!signals.isSetupSubroute) return { kind: "none" };
  // Oracle prevention (AC2): only redirect to a surface the actor can already
  // reach. A non-admin cannot browse the marketplace, so a redirect would be a
  // useless bounce AND a potential existence oracle — fail closed.
  if (!signals.actorCanBrowseMarketplace) return { kind: "none" };
  // Discovery + installable gate (AC2 + matrix): the package must be visible and
  // currently installable in the actor's own browse catalog. A global registry
  // match is not enough; withdrawn / incompatible / non-marketplace packages are
  // absent from it and stay 404.
  if (!signals.discoverableInstallable) return { kind: "none" };
  // "No active install" is NOT "not installed" (AC3): an install row anchored to
  // the actor's org (any status) or a workspace-level row is a management case.
  if (signals.hasOrgScopedInstall) return { kind: "none" };
  return {
    kind: "redirect",
    target: buildMarketplaceRedirectTarget(canonicalPackageName),
  };
}

export type ConnectorSetupRedirectDeps = {
  /** Load the actor-browsable marketplace catalog (override for tests). */
  loadBrowse?: typeof loadMarketplaceBrowse;
  /** Read the canonical install rows for a package (override for tests). */
  readRows?: (packageName: string) => Promise<InstalledExtension[]>;
};

/**
 * Whether the package is discoverable as a CONNECTOR AND currently installable in
 * the actor's own browse catalog — the SAME source `/configuration/marketplace`
 * renders, so the redirect can reveal nothing the actor could not already see.
 * Matched by canonical (case-insensitive) package name; a package the catalog
 * omits (unknown / not-discoverable / withdrawn / non-marketplace-sourced) →
 * false. The matched card must also be `kindSlug === "connector"`: package names
 * are globally unique across kinds, so a name that resolves to an agent / skill /
 * artifact / workflow means the CONNECTOR is unknown to this route and must stay
 * 404 — never redirect a connector setup URL to a non-connector listing. A
 * listed-but-ABI-incompatible connector → false (matrix: incompatible, no
 * redirect). Returns the canonical catalog package name for the `q` derivation.
 */
async function resolveDiscoverableInstallable(
  packageName: string,
  deps: ConnectorSetupRedirectDeps,
): Promise<{ discoverableInstallable: boolean; canonicalPackageName: string }> {
  const loadBrowse = deps.loadBrowse ?? loadMarketplaceBrowse;
  const browse = await loadBrowse();
  const want = packageName.toLowerCase();
  const card = browse.cards.find((c) => c.packageName.toLowerCase() === want);
  // Not in the catalog, or the name resolves to a non-connector listing → the
  // connector is unknown to this route (fail closed to 404).
  if (!card || card.kindSlug !== "connector") {
    return { discoverableInstallable: false, canonicalPackageName: packageName };
  }
  // Withdrawn packages are absent from the catalog; a listed connector that
  // declares an ABI the host cannot satisfy is "incompatible" — the matrix keeps
  // those as the existing response (no marketplace redirect).
  const compat = deriveExtensionCompatState(card.sdkAbiRange);
  return {
    discoverableInstallable: compat !== "incompatible",
    canonicalPackageName: card.packageName,
  };
}

/**
 * Whether the actor's ORG already carries an install row for the package (any
 * lifecycle status), or a workspace-level (org-less) row. `canonicalPackageName`
 * is the catalog's canonical name (the exact-case key install rows are stored
 * under), NOT the route-derived name — the store read is a case-sensitive `eq()`.
 * Status-agnostic and org-anchored so an inactive / archived / pending /
 * differently-owned install in the actor's org is correctly treated as
 * "installed" (not genuinely absent), per AC3. Deliberately ORG-anchored, NOT the
 * admin-standing `isInstallRowAddressableByActor` predicate: a platform admin has
 * standing over every org's row, so mirroring that would suppress the redirect
 * whenever ANY org holds the connector — a cross-org-only install is genuinely
 * absent for THIS actor's org and must still redirect (AC3). Only the
 * DEFAULT-version rows carry the package's unversioned global identity
 * (`isDefault !== false`), mirroring `isConnectorInstalledForActor`'s row filter.
 */
async function resolveHasOrgScopedInstall(
  canonicalPackageName: string,
  actor: ActorContext | undefined | null,
  deps: ConnectorSetupRedirectDeps,
): Promise<boolean> {
  const readRows = deps.readRows ?? readInstalledExtensionsByPackageName;
  const orgId = actor?.organizationId ?? null;
  const rows = (await readRows(canonicalPackageName)).filter((r) => r.isDefault !== false);
  return rows.some((r) => r.organizationId == null || r.organizationId === orgId);
}

/**
 * Resolve the connector setup-page marketplace-redirect decision (cinatra#1529).
 * Gathers the matrix signals and returns a plain decision — it NEVER calls
 * `redirect()` (the route does, outside any try/catch — AC5). All catalog / DB IO
 * is wrapped and fails closed to `none`, so a marketplace outage or a store read
 * error degrades to the route's existing 404, never a worse outcome.
 */
export async function resolveConnectorSetupRedirect(
  input: {
    packageName: string;
    subroute: string;
    actor: ActorContext | undefined | null;
  },
  deps: ConnectorSetupRedirectDeps = {},
): Promise<ConnectorSetupRedirectDecision> {
  // Cheap, IO-free gates first (also avoids an oracle-shaped catalog fetch for a
  // non-admin or a non-setup subroute).
  const isSetupSubroute = input.subroute === "setup";
  if (!isSetupSubroute) return { kind: "none" };
  const actorCanBrowseMarketplace = input.actor?.platformRole === "platform_admin";
  if (!actorCanBrowseMarketplace) return { kind: "none" };

  try {
    const { discoverableInstallable, canonicalPackageName } =
      await resolveDiscoverableInstallable(input.packageName, deps);
    if (!discoverableInstallable) return { kind: "none" };
    // Use the CANONICAL catalog package name (not the raw route-derived one) for
    // the install-row lookup: `resolveDiscoverableInstallable` matched the card
    // case-insensitively and the store read is an exact-case `eq()`, so a route
    // whose casing differs from the catalog's canonical name would otherwise miss
    // an install the actor's org genuinely has and redirect as if it were absent.
    const hasOrgScopedInstall = await resolveHasOrgScopedInstall(
      canonicalPackageName,
      input.actor,
      deps,
    );
    return decideConnectorSetupRedirect(canonicalPackageName, {
      isSetupSubroute,
      actorCanBrowseMarketplace,
      discoverableInstallable,
      hasOrgScopedInstall,
    });
  } catch {
    // Fail closed: any catalog/store IO failure keeps the route's existing 404.
    return { kind: "none" };
  }
}
