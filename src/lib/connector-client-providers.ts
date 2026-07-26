import "server-only";

// Host-side LAZY resolution of the CONNECTOR-OWNED vendor connection/instance
// clients (cinatra#975 Wave 3 CORE EVICTION — the vendor-publish-direction
// inversion, epic #978: core owns integration MECHANISM, never vendor CODE).
//
// The five vendor API clients that used to live in core
// (`@/lib/wordpress-api`, `@/lib/drupal-api`, `@/lib/linkedin-api`,
// `@/lib/github-api`, `@/lib/youtube-api`) are GONE from core. Each owning
// connector now OWNS its client and REGISTERS it from its `register(ctx)`
// under the SAME host capability id core published since cinatra#172 H2–H4:
//
//   - `@cinatra-ai/host:wordpress-mcp`      + `@cinatra-ai/host:wordpress-content`
//   - `@cinatra-ai/host:drupal-mcp`
//   - `@cinatra-ai/host:linkedin-connection`
//   - `@cinatra-ai/host:github-connection`
//   - `@cinatra-ai/host:youtube-connection`
//
// Core's former value-import sites resolve the client HERE at call time —
// never by value-importing a vendor module. Follows the merged Wave-2
// widget-auth resolver (`@/lib/widget-auth-provider`): lazy resolution,
// OWNER-PINNED provider selection, a structural guard, and FAIL-LOUD
// degradation (`resolve*()` → null for surfaces that degrade visibly;
// `require*()` → THROWS a descriptive error for surfaces that cannot proceed
// without the client).
//
// OWNER PIN (anti-spoof). Core must never name a specific extension package
// (core-extension-instance-coupling-ban, pinned empty). The owning package is
// DERIVED at resolution time from the ONE sanctioned hand-maintained identity
// registry — `@cinatra-ai/connectors-catalog` (`getConnectorDescriptorBySlug`)
// — exactly the `connector-instance-write-authority` precedent: the host maps
// a connector KIND/slug to the catalog descriptor and pins the provider whose
// host-injected `packageName` equals the catalog `packageId` AND whose impl
// passes the structural guard. Another active extension registering the same
// capability id is rejected unless it ALSO became the catalog-declared owner —
// a reviewed registry change, not a runtime registration. A slug the catalog
// does not cover resolves to null → fail closed.
//
// HOST-SIDE NON-MEMBERS stay in core by design (the connector PRs pin them):
// the wordpress/drupal mcp-adapter probes + endpoint resolution + url-policy
// (`@/lib/wordpress-mcp-connection` / `@/lib/drupal-mcp-connection` /
// `@/lib/url-policy`), the actor-scoped `listAuthorizedInstances` + instance
// write authority (authz stays core — #975), the dev-MODE guard on the host
// `dev*` wrappers, and the github actor-gated credential-resolver posture
// (`ActorContext` never crosses the extension boundary — #1077).

import type {
  HostGitHubConnectionService,
  HostLinkedInConnectionService,
  HostWordPressContentService,
  HostWordPressMcpService,
  HostYouTubeConnectionService,
} from "@cinatra-ai/sdk-extensions";
import { getConnectorDescriptorBySlug } from "@cinatra-ai/connectors-catalog/descriptors.mjs";
import { resolveCapabilityProviders } from "@/lib/extension-capabilities-registry";

// Capability ids as literals (the SAME ids the connectors register under and
// `HOST_CONNECTOR_SERVICE_CAPABILITIES` holds) — literals, never import
// specifiers, so they carry no vendor-import coupling (the Wave-2 precedent).
const WORDPRESS_MCP_CAPABILITY = "@cinatra-ai/host:wordpress-mcp";
const WORDPRESS_CONTENT_CAPABILITY = "@cinatra-ai/host:wordpress-content";
const DRUPAL_MCP_CAPABILITY = "@cinatra-ai/host:drupal-mcp";
const LINKEDIN_CONNECTION_CAPABILITY = "@cinatra-ai/host:linkedin-connection";
const GITHUB_CONNECTION_CAPABILITY = "@cinatra-ai/host:github-connection";
const YOUTUBE_CONNECTION_CAPABILITY = "@cinatra-ai/host:youtube-connection";

// Connector-catalog SLUGS (host-owned kind→slug mapping; the package id is
// registry-resolved, never a core literal — the instance-write-authority
// precedent).
const WORDPRESS_CONNECTOR_SLUG = "wordpress-mcp-connector";
const DRUPAL_CONNECTOR_SLUG = "drupal-mcp-connector";
const LINKEDIN_CONNECTOR_SLUG = "linkedin-connector";
const GITHUB_CONNECTOR_SLUG = "github-connector";
const YOUTUBE_CONNECTOR_SLUG = "youtube-connector";

