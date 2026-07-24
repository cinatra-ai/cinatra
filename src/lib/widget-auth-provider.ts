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
//
// MARKETPLACE-INSTALL-PROVENANCE ARM (arm (c), owner ruling 2026-07-23 — the
// widget-auth delivery fix, path B). The grant arm (b) still fails closed for a
// real released-image rider: the host loader reconstructs the connector's live
// provider + trusted-signed + trusted install anchor on EVERY boot, but the
// admin ownership GRANT row is written only by the interactive install
// pipeline's auto-approve — an auto-staged rider never gets one, so arm (b)
// resolves nothing forever. Arm (c) closes this by deriving ownership from
// SANCTIONED marketplace-install provenance rooted OUTSIDE the writable store:
// the UNIQUE signed+activated, live-provider package whose TRUSTED
// `installed_extension` anchor + integrity-verified materialized manifest
// DECLARES the `wordpress_widget_auth` store key (full rule P1–P6 + the
// write-/data/extensions threat model in `widget-auth-install-provenance.ts`).
// It is a FALLBACK: consulted ONLY when the build ∪ grant union is EMPTY, so the
// baked (dev) path is provably unchanged and a rogue provenance declarer can
// never DoS a legitimate baked/granted owner into ambiguity. Same fail-closed,
// error-logged posture as arm (b); same GLOBAL org-agnostic scope.

import type { HostWordPressWidgetAuthService } from "@cinatra-ai/sdk-extensions";
import {
  resolveCapabilityProviders,
  isPackageSignedActivated,
} from "@/lib/extension-capabilities-registry";
import { GENERATED_WIDGET_STREAM_AGENTS } from "@/lib/generated/extensions.server";
import {
  resolveOwnershipOwner,
  readOwnershipGrant,
  type OwnershipGrantDeps,
} from "@/lib/extension-capability-ownership-grants";
import {
  resolveInstallProvenanceOwner,
  type InstallProvenanceDeps,
} from "@/lib/widget-auth-install-provenance";

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
  /** Threaded into the marketplace-install-PROVENANCE fallback arm (arm (c),
   * owner ruling 2026-07-23) so the unauthenticated resolver is unit-testable
   * without a pg pool / on-disk store. Production callers pass nothing. */
  installProvenanceDeps?: InstallProvenanceDeps;
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
 * ARM (c) — the marketplace-install-PROVENANCE owner (owner ruling 2026-07-23,
 * the widget-auth delivery fix). A FALLBACK consulted ONLY when neither the
 * baked declarer (arm (a)) nor an admin ownership grant (arm (b)) resolves an
 * owner — i.e. exactly the released-image gap where the wordpress connector is a
 * runtime-installed marketplace rider that the loader activated (live provider +
 * trusted-signed + trusted install anchor) but for which no ownership grant was
 * ever recorded. Ownership derives from SANCTIONED install provenance rooted
 * OUTSIDE the writable store (the canonical `installed_extension` anchor +
 * store integrity + trusted-signed + the verified manifest's own store
 * declaration), never from arbitrary runtime registration and never from
 * path-scanning trust — see `widget-auth-install-provenance.ts` for the full
 * fail-closed rule (P1–P6) and threat model. FAIL CLOSED on any lookup error
 * (a swallowed error is logged so a DB/store-IO failure never silently masks the
 * provenance arm; the baked / grant arms are unaffected).
 */
