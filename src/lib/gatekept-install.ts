import "server-only";

/**
 * Marketplace-gatekept install.
 *
 * Closes the install loop: every gatekept install obtains a short-lived signed
 * GRANT from `marketplace.cinatra.ai` (the `extension_install_authorize`
 * ability), then reads packuments + tarballs through the broker install
 * read-proxy. The instance never reads `registry.cinatra.ai` directly.
 *
 * This module is the single resolver seam. It does NOT wire any call site by
 * itself — other slices call {@link resolveGatekeptInstallConfig} and branch on
 * {@link isGatekeptInstallEnabled}.
 *
 * MASTER FLAG `CINATRA_GATEKEPT_INSTALL` (default OFF = exact current behavior;
 * ON = grant/proxy). Everything here is dormant until the flag is ON.
 *
 * The grant is an OPAQUE bearer token on the TS side — it is placed in the
 * resolved `VerdaccioConfig.token` slot and forwarded to the broker as a Bearer
 * credential. It is NEVER parsed, decoded, or logged.
 */

import { createHttpMarketplaceMcpClient } from "@cinatra-ai/marketplace-mcp-client/http-client";
import type {
  MarketplaceExtensionInstallAuthorizeOutput,
  MarketplaceMcpClient,
} from "@cinatra-ai/marketplace-mcp-client";
import { vendorScopeOfPackage, type VerdaccioConfig } from "@cinatra-ai/registries";
import { readInstanceIdentity } from "@/lib/instance-identity-store";
import { resolveConsumerOrVendorMarketplaceToken } from "@/lib/marketplace-credentials";

/**
 * Master flag. When `false` (default), gatekept install is OFF and the legacy
 * direct-registry-read path is used unchanged. When `true`, install reads route
 * through the broker via a per-install grant.
 *
 * Read from the environment on every call (not memoized) so tests + operators
 * can flip it without a process restart.
 */
export function isGatekeptInstallEnabled(): boolean {
  return process.env.CINATRA_GATEKEPT_INSTALL === "true";
}

/**
 * Authorize metadata returned alongside the broker-pointed `VerdaccioConfig`.
 * Mirrors the marketplace `extension_install_authorize` output minus the opaque
 * `grant` (which is carried in `config.token`) and the `broker_base_url` (which
 * is carried in `config.registryUrl`). Callers use `kind` + `resolvedVersion`
 * to avoid a separate packument read, and `closure` to drive dependency reads.
 */
export interface GatekeptInstallAuthorizeMetadata {
  /** Extension kind of the authorized root (mirrors the storefront listing). */
  kind: MarketplaceExtensionInstallAuthorizeOutput["kind"];
  /** The storefront-listed version that was authorized. */
  resolvedVersion: string;
  /** Transitive dependency closure, exact-version-pinned. */
  closure: MarketplaceExtensionInstallAuthorizeOutput["closure"];
  /** Grant expiry (ISO-8601 UTC). Presentational/audit only on the TS side. */
  expiresAt: string;
}

/**
 * The resolver result: a broker-pointed Verdaccio config (all install reads go
 * through it) plus the authorize metadata.
 */
export interface GatekeptInstallResolution {
  /**
   * Broker-pointed config: `registryUrl` is the broker install read-proxy base
   * URL, `token` is the OPAQUE install grant. Drop-in for the existing
   * `VerdaccioConfig`-shaped install plumbing.
   */
  config: VerdaccioConfig;
  /** Authorize metadata (kind / resolvedVersion / closure / expiry). */
  authorize: GatekeptInstallAuthorizeMetadata;
}

/**
 * Derive the npm scope (e.g. "@cinatra-ai") from a scoped package name. Returns
 * an empty string for an unscoped name (the broker proxy keys on the grant, not
 * the scope; `packageScope` is informational for the install plumbing).
 * Delegates to the shared registries parser so scope parsing cannot drift.
 */
function packageScopeFromName(packageName: string): string {
  return vendorScopeOfPackage(packageName) ?? "";
}

