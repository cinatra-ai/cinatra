// resolveInstallEnvironment supports both topology A + B registry routing.
//
// Invariants:
//   - no secrets in origin; tokens are never written to origin JSONB
//   - resolveInstallEnvironment returns topology-aware CLI args
//   - both topology adapters (scope-based + shared-acl) are supported
//   - per-field AAD binding uses "destination.<id>.publish-token" / ".read-token"
//   - caller MUST run auth gate before calling these functions
//   - resolver-bypass regression test asserts no caller bypasses these helpers

import "server-only";
import { vendorScopeOfPackage, type VerdaccioConfig } from "@cinatra-ai/registries";
import {
  loadDeploymentRegistryConfig,
  DeploymentRegistryConfigNotAvailableError,
} from "@/lib/deployment-registry-config";
import { decryptSecret } from "@/lib/instance-secrets";
import { readDestinationCredential } from "@/lib/extension-destinations-store";
import { readInstanceIdentity } from "@/lib/instance-identity-store";
import type { ExtensionOrigin } from "@cinatra-ai/agents/schema";

// ---------------------------------------------------------------------------
// Error — thrown when the requested visibility has no configured destination.
// ---------------------------------------------------------------------------
export class PublishDestinationNotConfiguredError extends Error {
  readonly code = "PUBLISH_DESTINATION_NOT_CONFIGURED";
  constructor(public readonly visibility: "private" | "public") {
    super(`No ${visibility} publish destination is configured. Contact your admin.`);
    this.name = "PublishDestinationNotConfiguredError";
  }
}

// ---------------------------------------------------------------------------
// InstallEnvironment — returned by resolveInstallEnvironment.
// args: CLI flags to inject into npm/pnpm spawn (topology-aware).
//   Topology A (scope-based): ["--@<scope>:registry=<url>", "--//<host>/:_authToken=<token>"]
//   Topology B (shared-acl):  ["--registry=<url>", "--//<host>/:_authToken=<token>"]
// ---------------------------------------------------------------------------
export type InstallEnvironment = {
  /** CLI flags to pass to npm/pnpm install spawn. */
  args: string[];
  registryUrl: string;
  routingMode: "scope-based" | "shared-acl";
};

/**
 * Resolves the publish destination for a given visibility.
 *
 * Caller MUST run `requireAdminSession()` (or equivalent auth gate) BEFORE
 * calling this function.
 *
 * For "private": looks up destination credentials in extension_destinations,
 * decrypts publish token with AAD `destination.<destinationId>.publish-token`
 * using the per-field publish-token AAD.
 *
 * Throws PublishDestinationNotConfiguredError if the requested visibility
 * has no configured destination.
 */
/**
 * `options.vendorScopeOverride` lets dev-mode callers route the publish under
 * a delegated vendor scope instead of the instance's own scope.
 * The override is a bare scope name (no leading "@"); callers are responsible
 * for normalizing input. Provided by `readEffectivePublishScopeOverride()` in
 * `src/lib/dev-extensions.ts`, which hard-ignores stored values in production.
 * Install-path resolution (`resolveInstallEnvironment`) is intentionally NOT
 * affected — only the publish scope is overridden.
 */
export async function resolvePublishDestination(
  visibility: "private" | "public",
  options?: { vendorScopeOverride?: string | null },
): Promise<VerdaccioConfig> {
  const deployConfig = loadDeploymentRegistryConfig();
  const identity = readInstanceIdentity();
  const override = options?.vendorScopeOverride?.trim() || null;
  const vendorScope = override
    ? `@${override}`
    : identity
      ? `@${identity.instanceNamespace}`
      : "@cinatra-ai";

  if (visibility === "public") {
    if (!deployConfig.publicPublishToken) {
      throw new PublishDestinationNotConfiguredError("public");
    }
    return {
      registryUrl: deployConfig.publicRegistryUrl,
      packageScope: vendorScope,
      token: deployConfig.publicPublishToken,
      uiUrl: deployConfig.publicRegistryUrl,
    };
  }

  // visibility === "private"
  if (
    !deployConfig.privateDestinationConfigured ||
    !deployConfig.privateRegistryUrl ||
    !deployConfig.privateDestinationId
  ) {
    throw new PublishDestinationNotConfiguredError("private");
  }

  const cred = await readDestinationCredential(deployConfig.privateDestinationId);
  if (!cred) {
    throw new PublishDestinationNotConfiguredError("private");
  }

  // Per-field AAD binding: destination.<destinationId>.publish-token
  const token = decryptSecret(
    { ciphertext: cred.tokenCiphertext, iv: cred.tokenIv },
    `destination.${deployConfig.privateDestinationId}.publish-token`,
  );

  return {
    registryUrl: cred.registryUrl,
    packageScope: vendorScope,
    token,
    uiUrl: cred.registryUrl,
  };
}

