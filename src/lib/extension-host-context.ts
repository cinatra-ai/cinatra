import "server-only";

// The host `ExtensionHostContext` factory.
//
// Builds the privileged port surface the host passes to an extension's
// `register(ctx)` (via the StaticBundleLoader / activateExtensionModule). It is
// GRANT-AWARE: a privileged port is the real wired impl ONLY when the extension
// declared it in `requestedHostPorts`; otherwise it is FAIL-LOUD (throws on
// access) — distinguishing "not granted" (least-privilege denial) from
// "not implemented" (a granted `reserved`-tier port the host factory has not
// wired; driven by the canonical HOST_PORT_TIER table). Ambient ports
// (logger/runtime) are always available.
//
// The prototype is now the REAL host. Every privileged port
// connectors consume is wired to its host service through trusted, org-scoped
// resolution — `settings`/`secrets`/`nango`/`objects`/`mcp`/`jobs`/`notifications`/
// `telemetry` derive the actor + organization from the request/run context
// (`@/lib/extension-host-actor`), NOT from caller input, under any invocation
// path (cookie / MCP / worker / A2A). `capabilities` is a GENERIC, host-owned
// provider registry (`@/lib/extension-capabilities-registry`) that imports no
// connector — replacing the prototype that hardcoded `email-send` and imported
// `@cinatra-ai/email-connector` (the host itself used to violate the boundary).

import type {
  ExtensionHostContext,
  HostLoggerPort,
  HostRuntimePort,
  HostPortName,
  HostUsageEvent,
} from "@cinatra-ai/sdk-extensions";
// (no separate EnvOverrideMap import needed — the port factories consume the
// plain per-port `Record<string,string>` shape `splitEnvOverridesByPort` returns)
// The per-port ABI tier table — the canonical source for the fail-loud
// "not-implemented" branch below (a granted `reserved`-tier port is
// wired-but-unavailable until a future MINOR flips its tier to `stable`).
import { HOST_PORT_TIER } from "@cinatra-ai/sdk-extensions";
// Manifest-declared env-override layer (cinatra#982): validates the RAW
// `cinatra.envOverrides` pass-through carried on the loader record (the
// namespaced-vs-legacy security guard) and splits it into per-port
// (settings/secrets) reverse lookup maps the port factories below consume.
import { validateEnvOverrides, splitEnvOverridesByPort } from "@cinatra-ai/sdk-extensions";
import { getAppRuntimeMode } from "@/lib/runtime-mode";
import { registerExtensionMcpTool } from "@/lib/extension-mcp-registry";
import { deleteConnectorConfig, readConnectorConfigFromDatabase, writeConnectorConfigToDatabase } from "@/lib/database";
import { devFixtureProvenanceKey } from "@/lib/extension-fixture-provenance";
import {
  registerCapabilityProvider,
  resolveCapabilityProviders,
} from "@/lib/extension-capabilities-registry";
// The host-internal SYSTEM capability id(s) — fenced behind the `/internal`
// subpath (host modules are the sanctioned value-importer; see
// packages/sdk-extensions/src/internal.ts). Used to build
// RESERVED_SYSTEM_CAPABILITIES below.
import {
  NANGO_SYSTEM_CAPABILITY,
  HOST_CONNECTOR_SERVICE_CAPABILITIES,
  LLM_PROVIDER_ADAPTER_CAPABILITY,
  LLM_SKILL_DELIVERY_ADAPTER_CAPABILITY,
} from "@cinatra-ai/sdk-extensions/internal";
// The FIRST-PARTY host-build extension set — the packages COMPILED INTO the host
// image (static bundle). Pure DATA (the connector `import()`s are lazy `load()`
// thunks in GENERATED_EXTENSION_SERVER_ENTRIES, not this map), so importing it is
// boot-safe and pulls no connector onto the boot path. Membership is the
// host-owned, build-time first-party trust root that keys reserved-capability
// access (a package compiled into the host is first-party regardless of whether
// it activates via the static bundle OR the runtime package store — cinatra#161
// republishes first-party connectors through the store).
import { STATIC_EXTENSION_MANIFEST } from "@/lib/generated/extensions.server";
import {
  registerExtensionSetupSurface,
  registerExtensionSettingsSurface,
  registerExtensionUiAction,
} from "@/lib/extension-ui-registry";
// Version-keyed serving retention for NON-DEFAULT side-by-side versions
// (cinatra#1392 Gap 1). A non-default sibling's register-channel registrations
// are retained into a version-keyed SINK (owned by the host loader, which threads
// its commit/abort settle) — for edge-bound serving by a resolved dependent —
// instead of being discarded into an inert probe recorder.
import type { VersionKeyedRegistrationSink } from "@/lib/extension-version-keyed-serving";
// cinatra#1392 S8 — the two edge-bound consume seams of the host ctx:
//   - `runWithExtensionCtxIdentity` wraps `ctx.mcp.callPrimitive` so the
//     CALLING extension record's identity (not the outer run's) drives the
//     edge-bound version resolution of the invoked primitive;
//   - `substituteEdgeBoundCapabilityProviders` applies the record's
//     loader-published pre-resolved versioned pins to the SYNC
//     `resolveProviders` (the version-keyed retained provider replaces the
//     default's global registration, fail-closed on torn retention).
import { runWithExtensionCtxIdentity } from "@/lib/extension-ctx-dependent-identity";
import { substituteEdgeBoundCapabilityProviders } from "@/lib/extension-pre-resolved-edges";
import {
  resolveExtensionActorContext,
  resolveExtensionActorSummary,
  requireExtensionOrganizationId,
} from "@/lib/extension-host-actor";
// Imported from the NARROW registry entry point (`@cinatra-ai/objects/registry` —
// zero React / DB / server-only imports per its module header) so object-type
// registration is SYNCHRONOUS. A dynamic `import().then(register)` returns a
// Promise the loader does NOT await (the `HostObjectsPort.registerType` SDK
// contract is `void`, so `register(ctx){ ctx.objects.registerType(...) }` never
// awaits it) — the registration could float past activation. A synchronous
// register completes (and surfaces a failure as a thrown `register-threw`)
// BEFORE `await server.register(ctx)` resolves.
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";
// Host-owned request/response capture backing `HostLoggerPort.capture` /
// `captureDirectory` (cinatra#981) — see the module header there for the full
// rationale (retires extension-side `node:fs` logging).
import { captureExtensionLogEntry, resolveExtensionCaptureDirectory } from "@/lib/extension-log-capture";

// Kept in lockstep with SDK_EXTENSIONS_ABI_VERSION (cinatra#981 bumped 2.2.0 ->
// 2.3.0 for the additive `logger.capture`/`logger.captureDirectory` methods;
// cinatra#1392 bumped 2.3.0 -> 2.4.0 for the additive `objects.resolveType`
// edge-bound object-type consume method).
const ABI_VERSION = "2.4.0";

function makeLogger(packageName: string): HostLoggerPort {
  const tag = `[ext:${packageName}]`;
  return {
    // `tag` embeds the extension-supplied packageName, so it is passed as an
    // ARGUMENT to a constant "%s" format, never as the format string itself
    // (js/tainted-format-string, CWE-134): a packageName containing "%s"/"%d"
    // would otherwise consume the caller's msg/fields and forge log lines.
    // Rendered output is unchanged for every non-format-specifier packageName.
    debug: (msg, fields) => console.debug("%s", tag, msg, fields ?? ""),
    info: (msg, fields) => console.info("%s", tag, msg, fields ?? ""),
    warn: (msg, fields) => console.warn("%s", tag, msg, fields ?? ""),
    error: (msg, fields) => console.error("%s", tag, msg, fields ?? ""),
    // Host-owned capture (cinatra#981): storage/rotation only — the
    // extension gates enabled/opt-in + any redaction itself before calling.
    capture: (channel, entry) => captureExtensionLogEntry(packageName, channel, entry),
    captureDirectory: (channel) => resolveExtensionCaptureDirectory(packageName, channel),
  };
}

function makeRuntime(): HostRuntimePort {
  return {
    mode: getAppRuntimeMode(),
    flag: (name) => {
      if (/SECRET|KEY|TOKEN|PASSWORD|CREDENTIAL|PRIVATE/i.test(name)) return false;
      return process.env[name] === "true" || process.env[name] === "1";
    },
    publicBaseUrl: () =>
      process.env.NEXT_PUBLIC_APP_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? process.env.BETTER_AUTH_URL ?? null,
  };
}

// ---------------------------------------------------------------------------
// capabilities — generic, host-owned provider registry (no connector import).
// ---------------------------------------------------------------------------

// The reserved provider-identity namespace for HOST-published services. Only
// host-trusted DIRECT callers of `registerCapabilityProvider`
// (`register-host-connector-services` / `register-email-providers` /
// `register-blog-providers`) may claim it — never an extension via the
// `ctx.capabilities` port. The exact `@cinatra-ai/host` package and any
// `@cinatra-ai/host:<service>` id are both reserved.
const HOST_RESERVED_PROVIDER_NAMESPACE = "@cinatra-ai/host";

