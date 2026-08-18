import "server-only";

import type {
  KnownCapabilityId,
  ResolvedCapabilityProvider,
} from "@cinatra-ai/sdk-extensions";

// Generic, host-owned capability-provider registry.
//
// A connector advertises what it can DO behind a CAPABILITY facade (e.g. the
// `email-send` capability is served by `resend` OR `gmail`) instead of dependents
// importing a concrete sibling package. At `register(ctx)` an extension calls
// `ctx.capabilities.registerProvider(capability, { packageName, impl })`; a
// consumer calls `ctx.capabilities.resolveProviders(capability)` to get the live
// providers — neither side imports the other's package.
//
// This registry is HOST-OWNED and imports NO connector. It REPLACES the prototype
// `makeCapabilities` that hardcoded the `email-send` capability and imported
// `@cinatra-ai/email-connector` directly (the host itself was violating the
// extension-boundary rule). Providers are now data, registered at activation —
// never baked into the host.
//
// Active-manifest gating is realized by the LIFECYCLE — not a resolve-time DB
// read (`resolveProviders` is synchronous by ABI):
//   - REGISTRATION is activation-gated: an archived/uninstalled extension never
//     activates (the StaticBundleLoader archived-row tombstone gate), so it never
//     calls `registerProvider` — its provider is never in the registry.
//   - TEARDOWN: `invalidateProvidersForPackage(pkg)` drops every provider a
//     package registered, across all capabilities. The host wires it into the
//     extension capability-teardown hook (`src/lib/extensions.ts`), which the
//     purge saga fires after the DB delete commits.
// Therefore the set of registered providers IS the set of live providers, and
// `resolveProviders` returns exactly that — mirroring the proven
// `extension-mcp-registry` (register-on-activate / removeByPackage-on-teardown)
// model. (Live archive-without-restart of a compiled extension is a
// runtime-installer concern; there is no such transition for a compiled extension.)

export type CapabilityProvider = {
  packageName: string;
  impl: unknown;
};

// capability -> (packageName -> provider). One provider per package per
// capability; a re-registration REPLACES (idempotent — boot may re-activate).
//
// CROSS-COMPILATION SINGLETON: Next.js 16 builds separate bundler compilations
// (instrumentation / route / RSC), each with its own module cache. Extensions
// register providers at boot/activation (instrumentation compilation); consumers
// resolve them at request time (route / RSC compilation) — so the registry MUST
// be a true per-process singleton, anchored on a namespaced+versioned
// `Symbol.for(...)` key (same pattern as `extension-mcp-registry`). A plain
// module-level `const` Map would be re-instantiated per compilation, so post-boot
// registrations would be invisible to the compilation that resolves them.
const CAPABILITY_REGISTRY_KEY = Symbol.for(
  "@cinatra-ai/host:extension-capabilities-registry/v1",
);
type CapabilityRegistryHolder = {
  [k: symbol]: Map<string, Map<string, CapabilityProvider>> | undefined;
};
const _holder = globalThis as unknown as CapabilityRegistryHolder;
const registry: Map<string, Map<string, CapabilityProvider>> =
  _holder[CAPABILITY_REGISTRY_KEY] ??
  (_holder[CAPABILITY_REGISTRY_KEY] = new Map<string, Map<string, CapabilityProvider>>());

/**
 * Register (or idempotently replace) a provider for a capability. Keyed by
 * `packageName` so re-activation of the same package is a no-op replace, never
 * a duplicate.
 */
export function registerCapabilityProvider(
  capability: string,
  provider: CapabilityProvider,
): void {
  if (!provider?.packageName) {
    throw new Error(
      `[capabilities] a provider for "${capability}" was registered with no packageName`,
    );
  }
  let byPackage = registry.get(capability);
  if (!byPackage) {
    byPackage = new Map<string, CapabilityProvider>();
    registry.set(capability, byPackage);
  }
  byPackage.set(provider.packageName, provider);
}

/**
 * Resolve the live providers for a capability. The registered set IS the live
 * set (registration is activation-gated; teardown invalidates), so this returns
 * a fresh array of the registered providers (callers may sort/filter without
 * mutating the registry).
 *
 * ADDITIVE typed overload (mirrors `HostCapabilitiesPort.resolveProviders`): for
 * a first-party capability id KNOWN to `CapabilityContractMap` the returned
 * `impl` is typed to the mapped surface, so the host's resolver modules stop
 * hand-writing `impl as Partial<TSurface>`. The open `string` overload is kept
 * (returns `impl: unknown`). This narrows the COMPILE type only — the registry
 * still stores `unknown`, so the structural `isXSurface` guards in those modules
 * remain the runtime trust boundary.
 */
