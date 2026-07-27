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
  readAnthropicSkillSyncEnabledFromDatabase,
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
  devAttachTwentyBearerFromMintedKey,
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
import {
  requireAuthSession,
  isPlatformAdmin,
  resolveOrgRoleForSession,
  resolveOrgRoleForUser,
} from "@/lib/auth-session";
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
// TYPE-ONLY (erased at compile; NOT a route-graph edge) — the concrete seam is
// built at boot by register-cms-review-host-seam-runtime and read off globalThis
// below, so this route-reachable binder pulls no cms-review module onto a route.
import type { CmsReviewHostSeam } from "@/lib/cms-review-host-seam";
// The review fence is a PURE env leaf (no import cost; already reachable from
// every route) — read directly so `isReviewActive` needs no runtime slot.
import { isLifecycleReviewOrchestrationActive } from "@/lib/lifecycle/lifecycle-activation";
import {
  type NangoConnectionMaterializer,
  type NangoConnectionMaterializerInput,
  type HostMcpPaginationService,
  type HostContentEditorDispatchService,
  type HostDrupalMcpService,
  type HostWordPressMcpService,
  type HostInstanceWriteAuthorityService,
  type HostConnectorInstanceInvokerService,
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
// S5-W1 §5 — the trusted `public_site_widget` actor reader for the active MCP
// request frame. Published on the content-editor-dispatch service so the
// wordpress/drupal connectors bind their `resolveWidgetActor` deps seam to a
// SERVER-VERIFIED source (the delegated actor stamped at the transport
// boundary), never connector tool input.
import { resolveWidgetActorFromFrame } from "./widget-actor-frame";
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
  resolveTrustedWriteActor,
  InstanceWriteAuthorityError,
} from "./connector-instance-write-authority";
// cinatra#2017 S2 — the governed connector-instance invoker (Plane C) + its
// transport / catalog cache / policy store. Published below beside the
// instance-write-authority as `@cinatra-ai/host:connector-instance-invoker`.
import {
  invokeConnectorInstanceTool,
  listConnectorInstanceTools,
  type ConnectorInstanceInvokerDeps,
  type InvokerTrustedActor,
  type ResolvedInstanceEndpoint,
} from "@/lib/connector-instance-invoker";
import {
  callConnectorInstanceMcpTool,
  listConnectorInstanceMcpTools,
  InvokerError,
} from "@/lib/connector-instance-mcp-transport";
import {
  CATALOG_DEFAULT_SERVER_ID,
  createInMemoryConnectorInstanceCatalogCache,
} from "@/lib/connector-instance-catalog-cache";
import {
  readInstanceToolPolicy,
  ensureDefaultOpenPolicy,
} from "@/lib/connector-instance-tool-policy-store";
// cinatra#2018 S3 — multi-server enrollment: the persisted per-(instance,
// server) store read/write surface the invoker deps + snapshot loader bind,
// and the sibling enrollment module carrying the reconciler + manual-route
// machinery + the S7-facing health-refresh read. This binder only WIRES them.
import {
  ensureDefaultServerEnrollment,
  listEnrolledServers,
  readServer,
  recordServerExposureMode,
  recordServerStatus,
  retireServersForInstance,
  type ConnectorInstanceServerRecord,
} from "@/lib/connector-instance-server-store";
import { createConnectorInstanceSnapshotLoader } from "@/lib/connector-instance-snapshot-loader";
import {
  addManualServerRoute,
  createWordPressServerEnrollmentDeps,
  listInstanceServersWithHealthRefresh,
  removeManualServerRoute,
  type AddManualServerRouteResult,
  type RemoveManualServerRouteResult,
} from "@/lib/wordpress-server-enrollment";
// cinatra#2019 S4 — the trusted-site native-injection OPT-IN store + the
// org-admin consent members bound onto the `wordpress-mcp` publication below.
import {
  readNativeInjectionPolicy,
  setNativeInjectionMode,
} from "@/lib/connector-instance-native-injection-store";
import {
  createWordPressNativeInjectionConsentMembers,
  type WordPressNativeInjectionConsentSurface,
} from "@/lib/connector-instance-native-injection-consent";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
import { logAuditEvent } from "@/lib/authz/audit";
import { Buffer } from "node:buffer";
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
  /** DEV-ONLY (cinatra#1238): attach a freshly dev-minted Twenty workspace API
   * key through the SANCTIONED save so the bearer RESOLVER can mint it. The
   * twenty-connector's raw Nango import alone leaves `resolveBearer` failing
   * closed (`gateExternalMcpConnectionUse` needs an `externalMcp` connection
   * identity + grant that only the sanctioned path seeds). Runs
   * `saveTwentyConnection` bound to the seeded dev actor, then verifies the gated
   * resolver returns a bearer. Never throws; `resolved:false` on any failure.
   * Dev-gated host-side (`assertDevSetupHostOnly`). SECRET BOUNDARY: the key is
   * never logged/returned. */
  devAttachTwentyBearer(input: {
    instanceUrl: string;
    apiKey: string;
  }): Promise<{ resolved: boolean; connectionId: string | null }>;
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

