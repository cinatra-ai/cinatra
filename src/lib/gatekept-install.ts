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

import { createHash } from "node:crypto";
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
  // BATCH GRANT CONTEXT (#180 PR-2, P2-4): inside a dependency batch the ROOT
  // was authorized ONCE and every package read rides that grant. When the
  // context is active this seam DERIVES the resolution instead of calling
  // authorize — per-member (re-)authorize inside the dependency queue is
  // forbidden by construction. Outside a batch, behavior is unchanged.
  {
    const { getActiveInstallGrantContext } = await import(
      "@/lib/extension-install-grant-context"
    );
    const ctx = getActiveInstallGrantContext();
    if (ctx) return deriveResolutionFromContext(ctx, packageName, version);
  }
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

/**
 * Derive a package's resolution from the ACTIVE batch grant context — the
 * root's own reads reuse the root resolution verbatim; a closure MEMBER gets
 * the broker config with the ROOT grant + its own scope, and authorize
 * metadata carrying ITS pinned version and ITS kind (planner-resolved).
 * A package that is neither the root nor a closure member is an
 * AUTHORIZATION MISMATCH — fail-loud, never a fresh authorize (that would
 * silently bypass the entitlement model mid-batch).
 */
async function deriveResolutionFromContext(
  ctx: import("@/lib/extension-install-grant-context").InstallGrantContext,
  packageName: string,
  version?: string,
): Promise<GatekeptInstallResolution> {
  const { resolution, rootPackageName, memberKinds } = ctx;
  if (packageName === rootPackageName) {
    if (!isUnspecifiedVersion(version) && version !== resolution.authorize.resolvedVersion) {
      throw new Error(
        `[gatekept-install] the active batch grant authorizes ${rootPackageName}@` +
          `${resolution.authorize.resolvedVersion}, but ${version} was requested — refusing ` +
          `(the grant binds the exact authorized root version).`,
      );
    }
    return resolution;
  }
  const member = resolution.authorize.closure.find((c) => c.name === packageName);
  if (!member) {
    throw new Error(
      `[gatekept-install] ${packageName} requested a read under the root grant for ` +
        `${rootPackageName}, but it is not a member of the authorized closure — ` +
        `refusing (per-member authorize inside a dependency batch is forbidden; a ` +
        `package outside the closure is not entitled by this grant).`,
    );
  }
  if (!isUnspecifiedVersion(version) && version !== member.version) {
    throw new Error(
      `[gatekept-install] closure member ${packageName} is pinned at ${member.version} ` +
        `by the root authorization, but ${version} was requested — refusing (exact ` +
        `pins are the authorization set; silent drift would install an unentitled artifact).`,
    );
  }
  const { deriveMemberInstallConfig } = await import("@/lib/extension-install-grant-context");
  return {
    config: deriveMemberInstallConfig(resolution, packageName),
    authorize: {
      // The member's own kind (planner-resolved: canonical row for installed
      // members, manifest-under-root-grant for to-install members). Falls back
      // to the root's kind only if the planner did not record one — callers
      // inside a batch pass explicit typeIds, so this fallback is advisory.
      kind: memberKinds.get(packageName) ?? resolution.authorize.kind,
      resolvedVersion: member.version,
      closure: resolution.authorize.closure,
      expiresAt: resolution.authorize.expiresAt,
    },
  };
}

// ---------------------------------------------------------------------------
// Grant refresh (#180 PR-2; PLAN P2-5)
// ---------------------------------------------------------------------------

/**
 * Thrown when a grant refresh is needed but the marketplace ability is not
 * yet available. The batch saga treats this as ABORT + COMPENSATE — it never
 * proceeds into (or resumes) a batch under an expired root grant.
 */
export class GrantRefreshUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrantRefreshUnavailableError";
  }
}

/**
 * The injectable refresh seam the batch saga consumes (tests stub this).
 * Binding (P2-5): `sub` and the original grant `jti` travel INSIDE the
 * presented opaque grant (`current.config.token` — the marketplace reads its
 * own claims; the host never parses the token); the HOST-side bindings are
 * the root coordinates and the `closureHash` (stable hash over the sorted
 * name@version closure) the marketplace cross-checks before extending.
 */
export type GatekeptGrantRefresh = (
  current: GatekeptInstallResolution,
  root: { packageName: string; version: string; closureHash: string },
) => Promise<GatekeptInstallResolution>;

/**
 * Stable hash basis of an authorize closure: sorted `name@version`,
 * newline-joined, sha256-hex. The refresh ability binds to this — a refresh
 * whose closure differs is refused on BOTH sides (the marketplace's check +
 * the batch saga's own drift comparison).
 */
export function computeClosureHash(
  closure: readonly { name: string; version: string }[],
): string {
  const basis = [...closure]
    .map((c) => `${c.name}@${c.version}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(basis).digest("hex");
}

/**
 * Refresh the root install grant per the P2-5 contract: the marketplace
 * exposes a rate-limited grant-REFRESH ability bound to {subject, root
 * package, closure-hash, original grant jti} — it extends an in-progress
 * batch's read window WITHOUT enlarging any single token's replay window and
 * WITHOUT re-running entitlement (the closure must be byte-identical; a
 * changed closure refuses the refresh).
 *
 * The ability is NOT yet live on the marketplace side (tracked as an
 * integration-proof obligation on the host issue): this default
 * implementation fails closed with {@link GrantRefreshUnavailableError}, and
 * the batch saga compensates. The seam is injectable so the batch's refresh
 * behavior (refresh-when-near-expiry, refuse-on-closure-drift) is test-pinned
 * against the contract today and binds to the real ability when it ships.
 */
export async function refreshGatekeptInstallGrant(
  _current: GatekeptInstallResolution,
  root: { packageName: string; version: string; closureHash: string },
): Promise<GatekeptInstallResolution> {
  throw new GrantRefreshUnavailableError(
    `[gatekept-install] the root grant for ${root.packageName}@${root.version} needs a ` +
      `refresh to continue this batch, but the marketplace grant-refresh ability is not ` +
      `yet available on this host — aborting the batch (newly-installed members are ` +
      `compensated; retry the install to authorize a fresh grant).`,
  );
}