function isReservedHostProviderIdentity(packageName: string): boolean {
  return (
    packageName === HOST_RESERVED_PROVIDER_NAMESPACE ||
    packageName.startsWith(`${HOST_RESERVED_PROVIDER_NAMESPACE}:`)
  );
}

/**
 * Bind a capability registration to the HOST-INJECTED `packageName` — the only
 * authoritative provider identity (cinatra#150). Any caller-supplied
 * `provider.packageName` is UNTRUSTED extension input and is OVERRIDDEN, never
 * trusted: without this, an extension could register a provider claiming
 * ANOTHER package's identity (impersonation) or shadow a host
 * `@cinatra-ai/host:*` service. The `impl` is preserved; only the identity is
 * forced. Registering under the reserved host namespace from the extension port
 * is REJECTED (a real extension's `packageName` can never be the host namespace,
 * so this is defense-in-depth). Scope: provider-IDENTITY forgery only —
 * capability-ID squatting (same id, different provider) is out (cinatra#155).
 */
function bindProviderIdentity(
  packageName: string,
  provider: { packageName: string; impl: unknown },
): { packageName: string; impl: unknown } {
  if (isReservedHostProviderIdentity(packageName)) {
    throw new Error(
      `[capabilities] "${packageName}" may not register a capability provider via the extension port: the "${HOST_RESERVED_PROVIDER_NAMESPACE}" namespace is reserved for host-published services`,
    );
  }
  // Authoritative identity is the host-injected packageName — caller-supplied
  // provider.packageName is ignored (override, not merge of identity).
  return { ...provider, packageName };
}

/**
 * Whether `packageName` is a FIRST-PARTY extension — one COMPILED INTO the host
 * build (a key of `STATIC_EXTENSION_MANIFEST`). This is a build-time trust root
 * (a third party cannot inject itself into the host image, and the marketplace
 * publish gate reserves the first-party package names), NOT a vendor/scope
 * heuristic. It holds regardless of the activation LOADER: a first-party
 * connector activates the same whether via the static bundle OR the runtime
 * package store (cinatra#161 republishes first-party connectors through the
 * store, and the runtime loader's own trust classification gates the source),
 * so keying on the package identity — not the loader — is what preserves
 * first-party behavior while fencing arbitrary third-party marketplace code.
 */
function isFirstPartyPackage(packageName: string): boolean {
  return Object.prototype.hasOwnProperty.call(STATIC_EXTENSION_MANIFEST, packageName);
}

/**
 * Host-internal SYSTEM capability ids that expose RAW tenant credentials and are
 * published for HOST + FIRST-PARTY consumption ONLY. `nango-system` carries
 * `getNangoCredentials(providerConfigKey, connectionId)` — a connectionId-
 * addressed credential reader with NO per-tenant binding — so an ungated
 * in-process connector holding this surface can read ANY stored connection's
 * credentials.
 *
 * Fail-closed at the extension-facing `ctx.capabilities` port for a NON-first-
 * party (third-party marketplace) extension: RESOLVE → `[]` (the connector never
 * obtains the credential surface) and REGISTER → throw (a third-party digest
 * cannot POISON the id with a shadow provider the host might resolve). FIRST-
 * PARTY connectors (which legitimately register/resolve `nango-system` — e.g.
 * the nango gateway registers it and apollo/gmail/anthropic/… resolve it to
 * build their deps) and HOST-INTERNAL resolution (`@/lib/nango-system.ts` via
 * `resolveCapabilityProviders`, which does NOT go through this port) are
 * UNAFFECTED.
 *
 * Extensible: add other host-consumed raw-credential system ids here. The
 * forward design (issue-tracked) is a host-owned, per-package explicit GRANT so
 * a specific third-party connector can be re-permitted a specific reserved
 * capability without re-opening the surface to arbitrary marketplace code.
 */
const RESERVED_SYSTEM_CAPABILITIES: ReadonlySet<string> = new Set<string>([
  NANGO_SYSTEM_CAPABILITY,
  // The per-instance connection use-gate seam (#975 Wave 3, epic #978):
  // identity-row SEEDING is an authz-adjacent mutation (it establishes the
  // ownership/grant material the use-gate later evaluates), so the surface is
  // first-party-only like the credential reader above — a marketplace
  // extension must not ambiently seed identities or probe authorization
  // (codex round-0 finding on the instance-connection-gate contract).
  HOST_CONNECTOR_SERVICE_CAPABILITIES.instanceConnectionGate,
  // The LLM provider ADAPTER surface (llm-providers S4, cinatra#1715): a
  // registered adapter IS the LLM dispatch data plane for its provider — it
  // builds requests with the connector's tenant API credential and sees every
  // prompt/response. A third-party marketplace extension registering it could
  // intercept or exfiltrate the entire LLM data plane, so it is first-party
  // ONLY (epic #1711 non-goal: no runtime-installed third-party provider
  // adapters). Anti-poisoning: a non-first-party REGISTER throws (the shadow
  // adapter never enters the registry) and RESOLVE returns [] at the port.
  LLM_PROVIDER_ADAPTER_CAPABILITY,
  // The LLM SKILL-DELIVERY adapter surface (llm-providers S4.x, cinatra#1964):
  // a registered skill-delivery adapter sees every agent's skill set + skill
  // content and builds the tools/system-prompt that reach the model, so — like
  // the request-translation adapter above — it is a first-party-ONLY data-plane
  // seam (epic #1711 non-goal: no runtime-installed third-party provider
  // adapters). Same anti-poisoning fence: a non-first-party REGISTER throws and
  // RESOLVE returns [].
  LLM_SKILL_DELIVERY_ADAPTER_CAPABILITY,
]);

/** True when `capability` is a host-internal system credential surface that a
 * NON-first-party extension may neither resolve nor register through the
 * `ctx.capabilities` port. First-party packages are never denied. */
function isReservedSystemCapabilityDeniedFor(
  packageName: string,
  capability: string,
): boolean {
  return RESERVED_SYSTEM_CAPABILITIES.has(capability) && !isFirstPartyPackage(packageName);
}

/** Fail-loud denial for a non-first-party attempt to REGISTER a reserved system
 * capability (anti-poisoning: the shadow provider never enters the registry). */
function denyReservedSystemCapabilityRegister(packageName: string, capability: string): never {
  throw new Error(
    `[capabilities] "${packageName}" (not a first-party host-build extension) may not register ` +
      `the host-internal system capability "${capability}" via the extension port — it is a ` +
      `host/first-party credential surface.`,
  );
}

// ---------------------------------------------------------------------------
// Record identity (cinatra#1392 S8) — the (version | default) axis of the ctx-
// owning record, injected by the loaders. Optional + defaulted so every legacy
// caller (static bundle, destroy hooks, tests) keeps the pre-S8 DEFAULT
// identity, under which both consume seams below are byte-identical no-ops
// (no pre-resolved pins are ever published for a package with no versioned
// edges, and the ctx-identity frame resolves to the same default row the
// run-lineage path would).
// ---------------------------------------------------------------------------

export type ExtensionRecordIdentityInput = {
  /**
   * The EXACT canonical install-row id (from the trusted anchor). Binds the
   * edge-bound consume seams to THIS row — never a same-shape sibling's
   * (cinatra#1392 S8 codex round-0 #1). Omit for legacy/dev ctxs.
   */
  installId?: string | null;
  /** The record's version; omit/null for a legacy/unversioned record. */
  version?: string | null;
  /** Whether the record is the DEFAULT version of its package (default: true). */
  isDefault?: boolean;
};

function effectiveIdentity(identity: ExtensionRecordIdentityInput | undefined): {
  installId: string | null;
  version: string | null;
  isDefault: boolean;
} {
  return {
    installId: identity?.installId ?? null,
    version: identity?.version ?? null,
    isDefault: identity?.isDefault !== false,
  };
}

