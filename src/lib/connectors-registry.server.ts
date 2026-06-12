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
  /** Manifest-resolved dispatch-route href for the connector's setup surface. */
  setupHref: string;
};

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
