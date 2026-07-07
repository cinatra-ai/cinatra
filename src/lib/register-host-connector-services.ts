import "server-only";

// Host-side publication of the PER-CONCERN connector services.
//
// Transport-DI inversion COMPLETE (cinatra#151 Stage 3): every transport
// connector that needs host infra ships a `serverEntry` (`register(ctx)`)
// and BINDS ITSELF at activation — the StaticBundleLoader (dev) /
// RuntimePackageLoader (prod package store) discovers it from the generated
// manifest and calls `register(ctx)`; the connector adapts the host services
// this module publishes into its own deps slot via
// `ctx.capabilities.resolveProviders(<id>)`. Adding or removing a transport
// extension requires NO edit to this file — the manifest + capability
// registry carry the wiring, and this module names NO extension package.
//
// This file is imported at boot from `src/instrumentation.node.ts` (Next.js
// runtime entry) and the BullMQ worker boot path, BEFORE extension
// activation runs — so an activating `register(ctx)` always finds the
// services already published. `@/lib/*` is not reachable from any connector
// package itself.

import {
  readConnectorConfigFromDatabase,
  writeConnectorConfigToDatabase,
  deleteConnectorConfig,
  readOpenAIConnectionFromDatabase,
  readAnthropicConnectionFromDatabase,
} from "@/lib/database";
import {
  decodeCursor,
  buildListPage,
} from "@/lib/mcp-pagination";
// External-MCP registry mutation + the registry READ/bearer-mint surface
// (cinatra#172 Stage H4): the twenty transport resolves its live workspace
// row + upstream bearer through the extended `external-mcp-registry` service
// so `twenty-mcp-call.ts` carries no `@/` edge. The bearer mint is trusted
// in-process plumbing — see the contract's TRUST note.
import {
  upsertExternalMcpServer,
  deleteExternalMcpServer,
  getExternalMcpServerById,
  listExternalMcpServers,
  resolveExternalMcpServerBearer,
  EXTERNAL_MCP_NANGO_PROVIDER_CONFIG_KEY,
} from "@/lib/external-mcp-registry";
// Connector setup-page server actions for @cinatra-ai/mcp-server-connector
// (cinatra#612) and @cinatra-ai/twenty-connector (twenty-connector#39): the
// connectors adapt these into their own deps slots. The mcp-server-connector
// bundled-react fallback (and a lock-pinned OLDER twenty-connector — compat
// window, cinatra#1097) passes them DIRECTLY into `<form action={…}>`, so
// they MUST be real server-action REFERENCES — exports of a "use server"
// module — not adapter closures defined here: a closure in this
// (non-"use server") module carries no server-reference marker and React
// rejects it at RSC form render (twenty-connector#39, digest 1769553696; the
// setup page 500'd for every admin). The CURRENT twenty-connector instead
// binds connector-local "use server" actions that call the published
// implementation at POST time (cinatra#1097), so for it these are plain
// in-process functions. The dedicated `@/app/campaigns/connector-setup-actions` module is
// feather-weight (no static imports — each action lazy-imports the heavy
// `@/app/campaigns/actions` graph on FIRST INVOCATION, preserving the boot- /
// test-collection-path reason the old closures lazy-imported), so this static
// import is safe on the synchronous boot path.
import {
  createExternalMcpServerAction,
  deleteExternalMcpServerAction,
  saveTwentyConnectionAction,
  disconnectTwentyConnectionAction,
} from "@/app/campaigns/connector-setup-actions";
import { requireAuthSession, isPlatformAdmin } from "@/lib/auth-session";
import { getNangoStatus } from "@/lib/nango-system";
import { encryptSecret, decryptSecret } from "@/lib/instance-secrets";
import { buildAppMcpSelfClientHeaders } from "@/lib/mcp-self-client";
import { readInstanceIdentity } from "@/lib/instance-identity-store";
import { isAppDevelopmentMode } from "@/lib/runtime-mode";
import { createNotification } from "@/lib/notifications";
// The per-instance connection use-gate seam (#975 Wave 3 prerequisite, epic
// #978): published so the RELOCATED vendor connection clients gate credential
// use without importing `@/lib/instance-connection-actor` /
// `@/lib/connection-use-gate` / `@/lib/authz` (authz stays core). The seam
// module is deliberately light at module load — it lazy-imports the
// identity-store/use-gate DB/auth graph per call, so this static import adds
// no boot weight.
import {
  resolveOrSeedInstanceIdentity,
  enforceInstanceConnectionUse,
  enforcePerUserInstanceConnectionUse,
  authorizeWorkerConnectionUse,
  isConnectionUseDeniedError,
  resolveTrustedSessionBinding,
} from "@/lib/instance-connection-actor";
import { registerCapabilityProvider } from "@/lib/extension-capabilities-registry";
import {
  type NangoConnectionMaterializer,
  type NangoConnectionMaterializerInput,
  type HostMcpPaginationService,
  type HostContentEditorDispatchService,
  type HostDrupalMcpService,
  type HostWordPressMcpService,
  type HostInstanceWriteAuthorityService,
  type HostExternalMcpRegistryService,
  type HostYouTubeConnectionService,
  type HostInstanceConnectionGateService,
  type HostRuntimeModeService,
  type HostNotificationsService,
  type HostSkillsCatalogService,
  type HostOpenAIConnectionService,
  type HostAnthropicConnectionService,
  getObjectsProviderOrNull,
  lookupCrmProvider,
  requireExtensionAction,
} from "@cinatra-ai/sdk-extensions";
import {
  HOST_CONNECTOR_SERVICE_CAPABILITIES,
  NANGO_CONNECTION_MATERIALIZER_CAPABILITY,
} from "@cinatra-ai/sdk-extensions/internal";
// The generated extension registry — the host's runtime source of truth for
// each extension's manifest, including the raw `cinatra.envOverrides`
// declaration (cinatra#982) and the generator-owned `resolution`
// classification. Read here so the env-override env-var NAMES come SOLELY from
// a connector's own manifest, never hardcoded in core.
import { STATIC_EXTENSION_MANIFEST } from "@/lib/generated/extensions.server";
import { computeConnectorConfigEnvOverrides } from "@/lib/connector-config-env-overrides";
import {
  getGoogleOAuthStatus,
  googleApiFetch,
  refreshGoogleOAuthAccessTokenIfNeeded,
} from "@cinatra-ai/google-oauth-connection";
import {
  readOpenAIConnection,
  updateOpenAIConnection,
  clearOpenAIConnection,
  updateOpenAILoggingEnabled,
} from "@/lib/openai-connection-store";
// Shared host-side A2A content-editor dispatch helper (drupal + wordpress
// content-editor connectors). Carries the @cinatra-ai/llm + @cinatra-ai/a2a
// runtime edges host-side so neither connector imports them.
import { dispatchContentEditorViaA2A } from "./host-content-editor-dispatch";
// Per-user / per-connector-instance WRITE authority for the CMS content path
// (cinatra#409): the host-owned authority the wordpress/drupal content-editor
// connectors call before EVERY write primitive. It resolves the TRUSTED user
// actor host-side (never from connector input), fails closed on no actor, and
// delegates to the existing per-instance connector-authority policy. The
// package whose policy is evaluated is host-bound (allowlist-validated in
// `selectForPackage`) — never caller-supplied.
import {
  createInstanceListAuthority,
  createInstanceWriteAuthorityService,
} from "./connector-instance-write-authority";
// The vendor connection/instance CLIENTS are GONE from core (cinatra#975
// Wave 3 CORE EVICTION, epic #978): each owning connector registers its
// relocated client under the SAME capability id from its `register(ctx)`.
// The host resolves the connector-owned client LAZILY per call through the
// catalog-owner-pinned `@/lib/connector-client-providers` resolvers
// (fail-loud) — it re-publishes the client-backed members on the ids it still
// owns (wordpress-mcp / drupal-mcp, which carry HOST-side non-members, and the
// null-degrading youtube-connection mint whose consumer is another extension)
// by DELEGATION, and no longer publishes the ids whose full surface the
// connectors now own (wordpress-content / github-connection /
// linkedin-connection).
import {
  requireDrupalInstanceAdmin,
  requireLinkedInConnectionClient,
  requireWordPressInstanceAdmin,
  resolveDrupalInstanceAdmin,
  resolveWordPressInstanceAdmin,
  resolveYouTubeConnectionClient,
} from "@/lib/connector-client-providers";
// External-MCP toolbox surfaces — instance settings, the cached reachability
// probes, endpoint resolution, and the private-URL policy stay host-side and
// are published as the `wordpress-mcp` / `drupal-mcp` per-concern services so
// the connectors' `mcp-toolbox` modules carry no `@/` edge.
import {
  probeWordPressInstanceMcpAdapter,
  resolveWordPressMcpEndpoint,
  resolveWordPressMcpFallbackEndpoint,
  invalidateWordPressMcpProbeCache,
} from "@/lib/wordpress-mcp-connection";
// Private-URL policy is a NEUTRAL mechanism (cinatra#975) — sourced from the
// vendor-agnostic `@/lib/url-policy` module, not the wordpress vendor file.
import { isPrivateUrl } from "@/lib/url-policy";
// The widget auth-config stores INVERTED out of core (cinatra#975 Wave 2, epic
// #978): the wordpress-mcp / drupal-mcp connectors now OWN their widget-auth
// store and REGISTER it as the `@cinatra-ai/host:{wordpress,drupal}-widget-auth`
// capability from their own `register(ctx)` (persisting through the host
// `connector-config` capability). The host no longer implements or publishes
// them — core consumers resolve the connector-registered capability lazily
// (`@/lib/widget-auth-provider`, fail-loud degradation).
import {
  getDrupalMcpInstanceStatuses,
  probeDrupalMcp,
  probeDrupalMcpWithBearer,
  invalidateDrupalMcpProbeCache,
  resolveDrupalMcpServerUrl,
} from "@/lib/drupal-mcp-connection";
// The Drupal instance-settings client relocated to the drupal-mcp-connector
// (cinatra#975 Wave 3) — the host `drupal-mcp` publication below DELEGATES the
// client-backed members to the connector-owned provider; only the host-side
// probe/url-policy/status surface (`@/lib/drupal-mcp-connection`) stays
// implemented here.