/**
 * Treat a version argument as "unspecified" (caller wants the storefront's
 * listed/latest version). The two upstream resolvers (`resolveInstallEnvironment`,
 * `resolveExtensionTypeId`/`resolveExtensionPackageForLifecycle`) coalesce an
 * absent version to the `"latest"` sentinel before calling here, but a raw
 * `undefined`/empty string is treated the same way defensively.
 */
function isUnspecifiedVersion(version: string | undefined): boolean {
  if (version == null) return true;
  const trimmed = version.trim();
  return trimmed === "" || trimmed === "latest";
}

/**
 * Resolve the EXACT storefront-listed version for `packageName` via `extensionGet`.
 *
 * The `extension_install_authorize` contract requires an exact listed version —
 * entitlement (and the broker's packument `versions` filter) is per exact version,
 * so authorizing `"latest"` and then installing a different concrete version would
 * cause grant/install drift and broker fetch failures. When a caller does not
 * pin a version we resolve the listed version here FIRST, then authorize that.
 *
 * Failures (not-listed, transport) PROPAGATE — there is no fallback to a direct
 * registry read.
 */
async function resolveListedVersion(
  mcpClient: MarketplaceMcpClient,
  packageName: string,
): Promise<string> {
  const detail = await mcpClient.extensionGet({ packageName });
  const listed = detail.latestVersion;
  if (!listed || listed.trim() === "") {
    throw new Error(
      `[gatekept-install] No storefront-listed version available for ${packageName}`,
    );
  }
  return listed;
}

/**
 * Resolve a broker-pointed `VerdaccioConfig` for installing `packageName` at the
 * exact listed `version`, by calling the marketplace `extension_install_authorize`
 * ability.
 *
 * The returned `config.registryUrl` is the broker install read-proxy base URL
 * and `config.token` is the opaque install grant — together they route ALL
 * install reads (packument + tarball + deps) through the broker for this install.
 *
 * **Exact-version resolution.** The authorize ability requires an exact listed
 * version. When `version` is absent or the `"latest"` sentinel, the exact
 * storefront-listed version is resolved via `extensionGet` BEFORE authorizing, so
 * the grant pins the same concrete version that is installed (no latest→exact
 * drift, no broker packument-filter miss). When `version` is already an exact
 * version it is passed straight through (one round-trip).
 *
 * Authorize failures (denial, not-listed, closure-unresolved, transport) PROPAGATE
 * to the caller — there is no silent fallback to a direct registry read. The
 * caller decides how to surface the failure.
 *
 * @param packageName Full scoped npm name, e.g. "@scope/ext".
 * @param version     Exact storefront-listed version — entitlement is per version.
 *                    Absent or `"latest"` → resolved to the listed version first.
 * @param client      Injectable marketplace client (tests pass the mock). When
 *                    omitted, an HTTP client is constructed from the instance's
 *                    resolved consumer/vendor marketplace bearer.
 */
export async function resolveGatekeptInstallConfig(
  packageName: string,
  version?: string,
  client?: MarketplaceMcpClient,
): Promise<GatekeptInstallResolution> {
  const mcpClient = client ?? buildDefaultClient();
  const exactVersion = isUnspecifiedVersion(version)
    ? await resolveListedVersion(mcpClient, packageName)
    : (version as string);

  const authorized = await mcpClient.extensionInstallAuthorize({
    package_name: packageName,
    version: exactVersion,
  });

  const config: VerdaccioConfig = {
    registryUrl: authorized.broker_base_url,
    packageScope: packageScopeFromName(packageName),
    token: authorized.grant,
    uiUrl: null,
  };

  return {
    config,
    authorize: {
      kind: authorized.kind,
      resolvedVersion: authorized.resolved_version,
      closure: authorized.closure,
      expiresAt: authorized.expires_at,
    },
  };
}

/**
 * Build the default HTTP marketplace client, authenticated with the instance's
 * consumer/vendor marketplace bearer. Throws `VendorCredentialsMissingError`
 * (propagated) when no bearer is configured.
 */
function buildDefaultClient(): MarketplaceMcpClient {
  const token = resolveConsumerOrVendorMarketplaceToken(readInstanceIdentity());
  return createHttpMarketplaceMcpClient({ token });
}