async function resolveInstallProvenanceWidgetAuthOwner(
  deps?: WidgetAuthResolveDeps,
): Promise<string | null> {
  try {
    const resolved = await resolveInstallProvenanceOwner(
      {
        capability: WORDPRESS_WIDGET_AUTH_CAPABILITY,
        tokenConfigKey: WORDPRESS_WIDGET_AUTH_TOKEN_CONFIG_KEY,
        providerGuard: isWordPressWidgetAuthProvider,
      },
      deps?.installProvenanceDeps,
    );
    if (!resolved) return null;
    const { packageName: owner, orgId: ownerOrgId } = resolved;
    // GRANT-DECISION VETO (codex final round + org-scope fix, owner ruling
    // 2026-07-23). Arm (c) runs whenever the build ∪ grant union is EMPTY — but
    // arm (b) also returns null for a grant that is explicitly `revoked` (an admin
    // killed this package's ownership) or `pending` (an admin has not approved
    // it). Provenance MUST NOT override such an explicit admin decision.
    //
    // ORG SCOPE. Ownership grants for an org-anchored install are written at the
    // install's ORG, but the runtime arm (b) reads the GLOBAL (`org_id IS NULL`)
    // row — so an org-scoped revoke/pending decision was previously MISSED by a
    // global-only veto. Veto at BOTH the anchor's derived org (surfaced by the
    // provenance resolver) AND global: if a grant row exists at EITHER scope that
    // is NOT `approved`, fail closed. Only the NO-ROW-at-either-scope case (the
    // auto-staged rider that never had a grant recorded) is honored. A same-scope
    // `approved` row would have made arm (b) resolve, so arm (c) would not be
    // consulted — the `approved` pass here is defensive.
    const vetoScopes: (string | null)[] = ownerOrgId != null ? [ownerOrgId, null] : [null];
    for (const scope of vetoScopes) {
      const grant = await readOwnershipGrant(
        {
          packageName: owner,
          orgId: scope,
          tokenConfigKey: WORDPRESS_WIDGET_AUTH_TOKEN_CONFIG_KEY,
        },
        deps?.ownershipGrantDeps,
      );
      if (grant && grant.status !== "approved") return null;
    }
    return owner;
  } catch (err) {
    console.error(
      "[widget-auth-provider] marketplace-install-provenance lookup failed (failing closed on the " +
        "provenance arm; the build-time and grant owner arms are unaffected):",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * The SOLE sanctioned owner of the widget-auth credential store. The UNION of
 * the build-time (baked) declarer (arm (a)) and the runtime admin-granted owner
 * (arm (b)) is resolved FIRST: exactly one distinct owner → that owner; >1 (a
 * baked/grant conflict) → null (fail closed, unchanged). ONLY when that union is
 * EMPTY — neither baked nor admin-granted, the released-image rider gap — is the
 * marketplace-install-PROVENANCE fallback (arm (c)) consulted, itself
 * unique-or-fail-closed. Every arm retains anti-spoof: arm (a) pins to the
 * reviewed generated tree; arm (b) requires a signed, approved-grant,
 * live-provider package; arm (c) requires a signed, trusted-anchor +
 * integrity-verified, store-declaring, live-provider package (P1–P6). The
 * fallback ordering means the baked (dev) path is provably unchanged — arm (c)
 * never runs while a baked owner resolves — and a legitimate baked/granted owner
 * can never be DoS'd into ambiguity by a rogue install-provenance declarer.
 */
async function resolveWordPressWidgetAuthOwner(
  deps?: WidgetAuthResolveDeps,
): Promise<string | null> {
  const owners = new Set<string>();
  const buildTime = resolveBuildTimeWidgetAuthOwner();
  if (buildTime) owners.add(buildTime);
  const runtime = await resolveRuntimeWidgetAuthOwner(deps);
  if (runtime) owners.add(runtime);
  if (owners.size === 1) return owners.values().next().value ?? null;
  if (owners.size > 1) return null; // baked/grant conflict → fail closed
  // Union empty → the released-image rider gap: consult the install-provenance
  // fallback (arm (c)), unique-or-fail-closed.
  return resolveInstallProvenanceWidgetAuthOwner(deps);
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
            "manifest declarer, nor a signed admin-granted runtime connector, " +
            "nor a signed marketplace-installed connector with a trusted install " +
            "anchor + integrity-verified store declaring the token key — so no " +
            "provider can be trusted (fail-closed)."),
    );
  }
  return provider;
}