// ---------------------------------------------------------------------------
// Internal helper — read the origin JSONB from an agent_templates row.
// Uses a dynamic import to avoid a top-level circular dep on @cinatra-ai/agents.
// ---------------------------------------------------------------------------
async function readExtensionOriginByPackageName(packageName: string): Promise<ExtensionOrigin | null> {
  const { readAgentTemplateOrigin } = await import("@cinatra-ai/agents/store");
  return readAgentTemplateOrigin(packageName);
}

// ---------------------------------------------------------------------------
// Dev-only local-Verdaccio install fallback (parity with the publish paths).
//
// `agent_source_publish` / `agent_registry_publish` (packages/agents/src/mcp/
// handlers.ts) both fall back to `loadVerdaccioConfigForServer()` when the
// deployment-registry fixture still has `privateDestinationConfigured:false`
// (the default until the deployment wrapper ships the live resolver) but the
// operator HAS wired a local Verdaccio via the setup wizard
// (`instance_identity.registries
// .local`). Without the same fallback here, PRIVATE publish succeeds but
// PRIVATE install fails with "No private publish destination is configured" —
// the publish-works/install-fails asymmetry.
//
// Gated on CINATRA_RUNTIME_MODE === "development" so production keeps the hard
// PublishDestinationNotConfiguredError. The fallback lives INSIDE the canonical
// resolveInstallEnvironment() resolver, so no caller bypasses it — the
// resolver-bypass regression gate is preserved.
async function resolveDevLocalVerdaccioInstallEnvironment(
  extensionId: string,
  routingMode: "scope-based" | "shared-acl",
): Promise<InstallEnvironment | null> {
  if (process.env.CINATRA_RUNTIME_MODE !== "development") return null;
  const { loadVerdaccioConfigForServer } = await import("@/lib/verdaccio-config");
  const fallback = await loadVerdaccioConfigForServer();
  if (!fallback.token) return null;
  const url = fallback.registryUrl;
  const host = new URL(url).host;
  // Route by the package's OWN scope (e.g. "@cinatra-ai") — the published
  // tarball lives under that scope in the local Verdaccio. VerdaccioConfig
  // .packageScope already carries the leading "@". The shared registries
  // parser handles the no-slash / empty-scope edge cases ("@foo", "@/foo")
  // by returning null; fall back to the config scope in that case.
  const scope = vendorScopeOfPackage(extensionId) ?? fallback.packageScope;
  return {
    registryUrl: url,
    routingMode,
    args:
      routingMode === "scope-based"
        ? [`--${scope}:registry=${url}`, `--//${host}/:_authToken=${fallback.token}`]
        : [`--registry=${url}`, `--//${host}/:_authToken=${fallback.token}`],
  };
}

/**
 * Build a broker-pointed `InstallEnvironment` from a gatekept install grant.
 *
 * When the master gatekept-install flag is ON, ALL install reads route through
 * the marketplace broker read-proxy: `registryUrl` is the broker base URL and
 * the `_authToken` arg carries the OPAQUE install grant (never the
 * deployment-wide read token). The arg shape is preserved exactly so existing
 * callers that extract the token via `args.find(a => a.includes(":_authToken="))`
 * keep working unchanged. `routingMode` is reported as `"shared-acl"` — the
 * broker is a single registry endpoint that serves the grant-covered closure;
 * scope-based per-vendor routing is not applicable to a broker proxy.
 *
 * The grant is opaque: it is placed verbatim in the `_authToken` slot and is
 * NEVER parsed, decoded, or logged here.
 */