// ---------------------------------------------------------------------------
// Connector-save identity registration (cinatra#3460) — the HOST half of the
// ONE connection-identity road.
//
// The Sharing tab lists connection IDENTITY rows (`cinatra.nango_connection`,
// read by `listNangoConnectionsByOwner`). Until now an identity row was
// written ONLY by the host's own save roads (the Nango user-connect save
// route, the managed-api/WordPress cards, the instance-connection actor),
// each calling `registerSavedConnectionIdentity` explicitly. A schema-config
// connector's OWN Setup form saves through its own deps instead — it persists
// the verified pointer with the `nango-system` capability's
// `saveNangoConnectionRecord` — so its connections were born identity-less
// and its Sharing tab listed nothing to share.
//
// The fix is ONE road, not a per-connector special case: the host DECORATES
// the `nango-system` surface it hands to an extension through
// `ctx.capabilities.resolveProviders` so that a successful
// `saveNangoConnectionRecord` registers the connection's identity row with the
// SAME seam call the user-connect save route makes. Every connector that
// persists a connection pointer — today's six ceiling-declaring connectors and
// every future one — travels it, and no connector package changes.
//
// WHY THE EXTENSION PORT AND NOT THE REGISTRY: the host's own consumers reach
// the surface through `@/lib/nango-system` (`resolveCapabilityProviders`
// directly), which does NOT pass this port — so the save route's existing
// explicit `registerSavedConnectionIdentity` call is neither duplicated nor
// re-ordered, and its APP-scope `workspace` seed keeps winning on its own
// road. The connector road is the only road decorated here.
//
// The registration is a NO-OP (never a save failure) where it cannot be
// truthful:
//   • no string connection id on the record — nothing to address;
//   • a connector key the identity table has no connector package for
//     (`HOST_CONNECTOR_KEY_TO_PACKAGE`) — the seam would hard-fail a save that
//     worked before this decoration existed;
//   • no validated session (a boot/background save such as the dev
//     auto-connect) — an identity row's owner must come from a VALIDATED
//     session, never from caller input.
// A registration that CANNOT be completed — a foreign-identity conflict, an
// identity-store failure — is reported and left unwritten rather than thrown:
// it runs inside the connector's own save, after the credential import and the
// pointer write, where a throw is caught by the connector's sync-failure road
// and turned into a pointer clear plus a best-effort REMOTE DELETE of the
// connection (converge round 1, finding 2). The route's 409 has no equivalent
// here because the route rejects BEFORE it mutates anything.
//
// The seed follows the SAVED SCOPE, the same choice the save route makes: an
// app-scope connection (the default, and what every schema-config Setup form
// saves) is org-shared by construction and seeded `workspace`; a user-scope
// connection keeps the never-auto-share OWNER default. The connector's declared
// ceiling is a read-side treatment of that row
// (`decideConnectionShareSurface`), not a wider grant.
//
// The registration lives in THIS host module rather than a module of its own:
// `extension-host-context` is already on the instrumentation boot path and on
// every tracked route graph, so a separate leaf would add a module to each of
// them for nothing. Its imports of the seam and the session stay DYNAMIC —
// the seam/session graphs (identity store, permissions store, better-auth)
// must not be dragged onto the boot path at module eval.
// ---------------------------------------------------------------------------

/** The `nango-system` member whose success writes a connection pointer. */
const SAVE_CONNECTION_RECORD = "saveNangoConnectionRecord";

/**
 * The scope the gateway ACTUALLY persisted the pointer under, read the way the
 * surface contract normalizes it: the call's `options.scope` wins, then the
 * record's own `scope`, and an omitted scope is `"app"` (a connector that saves
 * without a scope — every schema-config Setup form today — saves an APP-scope
 * connection).
 */
function effectiveSavedScope(record: unknown, options: unknown): "app" | "user" {
  const fromOptions =
    typeof options === "object" && options !== null
      ? (options as { scope?: unknown }).scope
      : undefined;
  if (fromOptions === "user" || fromOptions === "app") return fromOptions;
  const fromRecord =
    typeof record === "object" && record !== null
      ? (record as { scope?: unknown }).scope
      : undefined;
  if (fromRecord === "user" || fromRecord === "app") return fromRecord;
  return "app";
}

type CapabilityProviderLike = { packageName: string; impl: unknown };

/**
 * Register the identity row for a connection a connector's own save road just
 * persisted — the same `registerSavedConnectionIdentity` call the user-connect
 * save route makes, with the acting user/org taken from the VALIDATED session.
 */
async function registerConnectorSavedConnectionIdentity(input: {
  connectorKey: unknown;
  connectionId: unknown;
  /** The EFFECTIVE scope the gateway persisted the pointer under. */
  scope: "app" | "user";
}): Promise<void> {
  const connectorKey = typeof input.connectorKey === "string" ? input.connectorKey : null;
  const connectionId = typeof input.connectionId === "string" ? input.connectionId : null;
  if (!connectorKey || !connectionId) return;

  const { HOST_CONNECTOR_KEY_TO_PACKAGE, registerSavedConnectionIdentity } = await import(
    "@/lib/connection-identity-seam"
  );
  if (!HOST_CONNECTOR_KEY_TO_PACKAGE[connectorKey]) {
    // No connector package is known for this key, so no identity row can name
    // its owner package. Never fail the connector's save over it — warn and
    // leave the pointer as it was before this decoration existed.
    console.warn(
      `[connection-identity] a connector saved a "${connectorKey}" connection record, but no ` +
        `connector package is known for that key — the connection has NO identity row and will ` +
        `not be listed on the connector's Sharing tab.`,
    );
    return;
  }

  const { getAuthSession } = await import("@/lib/auth-session");
  // A save can also come from a BOOT/background road with no request context
  // at all (the dev A2A peer auto-connect imports its peers at activation),
  // where reading the session throws rather than returning null. Both shapes
  // mean the same thing here — no validated actor, so no identity row can be
  // written truthfully — and neither may fail a save that worked before this
  // decoration existed.
  let session: Awaited<ReturnType<typeof getAuthSession>> | null = null;
  try {
    session = await getAuthSession();
  } catch {
    return;
  }
  const ownerUserId = session?.user?.id ?? null;
  if (!ownerUserId) return;

  await registerSavedConnectionIdentity({
    connectorKey,
    connectionId,
    ownerUserId,
    organizationId: session?.session?.activeOrganizationId ?? null,
    // SCOPE-AWARE SEED (converge round 1, finding 1) — the same choice the
    // user-connect save route makes for the same connection kind. An APP-scope
    // connection is org-shared BY CONSTRUCTION (the connector's own Setup form
    // is admin-gated by its declared ceiling exactly as the route admin-gates
    // an app-scope save), and the seam's docs are explicit that such a row is
    // minted for org-bound principals an owner-only grant would DENY. Seeding
    // is insert-if-absent, so an owner-only seed written here could never be
    // corrected by a later save through the route. A USER-scope save keeps the
    // never-auto-share OWNER default. (A null-org row is force-narrowed to
    // owner-only inside the seam regardless of what is asked for here.)
    seed: input.scope === "user" ? "owner" : "workspace",
  });
}

/**
 * Decorate the resolved `nango-system` providers so a connector's own
 * successful `saveNangoConnectionRecord` also registers the connection's
 * identity row. Every other member is passed through to the real surface with a
 * STABLE identity (bound once, cached), so `this`-using impls and the live
 * key-map Proxies behave identically and reference comparisons still hold.
 */
function withConnectorSaveIdentityRegistration<P extends CapabilityProviderLike>(
  providers: readonly P[],
): P[] {
  return providers.map((provider) => {
    const impl = provider.impl;
    if (typeof impl !== "object" || impl === null) return provider;
    const target = impl as Record<string | symbol, unknown>;
    const save = target[SAVE_CONNECTION_RECORD];
    if (typeof save !== "function") return provider;

    const wrappedSave = async (
      connectorKey: unknown,
      record: unknown,
      options?: unknown,
    ): Promise<unknown> => {
      const result = await (save as (...a: unknown[]) => unknown).call(
        target,
        connectorKey,
        record,
        options,
      );
      // NEVER THROW OUT OF THE DECORATION (converge round 1, finding 2). The
      // registration runs INSIDE the connector's own save, AFTER the credential
      // import and the pointer write. A throw here does not undo either — it is
      // caught by the connector's own sync-failure road, which clears the local
      // pointer and BEST-EFFORT DELETES THE REMOTE CONNECTION. On a foreign
      // identity conflict that road would destroy the very connection the
      // conflict exists to protect, and a transient identity-store failure would
      // destroy a healthy one. So a registration that cannot be completed leaves
      // the connection exactly as it was born before this decoration existed:
      // pointer saved, no identity row, not listed on the Sharing tab, and the
      // save itself unharmed. It is reported loudly instead.
      try {
        await registerConnectorSavedConnectionIdentity({
          connectorKey,
          connectionId:
            typeof record === "object" && record !== null
              ? (record as { connectionId?: unknown }).connectionId
              : undefined,
          scope: effectiveSavedScope(record, options),
        });
      } catch (error) {
        console.error(
          `[connection-identity] a connector saved a connection record but its identity row ` +
            `could not be registered — the connection is NOT listed on the connector's ` +
            `Sharing tab. The save itself was left intact.`,
          error,
        );
      }
      return result;
    };

    // STABLE MEMBER IDENTITY (converge round 1, finding 3): the bound
    // forwarder for a member is minted ONCE, so reading the same member twice
    // returns the SAME function object. A fresh `bind` per read would make
    // `surface.getNangoStatus !== surface.getNangoStatus`, which breaks every
    // caller that memoizes, compares or de-duplicates a member by reference.
    // The binding itself stays: without it a member invoked as
    // `surface.member()` would run with the PROXY as `this` (private class
    // fields on a real impl throw on a proxy receiver, and a member reaching a
    // sibling through `this` would re-enter this trap).
    const boundMembers = new Map<string | symbol, unknown>();
    const decorated = new Proxy(impl as object, {
      get: (raw, prop) => {
        if (prop === SAVE_CONNECTION_RECORD) return wrappedSave;
        if (boundMembers.has(prop)) return boundMembers.get(prop);
        // `raw` (never the proxy) is the receiver, so a getter reaches the REAL
        // surface and can never recurse back through this trap.
        const value = Reflect.get(raw, prop, raw);
        if (typeof value !== "function") return value;
        const bound = value.bind(raw);
        boundMembers.set(prop, bound);
        return bound;
      },
    });

    return { ...provider, impl: decorated };
  });
}