// ---------------------------------------------------------------------------
// cinatra#2017 S2 — governed connector-instance invoker (Plane C) wiring.
//
// The host publishes ONE shared `{ invokeSiteTool, listSiteTools }` guard; the
// connector resolves it via `hostService(ctx, …)` and calls it with NO
// connectorKey/kind (M6). `connectorKey` is HOST-DERIVED — never connector-
// selected. The host-authoritative source available to this shared impl at call
// time is the SIGNED, host-minted connector-instance pin on the ambient delegated
// actor (§2.7); an absent pin (the org-scope-via-shared-primitive path §1.6 flags
// as the danger) FAILS CLOSED (`connector_key_underivable`). The job path (S7
// seam) supplies `connectorKey` from a host-minted enqueue binding to the
// low-level core API directly — never a payload field (R3-B1).
//
// SHIP-DARK (§1.5): nothing in production reaches these methods yet — delegated
// chat/widget deny-by-default keeps the connector primitives off every live
// perimeter until the S7 cutover. This publication only lets the connector's
// `register(ctx)` RESOLVE the capability fail-loud at boot.
// ---------------------------------------------------------------------------

/** Per-process catalog cache (S3 owns TTL/invalidation/lifecycle — N6). */
const connectorInstanceCatalogCache = createInMemoryConnectorInstanceCatalogCache();
/** The shared authority service — `selectForConnector(kind).requireUse` is the
 * invoker's single live per-instance USE authority pass (M4). */
const connectorInstanceUseAuthority = createInstanceWriteAuthorityService();
/** The connector kinds the invoker guard host-derives a connectorKey for. */
const CONNECTOR_INSTANCE_INVOKER_KINDS = new Set(["wordpress", "drupal"]);

/** Resolve a connector instance's MCP endpoint + single-source Basic auth
 * HOST-SIDE (never connector input). The optional `serverId` (cinatra#2018 S3)
 * targets a dedicated ENROLLED server's route: omitted / the default id keeps
 * the exact pre-S3 default-route behavior; an unknown or non-enrolled serverId
 * resolves null (fail closed — a retired server's endpoint is unreachable even
 * mid-race). Drupal endpoint resolution stays null (later issue). The
 * credential is the host-resolved instance row's application password
 * (host-authoritative — NOT the connector toolbox's raw field, §1.3); it never
 * appears in error text. */
async function resolveConnectorInstanceEndpoint(
  connectorKey: string,
  instanceId: string,
  serverId?: string,
): Promise<ResolvedInstanceEndpoint | null> {
  if (connectorKey !== "wordpress") return null;
  const row = resolveWordPressInstanceAdmin()?.readInstanceById(instanceId) ?? null;
  if (!row || !row.siteUrl || !row.username || !row.applicationPassword) return null;
  const authHeader = `Basic ${Buffer.from(`${row.username}:${row.applicationPassword}`, "utf8").toString("base64")}`;
  if (!serverId || serverId === CATALOG_DEFAULT_SERVER_ID) {
    return { endpoint: resolveWordPressMcpFallbackEndpoint(row.siteUrl), authHeader };
  }
  const server = await readServer(connectorKey, instanceId, serverId);
  if (!server || server.status !== "enrolled") return null;
  return {
    endpoint: resolveWordPressMcpFallbackEndpoint(row.siteUrl, server.restPath),
    authHeader,
  };
}