// ---------------------------------------------------------------------------
// Row/document shapes. The SDK contracts stay frozen (the connectors register
// the ADDITIVE relocated-client members structurally — the
// `HostExternalMcpRegistrySetupSurface` precedent), so the additive members
// are typed HERE as local structural types, named exactly like the former
// core exports so call sites read unchanged.
// ---------------------------------------------------------------------------

/** WordPress instance row incl. the host-persisted multi-tenant install→org
 * binding (cinatra#274) the relocated client preserves verbatim. This is the
 * former `WordPressInstanceSettings` shape (timestamps required on host
 * rows). */
export type WordPressInstanceRow = {
  id: string;
  name: string;
  siteUrl: string;
  username: string;
  applicationPassword: string;
  providerConfigKey?: string;
  connectionId?: string;
  lastValidatedAt?: string;
  createdAt: string;
  updatedAt: string;
  blogConnectorId?: string;
  orgId?: string;
  runBy?: string;
};

/** The former `WordPressWritablePostPayload` (the content-service createDraft
 * payload; status pinned to "draft"). */
export type WordPressWritableDraftPayload = Parameters<
  HostWordPressContentService["createDraft"]
>[0]["payload"];

/** The connector-registered `@cinatra-ai/host:wordpress-mcp` provider surface
 * core consumes post-eviction: the client-backed CONTRACT members plus the
 * ADDITIVE relocated-client members (core `@/lib/wordpress-api` export
 * names). The host-side non-members (probes/endpoints/url-policy/
 * listAuthorizedInstances/dev-MODE guards) are NOT here — they stay published
 * by `register-host-connector-services.ts` on the same id. */
export type WordPressInstanceAdminClient = {
  listInstances(): WordPressInstanceRow[];
  getAPIStatus(): { status: "connected" | "not_connected"; detail: string };
  getAPISettings(): { instances: WordPressInstanceRow[]; loggingEnabled?: boolean };
  readInstanceById(id: string): WordPressInstanceRow | null;
  deleteInstance(id: string): Promise<void>;
  webhookSubscriptions: HostWordPressMcpService["webhookSubscriptions"];
  // --- additive relocated-client members (core export names) ---------------
  validateWordPressInstanceConnection(input: {
    siteUrl: string;
    username: string;
    applicationPassword: string;
  }): Promise<unknown>;
  saveWordPressInstance(input: {
    id?: string;
    siteUrl: string;
    username: string;
    applicationPassword?: string;
    blogConnectorId?: string;
    orgId?: string;
    runBy?: string;
  }): Promise<WordPressInstanceRow>;
  saveWordPressInstanceFromNangoConnection(input: {
    siteUrl: string;
    providerConfigKey: string;
    connectionId: string;
  }): Promise<unknown>;
  persistLocalDevWordPressInstanceUnvalidated(input: {
    id?: string;
    siteUrl: string;
    username: string;
    applicationPassword: string;
    name?: string;
  }): Promise<WordPressInstanceRow>;
  setWordPressInstanceBlogConnector(instanceId: string, connectorId: string): void;
  saveWordPressLoggingSettings(enabled: boolean): Promise<void>;
  getWordPressLoggingSettings(): { enabled: boolean; directory: string };
  listWordPressInstances(): Promise<WordPressInstanceRow[]>;
  readLatestPublishedWordPressPost(instance: WordPressInstanceRow): Promise<{
    apiResponse: unknown;
    writableTemplate: WordPressWritableDraftPayload;
  } | null>;
};

/** Drupal instance row incl. the cinatra#274 org binding (the former
 * `DrupalInstanceSettings` shape). */
export type DrupalInstanceRow = {
  id: string;
  name: string;
  siteUrl: string;
  nangoConnectionId: string;
  providerConfigKey: string;
  lastValidatedAt?: string;
  createdAt: string;
  updatedAt: string;
  orgId?: string;
  runBy?: string;
};

/** The connector-registered `@cinatra-ai/host:drupal-mcp` provider surface
 * (client-backed members only — probes/url-policy/statuses/dev-probe-cache
 * stay host-published on the same id). */