/** The SYNC edge-bound substitution over the global registry's resolution. */
function resolveProvidersEdgeBound(
  packageName: string,
  identity: ExtensionRecordIdentityInput | undefined,
  capability: string,
) {
  const providers = substituteEdgeBoundCapabilityProviders(
    packageName,
    effectiveIdentity(identity),
    capability,
    resolveCapabilityProviders(capability),
  );
  // cinatra#3460 — the connection-identity road for a connector's OWN save.
  // A schema-config connector's Setup form persists its verified connection
  // pointer through this surface (`saveNangoConnectionRecord`), so the host
  // registers the connection's identity row on a successful save exactly as
  // the user-connect save route does — one road, no per-connector special
  // case, and no connector package changes. Host-internal consumers resolve
  // through `resolveCapabilityProviders` directly and are untouched (their own
  // explicit seam call keeps its scope-aware seed).
  if (capability === NANGO_SYSTEM_CAPABILITY) {
    return withConnectorSaveIdentityRegistration(providers);
  }
  return providers;
}

function makeCapabilities(
  packageName: string,
  identity?: ExtensionRecordIdentityInput,
): ExtensionHostContext["capabilities"] {
  return {
    registerProvider: (capability, provider) => {
      if (isReservedSystemCapabilityDeniedFor(packageName, capability)) {
        denyReservedSystemCapabilityRegister(packageName, capability);
      }
      registerCapabilityProvider(capability, bindProviderIdentity(packageName, provider));
    },
    resolveProviders: (capability) => {
      if (isReservedSystemCapabilityDeniedFor(packageName, capability)) {
        console.warn(
          `[capabilities] "${packageName}" (not a first-party host-build extension) attempted to ` +
            `resolve the host-internal system capability "${capability}" via the extension port — ` +
            `DENIED (returning []). This surface exposes raw tenant credentials and is host/first-party only.`,
        );
        return [];
      }
      // cinatra#1392 S8: a versioned pin on the resolved target substitutes the
      // pinned version's retained provider for the default's global entry,
      // fail-closed (torn retention throws; no pins = the global set unchanged).
      return resolveProvidersEdgeBound(packageName, identity, capability);
    },
  };
}

// ---------------------------------------------------------------------------
// mcp — registerTool (host extension-MCP registry) + callPrimitive (host self
// invoker) + listExternalServers (global external MCP registry).
// ---------------------------------------------------------------------------

/**
 * The dispatch-time `callPrimitive` impl, shared by the default ctx and the
 * sink-carrying non-default ctx (cinatra#1392 S8). Runs the whole invocation
 * inside the extension-ctx identity ALS frame so the edge-bound resolver binds
 * the CALLING record's dependency edges (highest-precedence identity source),
 * never the outer run's.
 */
function makeCallPrimitive(
  packageName: string,
  identity: ExtensionRecordIdentityInput | undefined,
): ExtensionHostContext["mcp"]["callPrimitive"] {
  const ctxIdentity = { packageName, ...effectiveIdentity(identity) };
  return async (primitiveName, input) => {
    const [{ callHostPrimitive }, actor] = await Promise.all([
      import("@/lib/extension-self-mcp"),
      resolveExtensionActorContext(),
    ]);
    return runWithExtensionCtxIdentity(ctxIdentity, () =>
      callHostPrimitive(primitiveName, input, { actor }),
    );
  };
}

function makeMcp(
  packageName: string,
  identity?: ExtensionRecordIdentityInput,
): ExtensionHostContext["mcp"] {
  return {
    // cinatra#2817 slice 1 — the record's EXACT version rides the registration
    // so the per-request plan can bind it to the version actually serving. A
    // legacy/dev ctx carries none; that registration is then unversioned, and
    // version-bound admission refuses it rather than guessing.
    registerTool: (tool) =>
      registerExtensionMcpTool(packageName, tool, { resolvedVersion: identity?.version ?? null }),
    callPrimitive: makeCallPrimitive(packageName, identity),
    listExternalServers: async () => {
      const { listEnabledGlobalExternalMcpServers } = await import("@/lib/external-mcp-registry");
      return listEnabledGlobalExternalMcpServers();
    },
    getPublicBaseUrl: async () => {
      const { getMcpPublicBaseUrl } = await import("@cinatra-ai/mcp-server/credentials");
      const { publicBaseUrl } = getMcpPublicBaseUrl();
      return { publicBaseUrl };
    },
  };
}

// ---------------------------------------------------------------------------
// nango — the @/lib/nango surface, inverted. Arg order differs from the host
// helper (port: connectionId, providerConfigKey; host: providerConfigKey,
// connectionId).
// ---------------------------------------------------------------------------

function makeNango(): ExtensionHostContext["nango"] {
  return {
    isConfigured: async () => {
      const { isNangoConfigured } = await import("@/lib/nango-system");
      return isNangoConfigured();
    },
    getConnection: async (connectionId, providerConfigKey) => {
      const { getNangoConnection } = await import("@/lib/nango-system");
      return getNangoConnection(providerConfigKey, connectionId);
    },
    ensureConnectSession: async (input) => {
      const { createNangoConnectSession } = await import("@/lib/nango-system");
      return createNangoConnectSession(input as Parameters<typeof createNangoConnectSession>[0]);
    },
    // Render-time getters for connector setup/settings pages (ABI 2.2.0). The
    // SDK takes `connectorKey: string`; we narrow to the host roster union at the
    // boundary. `@/lib/nango` is `export * from "@cinatra-ai/nango-connector"`.
    getStatus: async () => {
      const { getNangoStatus } = await import("@/lib/nango-system");
      return getNangoStatus();
    },
    getFrontendConfig: async () => {
      const { getNangoFrontendConfig } = await import("@/lib/nango-system");
      return getNangoFrontendConfig();
    },
    getPrimarySavedConnection: async (connectorKey, opts) => {
      const { getPrimarySavedNangoConnection } = await import("@/lib/nango-system");
      return getPrimarySavedNangoConnection(
        connectorKey as Parameters<typeof getPrimarySavedNangoConnection>[0],
        opts,
      );
    },
    getPrimarySavedConnections: async (opts) => {
      const { getPrimarySavedNangoConnections } = await import("@/lib/nango-system");
      return getPrimarySavedNangoConnections(opts);
    },
    listConnectionRecords: async (connectorKey) => {
      const { listSavedNangoConnections } = await import("@/lib/nango-system");
      return listSavedNangoConnections(
        connectorKey as Parameters<typeof listSavedNangoConnections>[0],
      );
    },
    // Canonical OAuth callback URL (post-2.2.0 additive, optional on the port).
    // Delegates to the single canonical host helper so connector setup pages echo
    // the exact `redirect_uri` Nango sends — no connector-side normalization.
    getNangoOAuthCallbackUrl: async () => {
      const { getNangoOAuthCallbackUrl } = await import("@/lib/nango-system");
      return getNangoOAuthCallbackUrl();
    },
  };
}

// ---------------------------------------------------------------------------
// settings — non-secret, ORG + package-scoped config. Keys namespaced
// `ext:<packageName>:<orgId>:<key>` so one extension can't read another's config
// and one org can't read another's. The organization is REQUIRED from the
// trusted context: there is deliberately NO shared package-global fallback for
// extension config (a stale/absent actor must fail loud, never silently read or
// write a cross-tenant namespace). Workspace-global extension config, if ever
// needed, would be an explicit, separately-authorised host path — not an
// automatic default here.
// ---------------------------------------------------------------------------

async function settingsKey(packageName: string, key: string): Promise<string> {
  const orgId = await requireExtensionOrganizationId(packageName);
  return `ext:${packageName}:${orgId}:${key}`;
}

/**
 * Env-first-else-DB precedence for a settings/secrets `get` (cinatra#982). When
 * `key` has a validated env-override mapping AND the env var is actually SET
 * (non-blank after trim), the env value wins and the DB is never consulted —
 * this is what lets a `get()` succeed with NO resolvable org/actor (boot-time /
 * webhook-time reads for a required systemExtension), matching nango's
 * pre-existing `?.trim() || stored` precedence exactly (a `KEY=` empty-string
 * env line is treated as unset, falling through to the DB). Returns `undefined`
 * (not a value) when there is no override or the env var is unset/blank, so the
 * caller falls through to its normal DB read.
 */
function readEnvOverride(envByKey: Record<string, string>, key: string): string | undefined {
  const envVar = envByKey[key];
  if (!envVar) return undefined;
  return process.env[envVar]?.trim() || undefined;
}