let _registered = false;

/** The provider key the host registers its per-concern service impls under in
 * the capability registry. Not an extension package name (reserved host id). */
const HOST_PROVIDER_PACKAGE = "@cinatra-ai/host";

/**
 * Dev-boot provisioning WRITERS (cinatra#976, epic #978 W-D) are DEV-ONLY: they
 * persist unvalidated local-dev instance rows / drive a local docker credential
 * rotate. Only the connector `dev-setup.ts` hook (invoked by the strictly
 * dev-gated `dev-auto-setup` shell) resolves them, but we defense-in-depth
 * refuse outside development so a member can never be a production affordance
 * even if resolved on another path. The persist helpers themselves ALSO enforce
 * loopback-only host-side. */
function assertDevSetupHostOnly(member: string): void {
  if (!isAppDevelopmentMode()) {
    throw new Error(`${member} is a dev-only devSetup provisioning member; refused outside development.`);
  }
}

// Host-LOCAL extension of the SDK `HostExternalMcpRegistryService` for the
// "MCP Servers" connector setup-page surface (cinatra#612). Kept host-side
// (NOT in the SDK contract) because the connector resolves these members
// STRUCTURALLY through `@cinatra-ai/host:external-mcp-registry` and never
// imports the SDK type — its own `deps.ts` declares a local structural shape.
// The members extend the published service additively; existing SDK-typed
// consumers (the twenty transport's read/bearer surface) are unaffected.
type HostExternalMcpRegistrySetupSurface = HostExternalMcpRegistryService & {
  /** The host server action the add-form submits to (create/upsert). Owns the
   * admin-authorization boundary + redirect host-side. */
  createServerAction(formData: FormData): Promise<void>;
  /** The host server action the per-row delete button submits to. Owns the
   * authorization boundary + redirect host-side. */
  deleteServerAction(formData: FormData): Promise<void>;
  /** The host server action the twenty-connector setup page's connect form
   * submits to. Owns the admin-authorization boundary + the URL guard + the
   * live key probe + the Nango import + the twenty-workspace row write, host-side
   * (twenty-connector#39). */
  saveTwentyConnectionAction(formData: FormData): Promise<void>;
  /** The host server action the twenty-connector setup page's disconnect button
   * submits to. Owns the authorization boundary + row/connection teardown. */
  disconnectTwentyConnectionAction(formData: FormData): Promise<void>;
  /** Resolve the current viewer (platform-admin flag + user id) for the
   * setup page's visibility scoping. */
  resolveViewerContext(): Promise<{ isAdmin: boolean; userId: string }>;
  /** Is the host connection (Nango) service configured for API-key storage? */
  isConnectionServiceReady(): boolean;
  /** Is the given server URL private/non-public (not LLM-reachable)? */
  isPrivateUrl(serverUrl: string): boolean;
};