export type DrupalInstanceAdminClient = {
  listInstances(): DrupalInstanceRow[];
  getAPIStatus(): Promise<{
    instanceCount: number;
    instances: Array<{ id: string; name: string; siteUrl: string; lastValidatedAt?: string }>;
  }>;
  saveInstance(input: {
    id?: string;
    name: string;
    siteUrl: string;
    mcpApiKey?: string;
  }): Promise<DrupalInstanceRow>;
  deleteInstance(id: string): Promise<void>;
  devPersistLocalInstanceUnvalidated(input: {
    id?: string;
    name: string;
    siteUrl: string;
  }): Promise<{ id: string }>;
};

/** The connector-registered `@cinatra-ai/host:linkedin-connection` provider:
 * the SDK contract (token-stripped rows) plus the additive members the
 * eviction re-points to (linkedin-connector#42). */
export type LinkedInConnectionClient = HostLinkedInConnectionService & {
  /** The linkedin branch of the BLOCKING nango connection-save materializer
   * (row upsert; the return row is deliberately dropped connector-side so
   * token-adjacent material never rides the published surface). */
  saveAccountFromNangoConnection(input: {
    providerConfigKey: string;
    connectionId: string;
  }): Promise<void>;
  /** The telemetry-page logging read (`enabled` + the host-owned #981 capture
   * directory as a read-only display value). */
  getLoggingSettings(): { enabled: boolean; directory: string };
};

/** The connector-registered `@cinatra-ai/host:github-connection` provider:
 * the SDK contract (PAT-stripped `getOAuthSettings`) plus the additive
 * host-call-site members (github-connector#36). The actor-gated resolver
 * path stays host-side (gate + audit FIRST, then the connection-addressed
 * mint) — `ActorContext` never crosses the extension boundary (#1077). */
export type GitHubConnectionClient = HostGitHubConnectionService & {
  /** Actor-LESS legacy mint (PAT fallback preserved) — the packages/skills
   * push path. */
  getAccessToken(input?: {
    connectionId?: string;
  }): Promise<{ accessToken: string; connection: unknown }>;
  /** Gate-first-then-call mint for an ALREADY-AUTHORIZED connectionId —
   * HARD-FAILS, never the instance-global PAT. */
  getAccessTokenForAuthorizedConnection(input: {
    connectionId: string;
  }): Promise<{ accessToken: string; connection: unknown }>;
  /** The host skills-configuration PAT fallback writer. */
  savePersonalAccessToken(pat: string | null): void;
};

/** The connector-registered `@cinatra-ai/host:youtube-connection` provider:
 * the SDK single-reader contract plus the additive app-scoped status/clear
 * members (youtube-connector#36). */
export type YouTubeConnectionClient = HostYouTubeConnectionService & {
  getStatus(): { status: "connected" | "not_connected"; detail: string };
  clearSettings(): Promise<void>;
};

// ---------------------------------------------------------------------------
// Owner-pinned resolution core.
// ---------------------------------------------------------------------------

function catalogOwner(slug: string): string | null {
  return getConnectorDescriptorBySlug(slug)?.packageId ?? null;
}

/** Resolve the catalog-owner-pinned provider for `capability`, or null when
 * the owning connector is absent (not installed/active), the catalog does not
 * cover the slug (fail closed), or the registered impl fails the structural
 * guard (fail closed — never trust a same-id provider from another package or
 * a malformed impl). */
function resolveOwnedClient<T>(
  capability: string,
  slug: string,
  guard: (impl: unknown) => impl is T,
): T | null {
  const owner = catalogOwner(slug);
  if (!owner) return null;
  const match = resolveCapabilityProviders(capability).find(
    (p) => p.packageName === owner && guard(p.impl),
  );
  return (match?.impl as T | undefined) ?? null;
}

/** Fail-loud twin of `resolveOwnedClient` for surfaces that cannot proceed
 * without the client (writes, credential mints, the nango materializer). The
 * message names the catalog-derived owner — never a hardcoded package
 * literal. */
function requireOwnedClient<T>(
  capability: string,
  slug: string,
  guard: (impl: unknown) => impl is T,
): T {
  const client = resolveOwnedClient(capability, slug, guard);
  if (!client) {
    const owner = catalogOwner(slug);
    throw new Error(
      `Connector client capability "${capability}" unavailable — ` +
        (owner
          ? `the owning connector extension (${owner}) is not installed/active ` +
            "(or registered a malformed provider). Install/activate it before " +
            "this surface can resolve the relocated vendor client."
          : `the connector catalog does not declare an owner for "${slug}", so no ` +
            "provider can be trusted (fail-closed)."),
    );
  }
  return client;
}

