import "server-only";

import {
  CONNECTOR_DESCRIPTORS,
  getConnectorDescriptorByPackageId,
  getConnectorDescriptorBySlug,
  listConnectorDescriptors,
} from "@cinatra-ai/connectors-catalog/descriptors.mjs";
import {
  getConnectorSetupPageLoader,
  type ConnectorSetupPageLoader,
} from "@/lib/connector-setup-pages";
import { STATIC_EXTENSION_MANIFEST } from "@/lib/generated/extensions.server";
import {
  asConnectorVendorKey,
  type ConnectorVendorKey,
  type ConnectorVendorIdentity,
} from "@cinatra-ai/sdk-extensions";
import { isConnectorInstalledFromRuntime } from "@cinatra-ai/extensions/connector-installed-predicate";
import {
  pickActiveInstallId,
  isInstallRowAddressableByActor,
  type InstallRowForPick,
} from "@/lib/extension-install-resolution";
import { readInstalledExtensionsByPackageName } from "@cinatra-ai/extensions/canonical-store";
import type { ActorContext } from "@/lib/authz/actor-context";

export type ConnectorDescriptor = (typeof CONNECTOR_DESCRIPTORS)[number];

export type ConnectorReadiness = {
  connected: boolean;
  connectedLabel?: string;
};

export type ConnectorReadinessContext = {
  userId: string | null;
};

export type ConnectorReadinessProbe = (
  ctx: ConnectorReadinessContext,
) => Promise<ConnectorReadiness>;

export type ConnectorRegistryEntry = ConnectorDescriptor & {
  /**
   * The React setup-page loader, or `null` for a `schema-config` connector
   * (model B) that ships NO React page — the host renders it from
   * `cinatra.configSchema`. Only the bundled-react dispatch path consumes it;
   * the schema-config branch never touches it.
   */
  loadSetupPage: ConnectorSetupPageLoader | null;
  readinessProbe: ConnectorReadinessProbe;
  /**
   * The connector's vendor scope, resolved from the installed-extension
   * identity in the generated manifest (falling back to the packageId's scope
   * segment for a connector the static manifest does not cover).
   */
  vendor: string;
  /**
   * The connector's SELF-DECLARED vendor identity (`cinatra.vendor`, #12), or
   * `null` when the connector declares none. `key` is BRANDED as a
   * `ConnectorVendorKey` here — this registry is the host trust boundary that
   * accepts the connector's manifest-declared vendor identity (the SDK owns no
   * roster; authoritative shape/ownership/uniqueness/provider-mapping checks
   * run at the marketplace publish gate). Read-compat: the brand is a plain
   * string at runtime, so the value round-trips unchanged.
   */
  vendorIdentity: { key: ConnectorVendorKey; name: string } | null;
  /** Manifest-resolved dispatch-route href for the connector's setup surface. */
  setupHref: string;
};

/**
 * Whether a connector is BUNDLED in the running image (cinatra#607). The
 * generated `STATIC_EXTENSION_MANIFEST` is regenerated at every consuming surface
 * against the extension tree ACTUALLY PRESENT (`make setup`, the prod image build
 * stage), so an extension absent from the running image is OMITTED from the
 * manifest.
 *
 * cinatra#657 DEMOTION: this is no longer the SOLE installed predicate — it is
 * the BUNDLED-FALLBACK primitive. The runtime source of truth is a live canonical
 * `installed_extension` row for the actor's scope (see
 * `isConnectorInstalledForActor`). This sync, actor-less predicate is retained for
 * (a) the bundled fallback inside `isConnectorInstalledForActor`, and (b) the
 * existing sync card-filter render path (`packages/connectors/src/pages.tsx`),
 * which migrates to the actor-scoped predicate in Phase B (cinatra#658) — kept
 * intact here so PR-2 does not ripple the synchronous render path.
 *
 * Membership is own-key only — never an inherited prototype key (e.g.
 * "constructor") that `in` would falsely report as an installed connector.
 */
export function isConnectorInstalled(packageId: string): boolean {
  return Object.hasOwn(STATIC_EXTENSION_MANIFEST, packageId);
}

/**
 * The cinatra#657 RUNTIME-SOURCED connector "installed" predicate, scoped to the
 * actor. A connector is "installed" iff EITHER (a) a live (active|locked)
 * canonical `installed_extension` row addressable in the actor's scope exists
 * (the runtime source of truth, via `resolveActiveInstallIdForActor` →
 * `pickActiveInstallId`, which fail-closes on archived/cross-org/owner-less rows),
 * OR (b) the package is bundled in the running image (the bundled fallback —
 * `STATIC_EXTENSION_MANIFEST`).
 *
 * CG-1: the bundled fallback is LOAD-BEARING — but PRECISE. The boot seeder
 * (`static-bundle-lifecycle.ts`) anchors a canonical row only for bundled
 * serverEntry OR required-in-prod packages, so a bundled schema-config connector
 * that is neither has NO row on a fresh instance — a naive fail-closed flip would
 * blank it. So the bundled fallback applies for a bundled built-in that
 * LEGITIMATELY has no addressable row, AND for a canonical-store OUTAGE. It does
 * NOT apply when a bundled connector has an addressable ARCHIVED row: that is an
 * explicit operator disable, and the fallback must not resurrect a torn-down
 * surface. We therefore compute BOTH a live-row signal and a status-agnostic
 * addressable-row signal and hand them to the pure predicate.
 *
 * Store-outage handling: a canonical-store read failure is caught and treated as
 * "no addressable row at all" (we never invent a row). A bundled connector stays
 * visible because the static manifest is an in-image build-time constant; a
 * purely runtime-installed connector (no bundled entry) correctly fails closed —
 * its installed-ness cannot be proven during the outage.
 *
 * SECURITY: this predicate authorizes only LIST/CARD VISIBILITY. It is NOT render
 * or write authorization — rendering a runtime schema-config surface still passes
 * the full trust gate (`resolveRuntimeConnectorUiRecord`: anchor → integrity →
 * signature → trust classification), and action endpoints keep their own
 * install/action policy gates. A `true` here never grants render/execute.
 */