export function resolveCapabilityProviders<Id extends KnownCapabilityId>(
  capability: Id,
): ResolvedCapabilityProvider<Id>[];
export function resolveCapabilityProviders(capability: string): CapabilityProvider[];
export function resolveCapabilityProviders(capability: string): CapabilityProvider[] {
  const byPackage = registry.get(capability);
  if (!byPackage) return [];
  return [...byPackage.values()];
}

/**
 * Remove every provider a package registered, across all capabilities. The host
 * wires this into the extension capability-teardown hook
 * (`src/lib/extensions.ts`), which the purge saga fires after the DB delete
 * commits — so a removed extension leaves no stale provider.
 */
export function invalidateProvidersForPackage(packageName: string): void {
  for (const byPackage of registry.values()) {
    byPackage.delete(packageName);
  }
}

/** Whether a package has ANY registered capability provider (across all
 *  capabilities). Used by the capability-teardown hook to include a provider-only
 *  package in the control-plane generation bump guard — capability providers are
 *  in the operator snapshot, so their removal IS an observable control-plane change
 *  (the invalidate is a void delete with no count of its own). */
export function hasCapabilityProvidersForPackage(packageName: string): boolean {
  for (const byPackage of registry.values()) {
    if (byPackage.has(packageName)) return true;
  }
  return false;
}

/**
 * A read-only diagnostic snapshot of the registered providers (capability id +
 * owning packageName only — never the opaque `impl`). For the operator
 * control-plane endpoint; exposes WHAT is live, not the implementations.
 */
export function snapshotCapabilityProviders(): { capability: string; packageName: string }[] {
  const out: { capability: string; packageName: string }[] = [];
  for (const [capability, byPackage] of registry) {
    for (const packageName of byPackage.keys()) {
      out.push({ capability, packageName });
    }
  }
  return out;
}

/** Test/teardown helper — clears all providers AND the co-located
 * signed-activated markers and serving records below, so a "reset this registry
 * module" in a test leaves NO residual state (a stale signed marker outliving a
 * provider reset could otherwise bleed the fail-closed trust signal across
 * tests). Use `__resetSignedTrustedRegistry()` / `__resetServingRecords()` for a
 * targeted reset. */
export function __resetCapabilityRegistry(): void {
  registry.clear();
  signedTrustedRegistry.clear();
  servingRecords.clear();
}

// ---------------------------------------------------------------------------
// Signed-activated package registry (engineering#534 S1)
// ---------------------------------------------------------------------------
//
// Per-process record of the runtime-installed packages that reached
// `trusted-signed` AND SUCCESSFULLY ACTIVATED (registered/bootstrapped) in this
// process. Co-located HERE — rather than in a standalone module — because its
// lifecycle is lockstep-coupled to the capability providers above (it is cleared
// in the SAME `teardownExtensionCapabilities` chokepoint that invalidates a
// package's providers) and because a standalone module would add a net-new
// route-reachable first-party module to the baselined dev-perf route-graph
// (this registry is already in every relevant graph). Its own namespaced
// `Symbol.for(...)` singleton keeps it independent of the provider Map.
//
// WHY IT EXISTS. The widget-auth owner resolver (`widget-auth-provider.ts`)
// must, for a MARKETPLACE-installed connector, confirm the runtime owner
// currently classifies `trusted-signed` before it may own a credential store —
// a `trusted-bootstrap`/`untrusted` package can never own one (the same bar the
// install pipeline enforces for the auto-approve of a capability-ownership
// grant). The two consuming surfaces (`/api/connect/token`,
// `/api/webhooks/wordpress`) are UNAUTHENTICATED, server-to-server, and carry NO
// actor/org context, so the actor-scoped runtime trust gate cannot serve them.
// The only authoritative `trusted-signed` verdict for a runtime-installed
// package is produced by the `runtime-package-loader` at activation; this
// registry PUBLISHES that verdict for actor-free request-time lookup.
//
// TRUST CONTRACT (codex-converged, engineering#534 S1):
//   - A package is marked ONLY after the loader SUCCESSFULLY activated it
//     (registered/bootstrapped, no failed result) with a `trusted-signed`
//     verdict. The loader's pre-activation `signedTrustedNames` alone is NOT
//     sufficient: a package can classify signed then FAIL at bootstrap, so
//     publishing before final activation success would let a partially-failed
//     provider satisfy this credential-store trust boundary.
//   - The marker is CLEARED in the SAME teardown chokepoint that removes a
//     package's capability providers, so an archived/uninstalled/re-activated
//     package's stale signed marker never outlives its live providers.
//   - Reads FAIL CLOSED: an unmarked package is NOT trusted-signed (false), so a
//     missing/lost marker denies ownership rather than granting it.
//
// IDENTITY BASIS. mark / clear / isPackageSignedActivated key on the raw
// `packageName` string — the SAME host-injected canonical package name the
// provider Map above is keyed by (the loader's activation-result packageName, the
// teardown chokepoint's packageName, and the grant row's package_name all derive
// from that one materialized-manifest identity). Consistency across the three
// call-sites is what makes the fail-closed check exact; a divergent normalization
// at any site would fail closed on read or leave a stale marker on clear.