// ---------------------------------------------------------------------------
// cinatra#2018 S3 — multi-server enrollment wiring (implementation lives in
// the sibling modules; this section only binds host closures).
// ---------------------------------------------------------------------------

/** Per-server snapshot loader: exposure-mode dispatch + classification
 * write-back + flip audit (connector-instance-snapshot-loader.ts). */
const loadConnectorInstanceServerSnapshot = createConnectorInstanceSnapshotLoader({
  callWireTool: (input) => callConnectorInstanceMcpTool(input),
  listTools: (input) => listConnectorInstanceMcpTools(input),
  readExposureMode: async (connectorKey, instanceId, serverId) =>
    (await readServer(connectorKey, instanceId, serverId))?.exposureMode ?? null,
  recordExposureMode: (input) => recordServerExposureMode(input),
  invalidateSnapshot: (instanceId, serverId) =>
    connectorInstanceCatalogCache.invalidate(instanceId, serverId),
});

/** Per-server cache + probe eviction (§6 invalidation events). Omitting
 * `serverId` evicts the whole instance's catalog. Probe eviction is site-wide
 * by design (`invalidateWordPressMcpProbeCache` evicts every per-server entry
 * for the site by prefix — coarse but always safe). */
function invalidateWordPressServerArtifacts(instanceId: string, serverId?: string): void {
  connectorInstanceCatalogCache.invalidate(instanceId, serverId);
  const row = resolveWordPressInstanceAdmin()?.readInstanceById(instanceId) ?? null;
  if (row?.siteUrl) invalidateWordPressMcpProbeCache(row.siteUrl);
}

/** Linear trailing-slash trim (the codebase's ReDoS-safe standard form). */
function trimTrailingSlashesForSiteMatch(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--; // 47 = "/"
  return value.slice(0, end);
}

/** Site-keyed invalidation for the credential-materialization paths (§6 event
 * 4): evict the site's probe verdicts AND every matching instance's catalog so
 * the next acquire re-resolves against the fresh credential binding. */
function invalidateWordPressCatalogBySiteUrl(siteUrl: string): void {
  invalidateWordPressMcpProbeCache(siteUrl);
  const wanted = trimTrailingSlashesForSiteMatch(siteUrl);
  const instances = resolveWordPressInstanceAdmin()?.getAPISettings().instances ?? [];
  for (const instance of instances) {
    if (trimTrailingSlashesForSiteMatch(instance.siteUrl) === wanted) {
      connectorInstanceCatalogCache.invalidate(instance.id);
    }
  }
}

/** Probe/credential target for manual-route verification + health refresh. */
function resolveWordPressProbeTarget(
  instanceId: string,
): { siteUrl: string; username: string; applicationPassword: string } | null {
  const row = resolveWordPressInstanceAdmin()?.readInstanceById(instanceId) ?? null;
  if (!row?.siteUrl || !row.username || !row.applicationPassword) return null;
  return {
    siteUrl: row.siteUrl,
    username: row.username,
    applicationPassword: row.applicationPassword,
  };
}

/** The enrollment module's production deps (real store + real verifier bound
 * inside the sibling module; only the host-owned invalidation + instance
 * resolution close over this binder). */
const wordpressServerEnrollmentDeps = createWordPressServerEnrollmentDeps({
  onServerInvalidated: (instanceId, serverId) =>
    invalidateWordPressServerArtifacts(instanceId, serverId),
  resolveInstance: resolveWordPressProbeTarget,
});

/**
 * Org-admin gate for the S3 server-enrollment members — enforced INSIDE each
 * member (so the S7 settings UI is a pure consumer). Fail-closed: unknown
 * instance, an unbound instance row, a foreign-org binding, or a non-admin org
 * role all deny; a platform admin passes regardless of org binding (the
 * host-admin posture every host settings surface carries).
 */