function makeSettings(
  packageName: string,
  envByKey: Record<string, string> = {},
): ExtensionHostContext["settings"] {
  return {
    get: async <T = unknown>(key: string) => {
      const envValue = readEnvOverride(envByKey, key);
      if (envValue !== undefined) return envValue as unknown as T;
      return readConnectorConfigFromDatabase<T | null>(await settingsKey(packageName, key), null);
    },
    set: async <T = unknown>(key: string, value: T) => {
      const orgId = await requireExtensionOrganizationId(packageName);
      writeConnectorConfigToDatabase(`ext:${packageName}:${orgId}:${key}`, value);
      // A direct write makes this row USER-owned: drop any dev-fixture
      // provenance sidecar so the dev seeder never re-seeds/clobbers it.
      deleteConnectorConfig(devFixtureProvenanceKey(packageName, orgId, key));
    },
    delete: async (key: string) => {
      const orgId = await requireExtensionOrganizationId(packageName);
      // True row delete (not a write of JSON "null"), so an extension's config
      // surface is genuinely cleared and the lifecycle teardown leaves no residue.
      deleteConnectorConfig(`ext:${packageName}:${orgId}:${key}`);
      deleteConnectorConfig(devFixtureProvenanceKey(packageName, orgId, key));
    },
  };
}

// ---------------------------------------------------------------------------
// secrets — encrypted at rest (AES-256-GCM via @/lib/instance-secrets), ORG +
// package-scoped (org REQUIRED — no global fallback, same as settings),
// deliberately separate from non-secret settings. Stored under
// `ext-secret:<packageName>:<orgId>:<key>`; the FULL store key is bound as GCM
// additional-authenticated-data so a ciphertext row cannot be replayed under a
// different org / package / key and still decrypt.
// ---------------------------------------------------------------------------

async function secretMeta(packageName: string, key: string): Promise<{ storeKey: string; aad: string }> {
  const orgId = await requireExtensionOrganizationId(packageName);
  const storeKey = `ext-secret:${packageName}:${orgId}:${key}`;
  return { storeKey, aad: storeKey };
}

function makeSecrets(
  packageName: string,
  envByKey: Record<string, string> = {},
): ExtensionHostContext["secrets"] {
  return {
    get: async (key: string) => {
      const envValue = readEnvOverride(envByKey, key);
      if (envValue !== undefined) return envValue;
      const { storeKey, aad } = await secretMeta(packageName, key);
      const stored = readConnectorConfigFromDatabase<{ ciphertext: string; iv: string } | null>(storeKey, null);
      if (!stored) return null;
      const { decryptSecret } = await import("@/lib/instance-secrets");
      return decryptSecret(stored, aad);
    },
    set: async (key: string, value: string) => {
      const { storeKey, aad } = await secretMeta(packageName, key);
      const { encryptSecret } = await import("@/lib/instance-secrets");
      writeConnectorConfigToDatabase(storeKey, encryptSecret(value, aad));
    },
    delete: async (key: string) => {
      const { storeKey } = await secretMeta(packageName, key);
      // True row delete — never leave a decryptable-shaped residue behind.
      deleteConnectorConfig(storeKey);
    },
  };
}

// ---------------------------------------------------------------------------
// objects — object-type registration + org-scoped object store + history.
// ---------------------------------------------------------------------------

// The edge-bound object-type serve port (cinatra#1392) published by
// `extension-edge-bound-serving.ts` on the globalThis singleton surface. Read
// off globalThis rather than imported so this factory never adds the
// edge-bound-serving subgraph to the routes that reach it (route-graph ratchet
// is shrink-only); absent (that serve module never loaded) ⇒ `ctx.objects
// .resolveType` falls back to the global/default registration, the S7-consistent
// default-serving outcome. The Symbol key + this minimal port shape MUST match
// the publisher's `ExtensionObjectTypeServePort` (cross-compilation safe via
// `Symbol.for`).
const EXTENSION_OBJECT_TYPE_SERVE_KEY = Symbol.for(
  "@cinatra-ai/host:extension-object-type-serve/v1",
);
type PublishedObjectTypeServePort = {
  resolveObjectType(typeId: string): Promise<
    | { kind: "none" }
    | { kind: "default" }
    | { kind: "versioned"; descriptor: { typeId: string; ioSpec?: unknown; [k: string]: unknown } }
    | { kind: "refuse"; code: string; message: string }
  >;
};
function readObjectTypeServePort(): PublishedObjectTypeServePort | undefined {
  return (globalThis as unknown as { [k: symbol]: PublishedObjectTypeServePort | undefined })[
    EXTENSION_OBJECT_TYPE_SERVE_KEY
  ];
}

function makeObjects(
  packageName: string,
  identity?: ExtensionRecordIdentityInput,
): ExtensionHostContext["objects"] {
  // The CALLING record's ctx-identity (cinatra#1392 S8) — the same frame
  // `makeCallPrimitive` establishes so an edge-bound resolve binds THIS
  // extension's dependency edges (highest-precedence identity source), never the
  // outer run's. Used by `resolveType` below.
  const ctxIdentity = { packageName, ...effectiveIdentity(identity) };
  const requireClient = async () => {
    const actor = await resolveExtensionActorContext();
    if (!actor) {
      throw new Error(
        `[ExtensionHostContext] ${packageName}: ctx.objects used with no resolvable actor — ` +
          `the object store is organization-scoped and needs a trusted request/run context.`,
      );
    }
    const { createSessionObjectsClient } = await import("@cinatra-ai/objects");
    return createSessionObjectsClient(actor);
  };
  return {
    registerType: (descriptor) => {
      // Object-type registration is process-global (replace-by-id), not
      // org-scoped. Register SYNCHRONOUSLY against the eagerly-imported registry
      // (see the narrow `@cinatra-ai/objects/registry` import at the top of this
      // file) so the type is guaranteed registered — and any registration failure
      // surfaces (it is NOT swallowed) — BEFORE `register(ctx)` returns and the
      // loader's `await server.register(ctx)` resolves. The previous
      // dynamic-import-then-register returned a Promise the loader could not await
      // (the SDK `HostObjectsPort.registerType` contract is `void`), so the
      // registration floated past activation completion.
      //
      // The SDK keeps the descriptor opaque (`{ typeId, ioSpec?, [k]: unknown }`)
      // so it never depends on `@cinatra-ai/objects`; the concrete
      // `ObjectTypeDefinition` shape is validated host-side at registration. Pass
      // `packageName` as provenance so the teardown hook can deregister exactly
      // this package's types on archive/uninstall.
      objectTypeRegistry.register(
        descriptor as unknown as Parameters<typeof objectTypeRegistry.register>[0],
        packageName,
      );
    },
    resolveType: async (typeId: string) => {
      // The CONSUME side of registerType, edge-bound (cinatra#1392): when the
      // CALLING extension's resolved edge pins a NON-DEFAULT version of the
      // type's owning package, serve THAT version's retained descriptor; a torn
      // edge-bound retention REJECTS with evidence (never the default's). Absent
      // seam / no pin / a default edge falls back to the global registration.
      //
      // The port call runs inside THIS record's ctx-identity ALS frame (exactly
      // as `makeCallPrimitive` does) so the edge-bound resolver binds the CALLING
      // extension's dependency edges — never the outer agent/run's. Without the
      // frame, extension B calling `ctx.objects.resolveType` would be served the
      // version A's (the outer run's) edges select (codex convergence).
      const port = readObjectTypeServePort();
      if (port) {
        const decision = await runWithExtensionCtxIdentity(ctxIdentity, () =>
          port.resolveObjectType(typeId),
        );
        if (decision.kind === "refuse") {
          throw new Error(
            `[ExtensionHostContext] ${packageName}: ctx.objects.resolveType("${typeId}") refused — ${decision.message}`,
          );
        }
        if (decision.kind === "versioned") return decision.descriptor;
      }
      const def = objectTypeRegistry.resolve(typeId);
      if (!def) return null;
      // The global registry stores the host `ObjectTypeDefinition`; surface it
      // through the opaque SDK descriptor contract with an explicit `typeId`.
      return { typeId, ...(def as unknown as Record<string, unknown>) };
    },
    read: async <T = unknown>(typeId: string, id: string) => {
      const client = await requireClient();
      // `objects_get` returns a `{ object: StoredObject | null }` envelope —
      // unwrap it (returning the envelope would be wrong) and REFUSE a type
      // mismatch so a caller can't request one typeId and receive a different
      // object by id (no type confusion across the shared id space).
      const raw = (await client.get(id)) as { object?: { type?: string } | null } | null;
      const obj = raw?.object ?? null;
      if (!obj) return null;
      if (typeId && obj.type != null && obj.type !== typeId) return null;
      return obj as T;
    },
    write: async <T = unknown>(typeId: string, value: T) => {
      const client = await requireClient();
      const saved = await client.save({ rawData: value as Record<string, unknown>, typeHint: typeId });
      return { id: saved.objectId };
    },
    history: async (_typeId: string, id: string) => {
      const [{ callHostPrimitive }, actor] = await Promise.all([
        import("@/lib/extension-self-mcp"),
        resolveExtensionActorContext(),
      ]);
      const result = (await callHostPrimitive("object_history_list", { objectId: id }, { actor })) as
        | { items?: unknown[] }
        | unknown[]
        | null;
      if (Array.isArray(result)) return result;
      return result?.items ?? [];
    },
  };
}