const SIGNED_TRUSTED_REGISTRY_KEY = Symbol.for(
  "@cinatra-ai/host:extension-signed-trusted-registry/v1",
);
type SignedTrustedRegistryHolder = {
  [SIGNED_TRUSTED_REGISTRY_KEY]?: Set<string>;
};
const _signedHolder = globalThis as unknown as SignedTrustedRegistryHolder;
const signedTrustedRegistry: Set<string> =
  _signedHolder[SIGNED_TRUSTED_REGISTRY_KEY] ??
  (_signedHolder[SIGNED_TRUSTED_REGISTRY_KEY] = new Set<string>());

/**
 * Mark a package as having SUCCESSFULLY activated at the `trusted-signed` tier.
 * Called by the runtime-package-loader ONLY for a package whose activation
 * succeeded (registered/bootstrapped, no failure) and whose trust verdict was
 * `trusted-signed` — never from the pre-activation classification alone.
 */
export function markPackageSignedActivated(packageName: string): void {
  if (packageName) signedTrustedRegistry.add(packageName);
}

/**
 * Clear a package's signed-activated marker. Wired into the capability-teardown
 * chokepoint (`teardownExtensionCapabilities`), so it fires on every retire path
 * (archive / uninstall / force-delete / purge) and the defensive pre-reactivate
 * teardown — keeping the marker's lifecycle identical to the capability
 * providers it guards.
 */
export function clearPackageSignedActivated(packageName: string): void {
  signedTrustedRegistry.delete(packageName);
}

/**
 * Whether a package is CURRENTLY a successfully-activated `trusted-signed`
 * runtime package. Fail-closed: an unmarked package returns false. The widget-
 * auth owner resolver's runtime arm requires this before a marketplace-installed
 * connector may own the credential store.
 */
export function isPackageSignedActivated(packageName: string): boolean {
  return signedTrustedRegistry.has(packageName);
}

/** Test/teardown helper — clears every signed-activated marker. */
export function __resetSignedTrustedRegistry(): void {
  signedTrustedRegistry.clear();
}

// ---------------------------------------------------------------------------
// SERVING-PROVENANCE RECORD (cinatra#2762)
// ---------------------------------------------------------------------------
//
// WHICH IMPLEMENTATION OF A PACKAGE IS ACTUALLY IN SERVICE, and at which
// version.
//
// THE DEFECT IT EXISTS FOR. A package can hold a live marketplace install row
// that never registered — the bytes are materialized and the canonical row says
// `active`, but activation was refused (an untrusted registry, a missing signing
// key, a module that threw) and the implementation bundled in the image is what
// serves every request. #2762 is named for that state, and the product could not
// name it: the settings page read the version off the ROW and reported
// "Currently on version 0.1.5 — up to date" while 0.1.0 was serving, with
// Activate greyed "Already active".
//
// The row could not answer the question. `installed_extension.status` is the
// LIFECYCLE fact (has an operator archived it?), not the RUNTIME fact (did it
// register?), and nothing in the process recorded the difference: the provider
// Map above — like the MCP-tool, ctx.ui and object-type registries — is keyed by
// PACKAGE NAME and holds no provenance, so "is something serving this package?"
// was answerable and "WHAT is serving it?" was not. Boot reconciliation knew,
// but only within its own boot pass (`activatedThisBoot`), which no request-time
// surface can read.
//
// So each activation seam records what it put in service, right where it already
// knows the version: the StaticBundleLoader records the image's, the
// RuntimePackageLoader records the install's. The record is the PROVENANCE of
// the registrations that are live NOW.
//
// CO-LOCATED HERE for exactly the reason the signed-activated markers above are:
// its lifecycle is lockstep-coupled to those registrations (it is cleared in the
// SAME `teardownExtensionCapabilities` chokepoint), and a standalone module
// would add a net-new route-reachable first-party module to the baselined
// dev-perf route-graph — whose ceilings may only ever shrink. This registry is
// already in every relevant graph. Its own namespaced `Symbol.for(...)`
// singleton keeps it independent of the provider Map.
//
// IT IS DESCRIPTIVE, NEVER LOAD-BEARING — the one way it differs from the signed
// marker, which IS a trust boundary. Nothing gates, resolves, activates or
// refuses on this record; it exists so a surface can TELL AN OPERATOR what is
// happening. Every consumer must treat an absent record as UNKNOWN and say
// nothing rather than guess, because absence is a legitimate state: a
// metadata-only package registers no server module at all, a record written
// before a restart is gone, and a process that never ran a loader (a unit test,
// a build-time render) has nothing to report. Reporting "not in service" on
// absence would put a false alarm on every healthy skill and agent.
//
// CROSS-COMPILATION SINGLETON, as with every registry in this file: the loaders
// write at boot/activation (instrumentation compilation) and the settings
// surface reads at request time (RSC compilation).

