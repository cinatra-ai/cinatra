import "server-only";

// Host-side LAZY resolution of the WordPress widget-auth capability
// (cinatra#975 Wave 2 — the vendor-publish-direction inversion, epic #978).
//
// The wordpress-mcp-connector now OWNS the widget auth-config store — the
// UUID-pair api key + webhook secret persisted under
// `connector_config:wordpress_widget_auth` — and REGISTERS it as the
// `@cinatra-ai/host:wordpress-widget-auth` capability provider from its
// `register(ctx)`, persisting through the host `@cinatra-ai/host:connector-config`
// capability. The vendor store module (`@/lib/wordpress-widget-auth`) is GONE
// from core. Core's server-to-server surfaces (POST /api/connect/token,
// POST /api/webhooks/wordpress) resolve the store HERE at call time — never by
// value-importing the vendor module.
//
// FAIL-LOUD degradation (never silent): provider absent (the connector not
// installed/active) → `resolveWordPressWidgetAuth()` returns null and
// `requireWordPressWidgetAuth()` THROWS a descriptive error. The two former
// import sites use the fail-loud `require()` so a missing connector surfaces
// LOUDLY (a logged internal error / 500) rather than silently minting a
// credential or accepting an unverifiable webhook. Mirrors the
// `blog-system-provider` / `email-transport-provider` resolver shape (the
// nango-system model: register at activation, resolve lazily, fail loud).
//
// NOTE the capability id keeps its `@cinatra-ai/host:` prefix for continuity —
// it is the SAME id the host previously published under and the id both the
// connector's own `dev-setup` hook and this resolver read; only the PUBLISH
// DIRECTION inverted (the connector now registers it). The id string is a
// literal, never an import specifier, so it carries no vendor-import coupling.

import type { HostWordPressWidgetAuthService } from "@cinatra-ai/sdk-extensions";
import { resolveCapabilityProviders } from "@/lib/extension-capabilities-registry";

// Inlined string literal (the SAME id the connector registers under and
// `HOST_CONNECTOR_SERVICE_CAPABILITIES.wordpressWidgetAuth` holds) — a literal,
// never an import specifier, so it carries no vendor-import coupling and no
// barrel-init edge.
const WORDPRESS_WIDGET_AUTH_CAPABILITY = "@cinatra-ai/host:wordpress-widget-auth";

// The SOLE sanctioned owner of this capability (cinatra#975 Wave 2). The id
// keeps its `@cinatra-ai/host:` prefix for continuity, so we pin the OWNING
// package too (codex): another active extension holding the `capabilities` port
// cannot spoof/collide this singleton store by registering under the same id.
const WORDPRESS_WIDGET_AUTH_OWNER = "@cinatra-ai/wordpress-mcp-connector";

// Structural guard: a capability impl is `unknown` by contract (the registry
// stores `unknown`; the runtime trust boundary is HERE, not the compile type).
function isWordPressWidgetAuthProvider(
  impl: unknown,
): impl is HostWordPressWidgetAuthService {
  const candidate = impl as Partial<HostWordPressWidgetAuthService> | null;
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof candidate.read === "function" &&
    typeof candidate.generate === "function"
  );
}

/** The live WordPress widget-auth store, or null when the connector is absent.
 * Pinned to the owning package AND the structural guard — never a same-id
 * provider from any other extension. */
export function resolveWordPressWidgetAuth(): HostWordPressWidgetAuthService | null {
  const match = resolveCapabilityProviders(WORDPRESS_WIDGET_AUTH_CAPABILITY).find(
    (p) => p.packageName === WORDPRESS_WIDGET_AUTH_OWNER && isWordPressWidgetAuthProvider(p.impl),
  );
  return (match?.impl as HostWordPressWidgetAuthService | undefined) ?? null;
}

/** Fail-loud resolution for the server-to-server surfaces that cannot proceed
 * without the store (the connect/token webhook-secret ensure; the wordpress
 * webhook receiver's shared-secret read). */
export function requireWordPressWidgetAuth(): HostWordPressWidgetAuthService {
  const provider = resolveWordPressWidgetAuth();
  if (!provider) {
    throw new Error(
      "WordPress widget-auth capability unavailable — the wordpress-mcp-connector " +
        "extension is not installed/active. Install/activate it before the " +
        "connect-token or wordpress-webhook surfaces can resolve widget credentials.",
    );
  }
  return provider;
}