export async function isConnectorInstalledForActor(
  packageId: string,
  actor: ActorContext | undefined | null,
  deps: {
    /** Override the canonical-row reader (tests). */
    readRows?: (packageName: string) => Promise<InstallRowForPick[]>;
  } = {},
): Promise<boolean> {
  const bundledInStaticManifest = Object.hasOwn(STATIC_EXTENSION_MANIFEST, packageId);

  // A null actor can address no scoped row: only the bundled fallback can apply.
  if (!actor) {
    return isConnectorInstalledFromRuntime({
      hasAddressableLiveCanonicalRowForActor: false,
      hasAddressableCanonicalRowForActor: false,
      bundledInStaticManifest,
    });
  }

  const readRows = deps.readRows ?? readInstalledExtensionsByPackageName;
  let hasAddressableLiveCanonicalRowForActor = false;
  let hasAddressableCanonicalRowForActor = false;
  try {
    const rows = await readRows(packageId);
    const scope = {
      organizationId: actor.organizationId ?? null,
      ownerId: actor.principalId ?? null,
      teamIds: actor.teamIds ?? [],
    };
    // status-agnostic: ANY addressable row (live or archived) — distinguishes a
    // legitimate "no row" (bundled fallback applies) from an explicit archive
    // (bundled fallback must NOT resurrect it).
    hasAddressableCanonicalRowForActor = rows.some((r) =>
      isInstallRowAddressableByActor(r, scope),
    );
    // the live-row source of truth (active|locked, addressable).
    hasAddressableLiveCanonicalRowForActor = pickActiveInstallId(rows, scope) !== null;
  } catch (err) {
    // Canonical-store OUTAGE: treat as no addressable row — never invent one. A
    // runtime-only connector (no bundled entry) fails closed; a bundled connector
    // survives via the static manifest fallback in the pure predicate.
    console.warn(
      `[connectors-registry] canonical install-row read failed for "${packageId}" ` +
        `(treating as no addressable row; bundled fallback still applies):`,
      err instanceof Error ? err.message : err,
    );
    hasAddressableLiveCanonicalRowForActor = false;
    hasAddressableCanonicalRowForActor = false;
  }
  return isConnectorInstalledFromRuntime({
    hasAddressableLiveCanonicalRowForActor,
    hasAddressableCanonicalRowForActor,
    bundledInStaticManifest,
  });
}

/**
 * Whether a connector ships a React setup page (and therefore needs a loader).
 * A `schema-config` connector (its static manifest declares
 * `uiSurface: "schema-config"`) does NOT — it is listable/registerable with no
 * loader. Defaults to true for any package the static manifest doesn't cover
 * (legacy/bundled-react connectors), so existing behavior is unchanged.
 */
export function connectorRequiresSetupPageLoader(packageId: string): boolean {
  return STATIC_EXTENSION_MANIFEST[packageId]?.uiSurface !== "schema-config";
}

/** Slug → packageId, for the parity check (which is keyed by slug). */
function packageIdForSlug(slug: string): string | undefined {
  return getConnectorDescriptorBySlug(slug)?.packageId;
}

/**
 * Parity predicate keyed by SLUG (the loader map is slug-keyed). A schema-config
 * connector is exempt from needing a setup-page loader.
 */
export function slugRequiresSetupPageLoader(slug: string): boolean {
  const packageId = packageIdForSlug(slug);
  return packageId ? connectorRequiresSetupPageLoader(packageId) : true;
}

/**
 * Resolve the setup-page loader for a descriptor, or `null` when the connector
 * is `schema-config` (no React page). A bundled-react descriptor MUST have a
 * loader entry (the parity test guards drift), so a missing loader for a
 * non-schema-config connector is left to the strict dispatch path to surface.
 */
function resolveSetupPageLoader(
  packageId: string,
  slug: string,
): ConnectorSetupPageLoader | null {
  if (!connectorRequiresSetupPageLoader(packageId)) return null;
  return getConnectorSetupPageLoader(slug);
}

const READINESS_PROBES: Record<string, ConnectorReadinessProbe> = {};

export function registerConnectorReadinessProbe(
  packageId: string,
  probe: ConnectorReadinessProbe,
): void {
  READINESS_PROBES[packageId] = probe;
}

