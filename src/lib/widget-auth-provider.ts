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
//
// RUNTIME OWNER ARM (engineering#534 S1). The build-time derivation above only
// ever sees connectors BAKED into the image (`GENERATED_WIDGET_STREAM_AGENTS`),
// so on a released image a MARKETPLACE-installed wordpress connector never
// becomes the owner and both consuming surfaces fail closed even though the
// connector is installed + registered. S1 adds a SECOND owner arm that consumes
// the admin-approved capability-ownership grant (S0): a runtime-installed
// package owns the credential store ONLY when it (i) holds the UNIQUE `approved`
// ownership grant for the `wordpress_widget_auth` token key at the resolved
// scope, (ii) has a LIVE registered capability provider (structural guard), AND
// (iii) currently classifies `trusted-signed` and successfully activated. The
// two arms are UNIONED unique-or-fail-closed: 0 or >1 distinct owners → null
// (fail closed). The runtime arm resolves at GLOBAL scope (`orgId: null`)
// because the store is the single, org-agnostic `connector_config` singleton and
// both callers are unauthenticated server-to-server surfaces with no org anchor
// — an org-scoped grant must NOT control this global store. All runtime-arm
// lookups FAIL CLOSED on any error (the baked arm is unaffected; a swallowed
// runtime-grant error is logged).

import type { HostWordPressWidgetAuthService } from "@cinatra-ai/sdk-extensions";
import {
  resolveCapabilityProviders,
  isPackageSignedActivated,
} from "@/lib/extension-capabilities-registry";
import { GENERATED_WIDGET_STREAM_AGENTS } from "@/lib/generated/extensions.server";
import {
  resolveOwnershipOwner,
  type OwnershipGrantDeps,
} from "@/lib/extension-capability-ownership-grants";

// Inlined string literal (the SAME id the connector registers under and
// `HOST_CONNECTOR_SERVICE_CAPABILITIES.wordpressWidgetAuth` holds) — a literal,
// never an import specifier, so it carries no vendor-import coupling and no
// barrel-init edge.
const WORDPRESS_WIDGET_AUTH_CAPABILITY = "@cinatra-ai/host:wordpress-widget-auth";

// The connector_config key of the EXACT store this capability wraps (the
// UUID-pair api key + webhook secret row `connector_config:wordpress_widget_auth`)
// — a persisted DATA key, never an extension package name.
const WORDPRESS_WIDGET_AUTH_TOKEN_CONFIG_KEY = "wordpress_widget_auth";

/** Optional dependency injection for the runtime ownership-grant lookup so the
 * unauthenticated-surface resolver is unit-testable without a live pg pool. The
 * production callers pass nothing (the S0 module resolves the real pool). */
export type WidgetAuthResolveDeps = {
  /** Threaded straight into `resolveOwnershipOwner` (S0) for tests. */
  ownershipGrantDeps?: OwnershipGrantDeps;
};

/**
 * ARM (a) — the build-time (baked) declarer. The UNIQUE `packageName` among the
 * generator-emitted `GENERATED_WIDGET_STREAM_AGENTS` entries whose
 * `auth.tokenConfigKey` declares this exact store — i.e. the extension whose
 * reviewed, byte-pinned `cinatra.widgetStream` manifest declaration claims the
 * `wordpress_widget_auth` credential store (core-extension-instance-coupling-ban:
 * core never names a specific extension; the generated tree is the one sanctioned
 * named-extension source). Baked-into-the-image state is inherently host-trusted,
 * so this arm carries NO grant / trusted-signed check — the reviewed generated
 * tree IS the trust decision. Zero or MULTIPLE declaring packages → null.
 */
function resolveBuildTimeWidgetAuthOwner(): string | null {
  const owners = new Set<string>();
  for (const entry of Object.values(GENERATED_WIDGET_STREAM_AGENTS)) {
    if (entry.auth.tokenConfigKey === WORDPRESS_WIDGET_AUTH_TOKEN_CONFIG_KEY) {
      owners.add(entry.packageName);
    }
  }
  if (owners.size !== 1) return null; // absent or ambiguous → fail closed
  return owners.values().next().value ?? null;
}

/**
 * ARM (b) — the runtime (marketplace-installed) owner (engineering#534 S1). A
 * package owns the store at runtime ONLY when ALL hold:
 *   (i)   it is the UNIQUE `approved` capability-ownership grant holder for the
 *         `wordpress_widget_auth` token key at GLOBAL scope (`orgId: null`) — the
 *         store is the org-agnostic `connector_config` singleton and these
 *         callers have no org anchor, so an org-scoped grant must NOT control it;
 *         the S0 DB partial-unique index guarantees at most one approved owner;
 *   (ii)  it has a LIVE registered capability provider satisfying the structural
 *         guard (a mere approved grant with no active provider does not own);
 *   (iii) it CURRENTLY classifies `trusted-signed` and successfully activated
 *         (`isPackageSignedActivated`) — a `trusted-bootstrap`/`untrusted`
 *         package can never own a credential store, even if an admin approved its
 *         grant (the auto-approve is signed-only; a manual approval of a
 *         non-signed package is still refused HERE, fail-closed).
 * FAIL CLOSED on any lookup error (a swallowed error is logged so a DB failure
 * never silently masks the runtime arm while the baked arm still resolves).
 */