// ---------------------------------------------------------------------------
// jobs — background job enqueue (the BullMQ queue). `registerWorker` is NOT
// supported: the host dispatcher is a static switch keyed by `BACKGROUND_JOB_NAMES`,
// not a dynamic registry, and no in-scope extension registers a worker. Fail
// loud rather than silently no-op.
// ---------------------------------------------------------------------------

function makeJobs(packageName: string): ExtensionHostContext["jobs"] {
  return {
    enqueue: async (jobName, payload, opts) => {
      const { enqueueBackgroundJob } = await import("@/lib/background-jobs");
      const id = await enqueueBackgroundJob(
        jobName as Parameters<typeof enqueueBackgroundJob>[0],
        (payload ?? {}) as Record<string, unknown>,
        opts as Parameters<typeof enqueueBackgroundJob>[2],
      );
      return { id };
    },
    registerWorker: () => {
      throw new Error(
        `[ExtensionHostContext] ${packageName}: ctx.jobs.registerWorker is not supported — the host ` +
          `runs a static background-job dispatcher (BACKGROUND_JOB_NAMES). Use ctx.jobs.enqueue against ` +
          `a host-recognised job name.`,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// notifications — host notification emission, addressed to the resolved actor
// (user → org → admins fallback). SDK `level` (info|warn|error) maps to the
// host `NotificationKind` (info|warning|error).
// ---------------------------------------------------------------------------

function makeNotifications(packageName: string): ExtensionHostContext["notifications"] {
  return {
    emit: async ({ level, title, body }) => {
      const summary = await resolveExtensionActorSummary();
      const recipient = summary?.userId
        ? ({ kind: "user", userId: summary.userId } as const)
        : summary?.organizationId
          ? ({ kind: "organization", organizationId: summary.organizationId } as const)
          : ({ kind: "admins" } as const);
      const kind = level === "warn" ? "warning" : level;
      const { createNotificationForRecipient } = await import("@cinatra-ai/notifications/server");
      await createNotificationForRecipient(recipient, {
        title,
        ...(body !== undefined ? { body } : {}),
        kind,
        metadata: { source: "extension", packageName },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// ui — registration channel (setup/settings surfaces + named actions). Records
// into the host UI registry; the schema-driven runtime installer reads
// it. NOT a host-component bag.
// ---------------------------------------------------------------------------

function makeUi(packageName: string): ExtensionHostContext["ui"] {
  return {
    registerSetupSurface: (surface) => registerExtensionSetupSurface(packageName, surface),
    registerSettingsSurface: (surface) => registerExtensionSettingsSurface(packageName, surface),
    registerAction: (action) => registerExtensionUiAction({ packageName, id: action.id, handler: action.handler }),
  };
}

// ---------------------------------------------------------------------------
// telemetry — usage/cost emission (the @cinatra-ai/metric-usage-api surface,
// inverted). Fire-and-forget by contract: never throws, never blocks.
// ---------------------------------------------------------------------------

function makeTelemetry(packageName: string, logger: HostLoggerPort): ExtensionHostContext["telemetry"] {
  return {
    emitUsage: (event: HostUsageEvent) => {
      void import("@cinatra-ai/metric-usage-api")
        .then(({ emitUsageEvent }) => emitUsageEvent(event as Parameters<typeof emitUsageEvent>[0]))
        .catch((err) =>
          logger.warn(`telemetry.emitUsage failed (swallowed)`, {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
    },
  };
}

// ---------------------------------------------------------------------------
// authSession — resolve the actor across cookie / MCP / worker / A2A contexts
// (NOT cookie-only). The summary is `{ userId, organizationId, orgRole }`.
// ---------------------------------------------------------------------------

function makeAuthSession(packageName: string): ExtensionHostContext["authSession"] {
  return {
    getActor: async () => resolveExtensionActorSummary(),
    requireOrganizationId: async () => {
      const summary = await resolveExtensionActorSummary();
      const orgId = summary?.organizationId;
      if (!orgId) {
        throw new Error(
          `[ExtensionHostContext] ${packageName}: ctx.authSession.requireOrganizationId() — ` +
            `no organizationId on the current actor (cookie / MCP / worker context).`,
        );
      }
      return orgId;
    },
  };
}

// ---------------------------------------------------------------------------

const AMBIENT_PORTS: readonly HostPortName[] = ["logger", "runtime"];

// Well-known hooks that serialization / inspection infrastructure probes on
// EVERY value it touches — React's RSC Flight serializer (`toJSON`, the
// thenable check, the `$$typeof` element check), `JSON.stringify`, and
// console/inspect. Reading one of these is NOT an extension using the port, so
// the fail-loud proxy must answer them inertly (undefined) instead of throwing;
// otherwise a host route that merely passes `ctx` as a prop to a server
// component crashes when the framework serializes the element tree (the setup
// page renders 200, then the browser's Flight client throws on
// `ctx.<ungranted-port>.toJSON`). Real port methods (query/get/registerTool/…)
// are never in this set and still fail loud below.
const SERIALIZATION_PROBE_PROPS: ReadonlySet<string> = new Set([
  "toJSON",
  "then",
  "catch",
  "finally",
  "$$typeof",
]);

/**
 * Fail-loud placeholder for a privileged port the extension cannot use. Any
 * property access throws. Two distinct reasons:
 *  - "not-granted": the port is not in the extension's `requestedHostPorts`.
 *  - "not-implemented": granted, but its ABI tier is `reserved` — declared in the
 *    frozen surface yet not wired (driven by HOST_PORT_TIER; today only `db`, the
 *    scoped escape hatch, which stays unwired until a real consumer needs it).
 */
function unavailablePort(
  packageName: string,
  port: HostPortName,
  reason: "not-granted" | "not-implemented",
): unknown {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        // Answer serialization/inspection probes inertly so a passed-but-unused
        // ungranted/unwired port survives framework serialization (RSC Flight,
        // JSON, console) instead of hard-crashing the page. All symbol-keyed
        // access (Symbol.toPrimitive / toStringTag / iterator / inspect.custom,
        // the React element symbols) is infrastructure, never a port method.
        if (typeof prop === "symbol" || SERIALIZATION_PROBE_PROPS.has(prop)) {
          return undefined;
        }
        if (reason === "not-granted") {
          throw new Error(
            `[ExtensionHostContext] ${packageName}: host port "${port}".${String(prop)} accessed but NOT GRANTED — ` +
              `add "${port}" to the extension manifest's cinatra.requestedHostPorts (least-privilege).`,
          );
        }
        throw new Error(
          `[ExtensionHostContext] ${packageName}: host port "${port}".${String(prop)} is not implemented in the host factory.`,
        );
      },
    },
  );
}

/**
 * The manifest-declared env-override input a caller MAY pass to
 * `createExtensionHostContext` (cinatra#982) — the RAW `cinatra.envOverrides`
 * pass-through plus the `resolution` classification needed to decide legacy
 * (non-namespaced) env-name eligibility. Both optional; an omitted/empty input
 * yields NO env overrides (behavior-preserving default).
 */
export type ExtensionEnvOverrideInput = {
  envOverrides?: Record<string, string> | null;
  resolution?: "required" | "guardedOptional";
};

/**
 * Build the host ctx for one extension, GRANT-AWARE: a privileged port is the
 * real wired impl only when the extension granted it via `requestedHostPorts`;
 * ungranted privileged ports are fail-loud. Ambient ports (`logger`/`runtime`)
 * are always real. Org/actor-scoped ports resolve the trusted context PER CALL.
 *
 * `envInput` (cinatra#982) carries the extension's manifest-declared
 * `cinatra.envOverrides` + its generator-owned `resolution`. Validated here
 * (namespaced-vs-legacy security guard) BEFORE the settings/secrets ports are
 * built — a rejected entry is logged via the extension's own logger and never
 * activates a mapping.
 */
export function createExtensionHostContext(
  packageName: string,
  grantedPorts: readonly HostPortName[] = [],
  envInput: ExtensionEnvOverrideInput = {},
  // cinatra#1392 S8: the record's (version | default) identity, threaded by the
  // loaders into the two edge-bound consume seams (callPrimitive identity frame
  // + sync capability substitution). Omitted = the legacy DEFAULT identity.
  identity?: ExtensionRecordIdentityInput,
): ExtensionHostContext {
  const granted = new Set<HostPortName>([...grantedPorts, ...AMBIENT_PORTS]);
  const logger = makeLogger(packageName);

  const envValidation = validateEnvOverrides(packageName, envInput.envOverrides ?? null, {
    allowLegacyNames: envInput.resolution === "required",
  });
  for (const rejection of envValidation.rejected) {
    logger.warn(`cinatra.envOverrides["${rejection.envKey}"] rejected: ${rejection.reason}`);
  }
  const envByPort = splitEnvOverridesByPort(envValidation.overrides);

  // A privileged port is the real wired impl only when GRANTED and its ABI tier
  // is `stable`. Three states (see the ABI-evolution port-tiering policy):
  //   - not granted                  → fail-loud "not-granted" (least-privilege).
  //   - granted + `reserved` tier     → fail-loud "not-implemented" (declared in
  //                                     the frozen surface but not wired yet).
  //   - granted + `stable` tier       → the real impl.
  // Today only `db` is `reserved`, so this is behavior-preserving; wiring it later
  // is a one-line tier flip in HOST_PORT_TIER (no host-factory edit needed).
  const gated = <K extends HostPortName>(port: K, build: () => ExtensionHostContext[K]): ExtensionHostContext[K] => {
    if (!granted.has(port)) return unavailablePort(packageName, port, "not-granted") as ExtensionHostContext[K];
    if (HOST_PORT_TIER[port] === "reserved")
      return unavailablePort(packageName, port, "not-implemented") as ExtensionHostContext[K];
    return build() as ExtensionHostContext[K];
  };

  return {
    abiVersion: ABI_VERSION,
    packageName,
    logger,
    runtime: makeRuntime(),
    // `db` is the deliberate scoped escape hatch — a `reserved`-tier port, unwired
    // until a real consumer needs it. The tier-aware `gated` helper fail-louds it
    // ("not-implemented" when granted, "not-granted" otherwise); the `build()`
    // throws so a future wiring never silently activates an un-flipped reserved port.
    db: gated("db", () => {
      throw new Error(
        `[ExtensionHostContext] ${packageName}: reserved port "db" has no wired impl — flip HOST_PORT_TIER.db to "stable" when wiring it.`,
      );
    }),
    settings: gated("settings", () => makeSettings(packageName, envByPort.settings)),
    secrets: gated("secrets", () => makeSecrets(packageName, envByPort.secrets)),
    nango: gated("nango", () => makeNango()),
    authSession: gated("authSession", () => makeAuthSession(packageName)),
    mcp: gated("mcp", () => makeMcp(packageName, identity)),
    objects: gated("objects", () => makeObjects(packageName, identity)),
    jobs: gated("jobs", () => makeJobs(packageName)),
    notifications: gated("notifications", () => makeNotifications(packageName)),
    ui: gated("ui", () => makeUi(packageName)),
    capabilities: gated("capabilities", () => makeCapabilities(packageName, identity)),
    telemetry: gated("telemetry", () => makeTelemetry(packageName, logger)),
  };
}

/**
 * Build a PROBE host ctx for the hot-UPDATE pre-verify (`verifyNewDigest-
 * Activatable`). It is identical to `createExtensionHostContext` EXCEPT the four
 * register-CHANNEL ports (`mcp` / `capabilities` / `objects` / `ui`) are replaced
 * by INERT recorders that touch NO live host registry. Running the new digest's
 * `register(ctx)` against this probe PROVES it does not throw — the invariant
 * "verify the new digest ACTIVATES (register succeeds) BEFORE teardown+GC of the
 * old" — without mutating any in-memory registration (the live state stays the OLD
 * digest's until the real activation pass runs after teardown).
 *
 * GRANT-AWARE + FAIL-CLOSED PRESERVED: every OTHER port (settings / secrets / nango
 * / authSession / jobs / notifications / telemetry / db) is the REAL grant-gated
 * impl — so a register that reads settings sees real values, and a register that
 * accesses an UNGRANTED privileged port still fails loud exactly as it would during
 * the real activation. Only the four registration sinks are inert (a probe must not
 * register into the live process). The recorder is returned so a caller can inspect
 * what the probe register WOULD have registered.
 */
export function createExtensionProbeHostContext(
  packageName: string,
  grantedPorts: readonly HostPortName[] = [],
  envInput: ExtensionEnvOverrideInput = {},
  // cinatra#1392 S8: forwarded to the real base ctx + applied to the probe's
  // OWN capability reads, so a pre-verify resolves the same edge-bound
  // substituted providers the real activation would.
  identity?: ExtensionRecordIdentityInput,
): {
  ctx: ExtensionHostContext;
  recorder: {
    mcpTools: unknown[];
    capabilityProviders: Array<{ capability: string; provider: unknown }>;
    objectTypes: unknown[];
    uiSetupSurfaces: unknown[];
    uiSettingsSurfaces: unknown[];
    uiActions: unknown[];
  };
} {
  const real = createExtensionHostContext(packageName, grantedPorts, envInput, identity);
  const granted = new Set<HostPortName>([...grantedPorts, ...AMBIENT_PORTS]);

  const recorder = {
    mcpTools: [] as unknown[],
    capabilityProviders: [] as Array<{ capability: string; provider: unknown }>,
    objectTypes: [] as unknown[],
    uiSetupSurfaces: [] as unknown[],
    uiSettingsSurfaces: [] as unknown[],
    uiActions: [] as unknown[],
  };

  // Inert register-channel ports — built ONLY when GRANTED (else keep the real
  // fail-loud `unavailablePort` so an ungranted access throws during the probe
  // exactly as it would during real activation). Constructing them lazily matters:
  // referencing a method off the ungranted `real.<port>` fail-loud Proxy (e.g.
  // `real.jobs.registerWorker`) would itself THROW at ctx-build time, so each probe
  // port is self-contained and never reads off the ungranted real port.
  const probeMcp: ExtensionHostContext["mcp"] = {
    registerTool: (tool) => {
      recorder.mcpTools.push(tool);
    },
    callPrimitive: async () => {
      throw new Error(`[probe] ${packageName}: ctx.mcp.callPrimitive is not available during a register probe`);
    },
    listExternalServers: async () => [],
    getPublicBaseUrl: async () => ({ publicBaseUrl: null }),
  };
  const probeCapabilities: ExtensionHostContext["capabilities"] = {
    registerProvider: (capability, provider) => {
      // Identity enforcement (cinatra#150) applies to the probe too: a malicious
      // digest must not pass the hot-update pre-verify by claiming another
      // package's identity or the reserved host namespace, and the recorder must
      // reflect the FORCED (authoritative) identity the real activation would
      // register — so apply the same bind+reservation as the live port. The
      // reserved-system-capability guard applies identically (a non-first-party
      // digest must not pass pre-verify by registering a shadow `nango-system`).
      if (isReservedSystemCapabilityDeniedFor(packageName, capability)) {
        denyReservedSystemCapabilityRegister(packageName, capability);
      }
      recorder.capabilityProviders.push({
        capability,
        provider: bindProviderIdentity(packageName, provider),
      });
    },
    // READS stay REAL (matching the probe contract: read ports are real, only
    // registration sinks are inert) — EXCEPT a reserved system credential
    // capability is fail-closed for a non-first-party package exactly as on the
    // live port, so the pre-verify cannot resolve a surface the real activation
    // would deny. A register(ctx) that resolves a legitimate host service
    // capability (e.g. the email/blog facades' `@cinatra-ai/host:*` routing)
    // still sees the same live providers the real activation would.
    resolveProviders: (capability) => {
      if (isReservedSystemCapabilityDeniedFor(packageName, capability)) return [];
      // Same edge-bound substitution as the live port (cinatra#1392 S8) — the
      // pre-verify must resolve what the real activation would.
      return resolveProvidersEdgeBound(packageName, identity, capability);
    },
  };
  const probeObjects: ExtensionHostContext["objects"] = granted.has("objects")
    ? {
        // Spread the REAL objects port (identity + env threaded — so a probe's
        // `resolveType` binds THIS record's ctx-identity, not the default;
        // cinatra#1392) and override ONLY registerType to record instead of
        // registering. Was a fresh identity-less ctx, which dropped the record
        // identity from the non-default ctx's inherited `resolveType`.
        ...real.objects,
        registerType: (descriptor) => {
          // Minimal shape validation mirrors the host registry's keying field so a
          // structurally-broken descriptor (the same input the real registry
          // throws on) still surfaces as a register-threw during the probe.
          if (descriptor == null || typeof descriptor !== "object") {
            throw new Error(
              `[probe] ${packageName}: ctx.objects.registerType received a non-object descriptor`,
            );
          }
          recorder.objectTypes.push(descriptor);
        },
      }
    : real.objects;
  const probeUi: ExtensionHostContext["ui"] = {
    registerSetupSurface: (surface) => {
      recorder.uiSetupSurfaces.push(surface);
    },
    registerSettingsSurface: (surface) => {
      recorder.uiSettingsSurfaces.push(surface);
    },
    registerAction: (action) => {
      recorder.uiActions.push(action);
    },
  };

  // Suppress WORLD-MUTATING action ports during the probe so a `register` that
  // (against contract) enqueues a job / emits a notification / emits telemetry
  // does NOT double-fire when the REAL activation re-runs `register` after
  // teardown. READS (settings/secrets/nango/authSession) stay the real impl so a
  // register that reads config to decide what to register still sees real values.
  const probeJobs: ExtensionHostContext["jobs"] = {
    enqueue: async () => ({ id: "probe-noop" }),
    registerWorker: () => {
      throw new Error(`[probe] ${packageName}: ctx.jobs.registerWorker is not supported`);
    },
  };
  const probeNotifications: ExtensionHostContext["notifications"] = {
    emit: async () => {},
  };
  const probeTelemetry: ExtensionHostContext["telemetry"] = {
    emitUsage: () => {},
  };

  const ctx: ExtensionHostContext = {
    ...real,
    mcp: granted.has("mcp") ? probeMcp : real.mcp,
    capabilities: granted.has("capabilities") ? probeCapabilities : real.capabilities,
    objects: probeObjects,
    ui: granted.has("ui") ? probeUi : real.ui,
    jobs: granted.has("jobs") ? probeJobs : real.jobs,
    notifications: granted.has("notifications") ? probeNotifications : real.notifications,
    telemetry: granted.has("telemetry") ? probeTelemetry : real.telemetry,
  };

  return { ctx, recorder };
}

/**
 * Build the host ctx for a NON-DEFAULT side-by-side version (cinatra#1040 S4).
 *
 * A package may now be installed at several versions at once; the DEFAULT version
 * alone owns the package's unversioned GLOBAL names (MCP tool names, capability
 * providers, connector routes, agent mounts, object types, UI surfaces) and runs
 * bootstrap. A NON-DEFAULT sibling still `register(ctx)`s (proving it activates
 * and enforcing its own declared∩approved ports) but must claim NOTHING global
 * and mutate NO package-keyed shared state — otherwise it would clobber the
 * default version's registrations, settings, or credentials (settings/secrets are
 * keyed by packageName and SHARED across versions).
 *
 * This is the register-only, SIDE-EFFECT-FREE context: it starts from the probe
 * context (register-channel ports mcp/capabilities/objects.registerType/ui +
 * world-mutating action ports jobs/notifications/telemetry already inert) and
 * ADDITIONALLY inerts the package-keyed PERSISTENCE writers — settings/secrets
 * `set`/`delete`, `objects.write`, and `nango.ensureConnectSession`. Every READ
 * (settings/secrets `get`, nango status/connection getters, objects read/history,
 * authSession, logger, runtime) stays the REAL grant-gated impl, and an ungranted
 * privileged port still fails loud exactly as in real activation.
 *
 * VERSION-KEYED SERVING (cinatra#1392 Gap 1). When a version-keyed `sink` is
 * supplied (the host loader `begin`s one per non-default record and threads its
 * commit/abort settle), the four register-channel ports (mcp.registerTool /
 * capabilities.registerProvider / objects.registerType / ui.register*) no longer
 * discard into the probe's throwaway recorder — they RETAIN into that sink (keyed
 * by `(packageName, version)`), so a resolved dependent that is edge-bound to this
 * non-default version can be SERVED its handlers (without leaking the default's
 * global names — the retention is a separate store, never the global registries).
 * The SAME identity/authorization guards the live/probe capability port applies
 * are applied here BEFORE retaining (a non-default sibling must not impersonate
 * another package's provider identity, nor register a reserved host-system
 * capability). Grant-gating is preserved: an UNGRANTED register-channel port keeps
 * the probe's fail-loud `unavailablePort` proxy. Retention starts NON-servable;
 * the host's per-record settle hook commits the sink only on a fully-successful
 * register (see `extension-version-keyed-serving`). Without a `sink` (legacy /
 * single-version), the behavior is byte-for-byte the pre-Gap-1 inert probe.
 */
export function createNonDefaultVersionHostContext(
  packageName: string,
  grantedPorts: readonly HostPortName[] = [],
  envInput: ExtensionEnvOverrideInput = {},
  sink?: VersionKeyedRegistrationSink,
  // cinatra#1392 S8: the NON-DEFAULT record's own (version, isDefault:false)
  // identity. Threaded into the probe base (edge-bound capability reads bind
  // THIS version's pre-resolved pins, not the default's) and into the
  // dispatch-time `callPrimitive` below.
  identity?: ExtensionRecordIdentityInput,
): ExtensionHostContext {
  const { ctx: base } = createExtensionProbeHostContext(packageName, grantedPorts, envInput, identity);
  const granted = new Set<HostPortName>([...grantedPorts, ...AMBIENT_PORTS]);
  const inertVoid = async () => {};

  // Inert the package-keyed persistence writers ONLY when the port is granted —
  // touching an UNGRANTED port's fail-loud proxy would itself throw at build time
  // (same lazy-construction rule the probe follows), and an ungranted write must
  // keep failing loud exactly as in real activation.
  const settings: ExtensionHostContext["settings"] = granted.has("settings")
    ? { get: base.settings.get.bind(base.settings), set: inertVoid, delete: inertVoid }
    : base.settings;
  const secrets: ExtensionHostContext["secrets"] = granted.has("secrets")
    ? { get: base.secrets.get.bind(base.secrets), set: inertVoid, delete: inertVoid }
    : base.secrets;
  const objects: ExtensionHostContext["objects"] = granted.has("objects")
    ? { ...base.objects, write: async () => ({ id: "non-default-version-noop" }) }
    : base.objects;
  const nango: ExtensionHostContext["nango"] = granted.has("nango")
    ? { ...base.nango, ensureConnectSession: async () => ({}) }
    : base.nango;

  // No version-keyed sink → the pre-Gap-1 inert-recorder behavior (legacy /
  // single-version). Retention (and therefore edge-bound serving) is only for a
  // PINNED non-default sibling, for which the host provides a sink.
  if (!sink) {
    return { ...base, settings, secrets, objects, nango };
  }

  // Retain this non-default version's register-channel registrations into the
  // host-provided sink (a fresh, NON-servable entry keyed by (packageName,
  // version); the host commits/aborts it once register settles). The ports below
  // write into it, applying the same guards the live/probe ports apply.
  // Grant-gating preserved: an ungranted port keeps the probe's fail-loud proxy.
  const mcp: ExtensionHostContext["mcp"] = granted.has("mcp")
    ? {
        ...base.mcp,
        registerTool: (tool) => sink.retainMcpTool({ ...tool, packageName }),
        // cinatra#1392 S8: a retained (edge-bound-served) handler of this
        // non-default version may itself call host primitives at DISPATCH time.
        // The probe base's callPrimitive throws unconditionally; with a sink
        // this ctx is a REAL activation, so wire the real invoker under THIS
        // record's identity frame — its own resolved edges (not the default's,
        // not the outer run's) drive the versions it is served. GATED on the
        // sink having SETTLED: during `register(ctx)` (pre-settle) dispatching
        // stays refused, preserving the register-only side-effect-free
        // contract this context exists for.
        callPrimitive: (primitiveName, input) => {
          // Gate on COMMITTED, not merely settled (codex S8 round-0 #5): a
          // FAILED/aborted registration's leaked callbacks must never
          // dispatch — only handlers of a successfully-registered attempt are
          // ever served, and only they may invoke primitives.
          if (!sink.isCommitted()) {
            throw new Error(
              `[non-default-version] ${packageName}: ctx.mcp.callPrimitive is not available ` +
                `during register(ctx) or after a failed registration — a non-default sibling's ` +
                `register must stay dispatch-free, and only a successfully-committed activation's ` +
                `retained handlers may call primitives.`,
            );
          }
          return makeCallPrimitive(packageName, identity)(primitiveName, input);
        },
      }
    : base.mcp;

  const capabilities: ExtensionHostContext["capabilities"] = granted.has("capabilities")
    ? {
        ...base.capabilities,
        registerProvider: (capability, provider) => {
          // Same anti-poisoning + anti-impersonation guards as the live port: a
          // non-default sibling must not register a reserved host-system
          // capability, and its provider identity is FORCED to the host-injected
          // packageName (caller-supplied provider.packageName is untrusted).
          if (isReservedSystemCapabilityDeniedFor(packageName, capability)) {
            denyReservedSystemCapabilityRegister(packageName, capability);
          }
          sink.retainCapabilityProvider(
            capability,
            bindProviderIdentity(packageName, provider),
          );
        },
      }
    : base.capabilities;

  // `objects` already inerts `write` above; override registerType to retain
  // (read/history stay the real grant-gated impl). When objects is ungranted,
  // `objects` is the fail-loud proxy — keep it.
  const objectsVersionKeyed: ExtensionHostContext["objects"] = granted.has("objects")
    ? { ...objects, registerType: (descriptor) => sink.retainObjectType(descriptor) }
    : objects;

  const ui: ExtensionHostContext["ui"] = granted.has("ui")
    ? {
        registerSetupSurface: (surface) => sink.retainUiSetupSurface(surface),
        registerSettingsSurface: (surface) => sink.retainUiSettingsSurface(surface),
        registerAction: (action) =>
          sink.retainUiAction({ id: action.id, handler: action.handler }),
      }
    : base.ui;

  return { ...base, settings, secrets, objects: objectsVersionKeyed, nango, mcp, capabilities, ui };
}