const DEFAULT_PROBE: ConnectorReadinessProbe = async () => ({
  connected: false,
});

export function getConnectorReadinessProbe(
  packageId: string,
): ConnectorReadinessProbe {
  return READINESS_PROBES[packageId] ?? DEFAULT_PROBE;
}

/**
 * The HOST-side connection state + count for a single connector, resolved
 * through the SAME readiness-probe pipeline that feeds the `/connectors` card
 * grid (`packages/connectors/src/pages.tsx`). This is the source of
 * truth for the host-injected setup-page badge: the badge and the card stay in
 * lock-step because both read this probe.
 *
 * FAIL-SOFT (mirrors `resolveReadinessFailSoft` for the card grid): a connector
 * with no registered probe falls back to `DEFAULT_PROBE` ({connected:false}),
 * and a probe that THROWS (the connector's host deps were never registered, a
 * status read fails) degrades to "not connected" rather than 500-ing the setup
 * page. A runtime-only connector (no catalog descriptor, hence no built-in
 * probe) therefore renders a disconnected badge — exactly as its card does.
 *
 * SECURITY: this is a READ-ONLY status read. It exposes nothing the card grid
 * does not already expose to the same actor, and it runs AFTER the dispatch
 * route's authorization/trust gates — it grants no render/write authority.
 */
export async function resolveConnectorBadgeState(
  packageId: string,
  ctx: ConnectorReadinessContext,
): Promise<ConnectorReadiness> {
  try {
    return await getConnectorReadinessProbe(packageId)(ctx);
  } catch (err) {
    console.warn(
      `[connectors-registry] setup-page readiness probe failed for "${packageId}" ` +
        `(rendering the badge as not connected):`,
      err instanceof Error ? err.message : err,
    );
    return { connected: false };
  }
}

/**
 * The connector's vendor scope. The generated manifest (installed-extension
 * identity) is authoritative; a connector the manifest does not cover derives
 * its vendor from the packageId's scope segment.
 */
export function connectorVendor(packageId: string): string {
  const manifestScope = STATIC_EXTENSION_MANIFEST[packageId]?.scope;
  if (manifestScope) return manifestScope;
  const match = /^@([^/]+)\//.exec(packageId);
  return match ? match[1] : "";
}

/**
 * The connector's SELF-DECLARED vendor identity (`cinatra.vendor`, #12) from
 * the generated manifest, or `null` when the connector declares none. This is
 * the host trust boundary: the connector AUTHORED its vendor key and the
 * marketplace publish gate verified it, so the accepted `string` key is BRANDED
 * to `ConnectorVendorKey` here via `asConnectorVendorKey`. The SDK performs no
 * roster/membership check (open marketplace); this function neither validates
 * nor enumerates a vendor list — it carries the manifest value through, branded.
 */
export function connectorVendorIdentity(
  packageId: string,
): { key: ConnectorVendorKey; name: string } | null {
  const declared: ConnectorVendorIdentity | null | undefined =
    STATIC_EXTENSION_MANIFEST[packageId]?.vendor;
  if (!declared) return null;
  return { key: asConnectorVendorKey(declared.key), name: declared.name };
}

function setupHrefFor(descriptor: ConnectorDescriptor): string {
  return `/connectors/${connectorVendor(descriptor.packageId)}/${descriptor.slug}/${descriptor.setupSubroute}`;
}

/**
 * Manifest-resolved setup href for a connector slug, or `null` for an unknown
 * slug. Redirect/link sites use this instead of hardcoding dispatch-route
 * paths.
 */
export function getConnectorSetupHref(slug: string): string | null {
  const descriptor = getConnectorDescriptorBySlug(slug);
  return descriptor ? setupHrefFor(descriptor) : null;
}

function toRegistryEntry(descriptor: ConnectorDescriptor): ConnectorRegistryEntry {
  return {
    ...descriptor,
    loadSetupPage: resolveSetupPageLoader(descriptor.packageId, descriptor.slug),
    // Resolved lazily so probes registered after this entry was built (e.g. a
    // late side-effect import of the built-in probe module) still apply.
    readinessProbe: (ctx) => getConnectorReadinessProbe(descriptor.packageId)(ctx),
    vendor: connectorVendor(descriptor.packageId),
    vendorIdentity: connectorVendorIdentity(descriptor.packageId),
    setupHref: setupHrefFor(descriptor),
  };
}

export function listConnectorRegistryEntries(): ConnectorRegistryEntry[] {
  return listConnectorDescriptors().map(toRegistryEntry);
}

export function getConnectorRegistryEntryBySlug(
  slug: string,
): ConnectorRegistryEntry | undefined {
  const descriptor = getConnectorDescriptorBySlug(slug);
  if (!descriptor) return undefined;
  return toRegistryEntry(descriptor);
}

export function getConnectorRegistryEntryByPackageId(
  packageId: string,
): ConnectorRegistryEntry | undefined {
  const descriptor = getConnectorDescriptorByPackageId(packageId);
  if (!descriptor) return undefined;
  return toRegistryEntry(descriptor);
}
