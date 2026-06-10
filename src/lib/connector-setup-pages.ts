import "server-only";

import type { ComponentType } from "react";
import type { ExtensionHostContext } from "@cinatra-ai/sdk-extensions";
import { CONNECTOR_DESCRIPTORS } from "@cinatra-ai/connectors-catalog/descriptors.mjs";
import { GENERATED_CONNECTOR_SETUP_PAGES } from "@/lib/generated/connector-setup-pages";

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

// Static loader map for connector setup pages. Mirrors the pattern used by
// `src/app/plugins-registry.tsx`: literal dynamic imports keyed by slug, no
// computed `import(\`@cinatra-ai/${slug}/setup-page\`)` calls (Turbopack rejects).
//
// Placeholder loaders throw until each connector provides a real setup-page
// module. Once a real setup-page exists, replace the placeholder with
// `() => import("@cinatra-ai/<slug>/setup-page")`.
const PLACEHOLDER_SETUP_PAGE_LOADER: ConnectorSetupPageLoader = async () => {
  throw new Error(
    "Connector setup page not yet migrated to an extension setup module.",
  );
};

const SETUP_PAGE_LOADERS: Record<string, ConnectorSetupPageLoader> = {
  // Adapter-wrapped existing settings pages.
  "openai-connector": () => import("@cinatra-ai/openai-connector/setup-page"),
  "apollo-connector": () => import("@cinatra-ai/apollo-connector/setup-page"),
  "linkedin-connector": () => import("@cinatra-ai/linkedin-connector/setup-page"),
  "youtube-connector": () => import("@cinatra-ai/youtube-connector/setup-page"),
  "wordpress-mcp-connector": () => import("@cinatra-ai/wordpress-mcp-connector/setup-page"),
  "drupal-mcp-connector": () => import("@cinatra-ai/drupal-mcp-connector/setup-page"),
  "wordpress-assistant-connector": () =>
    import("@cinatra-ai/wordpress-assistant-connector/setup-page"),
  "drupal-assistant-connector": () =>
    import("@cinatra-ai/drupal-assistant-connector/setup-page"),
  "twenty-connector": () => import("@cinatra-ai/twenty-connector/setup-page"),
  "github-connector": () => import("@cinatra-ai/github-connector/setup-page"),
  // Anthropic API setup lives in its own extension package. The mcp-client
  // connector owns inbound MCP-client OAuth client management; its loader
  // resolves through the GENERATED manifest map instead of a hand-pinned
  // package import (the rename pilot for the loader-map cutover — renamed
  // entries must not re-pin the package-name literal in core).
  "anthropic-connector": () =>
    import("@cinatra-ai/anthropic-connector/setup-page"),
  "mcp-client-connector": GENERATED_CONNECTOR_SETUP_PAGES[
    "mcp-client-connector"
  ] as ConnectorSetupPageLoader,
  // Gemini setup-page lives inside the extension package.
  "gemini-connector": () => import("@cinatra-ai/gemini-connector/setup-page"),
  // Google Calendar setup-page subsumes Appointment Schedules. The
  // `/connectors/google-calendar/` and `/connectors/appointment-schedules/`
  // host routes are no longer present.
  "google-calendar-connector": () =>
    import("@cinatra-ai/google-calendar-connector/setup-page"),
  // A2A and Google OAuth setup pages are first-class extensions. A2A wraps the
  // existing Nango a2aServer storage; Google OAuth is setup-page only, while
  // runtime stays at @cinatra-ai/google-oauth-connection.
  "a2a-server-connector": () =>
    import("@cinatra-ai/a2a-server-connector/setup-page"),
  "google-oauth-connector": () =>
    import("@cinatra-ai/google-oauth-connector/setup-page"),
  // Gmail, Apify, and Tailscale setup pages are owned by their extension
  // packages.
  "gmail-connector": () => import("@cinatra-ai/gmail-connector/setup-page"),
  "apify-connector": () => import("@cinatra-ai/apify-connector/setup-page"),
  "tailscale-connector": () =>
    import("@cinatra-ai/tailscale-connector/setup-page"),
};

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
  return SETUP_PAGE_LOADERS[slug] ?? null;
}

/**
 * Strict resolver — throws when the slug has no loader. Use this only on the
 * bundled-react dispatch path where a loader is REQUIRED. Prefer
 * `getConnectorSetupPageLoader` (optional) when listing/registering a connector
 * whose UI surface may be `schema-config`.
 */
export function loadConnectorSetupPage(slug: string): ConnectorSetupPageLoader {
  const loader = SETUP_PAGE_LOADERS[slug];
  if (!loader) {
    throw new Error(`Unknown connector slug: ${slug}`);
  }
  return loader;
}

export function hasConnectorSetupPage(slug: string): boolean {
  return slug in SETUP_PAGE_LOADERS;
}

export function listConnectorSetupPageSlugs(): string[] {
  return Object.keys(SETUP_PAGE_LOADERS);
}

// Parity invariant: every catalog descriptor that ships a React setup page must
// have a matching loader-map entry, and every loader entry must map to a catalog
// descriptor. A `schema-config` descriptor (per `requiresSetupPageLoader`) is
// EXEMPT from needing a loader — it renders from `cinatra.configSchema`, not a
// React module. Tested by setup-pages-parity.test.ts.
export function assertSetupPagesParityWithCatalog(
  requiresSetupPageLoader: (slug: string) => boolean = () => true,
): void {
  const catalogSlugs = new Set(CONNECTOR_DESCRIPTORS.map((d) => d.slug));
  const loaderSlugs = new Set(Object.keys(SETUP_PAGE_LOADERS));
  for (const slug of catalogSlugs) {
    if (!requiresSetupPageLoader(slug)) continue; // schema-config: no loader needed
    if (!loaderSlugs.has(slug)) {
      throw new Error(
        `Connector catalog drift: descriptor for "${slug}" has no loader entry in connector-setup-pages.ts`,
      );
    }
  }
  for (const slug of loaderSlugs) {
    if (!catalogSlugs.has(slug)) {
      throw new Error(
        `Connector catalog drift: loader entry for "${slug}" has no descriptor in @cinatra-ai/connectors-catalog`,
      );
    }
  }
}