/**
 * WHERE the implementation now serving a package came from.
 *
 * `bundled` — the copy that ships in the image, activated by the
 * StaticBundleLoader (at boot, or by the targeted reactivation seam a rollback
 * and the post-failure compensation use).
 * `install` — a materialized marketplace install, activated by the
 * RuntimePackageLoader (at boot, or by a targeted in-process activation).
 */
export type ServingOrigin = "bundled" | "install";

export type ServingRecord = {
  origin: ServingOrigin;
  /** The version that registered, or null when the seam could not name one. */
  version: string | null;
};

const SERVING_RECORD_REGISTRY_KEY = Symbol.for(
  "@cinatra-ai/host:extension-serving-record/v1",
);
type ServingRecordHolder = { [SERVING_RECORD_REGISTRY_KEY]?: Map<string, ServingRecord> };
const _servingHolder = globalThis as unknown as ServingRecordHolder;
const servingRecords: Map<string, ServingRecord> =
  _servingHolder[SERVING_RECORD_REGISTRY_KEY] ??
  (_servingHolder[SERVING_RECORD_REGISTRY_KEY] = new Map<string, ServingRecord>());

/**
 * Record that `origin`'s `version` of `packageName` is now in service.
 *
 * Called ONLY after a registration succeeded — the same bar
 * {@link markPackageSignedActivated} holds to, and for the same reason: a
 * package emits ONE result per phase, so a register-passes/bootstrap-throws
 * activation yields both a success and a failure, and recording on the success
 * alone would claim a half-activated version is serving.
 *
 * Idempotent and LAST-WRITE-WINS, which is the truth: at boot the bundled record
 * activates first and the install's activation then REPLACES it (the loader
 * tears the previous registrations down before it registers), so the last
 * successful writer is whoever owns the package's names right now. A REFUSED
 * install writes nothing, so the bundled record stands — which is precisely what
 * makes the #2762 state nameable.
 *
 * A blank / absent version is stored as `null` rather than `""`, so a consumer
 * cannot compare an empty string against a real version and call them different.
 */
export function recordServingImplementation(input: {
  packageName: string;
  origin: ServingOrigin;
  version?: string | null;
}): void {
  if (!input.packageName) return;
  const version =
    typeof input.version === "string" && input.version.length > 0 ? input.version : null;
  servingRecords.set(input.packageName, { origin: input.origin, version });
}

/**
 * What is serving `packageName` in THIS process, or null when nothing recorded
 * it. Null means UNKNOWN — never "nothing is serving it".
 */
export function readServingRecord(packageName: string): ServingRecord | null {
  return servingRecords.get(packageName) ?? null;
}

/**
 * Drop a package's serving record. Wired into the capability-teardown chokepoint
 * alongside {@link clearPackageSignedActivated}, so the record is cleared in
 * lockstep with the registrations it DESCRIBES and can never outlive them.
 * Returns whether a record was actually removed.
 */
export function clearServingRecordForPackage(packageName: string): boolean {
  return servingRecords.delete(packageName);
}

// THERE IS DELIBERATELY NO SECOND ACCESSOR (cinatra#2762 round-5 convergence).
// A `snapshotServingRecords()` lived here briefly, exported and used by nothing
// but its own test. It cost more than it was worth: the "nothing GATES on this
// record" enforcement is a source scan for the accessor names, so every extra
// exported way to reach the map is another way to read it that the scan has to
// know about — and an export nobody imports is not diagnostics, it is surface.
// {@link readServingRecord} is the whole read side. If a real diagnostic need
// appears, add the accessor AND add its name to that test's scanned set.

/** Test/teardown helper — clears every serving record. */
export function __resetServingRecords(): void {
  servingRecords.clear();
}