async function requireWordPressInstanceOrgAdmin(instanceId: string): Promise<{ actorId: string }> {
  const session = await requireAuthSession();
  const row = resolveWordPressInstanceAdmin()?.readInstanceById(instanceId) ?? null;
  if (!row) {
    throw new Error("wordpress-mcp server enrollment: unknown instance");
  }
  if (isPlatformAdmin(session)) return { actorId: session.user.id };
  const activeOrgId = session.session?.activeOrganizationId ?? null;
  const rawOrgId = (row as { orgId?: unknown }).orgId;
  const rowOrgId = typeof rawOrgId === "string" && rawOrgId.trim() ? rawOrgId.trim() : null;
  if (!activeOrgId || !rowOrgId || rowOrgId !== activeOrgId) {
    throw new Error(
      "wordpress-mcp server enrollment: instance is not bound to the caller's active organization",
    );
  }
  const orgRole = await resolveOrgRoleForSession(session);
  if (orgRole !== "org_admin" && orgRole !== "org_owner") {
    throw new Error("wordpress-mcp server enrollment: org-admin role required");
  }
  return { actorId: session.user.id };
}

// Host-LOCAL structural extension of the SDK `HostWordPressMcpService` for the
// S3 server-enrollment surface (the `HostExternalMcpRegistrySetupSurface`
// precedent — NO SDK edit): S7's settings UI resolves these members
// structurally; org-admin authorization runs INSIDE each member.
type HostWordPressMcpServerEnrollmentSurface = HostWordPressMcpService & {
  /** Full enrollment row set (enrolled + present_unenrolled + retired) — the
   * S7 health/catalog matrix read. Also kicks the debounced background probe
   * health refresh for KNOWN enrolled rows. */
  listInstanceServers(instanceId: string): Promise<ConnectorInstanceServerRecord[]>;
  /** Verify-then-enroll a manual server route (probe + real MCP handshake;
   * nothing persists on failure). */
  addManualServerRoute(input: {
    instanceId: string;
    restPath: string;
  }): Promise<AddManualServerRouteResult>;
  /** Delete a manual route (manual rows only — typed rejection otherwise). */
  removeManualServerRoute(input: {
    instanceId: string;
    serverId: string;
  }): Promise<RemoveManualServerRouteResult>;
  /** Manual "refresh now": evict the instance's catalog snapshots + the
   * site's probe verdicts so the next acquire reloads from the wire. */
  invalidateInstanceCatalog(instanceId: string): Promise<void>;
};

/** Build the invoker deps for a host-bound connectorKey (closes over the shared
 * authority / transport / cache / policy store, §1.6). */
