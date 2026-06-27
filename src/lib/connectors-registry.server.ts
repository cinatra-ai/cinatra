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
 * Whether a connector is actually INSTALLED / BUNDLED in the running image
 * (cinatra#607). The generated `STATIC_EXTENSION_MANIFEST` is regenerated at
 * every consuming surface against the extension tree ACTUALLY PRESENT (`make
 * setup`, the prod image build stage), so an extension absent from the running
 * image is OMITTED from the manifest. Membership is therefore the authoritative
 * installed/bundled predicate: a catalog descriptor whose package is not in the
 * manifest exists only as catalog data — it is not installed here.
 *
 * Use this to gate the /connectors visible card set: a card must only render for
 * an installed connector, never for the full static catalog (which would imply a
 * connector is available when it is not bundled, dead-ending at the
 * "requires a rebuild" setup state).
 */
export function isConnectorInstalled(packageId: string): boolean {
  // Own-key membership only — never an inherited prototype key (e.g.
  // "constructor") that `in` would falsely report as an installed connector.
  return Object.hasOwn(STATIC_EXTENSION_MANIFEST, packageId);
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