// ---------------------------------------------------------------------------
// Env-override precedence for the instance-global `connector-config` store
// (cinatra#982, Option A).
//
// Nango KEEPS its persistence exactly where it is: a single instance-global
// connector-config KV blob (constant id), read from ACTOR-FREE contexts (the
// inbound Nango webhook signature verify resolves the secret with no cookie /
// MCP / A2A actor). The org-scoped `ctx.settings`/`ctx.secrets` ports
// deliberately fail closed with no actor, so nango must NOT be routed through
// them. Instead, the operator env override (the shape nango already supported
// via its now-evicted `process.env` reads) is applied HERE, at the
// connector-config boundary: env-first-else-DB, resolved from `process.env`
// plus the connector's OWN manifest `cinatra.envOverrides` — core hardcodes NO
// env-var name. A connector opts in by binding its package name to
// `resolveEnvOverrides` in its `register(ctx)` (nango does); this member is
// additive and does not alter the frozen `HostConnectorConfigService` contract.
// The pure precedence/validation lives in `@/lib/connector-config-env-overrides`
// (unit-tested without the host boot graph); this file owns the registry lookup
// and the capability wiring.
// ---------------------------------------------------------------------------

/**
 * The `resolveEnvOverrides` member bound onto the host `connector-config`
 * capability. Looks the CALLER's manifest up in the generated registry (by the
 * package name it supplies from its own `register(ctx)`) and resolves its
 * currently-set env overrides. Returns `{}` for a package that declares none
 * (every extension today, until nango's manifest change ships), so the member
 * is inert for every other connector-config consumer.
 */
export function resolveConnectorConfigEnvOverrides(packageName: string): Record<string, string> {
  const record = STATIC_EXTENSION_MANIFEST[packageName];
  return computeConnectorConfigEnvOverrides(
    packageName,
    record?.envOverrides,
    record?.resolution,
  );
}

/**
 * Publish the per-concern host connector services into the capability
 * registry. A serverEntry transport's `register(ctx)` resolves exactly the
 * concerns it needs via `ctx.capabilities.resolveProviders(<id>)` and adapts
 * them into its own deps slot — the host names no transport here. Idempotent
 * — safe to call from multiple boot paths; only the first call publishes
 * (subsequent calls no-op so test setups that re-import this module don't
 * double-publish).
 */