function buildConnectorInstanceInvokerDeps(boundConnectorKey: string): ConnectorInstanceInvokerDeps {
  const authority = connectorInstanceUseAuthority.selectForConnector(boundConnectorKey);
  return {
    requireUse: (actor, gateInput) => authority.requireUse(actor, gateInput),
    ensureDefaultOpenPolicy: (input) => ensureDefaultOpenPolicy(input),
    resolveInstanceEndpoint: resolveConnectorInstanceEndpoint,
    cache: connectorInstanceCatalogCache,
    // Per-server exposure dispatch (cinatra#2018 S3): the default server keeps
    // the pre-S3 triad expansion; a dedicated server classifies from the wire
    // `tools/list` (sibling module connector-instance-snapshot-loader.ts).
    loadServerSnapshot: loadConnectorInstanceServerSnapshot,
    callWireTool: (input) => callConnectorInstanceMcpTool(input),
    // Multi-server enrollment deps (cinatra#2018 S3) — WordPress only for now:
    // drupal keeps the exact S2 single-default-server acquire path until its
    // own enrollment lands (a later issue), so no drupal rows are ever minted.
    ...(boundConnectorKey === "wordpress"
      ? {
          listEnrolledServers: (connectorKey: string, instanceId: string) =>
            listEnrolledServers(connectorKey, instanceId),
          ensureDefaultServerEnrollment: async (input: {
            connectorKey: string;
            instanceId: string;
          }) => {
            await ensureDefaultServerEnrollment(input);
          },
          recordServerCatalogStatus: async (input: {
            connectorKey: string;
            instanceId: string;
            serverId: string;
            status: "catalog_unavailable" | "unreachable" | "auth_error";
            at: number;
          }) => {
            await recordServerStatus({
              connectorKey: input.connectorKey,
              instanceId: input.instanceId,
              serverId: input.serverId,
              status: input.status,
              at: new Date(input.at).toISOString(),
            });
          },
        }
      : {}),
    readPolicy: (connectorKey, instanceId) => readInstanceToolPolicy(connectorKey, instanceId),
    audit: (event) =>
      logAuditEvent({
        resourceType: event.resourceType,
        resourceId: event.resourceId,
        actorPrincipalType: "human",
        ...(event.actorPrincipalId ? { actorPrincipalId: event.actorPrincipalId } : {}),
        ...(event.organizationId ? { organizationId: event.organizationId } : {}),
        authSource: "mcp",
        operation: event.operation,
        decision: event.decision,
        policyVersion: "connector-instance-invoker",
        metadata: { ...event.metadata, ...(event.causation ? { causation: event.causation } : {}) },
      }),
    // destructiveHook is INTENTIONALLY absent in S2 — S2 provides the classifier +
    // the hook POINT; the subsystem (persistence/UI/resume-token) is S5 (N2).
    warnAbsentPolicy: (connectorKey, instanceId) => {
      console.warn(
        `[connector-instance-invoker] no persisted policy for ${connectorKey}/${instanceId} — ` +
          `compatibility fallback OPEN (transient; reconcile + first-touch converge it).`,
      );
    },
    // Fail-closed INVALID policy (§10-A3): denies-all AND emits an audit warn —
    // an invalid/malformed persisted record is a security signal, not the benign
    // absent-fallback. Loud + audited so an operator sees a corrupt policy row.
    warnInvalidPolicy: (connectorKey, instanceId) => {
      console.error(
        `[connector-instance-invoker] INVALID policy record for ${connectorKey}/${instanceId} — ` +
          `evaluating as DENY-ALL (fail-closed). A malformed policy row must be repaired.`,
      );
      void logAuditEvent({
        resourceType: "connector_instance",
        resourceId: instanceId,
        actorPrincipalType: "system",
        authSource: "worker",
        operation: "policy_invalid_deny_all",
        decision: "denied",
        policyVersion: "connector-instance-tool-policy",
        metadata: { connectorKey, reason: "invalid_policy_deny_all" },
      });
    },
  };
}