async function resolveRuntimeWidgetAuthOwner(
  deps?: WidgetAuthResolveDeps,
): Promise<string | null> {
  try {
    const candidate = await resolveOwnershipOwner(
      { tokenConfigKey: WORDPRESS_WIDGET_AUTH_TOKEN_CONFIG_KEY, orgId: null },
      deps?.ownershipGrantDeps,
    );
    if (!candidate) return null;
    // (ii) a live, structurally-valid provider for this exact package.
    const hasProvider = resolveCapabilityProviders(WORDPRESS_WIDGET_AUTH_CAPABILITY).some(
      (p) => p.packageName === candidate && isWordPressWidgetAuthProvider(p.impl),
    );
    if (!hasProvider) return null;
    // (iii) currently trusted-signed AND successfully activated.
    if (!isPackageSignedActivated(candidate)) return null;
    return candidate;
  } catch (err) {
    console.error(
      "[widget-auth-provider] runtime ownership-grant lookup failed (failing closed on the " +
        "runtime owner arm; the build-time owner arm is unaffected):",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * The SOLE sanctioned owner of the widget-auth credential store — the UNIQUE
 * member of the UNION of the build-time (baked) declarer and the runtime
 * (marketplace-installed, admin-granted, trusted-signed) owner. 0 or >1 distinct
 * owners → null → resolution fails closed. Both arms retain anti-spoof: arm (a)
 * pins to the reviewed generated tree; arm (b) requires a signed, approved-grant,
 * live-provider package.
 */
async function resolveWordPressWidgetAuthOwner(
  deps?: WidgetAuthResolveDeps,
): Promise<string | null> {
  const owners = new Set<string>();
  const buildTime = resolveBuildTimeWidgetAuthOwner();
  if (buildTime) owners.add(buildTime);
  const runtime = await resolveRuntimeWidgetAuthOwner(deps);
  if (runtime) owners.add(runtime);
  if (owners.size !== 1) return null; // absent or ambiguous → fail closed
  return owners.values().next().value ?? null;
}

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

/** The live provider impl for a resolved owner package, pinned to that exact
 * package AND the structural guard — never a same-id provider from any other
 * extension. */
function resolveProviderForOwner(owner: string): HostWordPressWidgetAuthService | null {
  const match = resolveCapabilityProviders(WORDPRESS_WIDGET_AUTH_CAPABILITY).find(
    (p) => p.packageName === owner && isWordPressWidgetAuthProvider(p.impl),
  );
  return (match?.impl as HostWordPressWidgetAuthService | undefined) ?? null;
}

/** The live WordPress widget-auth store, or null when the connector is absent.
 * Pinned to the resolved owning package (build-time OR runtime-granted) AND the
 * structural guard — never a same-id provider from any other extension. */
export async function resolveWordPressWidgetAuth(
  deps?: WidgetAuthResolveDeps,
): Promise<HostWordPressWidgetAuthService | null> {
  const owner = await resolveWordPressWidgetAuthOwner(deps);
  if (!owner) return null;
  return resolveProviderForOwner(owner);
}

/** Fail-loud resolution for the server-to-server surfaces that cannot proceed
 * without the store (the connect/token webhook-secret ensure; the wordpress
 * webhook receiver's shared-secret read). */
export async function requireWordPressWidgetAuth(
  deps?: WidgetAuthResolveDeps,
): Promise<HostWordPressWidgetAuthService> {
  const owner = await resolveWordPressWidgetAuthOwner(deps);
  const provider = owner ? resolveProviderForOwner(owner) : null;
  if (!provider) {
    // The owning connector's name comes from the owner derivation (never a
    // hardcoded package literal); when no unique owner resolves the message
    // says so instead.
    throw new Error(
      "WordPress widget-auth capability unavailable — " +
        (owner
          ? `the owning connector extension (${owner}) is not installed/active. ` +
            "Install/activate it before the connect-token or wordpress-webhook " +
            "surfaces can resolve widget credentials."
          : "no unique trusted owner for the wordpress widget-auth token store " +
            "(`cinatra.widgetStream.auth.tokenConfigKey`) — neither a baked " +
            "manifest declarer nor a signed, admin-granted runtime connector — " +
            "so no provider can be trusted (fail-closed)."),
    );
  }
  return provider;
}