export function registerHostConnectorServices(): void {
  if (_registered) return;
  _registered = true;

  const svc = HOST_CONNECTOR_SERVICE_CAPABILITIES;
  const register = (capability: string, impl: unknown) =>
    registerCapabilityProvider(capability, { packageName: HOST_PROVIDER_PACKAGE, impl });

  register(svc.connectorConfig, {
    read: readConnectorConfigFromDatabase,
    write: writeConnectorConfigToDatabase,
    // PHYSICAL row delete — the nango legacy-key purge (security-reviewed:
    // the dead, untrusted key must be REMOVED, never blanked) binds this
    // member through its injected config store.
    delete: deleteConnectorConfig,
    // ADDITIVE member (cinatra#982, Option A) — the frozen SDK
    // `HostConnectorConfigService` contract (read/write/delete) is unchanged;
    // consumers that need env-override precedence resolve it structurally (the
    // `HostExternalMcpRegistrySetupSurface` precedent). Nango calls this,
    // bound to its own package name, to overlay the operator env override onto
    // its instance-global settings read WITHOUT the org-scoped ports —
    // preserving the actor-free webhook-verify secret read (see the note above
    // this function).
    resolveEnvOverrides: resolveConnectorConfigEnvOverrides,
  });

  // BLOCKING nango connection-save materializers (linkedin account row +
  // wordpress instance row). One host provider; dispatches by connectorKey and
  // reports `handled` so the nango save path can fail loud on a key that
  // requires materialization but finds no handler. Failures propagate — the
  // save FAILS, exactly the inline semantics the save body carried when it
  // imported these host modules directly. Since the Wave-3 core eviction the
  // row writers are the CONNECTOR-owned relocated clients, resolved fail-loud
  // per dispatch (a save for a key whose owning connector is absent FAILS
  // LOUD — never a silent half-saved connection). The host keeps owning the
  // materializer DISPATCH itself: the nango save path runs EVERY registered
  // provider, so a second connector-registered linkedin/wordpress handler
  // would double-materialize each save (linkedin-connector#42).
  const hostNangoMaterializer: NangoConnectionMaterializer = {
    materialize: async (input: NangoConnectionMaterializerInput) => {
      if (input.connectorKey === "wordpress") {
        const siteUrl = input.siteUrl?.trim();
        if (!siteUrl) {
          throw new Error("Enter the WordPress site domain before connecting with Nango.");
        }
        await requireWordPressInstanceAdmin().saveWordPressInstanceFromNangoConnection({
          siteUrl,
          providerConfigKey: input.providerConfigKey,
          connectionId: input.connectionId,
        });
        return { handled: true };
      }
      if (input.connectorKey === "linkedin") {
        await requireLinkedInConnectionClient().saveAccountFromNangoConnection({
          providerConfigKey: input.providerConfigKey,
          connectionId: input.connectionId,
        });
        return { handled: true };
      }
      return { handled: false };
    },
  };
  register(NANGO_CONNECTION_MATERIALIZER_CAPABILITY, hostNangoMaterializer);

  // The legacy `@cinatra-ai/host:nango-connection-storage` id is FULLY
  // RETIRED (cinatra#151 Stage 7 — the epic's governance end-state). It was
  // removed from the SDK contract and every in-tree consumer by the
  // transport-DI inversion (Stage 3) and survived here only as a
  // deprecation-window compat shim for runtime package-store digests
  // installed before the re-point; that window is closed. A digest that old
  // gets a capability-resolution miss at call time and must be refreshed
  // from the marketplace (every current package resolves the
  // connector-authored `nango-system` surface directly). The miss is thrown
  // by the stale package's OWN bundled code — the host deliberately does NOT
  // resurrect the id with a tombstone provider (the Stage 7 pin: the id
  // resolves to NOTHING, host-connector-services-publication.test.ts).
  // Operator remediation — an installed digest that predates a host
  // capability re-point is refreshed via the marketplace hot-update path;
  // for a first-party connector that refresh is only meaningful AFTER the
  // cinatra#161 republish wave (earlier refreshes hit the built-artifacts-
  // only install gate: loud, old digest stays active). Runbook:
  // docs/extension-server-entry-contract.md ("refreshing a stale digest").

  register(svc.googleOAuth, {
    getStatus: getGoogleOAuthStatus,
    apiFetch: googleApiFetch,
    refreshAccessTokenIfNeeded: refreshGoogleOAuthAccessTokenIfNeeded,
  });

  register(svc.secretsCodec, { encryptSecret, decryptSecret });

  register(svc.externalMcpRegistry, {
    upsertServer: upsertExternalMcpServer,
    deleteServer: deleteExternalMcpServer,
    // Registry READ + bearer-mint surface (cinatra#172 Stage H4). The bearer
    // mint is trusted in-process plumbing for server-side callers (the twenty
    // transport) — it bypasses the LLM-facing Layer-B proxy by design; see
    // the contract's TRUST note. The minted bearer never crosses a wire
    // boundary other than the upstream MCP call itself.
    getServerById: getExternalMcpServerById,
    listServers: listExternalMcpServers,
    resolveBearer: resolveExternalMcpServerBearer,
    // --- mcp-server-connector setup-page surface (cinatra#612) --------------
    // The carved "MCP Servers" connector binds these into its deps slot and
    // passes them straight into `<form action={…}>`, so they are published as
    // the REAL server-action references from the "use server"
    // connector-setup-actions module (see the module-head note — an adapter
    // closure here carries no server-reference marker and 500s the setup page
    // at RSC form render, twenty-connector#39). The actions own the
    // admin-authorization boundary + redirect host-side
    // (src/app/campaigns/actions.ts, lazy-loaded on first submit) — the
    // connector reimplements NO auth.
    createServerAction: createExternalMcpServerAction,
    deleteServerAction: deleteExternalMcpServerAction,
    // twenty-connector setup-page connect/disconnect actions
    // (twenty-connector#39). Same posture as the MCP-Servers write actions
    // above: real "use server" references, bound by the connector's
    // register(ctx) directly into `<form action={…}>`. The host owns the admin
    // authz + URL guard + live key probe + Nango import + twenty-workspace row
    // write inside the action; the connector reimplements NO auth and never
    // sees the key.
    saveTwentyConnectionAction,
    disconnectTwentyConnectionAction,
    // Resolve the viewer (platform-admin flag + user id) for visibility
    // scoping. Mirrors the derivation the host external-MCP page carried —
    // `requireAuthSession` redirects an unauthenticated viewer to sign-in.
    resolveViewerContext: async () => {
      const session = await requireAuthSession();
      return { isAdmin: isPlatformAdmin(session), userId: session.user.id };
    },
    // Nango readiness for the API-key field advisory copy.
    isConnectionServiceReady: () => getNangoStatus().status === "connected",
    // Private-URL guard (LLM providers cannot reach localhost/private IPs).
    isPrivateUrl,
    // The shared external-MCP Nango provider-config key, published as DATA so a
    // dev-boot hook (the Twenty `dev-setup.ts`) imports its minted bearer under
    // the SAME key the row's `resolveBearer` reads — never hardcoded
    // connector-side (cinatra#976, epic #978 W-D).
    nangoProviderConfigKey: EXTERNAL_MCP_NANGO_PROVIDER_CONFIG_KEY,
  } satisfies HostExternalMcpRegistrySetupSurface);

  register(svc.mcpSelfClient, { buildHeaders: buildAppMcpSelfClientHeaders });

  register(svc.instanceIdentity, { read: readInstanceIdentity });

  // Objects-integration surface (lazy/guarded host-access cutover): the
  // host-bound objects provider + the capability-aware CRM provider lookup,
  // published as VALUES so a connector's serverEntry graph (which must keep
  // SDK peers type-only — host-peer-value-import ban) can register object
  // types / sync adapters / pointer writers through `ctx.capabilities`.
  register(svc.objectsIntegration, {
    getObjectsProvider: () => getObjectsProviderOrNull(),
    // `lookupCrmProvider` consults the SDK registry AND the external resolver
    // bound by src/lib/register-crm-providers.ts (capability-registered CRM
    // providers), so activation order never matters.
    lookupCrmProvider: (providerId: string) => lookupCrmProvider(providerId) ?? null,
  });

  // Extension-action permission gate as a per-concern service: the SAME
  // enforcement the SDK `requireExtensionAction` slot binds
  // (src/lib/register-extension-action-guard.ts), published as a VALUE so a
  // serverEntry-built action impl can gate without an SDK value import
  // (host-peer-value-import ban). Fail-closed: the SDK slot throws until the
  // guard module has bound it (instrumentation imports it before activation).
  register(svc.extensionActionGuard, {
    require: (packageId: string, mode: "read" | "manage") =>
      requireExtensionAction(packageId, mode),
  });

  // --- transport-DI inversion services (cinatra#151 Stage 3) ---------------
  // The per-concern surfaces the LLM-platform and content-editor MCP
  // serverEntry transports adapt into their own deps slots at activation.

  register(svc.mcpPagination, {
    decodeCursor,
    buildListPage,
  } satisfies HostMcpPaginationService);

  register(svc.contentEditorDispatch, {
    // A2A blocking dispatch to the content-editor agents (host-side bearer
    // mint + external A2A client + history-walk -> reply text).
    dispatch: dispatchContentEditorViaA2A,
  } satisfies HostContentEditorDispatchService);

  // Actor-scoped instance LIST filters — the read-boundary twin of the
  // instance-write-authority `requireWrite` gate, reusing the IDENTICAL
  // machinery (trusted-actor resolution from the MCP/llm frame,
  // live-membership reverify with deny-no-row, sanitized decisionActor,
  // per-instance org-binding + connector-package `use` gate).
  // Returns ONLY the trusted actor's authorized instances, [] fail-closed when
  // no actor/membership resolves. Bound host-side to the connector KIND (never
  // caller input) so the package policy + instance reader are host-controlled.
  const filterAuthorizedDrupalInstances = createInstanceListAuthority("drupal");
  const filterAuthorizedWordPressInstances = createInstanceListAuthority("wordpress");

  // The host stays the FIRST (and complete) `drupal-mcp` provider so every
  // existing `[0]` resolver (the drupal connector's deps slot + dev-setup
  // hook) keeps resolving ONE full service. Since the Wave-3 core eviction
  // the CLIENT-backed members (instance list/status/save/delete + the dev
  // persist) DELEGATE lazily to the connector-owned relocated client
  // (fail-loud, owner-pinned); the host-side non-members — the cached MCP
  // probe + endpoint/url-policy surface, the actor-scoped lister, and the
  // dev-MODE guard — stay implemented here (authz + probes stay core, #975).
  register(svc.drupalMcp, {
    listInstances: () => requireDrupalInstanceAdmin().listInstances(),
    // ACTOR-SCOPED lister for the external-MCP toolbox-injection path. The host
    // resolves the trusted actor from the MCP request frame and returns ONLY
    // that actor's org-entitled instances; [] fail-closed when no actor resolves
    // AND when the owning connector (the instance store) is absent.
    // The connector toolbox uses THIS, never the global unscoped `listInstances`.
    listAuthorizedInstances: () =>
      filterAuthorizedDrupalInstances(resolveDrupalInstanceAdmin()?.listInstances() ?? []),
    probe: probeDrupalMcp,
    resolveServerUrl: resolveDrupalMcpServerUrl,
    isPrivateUrl,
    // Instance-admin surface (cinatra#172 Stage H2), delegated to the
    // connector-owned client. The writers (saveInstance/deleteInstance) sit
    // behind the connector's manage-gated "use server" actions — identical
    // posture to the static imports they replaced (contract TRUST note).
    getAPIStatus: () => requireDrupalInstanceAdmin().getAPIStatus(),
    saveInstance: (input) => requireDrupalInstanceAdmin().saveInstance(input),
    deleteInstance: (id) => requireDrupalInstanceAdmin().deleteInstance(id),
    getInstanceStatuses: getDrupalMcpInstanceStatuses,
    // --- dev-boot provisioning surface (cinatra#976, epic #978 W-D) ----------
    // Resolved ONLY by the Drupal connector `dev-setup.ts` hook via the
    // strictly dev-gated `dev-auto-setup` shell. The dev-MODE guard is
    // host-side defense-in-depth; the relocated persist helper keeps its
    // intrinsic loopback-only hard-gate (and its own runtime-mode refusal).
    devPersistLocalInstanceUnvalidated: async (input) => {
      assertDevSetupHostOnly("drupal-mcp.devPersistLocalInstanceUnvalidated");
      const persisted = await requireDrupalInstanceAdmin().devPersistLocalInstanceUnvalidated(input);
      return { id: persisted.id };
    },
    devProbeWithBearer: probeDrupalMcpWithBearer,
    devInvalidateProbeCache: invalidateDrupalMcpProbeCache,
  } satisfies HostDrupalMcpService);

  // The drupal widget auth-config store INVERTED to the drupal-mcp-connector
  // (cinatra#975 Wave 2): it now registers `@cinatra-ai/host:drupal-widget-auth`
  // from its own `register(ctx)` (persisting through the host connector-config
  // capability), so the host publishes nothing here.

  // The host stays the FIRST (and complete) `wordpress-mcp` provider — the
  // wordpress connector's deps slot prefers a NON-SELF provider, so it must
  // find one full service here. Since the Wave-3 core eviction the
  // CLIENT-backed members DELEGATE lazily to the connector-owned relocated
  // client (fail-loud, owner-pinned); the host-side non-members — the
  // mcp-adapter probe + endpoint resolution + url-policy
  // (`@/lib/wordpress-mcp-connection`), the actor-scoped lister, and the
  // dev-MODE guard — stay implemented here (authz + probes stay core, #975).
  register(svc.wordpressMcp, {
    listInstances: () => requireWordPressInstanceAdmin().listInstances(),
    // ACTOR-SCOPED lister, published symmetrically with the Drupal service (the
    // WordPress connector toolbox is already fail-closed via the per-instance
    // `instance-write-authority` gate; this is the additive single-call lister
    // a future toolbox revision can adopt). Same trusted-actor +
    // membership-reverify + per-instance gate; [] fail-closed when the owning
    // connector (the instance store) is absent.
    listAuthorizedInstances: () =>
      filterAuthorizedWordPressInstances(
        resolveWordPressInstanceAdmin()?.getAPISettings().instances ?? [],
      ),
    probeAdapter: probeWordPressInstanceMcpAdapter,
    resolveServerUrl: resolveWordPressMcpFallbackEndpoint,
    isPrivateUrl,
    // Instance hard-delete behind the connector's manage-gated relocated
    // action (the relocated client already returns Promise<void>).
    deleteInstance: (id) => requireWordPressInstanceAdmin().deleteInstance(id),
    // Connection/instance-admin surface (cinatra#172 Stage H3), delegated to
    // the connector-owned client. The webhook writers (register/remove) sit
    // behind the assistant connector's manage-gated "use server" actions —
    // identical posture to the static imports they replaced (contract TRUST
    // note).
    getAPIStatus: () => requireWordPressInstanceAdmin().getAPIStatus(),
    getAPISettings: () => requireWordPressInstanceAdmin().getAPISettings(),
    readInstanceById: (id) => requireWordPressInstanceAdmin().readInstanceById(id),
    resolveEndpoint: resolveWordPressMcpEndpoint,
    webhookSubscriptions: {
      list: (instance) => requireWordPressInstanceAdmin().webhookSubscriptions.list(instance),
      register: (instance, subscription) =>
        requireWordPressInstanceAdmin().webhookSubscriptions.register(instance, subscription),
      remove: (instance, subscriptionId) =>
        requireWordPressInstanceAdmin().webhookSubscriptions.remove(instance, subscriptionId),
    },
    // --- dev-boot provisioning surface (cinatra#976, epic #978 W-D) ----------
    // Resolved ONLY by the WordPress connector `dev-setup.ts` hook via the
    // strictly dev-gated `dev-auto-setup` shell. The dev-MODE guard is
    // host-side defense-in-depth; the relocated unvalidated persist keeps its
    // intrinsic loopback-only hard-gate.
    devSaveInstance: async (input) => {
      assertDevSetupHostOnly("wordpress-mcp.devSaveInstance");
      const saved = await requireWordPressInstanceAdmin().saveWordPressInstance(input);
      return { id: saved.id, connectionId: saved.connectionId };
    },
    devPersistLocalInstanceUnvalidated: async (input) => {
      assertDevSetupHostOnly("wordpress-mcp.devPersistLocalInstanceUnvalidated");
      const persisted =
        await requireWordPressInstanceAdmin().persistLocalDevWordPressInstanceUnvalidated(input);
      return { id: persisted.id, connectionId: persisted.connectionId };
    },
    devInvalidateProbeCache: invalidateWordPressMcpProbeCache,
  } satisfies HostWordPressMcpService);

  // The WordPress post/media CONTENT surface (`@cinatra-ai/host:
  // wordpress-content`, cinatra#172 Stage H3) is NO LONGER host-published:
  // the wordpress-mcp-connector registers the full content service from its
  // own `register(ctx)` (cinatra#975 Wave 3 — the relocated client), and its
  // deps slot's non-self preference falls back to its own registration on
  // this post-eviction host. Core's blog publish/status/delete flows resolve
  // the connector-owned provider through `@/lib/connector-client-providers`
  // (fail-loud degradation).

  // Per-user / per-connector-instance WRITE authority (cinatra#409). The
  // wordpress/drupal content-editor MCP connectors resolve this service and
  // call `selectForConnector(<their kind>).requireWrite(...)` at the TOP of
  // every write primitive (after schema-parse + instance resolve, before any
  // host content writer). The host resolves the TRUSTED user actor from the
  // active MCP/llm/cookie frame (NEVER connector input), DENIES fail-closed when
  // no userId+orgId resolve, then enforces TWO host-side gates keyed on the
  // trusted actor's org: (1) PER-INSTANCE — resolves the instance row host-side
  // and asserts its persisted org binding (cinatra#274) == the actor's org, so a
  // forged instanceId (same-org-mismatch or different-org) is DENIED and an
  // unknown/unbound row is DENIED fail-closed; (2) CONNECTOR-PACKAGE — the
  // existing `requireConnectorAuthority` policy (emits a `connector_instance`
  // audit row). `selectForConnector` maps the connector KIND to BOTH the package
  // id and the instance reader host-side — neither is ever caller-supplied.
  register(svc.instanceWriteAuthority, createInstanceWriteAuthorityService() satisfies HostInstanceWriteAuthorityService);

  // The wordpress widget auth-config store INVERTED to the
  // wordpress-mcp-connector (cinatra#975 Wave 2): it now registers
  // `@cinatra-ai/host:wordpress-widget-auth` from its own `register(ctx)`
  // (persisting through the host connector-config capability), so the host
  // publishes nothing here. The webhook HMAC verification is a generic
  // mechanism kept host-side (@cinatra-ai/webhooks verifyLegacyHmac).

  register(svc.runtimeMode, {
    isDevelopment: isAppDevelopmentMode,
  } satisfies HostRuntimeModeService);

  register(svc.notifications, {
    create: createNotification,
  } satisfies HostNotificationsService);

  // Skills catalog read for shell-tool skill delivery. Lazy `import()` so the
  // @cinatra-ai/skills -> @cinatra-ai/agents boot cycle never rides this
  // module's load: the skills module loads at call time, never boot.
  register(svc.skillsCatalog, {
    read: async () => {
      const { readSkillsCatalog } = await import("@cinatra-ai/skills");
      return readSkillsCatalog();
    },
  } satisfies HostSkillsCatalogService);

  // Provider-named host stores (the `googleOAuth` precedent): the openai /
  // anthropic connection rows live in the host metadata store and are read by
  // host configuration surfaces — NOT relocatable into the extensions.
  register(svc.openaiConnection, {
    readRowFromDatabase: readOpenAIConnectionFromDatabase,
    read: readOpenAIConnection,
    update: updateOpenAIConnection,
    clear: clearOpenAIConnection,
    updateLoggingEnabled: updateOpenAILoggingEnabled,
  } satisfies HostOpenAIConnectionService);

  register(svc.anthropicConnection, {
    readRowFromDatabase: readAnthropicConnectionFromDatabase,
  } satisfies HostAnthropicConnectionService);

  // Chat user-context providers register through each connector's own
  // `register(ctx)` (gmail-connector#7 / google-calendar-connector#7) via the
  // serverEntry loader. The LLM-platform and content-editor MCP transports'
  // deps slots bind the same way since the transport-DI inversion
  // (cinatra#151 Stage 3) — no static registrar call survives here.

  // Transport-tail connection services (cinatra#172 Stage H4 →
  // cinatra#975 Wave 3): the `github-connection` / `linkedin-connection` ids
  // are NO LONGER host-published. Each owning connector registers its
  // relocated client (the full former host member set: the SDK contract
  // members with the identical token/PAT-stripping posture, PLUS the additive
  // core-call-site members) from its own `register(ctx)`; the github
  // connector's own deps slot resolves `[0]` and now finds the
  // connector-owned provider, and the linkedin connector binds its deps
  // directly to its own client. Core resolves the connector-owned providers
  // through `@/lib/connector-client-providers` (owner-pinned, fail-loud
  // degradation).

  // `youtube-connection` KEEPS a host-published provider — a thin DELEGATION
  // to the connector-owned relocated client — because its consumer is a
  // DIFFERENT extension (the media-feeds connector's `[0]` deps adapter, with
  // no manifest dependency edge on the youtube connector). An absent youtube
  // connector degrades the mint to `null` — the SAME "no usable credential"
  // contract the former in-core client returned when Nango/the connection was
  // unconfigured — so `media_feed_youtube_list` keeps its token-missing
  // domain error instead of a host-service wiring throw (codex Wave-3
  // eviction round-1 finding 1).
  register(svc.youtubeConnection, {
    getConfiguredAccessToken: async () =>
      (await resolveYouTubeConnectionClient()?.getConfiguredAccessToken()) ?? null,
  } satisfies HostYouTubeConnectionService);

  // Per-instance connection use-gate seam (#975 Wave 3 prerequisite, epic
  // #978): the gate decision, audit rows, actor construction and identity-row
  // storage stay HOST-SIDE (authz stays core — #975); the relocated vendor
  // clients resolve outcome records only. Identity-row internals never cross
  // the boundary: the host seam's `NangoConnectionIdentity | null` returns
  // fold to `{ identityResolved } / { gated }` booleans (`null` == the
  // pre-#967 ungated fallback — the import-era semantics, preserved). A
  // use-gate DENY propagates fail-closed out of the enforce members
  // (classifiable via `isConnectionUseDenied`); `authorizeWorkerConnectionUse`
  // is the actor-less worker gate (no seeding; no-identity AND deny both fold
  // to a bare `false` — the youtube-api scraper-mint pattern);
  // `resolveTrustedSessionBinding` is the only sanctioned FRESH-binding
  // source (validated session, never request input). NOTE this id is in the
  // host's RESERVED_SYSTEM_CAPABILITIES (extension-host-context.ts): a
  // non-first-party extension can neither resolve nor register it through
  // the `ctx.capabilities` port — identity seeding is authz-adjacent and
  // must not be ambient to marketplace code (codex round-0 finding).
  register(svc.instanceConnectionGate, {
    resolveOrSeedInstanceIdentity: async (input) => ({
      identityResolved: (await resolveOrSeedInstanceIdentity(input)) !== null,
    }),
    enforceInstanceConnectionUse: async (input) => ({
      gated: (await enforceInstanceConnectionUse(input)) !== null,
    }),
    enforcePerUserInstanceConnectionUse: async (input) => ({
      gated: (await enforcePerUserInstanceConnectionUse(input)) !== null,
    }),
    authorizeWorkerConnectionUse,
    resolveTrustedSessionBinding,
    isConnectionUseDenied: isConnectionUseDeniedError,
  } satisfies HostInstanceConnectionGateService);

  // Observability parity: agent extensions log per-package via
  // `[cinatra:extensions:agent]`; skill extensions log a scan summary via
  // flat `[cinatra:extensions]`. This line confirms the host-service
  // publication ran. The serverEntry transports log their own activation
  // through the loader result lines.
  //
  // Dev-gated for parity: the skill/agent scans are CINATRA_RUNTIME_MODE-gated,
  // so prod/worker boots stay lean (the publication still runs; only the
  // confirmation line is suppressed).
  if (process.env.CINATRA_RUNTIME_MODE === "development") {
    console.info(
      "[register-host-connector-services] published per-concern host connector " +
        "services (serverEntry transports self-bind at activation).",
    );
  }
}

// Auto-register on module load. Boot paths import this module at startup;
// the moment it loads, the host services are resolvable by activating
// serverEntry transports.
registerHostConnectorServices();