function buildGatekeptInstallEnvironment(config: VerdaccioConfig): InstallEnvironment {
  const url = config.registryUrl;
  const host = new URL(url).host;
  return {
    args: [`--registry=${url}`, `--//${host}/:_authToken=${config.token ?? ""}`],
    registryUrl: url,
    routingMode: "shared-acl",
  };
}

/**
 * Test/DI seam for the gatekept-install path. Production code leaves these
 * undefined so the real `@/lib/gatekept-install` server-only module is
 * dynamically imported (keeping `destination-resolver.ts` importable by the
 * non-server callers that only need `deriveTypeId`/`InstallEnvironment`). Tests
 * inject in-memory stubs so they never touch the marketplace HTTP client.
 */
export interface ResolveInstallEnvironmentOptions {
  /** Override the master-flag check (defaults to `isGatekeptInstallEnabled`). */
  isGatekeptInstallEnabled?: () => boolean;
  /**
   * Override the gatekept resolver (defaults to `resolveGatekeptInstallConfig`).
   * `version` is optional — when absent or `"latest"`, the resolver resolves the
   * EXACT storefront-listed version (via `extensionGet`) before authorizing.
   */
  resolveGatekeptInstallConfig?: (
    packageName: string,
    version?: string,
  ) => Promise<{ config: VerdaccioConfig }>;
}

/**
 * Resolves the install environment for a given extension.
 *
 * Both topology A (scope-based) and topology B (shared-ACL) adapters are
 * supported. Runtime selection is driven by
 * `DeploymentRegistryConfig.routingMode` from the deployment registry config.
 *
 * Tokens are decrypted with per-field AAD bindings:
 *   "destination.<destinationId>.read-token"  — for read/install operations
 *   "destination.<destinationId>.publish-token" — fallback when read token absent
 *
 * Caller MUST run auth gate before calling this function.
 *
 * Hard-error rule: if routingMode is undefined / falsy at
 * runtime, throws DeploymentRegistryConfigNotAvailableError
 * "deployment config malformed — routingMode missing" — no fallback.
 * Module-init fallbacks would bypass the required auth-gated config load.
 *
 * Gatekept install: when `CINATRA_GATEKEPT_INSTALL` is ON, the PUBLIC
 * path is replaced by a broker-pointed environment sourced from a per-install
 * grant (`resolveGatekeptInstallConfig`) instead of the deployment-wide
 * `publicReadToken`. The PRIVATE path is unchanged for now. When the flag is
 * OFF (the default), behavior is EXACTLY unchanged.
 *
 * @param extensionId — packageName identifying the extension (e.g. "@acme/my-agent")
 * @param version — exact listed version (required by the gatekept authorize ability).
 *   When the flag is ON and version is omitted (or `"latest"`), the gatekept
 *   resolver resolves the EXACT storefront-listed version via `extensionGet`
 *   before authorizing — the grant pins the same concrete version that is
 *   installed (no latest→exact drift). Ignored entirely when the flag is OFF.
 * @param options — test/DI seam; production callers omit it.
 */