/** Resolve the HOST-DERIVED connectorKey + trusted actor for a guard call. */
async function resolveConnectorInstanceInvokerContext(): Promise<{
  actor: InvokerTrustedActor;
  boundConnectorKey: string;
}> {
  const frame = mcpRequestContextStorage.getStore();
  const delegated = frame?.delegatedActor;
  // The `chat` delegation member carries no pin; narrow via `in` before reading.
  const pin =
    delegated && "connectorInstancePin" in delegated ? delegated.connectorInstancePin : undefined;
  // connectorKey is HOST-DERIVED from the signed pin (host-authoritative) — never
  // connector-selected (M6/R2-B1). No pin / unknown kind ⇒ fail closed.
  if (!pin || !CONNECTOR_INSTANCE_INVOKER_KINDS.has(pin.connectorKey)) {
    throw new InvokerError(
      "connector_key_underivable",
      "the governed invoker requires a signed connector-instance pin to host-derive the connector",
    );
  }
  const resolved = await resolveTrustedWriteActor();
  if (!resolved) {
    // Fail closed — no anonymous/synthetic invoker calls (the gate would deny
    // no_trusted_actor; surface it here before touching any endpoint/cache).
    throw new InstanceWriteAuthorityError("no_trusted_actor");
  }
  return { actor: { ...resolved, connectorInstancePin: pin }, boundConnectorKey: pin.connectorKey };
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

  // The Anthropic "Skills" opt-in (`anthropic_skill_sync_enabled`) is migrating
  // out of the core /configuration/llm page onto the anthropic-connector's own
  // Skills tab (cinatra#1104 pairs with anthropic-connector#44). The connector
  // resolves THIS capability by id and calls `write(enabled)` from its
  // Skills-tab Save; the host owns the full write path so the connector stays a
  // thin caller:
  //  - read():  the canonical fail-closed opt-in reader (`=== true`) that the
  //             core consumers already read, so the connector renders a
  //             read-backed toggle from the same value.
  //  - write(): admin-gated (fail-closed — the host owns the authorization
  //             boundary), persists the primitive boolean to the canonical key,
  //             then runs the SAME eager catalog-sync + stale-GC orchestration
  //             (admin-notify on failure, save never rolled back, inert when
  //             OFF) that core's own settings save runs.
  // A NEW host-local capability id (deliberately NOT a
  // `HOST_CONNECTOR_SERVICE_CAPABILITIES` / sdk-extensions entry):
  // `registerCapabilityProvider` accepts an arbitrary string id, so this stays a
  // core-only, non-ABI registration. Dormant until a connector release that
  // resolves it is installed. The core UI/writer removal is DEFERRED to the
  // paired landing (see cinatra#1104) so this migration never strands the
  // setting.
  const ANTHROPIC_SKILL_CONFIG_CAPABILITY = "@cinatra-ai/host:anthropic-skill-config";
  register(ANTHROPIC_SKILL_CONFIG_CAPABILITY, {
    read: (): boolean => readAnthropicSkillSyncEnabledFromDatabase(),
    // Lazy dynamic import so THIS boot binder never statically pulls the skill
    // sync/GC + auth graph (the write impl + its deps load only when an admin
    // actually writes). The connector's `write(enabled)` runs the full path.
    write: (enabled: boolean): Promise<void> =>
      import("@/lib/anthropic-skill-config-service").then((m) =>
        m.writeAnthropicSkillConfig(enabled),
      ),
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
        // Credential (re)materialization (cinatra#2018 S3 §6 event 4): evict
        // the site's probe verdicts + catalog snapshots so the next acquire
        // re-resolves against the fresh credential binding.
        invalidateWordPressCatalogBySiteUrl(siteUrl);
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
  // docs/internals/contracts/extension-server-entry-contract.md ("refreshing a stale digest").

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
    // DEV-ONLY sanctioned Twenty bearer attach (cinatra#1238). The dev-MODE
    // guard is host-side defense-in-depth (the dev-gated `dev-auto-setup` shell
    // is the only caller); the sanctioned save it delegates to seeds the
    // `externalMcp` connection identity + grant the resolver's use-gate requires.
    devAttachTwentyBearer: async (input: { instanceUrl: string; apiKey: string }) => {
      assertDevSetupHostOnly("external-mcp-registry.devAttachTwentyBearer");
      return devAttachTwentyBearerFromMintedKey(input);
    },
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
    // mint + external A2A client + history-walk -> reply text). Forwards the S5
    // delegated-widget `actorOverride` + `preCreateAuthorize` VERBATIM (the
    // input shape is a superset of the SDK contract's).
    dispatch: dispatchContentEditorViaA2A,
    // S5-W1 §5 — trusted `public_site_widget` actor for the active MCP frame
    // (null on non-widget turns). Read from the verified delegated actor stamped
    // at the transport boundary, NEVER connector tool input.
    resolveWidgetActor: resolveWidgetActorFromFrame,
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
    // action — wrapped (cinatra#2018 S3 §6 event 5) to evict the instance's
    // catalog snapshots and retire every enrollment row (tombstones keep
    // identity/health continuity). The retire is post-delete hygiene: a
    // failure is loud but never resurrects the already-deleted instance.
    deleteInstance: async (id) => {
      await requireWordPressInstanceAdmin().deleteInstance(id);
      connectorInstanceCatalogCache.invalidate(id);
      try {
        await retireServersForInstance("wordpress", id);
      } catch (err) {
        console.error(
          "[wordpress-mcp] failed to retire enrollment rows after instance delete",
          err,
        );
      }
    },
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
    // Credential-rotate eviction (cinatra#2018 S3 §6 event 4): the dev
    // reconcile already evicted the probe cache here; the per-instance catalog
    // snapshots now go with it so a rotated application password never serves
    // a snapshot resolved under the dead credential.
    devInvalidateProbeCache: invalidateWordPressCatalogBySiteUrl,
    // --- cinatra#2018 S3 — multi-server enrollment surface (S7 consumes) -----
    // Org-admin gated INSIDE each member; implementation lives in the sibling
    // enrollment module. S3 ships the machinery + tests; S7 ships the controls.
    listInstanceServers: async (instanceId) => {
      await requireWordPressInstanceOrgAdmin(instanceId);
      return listInstanceServersWithHealthRefresh(
        { connectorKey: "wordpress", instanceId },
        wordpressServerEnrollmentDeps,
      );
    },
    addManualServerRoute: async (input) => {
      const { actorId } = await requireWordPressInstanceOrgAdmin(input.instanceId);
      return addManualServerRoute(
        {
          connectorKey: "wordpress",
          instanceId: input.instanceId,
          restPath: input.restPath,
          actor: actorId,
        },
        wordpressServerEnrollmentDeps,
      );
    },
    removeManualServerRoute: async (input) => {
      const { actorId } = await requireWordPressInstanceOrgAdmin(input.instanceId);
      return removeManualServerRoute(
        {
          connectorKey: "wordpress",
          instanceId: input.instanceId,
          serverId: input.serverId,
          actor: actorId,
        },
        wordpressServerEnrollmentDeps,
      );
    },
    invalidateInstanceCatalog: async (instanceId) => {
      await requireWordPressInstanceOrgAdmin(instanceId);
      invalidateWordPressServerArtifacts(instanceId);
    },
    // --- trusted-site native-injection OPT-IN surface (cinatra#2019 S4) ------
    // ADDITIVE host-local members (the S3 manual-route / #982 structural
    // precedent — the frozen SDK `HostWordPressMcpService` is untouched; the
    // connector resolves these structurally and an older host simply lacks
    // them, which reads as "cannot enable" fail-closed). Authorization lives
    // INSIDE the members: cookie session + `connector.update` (org_admin+) in
    // the org that OWNS the instance, resolved from the persisted row — never
    // caller input, no platform-admin synthesis. On enable/re-acknowledge the
    // member stamps the persisted consent with the HOST-shipped descriptor-set
    // version/hash + disclosure version (the caller can only choose the mode).
    // DORMANT: nothing consumes the persisted mode until the connector's
    // toolbox guard replacement lands; enabling changes no injection behavior.
    ...createWordPressNativeInjectionConsentMembers({
      requireSession: () => requireAuthSession(),
      resolveInstanceOrgId: (instanceId) => {
        // Mirrors the instance-write-authority org-binding read: the persisted
        // row's org (cinatra#274), trimmed; unknown/unbound → null (refused).
        const row = resolveWordPressInstanceAdmin()?.readInstanceById(instanceId) ?? null;
        if (!row) return null;
        return typeof row.orgId === "string" && row.orgId.trim() ? row.orgId.trim() : null;
      },
      resolveOrgRole: (orgId, userId) => resolveOrgRoleForUser(orgId, userId),
      readPolicy: (connectorKey, instanceId, ownerOrgId) =>
        readNativeInjectionPolicy(connectorKey, instanceId, ownerOrgId),
      writeMode: (input) => setNativeInjectionMode(input),
    }),
  } satisfies HostWordPressMcpServerEnrollmentSurface & WordPressNativeInjectionConsentSurface);

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

  // cinatra#2017 S2 — the governed connector-instance invoker (Plane C). ONE
  // shared guard; `connectorKey` is HOST-DERIVED from the signed instance pin on
  // the ambient delegated actor (M6/R2-B1), never a connector/kind selector on
  // the connector-facing shape. `listSiteTools` runs the SAME pin + live USE
  // authority gate BEFORE any catalog read (B2). Ship-dark: no live perimeter
  // reaches these until S7 (delegated deny-by-default keeps them off, untouched).
  register(svc.connectorInstanceInvoker, {
    invokeSiteTool: async (input) => {
      const { actor, boundConnectorKey } = await resolveConnectorInstanceInvokerContext();
      return invokeConnectorInstanceTool(
        {
          connectorKey: boundConnectorKey,
          toolName: input.toolName,
          args: input.args,
          ...(input.instanceId ? { instanceId: input.instanceId } : {}),
          ...(input.serverId ? { serverId: input.serverId } : {}),
          actor,
          primitiveName: `${boundConnectorKey}_site_tool_call`,
        },
        buildConnectorInstanceInvokerDeps(boundConnectorKey),
      );
    },
    listSiteTools: async (input) => {
      const { actor, boundConnectorKey } = await resolveConnectorInstanceInvokerContext();
      return listConnectorInstanceTools(
        {
          connectorKey: boundConnectorKey,
          ...(input.instanceId ? { instanceId: input.instanceId } : {}),
          ...(input.serverId ? { serverId: input.serverId } : {}),
          ...(input.cursor ? { cursor: input.cursor } : {}),
          actor,
          primitiveName: `${boundConnectorKey}_site_tools_list`,
        },
        buildConnectorInstanceInvokerDeps(boundConnectorKey),
      );
    },
  } satisfies HostConnectorInstanceInvokerService);

  // cinatra#2043 S5 — the CMS review-before-publish capability. A NEW host-local
  // capability id (the anthropic-skill-config precedent — an arbitrary string,
  // NOT a HOST_CONNECTOR_SERVICE_CAPABILITIES / sdk-extensions ABI entry). The
  // wordpress-mcp-connector's staged-write trigger resolves it OPTIONALLY +
  // lazily and is INERT until it is published here; the four bound seams
  // (`isReviewActive` / `captureStagedWrite` / `resolveDisposition` /
  // `recordApplyVerification`) delegate to the core capture + read-back +
  // effect-disposition, deriving org/run/actor from the trusted MCP request
  // frame — never connector input. Publication is UNCONDITIONAL at module load
  // (the connector no-ops on the fence-off path); the capability reports the
  // review fence truthfully. This is a thin DEFERRED wrapper that does NO
  // host-service resolution and NO I/O here: `isReviewActive` is the pure fence,
  // and the three write-driving members delegate to the REAL seam built at boot
  // by register-cms-review-host-seam-runtime and installed into the globalThis
  // slot by the system-loops `bind-cms-review-host-seam` phase. The heavy store
  // bindings are deliberately kept OUT of this route-reachable binder — a literal
  // dynamic-import specifier here would still grow every locked route's reachable
  // graph (route-graph ratchet), so the runtime rides only the boot graph, never
  // a route (the background-jobs-registry runner-slot precedent). If the boot
  // phase never bound the slot (a swallowed boot-phase failure), a write-driving
  // member fails CLOSED with a loud error rather than silently dropping a
  // capture — but it is only reached when `isReviewActive()` is true, which on a
  // healthy boot implies the slot is bound. A host-LOCAL capability id defined
  // INLINE (the anthropic-skill-config precedent above) so this binder imports no
  // value from the seam module — a value import would pull it onto a route.
  const CMS_REVIEW_CAPABILITY = "@cinatra-ai/host:cms-review";
  const requireBoundCmsReviewSeam = (): CmsReviewHostSeam => {
    const seam = globalThis.__cinatraCmsReviewHostSeam;
    if (!seam) {
      throw new Error(
        "[cms-review] the host seam was not bound at boot (system-loops `bind-cms-review-host-seam` phase) — refusing to capture/verify a staged CMS write fail-closed.",
      );
    }
    return seam;
  };
  register(CMS_REVIEW_CAPABILITY, {
    isReviewActive: () => isLifecycleReviewOrchestrationActive(),
    captureStagedWrite: (input) => requireBoundCmsReviewSeam().captureStagedWrite(input),
    resolveDisposition: (input) => requireBoundCmsReviewSeam().resolveDisposition(input),
    recordApplyVerification: (input) => requireBoundCmsReviewSeam().recordApplyVerification(input),
  } satisfies CmsReviewHostSeam);

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