function hasFunctionMembers(impl: unknown, members: string[]): boolean {
  if (typeof impl !== "object" || impl === null) return false;
  const candidate = impl as Record<string, unknown>;
  return members.every((m) => typeof candidate[m] === "function");
}

function structuralGuard<T>(...members: string[]): (impl: unknown) => impl is T {
  return (impl: unknown): impl is T => hasFunctionMembers(impl, members);
}

// Structural guards: a capability impl is `unknown` by contract (the registry
// stores `unknown`; the runtime trust boundary is HERE, not the compile type).
// Each checks EVERY member the core consumers / host delegations call (codex
// Wave-3 eviction round-1 finding 3: a guard weaker than its consumers lets a
// malformed or stale pre-Wave-3 registration pass resolution and TypeError
// later deep in a consumer instead of failing closed at the boundary).
function isWordPressInstanceAdminClient(impl: unknown): impl is WordPressInstanceAdminClient {
  if (
    !hasFunctionMembers(impl, [
      "listInstances",
      "getAPIStatus",
      "getAPISettings",
      "readInstanceById",
      "deleteInstance",
      "validateWordPressInstanceConnection",
      "saveWordPressInstance",
      "saveWordPressInstanceFromNangoConnection",
      "persistLocalDevWordPressInstanceUnvalidated",
      "setWordPressInstanceBlogConnector",
      "saveWordPressLoggingSettings",
      "getWordPressLoggingSettings",
      "listWordPressInstances",
      "readLatestPublishedWordPressPost",
    ])
  ) {
    return false;
  }
  const subs = (impl as { webhookSubscriptions?: unknown }).webhookSubscriptions;
  return hasFunctionMembers(subs, ["list", "register", "remove"]);
}

const isWordPressContentClient = structuralGuard<HostWordPressContentService>(
  "createDraft",
  "readPost",
  "readPostStatus",
  "listPublishedPosts",
  "deletePost",
  "uploadMedia",
  "updateDraftMeta",
  "updatePost",
);

const isDrupalInstanceAdminClient = structuralGuard<DrupalInstanceAdminClient>(
  "listInstances",
  "getAPIStatus",
  "saveInstance",
  "deleteInstance",
  "devPersistLocalInstanceUnvalidated",
);

const isLinkedInConnectionClient = structuralGuard<LinkedInConnectionClient>(
  "getStatus",
  "getSettings",
  "listAccounts",
  "listDestinations",
  "publishPost",
  "saveAccountFromNangoConnection",
  "getLoggingSettings",
);

const isGitHubConnectionClient = structuralGuard<GitHubConnectionClient>(
  "getStatus",
  "getOAuthSettings",
  "listRepositories",
  "saveOAuthSettings",
  "saveRepositorySelection",
  "getAccessToken",
  "getAccessTokenForAuthorizedConnection",
  "savePersonalAccessToken",
);

const isYouTubeConnectionClient = structuralGuard<YouTubeConnectionClient>(
  "getConfiguredAccessToken",
  "getStatus",
  "clearSettings",
);

// ---------------------------------------------------------------------------
// Per-slice resolvers.
// ---------------------------------------------------------------------------

/** The connector-owned WordPress instance-admin client, or null when the
 * connector is absent (status/readiness/telemetry surfaces degrade visibly). */
export function resolveWordPressInstanceAdmin(): WordPressInstanceAdminClient | null {
  return resolveOwnedClient(
    WORDPRESS_MCP_CAPABILITY,
    WORDPRESS_CONNECTOR_SLUG,
    isWordPressInstanceAdminClient,
  );
}

/**
 * Vendor-neutral enumeration of every MCP endpoint URL a managed connector
 * instance owns (cinatra#2015 S0 managed-endpoint containment). The host
 * publishes ONE merged service object on the wordpress-mcp capability id —
 * the typed admin-client members plus the host-side endpoint resolvers
 * (`resolveEndpoint` pretty form, `resolveServerUrl` query-string form; see
 * register-host-connector-services.ts) — so the resolvers are probed
 * structurally off the same resolution instead of importing vendor modules
 * into consumers (vendor-token-core-gate: core owns mechanism, not vendor
 * code). Returns BOTH URL forms per instance; extend per managed CMS as more
 * managed MCP surfaces appear. Never throws — enumeration failure degrades to
 * an empty list (the consumer's containment simply protects fewer endpoints
 * this process).
 */