export async function resolveInstallEnvironment(
  extensionId: string,
  version?: string,
  options?: ResolveInstallEnvironmentOptions,
): Promise<InstallEnvironment> {
  // ---------------------------------------------------------------------------
  // Gatekept install — when ON, route ALL reads through the broker
  // via a per-install grant. The deployment-wide publicReadToken is NOT used.
  // ---------------------------------------------------------------------------
  const isEnabled =
    options?.isGatekeptInstallEnabled ??
    (await import("@/lib/gatekept-install")).isGatekeptInstallEnabled;
  if (isEnabled()) {
    const resolve =
      options?.resolveGatekeptInstallConfig ??
      (await import("@/lib/gatekept-install")).resolveGatekeptInstallConfig;
    // Pass the version straight through (no "latest" coalescing here): the
    // gatekept resolver resolves an absent/"latest" version to the EXACT
    // storefront-listed version via `extensionGet` BEFORE authorizing, so the
    // grant pins the same concrete version that is installed.
    const { config } = await resolve(extensionId, version);
    return buildGatekeptInstallEnvironment(config);
  }

  const deployConfig = loadDeploymentRegistryConfig();

  // Hard error if routingMode is missing (by design).
  if (!deployConfig.routingMode) {
    throw new DeploymentRegistryConfigNotAvailableError();
  }

  // Attempt to read origin JSONB. Grandfathered rows (origin IS NULL) are
  // treated as public per the grandfather clause in store.ts visibility filter.
  const origin = await readExtensionOriginByPackageName(extensionId);
  const visibility = origin?.visibility ?? "public";

  // ---------------------------------------------------------------------------
  // Public visibility — same CLI flags regardless of topology
  // (public registry is shared; no scope-based routing needed for public pkgs)
  // ---------------------------------------------------------------------------
  if (visibility === "public") {
    const url = deployConfig.publicRegistryUrl;
    const host = new URL(url).host;
    return {
      args: [
        `--registry=${url}`,
        `--//${host}/:_authToken=${deployConfig.publicReadToken}`,
      ],
      registryUrl: url,
      routingMode: deployConfig.routingMode,
    };
  }

  // ---------------------------------------------------------------------------
  // Private visibility — validate destination is configured
  // ---------------------------------------------------------------------------
  if (
    !deployConfig.privateDestinationConfigured ||
    !deployConfig.privateRegistryUrl ||
    !deployConfig.privateDestinationId
  ) {
    const devFallback = await resolveDevLocalVerdaccioInstallEnvironment(
      extensionId,
      deployConfig.routingMode,
    );
    if (devFallback) return devFallback;
    throw new PublishDestinationNotConfiguredError("private");
  }

  const cred = await readDestinationCredential(deployConfig.privateDestinationId);
  if (!cred) {
    throw new PublishDestinationNotConfiguredError("private");
  }

  // Per-field AAD binding:
  // - Use read token when available: aad = "destination.<id>.read-token"
  // - Fall back to publish token:    aad = "destination.<id>.publish-token"
  const destId = deployConfig.privateDestinationId;
  let token: string;
  if (cred.readTokenCiphertext && cred.readTokenIv) {
    token = decryptSecret(
      { ciphertext: cred.readTokenCiphertext, iv: cred.readTokenIv },
      `destination.${destId}.read-token`,
    );
  } else {
    token = decryptSecret(
      { ciphertext: cred.tokenCiphertext, iv: cred.tokenIv },
      `destination.${destId}.publish-token`,
    );
  }

  const url = cred.registryUrl;
  const host = new URL(url).host;

  // Read instance identity for vendor scope (topology A needs the scope prefix).
  const identity = readInstanceIdentity();
  // vendorName is the primary field; instanceNamespace is the legacy fallback.
  const vendorName = identity
    ? ((identity as { vendorName?: string; instanceNamespace?: string }).vendorName ??
       (identity as { vendorName?: string; instanceNamespace?: string }).instanceNamespace)
    : undefined;
  const scope = vendorName ? `@${vendorName}` : "@cinatra-ai";

  // ---------------------------------------------------------------------------
  // Topology A — scope-based npm config
  // CLI flag: --@<scope>:registry=<url> (scopes all @<scope>/* packages to the
  // private registry while leaving other scopes on the public registry)
  // ---------------------------------------------------------------------------
  if (deployConfig.routingMode === "scope-based") {
    return {
      args: [
        `--${scope}:registry=${url}`,
        `--//${host}/:_authToken=${token}`,
      ],
      registryUrl: url,
      routingMode: "scope-based",
    };
  }

  // ---------------------------------------------------------------------------
  // Topology B — shared-ACL
  // Single registry URL; auth header carries per-vendor access predicates.
  // CLI flag: --registry=<url> (overrides default registry globally)
  // ---------------------------------------------------------------------------
  return {
    args: [
      `--registry=${url}`,
      `--//${host}/:_authToken=${token}`,
    ],
    registryUrl: url,
    routingMode: "shared-acl",
  };
}
