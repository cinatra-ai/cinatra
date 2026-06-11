import "server-only";

import type { ComponentType } from "react";
import type { ExtensionHostContext } from "@cinatra-ai/sdk-extensions";
import { CONNECTOR_DESCRIPTORS } from "@cinatra-ai/connectors-catalog/descriptors.mjs";
import {
  GENERATED_CONNECTOR_SETUP_PAGES,
  GENERATED_CONNECTOR_SETTINGS_PAGES,
  type GeneratedPageLoader,
} from "@/lib/generated/connector-setup-pages";

// Page-map entries carry the generator-owned `resolution` classification
// (cinatra#7); a guardedOptional page loader RESOLVES the standardized
// degraded result (src/lib/extension-load-guard.ts) when its module is absent
// post-build — the dispatch route detects it (isDegradedExtensionLoad) and
// renders its existing "requires rebuild" state.

export type ConnectorSetupPageProps = {
  packageId: string;
  slug: string;
  searchParams: Record<string, string | string[] | undefined>;
  // Grant-aware host context built by the dispatch route from the manifest's
  // `requestedHostPorts`. Setup pages consume `ctx.<port>.*` instead of
  // importing `@/lib/*` host modules directly. Render-time only — server
  // actions cannot safely close over `ctx` (non-serializable).
  ctx: ExtensionHostContext;
};

export type ConnectorSetupPageComponent = ComponentType<ConnectorSetupPageProps>;

export type ConnectorSetupPageLoader = () => Promise<{
  default: ConnectorSetupPageComponent;
}>;

export type ConnectorSettingsPageLoader = GeneratedPageLoader;

// Loader resolution is fully manifest-driven: the GENERATED maps (regenerated
// from each extension's on-disk declaration by
// scripts/extensions/generate-extension-manifest.mjs) are the source of truth.
// Adding or removing a bundled connector changes the generated maps, never
// this module — the host names no connector package here.

/**
 * Resolve a connector's React setup-page loader, or `null` when the slug has no
 * loader entry. A `schema-config` connector (model B) ships NO React setup page —
 * the host renders it from `cinatra.configSchema` — so it legitimately has no
 * loader and MUST be resolvable (listable/registerable) without one. Only the
 * `bundled-react` dispatch path consumes a loader; it surfaces a "requires
 * rebuild" state when the module is absent from the base image.
 */
export function getConnectorSetupPageLoader(
  slug: string,
): ConnectorSetupPageLoader | null {
  return (GENERATED_CONNECTOR_SETUP_PAGES[slug]?.load as ConnectorSetupPageLoader | undefined) ?? null;
}

/**
 * Strict resolver — throws when the slug has no loader. Use this only on the
 * bundled-react dispatch path where a loader is REQUIRED. Prefer
 * `getConnectorSetupPageLoader` (optional) when listing/registering a connector
 * whose UI surface may be `schema-config`.
 */
export function loadConnectorSetupPage(slug: string): ConnectorSetupPageLoader {
  const loader = getConnectorSetupPageLoader(slug);
  if (!loader) {
    throw new Error(`Unknown connector slug: ${slug}`);
  }
  return loader;
}

export function hasConnectorSetupPage(slug: string): boolean {
  return slug in GENERATED_CONNECTOR_SETUP_PAGES;
}

export function listConnectorSetupPageSlugs(): string[] {
  return Object.keys(GENERATED_CONNECTOR_SETUP_PAGES);
}

/**
 * Resolve a connector's settings-page module loader, or `null` when the
 * connector ships none. The loader resolves the settings-page MODULE (its
 * exports are connector-defined); callers pick the component they need off the
 * loaded module.
 */
export function getConnectorSettingsPageLoader(
  slug: string,
): ConnectorSettingsPageLoader | null {
  return GENERATED_CONNECTOR_SETTINGS_PAGES[slug]?.load ?? null;
}

export function hasConnectorSettingsPage(slug: string): boolean {
  return slug in GENERATED_CONNECTOR_SETTINGS_PAGES;
}

// Parity invariant: every catalog descriptor that ships a React setup page must
// have a matching loader-map entry, and every loader entry must map to a catalog
// descriptor. A `schema-config` descriptor (per `requiresSetupPageLoader`) is
// EXEMPT from needing a loader — it renders from `cinatra.configSchema`, not a
// React module. Tested by connector-setup-pages-parity.test.ts.
export function assertSetupPagesParityWithCatalog(
  requiresSetupPageLoader: (slug: string) => boolean = () => true,
): void {
  const catalogSlugs = new Set(CONNECTOR_DESCRIPTORS.map((d) => d.slug));
  const loaderSlugs = new Set(Object.keys(GENERATED_CONNECTOR_SETUP_PAGES));
  for (const slug of catalogSlugs) {
    if (!requiresSetupPageLoader(slug)) continue; // schema-config: no loader needed
    if (!loaderSlugs.has(slug)) {
      throw new Error(
        `Connector catalog drift: descriptor for "${slug}" has no generated setup-page loader entry`,
      );
    }
  }
  for (const slug of loaderSlugs) {
    if (!catalogSlugs.has(slug)) {
      throw new Error(
        `Connector catalog drift: generated setup-page loader for "${slug}" has no descriptor in @cinatra-ai/connectors-catalog`,
      );
    }
  }
}