export function listManagedExternalMcpEndpointUrls(): string[] {
  const out: string[] = [];
  try {
    const admin = resolveWordPressInstanceAdmin();
    if (!admin) return out;
    const svc = admin as unknown as {
      resolveEndpoint?: (siteUrl: string) => string;
      resolveServerUrl?: (siteUrl: string) => string;
    };
    const resolvers = [svc.resolveEndpoint, svc.resolveServerUrl].filter(
      (fn): fn is (siteUrl: string) => string => typeof fn === "function",
    );
    if (resolvers.length === 0) return out;
    for (const instance of admin.listInstances()) {
      const siteUrl = (instance as { siteUrl?: unknown }).siteUrl;
      if (typeof siteUrl !== "string" || siteUrl === "") continue;
      for (const resolve of resolvers) out.push(resolve(siteUrl));
    }
  } catch (err) {
    console.warn(
      "[connector-client-providers] managed MCP endpoint enumeration failed",
      err instanceof Error ? err.message : String(err),
    );
  }
  return out;
}

/** Fail-loud resolution for the surfaces that cannot proceed without the
 * WordPress client (the admin save action, the nango materializer, the blog
 * publish/status/delete flows, the host wordpress-mcp delegation). */
export function requireWordPressInstanceAdmin(): WordPressInstanceAdminClient {
  return requireOwnedClient(
    WORDPRESS_MCP_CAPABILITY,
    WORDPRESS_CONNECTOR_SLUG,
    isWordPressInstanceAdminClient,
  );
}

/** Fail-loud resolution of the connector-owned WordPress post/media content
 * client (the blog draft/publish/status/delete content flows — none of them
 * can proceed without the client, so there is no null-returning twin). */
export function requireWordPressContentClient(): HostWordPressContentService {
  return requireOwnedClient(
    WORDPRESS_CONTENT_CAPABILITY,
    WORDPRESS_CONNECTOR_SLUG,
    isWordPressContentClient,
  );
}

/** The connector-owned Drupal instance-settings client, or null. */
export function resolveDrupalInstanceAdmin(): DrupalInstanceAdminClient | null {
  return resolveOwnedClient(
    DRUPAL_MCP_CAPABILITY,
    DRUPAL_CONNECTOR_SLUG,
    isDrupalInstanceAdminClient,
  );
}

/** Fail-loud twin for the host drupal-mcp delegation. */
export function requireDrupalInstanceAdmin(): DrupalInstanceAdminClient {
  return requireOwnedClient(
    DRUPAL_MCP_CAPABILITY,
    DRUPAL_CONNECTOR_SLUG,
    isDrupalInstanceAdminClient,
  );
}

/** The connector-owned LinkedIn connection client, or null (setup-status /
 * telemetry degrade visibly). */
export function resolveLinkedInConnectionClient(): LinkedInConnectionClient | null {
  return resolveOwnedClient(
    LINKEDIN_CONNECTION_CAPABILITY,
    LINKEDIN_CONNECTOR_SLUG,
    isLinkedInConnectionClient,
  );
}

/** Fail-loud twin for the nango materializer's linkedin branch. */
export function requireLinkedInConnectionClient(): LinkedInConnectionClient {
  return requireOwnedClient(
    LINKEDIN_CONNECTION_CAPABILITY,
    LINKEDIN_CONNECTOR_SLUG,
    isLinkedInConnectionClient,
  );
}

/** The connector-owned GitHub connection client, or null (the skills
 * configuration page degrades to not_connected). */
export function resolveGitHubConnectionClient(): GitHubConnectionClient | null {
  return resolveOwnedClient(
    GITHUB_CONNECTION_CAPABILITY,
    GITHUB_CONNECTOR_SLUG,
    isGitHubConnectionClient,
  );
}

/** Fail-loud twin for the skills push/install token mints and the
 * repository-selection/PAT writers. */
export function requireGitHubConnectionClient(): GitHubConnectionClient {
  return requireOwnedClient(
    GITHUB_CONNECTION_CAPABILITY,
    GITHUB_CONNECTOR_SLUG,
    isGitHubConnectionClient,
  );
}

/** The connector-owned YouTube connection client, or null (setup-status
 * degrades to not_connected). */
export function resolveYouTubeConnectionClient(): YouTubeConnectionClient | null {
  return resolveOwnedClient(
    YOUTUBE_CONNECTION_CAPABILITY,
    YOUTUBE_CONNECTOR_SLUG,
    isYouTubeConnectionClient,
  );
}
