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
import {
  MarketplaceMcpError,
  type MarketplaceExtensionInstallAuthorizeOutput,
  type MarketplaceMcpClient,
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
 * Thrown when a grant refresh CANNOT be obtained for a transport/availability
 * reason — the marketplace ability is unreachable, returns a 5xx/503, has no
 * backing method (501), the response is malformed, or the refreshed grant's
 * expiry is unparseable/non-future (fail-closed: a grant we cannot trust to be
 * valid is treated as no grant). The batch saga treats this as ABORT +
 * COMPENSATE — it never proceeds into (or resumes) a batch under an expired or
 * untrustworthy root grant.
 */
export class GrantRefreshUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrantRefreshUnavailableError";
  }
}

/**
 * Thrown when the marketplace REFUSED to refresh the grant — a deliberate,
 * auditable decision rather than an availability failure: closure_changed
 * (409), rate_limited (429), or op_deadline/forbidden (403); OR the host's own
 * post-refresh binding check failed (the refreshed closure / closure-hash /
 * root version drifted from the authorized set). A refusal still ABORTS +
 * COMPENSATES the batch — distinguishing it from {@link GrantRefreshUnavailableError}
 * keeps the trust-floor decision auditable (the grant was actively denied, not
 * merely unreachable) and never lets a refused/drifted grant look usable.
 */
export class GrantRefreshRefusedError extends Error {
  /** The upstream HTTP status when the refusal came from the marketplace (else null). */
  readonly httpStatus: number | null;
  constructor(message: string, httpStatus: number | null = null) {
    super(message);
    this.name = "GrantRefreshRefusedError";
    this.httpStatus = httpStatus;
  }
}

/**
 * The injectable refresh seam the batch saga consumes (tests stub this).
 * Binding (P2-5): `sub` and the original grant `jti` travel INSIDE the
 * presented opaque grant (`current.config.token` — the marketplace reads its
 * own claims; the host never parses the token); the HOST-side bindings are
 * the root coordinates and the `closureHash` (stable hash over the sorted
 * name@version closure) the marketplace cross-checks before extending.
 *
 * The optional `client` keeps the seam injectable for tests; the batch saga
 * calls it positionally as `(current, root)` and the default builds an HTTP
 * client (an extra OPTIONAL param stays assignable to this type).
 */
export type GatekeptGrantRefresh = (
  current: GatekeptInstallResolution,
  root: { packageName: string; version: string; closureHash: string },
  client?: MarketplaceMcpClient,
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

/** Refresh-margin guard: a refreshed grant must outlast the saga's near-expiry
 *  margin, else the batch would immediately try to refresh again (or run under a
 *  grant already inside the margin). Mirrors GRANT_REFRESH_MARGIN_MS in the saga. */
const REFRESH_MIN_REMAINING_MS = 60_000;

/** Sanity ceiling on a refreshed grant's remaining lifetime. Install grants are
 *  SHORT-TTL (minutes); a remaining lifetime far beyond this signals a unit-drift
 *  bug (e.g. a MILLISECOND-shaped `expires_at` re-multiplied by 1000 → a date
 *  thousands of years out) or a clock-skew anomaly. Either way the grant is not
 *  trustworthy as a short-lived install grant, so we fail closed. 24h is well
 *  above any legitimate grant TTL yet far below the ms-misunit blowup. */
const REFRESH_MAX_REMAINING_MS = 24 * 60 * 60 * 1000;

/**
 * Refresh the root install grant per the P2-5 contract: the marketplace
 * grant-REFRESH ability (`extension_install_grant_refresh`, LIVE) is bound to
 * {subject, root package, op, op_iat, closure-hash, original grant jti} — it
 * extends an in-progress batch's read window WITHOUT enlarging any single
 * token's replay window and WITHOUT re-running entitlement (the closure must be
 * byte-identical; a changed closure refuses the refresh with 409).
 *
 * This calls the real ability with the CURRENT opaque grant
 * (`current.config.token`) and maps the refreshed output back into a
 * {@link GatekeptInstallResolution}, FAILING CLOSED on any of:
 *  - transport/5xx/501/malformed response → {@link GrantRefreshUnavailableError};
 *  - marketplace refusal (409 closure_changed / 429 rate_limited / 403
 *    op_deadline) → {@link GrantRefreshRefusedError};
 *  - host-side binding drift (refreshed closure / closure-hash / root version ≠
 *    the authorized set, or the bound `root.closureHash` ≠ the current closure)
 *    → {@link GrantRefreshRefusedError};
 *  - an unparseable / non-integer / non-future / still-inside-margin expiry, or
 *    a missing required field → {@link GrantRefreshUnavailableError}.
 *
 * CRITICAL wire-shape reconciliation: the ability's `expires_at` is Unix epoch
 * SECONDS (PHP `time()+GRANT_TTL`), but `GatekeptInstallAuthorizeMetadata.expiresAt`
 * is an ISO string the batch saga parses with `Date.parse(...)`. We convert
 * (`new Date(expires_at*1000).toISOString()`); a raw integer would `Date.parse`
 * to `NaN`, skip the near-expiry refresh, and let the batch run until the grant
 * expired mid-install — a real trust-floor weakening. `kind` is NOT in the
 * refresh output, so it is preserved from the current authorize metadata.
 *
 * The seam stays injectable (`client`) for tests; the default builds the HTTP
 * client from the instance's resolved marketplace bearer.
 */
export async function refreshGatekeptInstallGrant(
  current: GatekeptInstallResolution,
  root: { packageName: string; version: string; closureHash: string },
  client?: MarketplaceMcpClient,
): Promise<GatekeptInstallResolution> {
  const where = `${root.packageName}@${root.version}`;
  const compensationNote =
    `aborting the batch (newly-installed members are compensated; retry the install ` +
    `to authorize a fresh grant)`;

  // BINDING PRECONDITION: the bound hash the caller asks us to refresh under must
  // describe the CURRENT authorized closure — a mismatch means the saga's view of
  // the closure already drifted; refuse before presenting anything to the market.
  const currentClosureHash = computeClosureHash(current.authorize.closure);
  if (root.closureHash !== currentClosureHash) {
    throw new GrantRefreshRefusedError(
      `[gatekept-install] refusing to refresh the grant for ${where}: the requested ` +
        `binding closure-hash does not match the current authorized closure — ${compensationNote}.`,
    );
  }

  // The presented grant is the CURRENT opaque token. A null/empty token means
  // there is no grant to refresh — fail closed rather than present garbage.
  const currentGrant = current.config.token;
  if (typeof currentGrant !== "string" || currentGrant.trim() === "") {
    throw new GrantRefreshUnavailableError(
      `[gatekept-install] cannot refresh the grant for ${where}: the current resolution has ` +
        `no install grant to present — failing closed; ${compensationNote}.`,
    );
  }

  const mcpClient = client ?? buildDefaultClient();

  let out: import("@cinatra-ai/marketplace-mcp-client").MarketplaceExtensionInstallGrantRefreshOutput;
  try {
    out = await mcpClient.extensionInstallGrantRefresh({ grant: currentGrant });
  } catch (e) {
    if (e instanceof MarketplaceMcpError) {
      // 409 closure_changed / 429 rate_limited / 403 op_deadline → an auditable
      // REFUSAL. Everything else (5xx/503, 501 no-method, transport, unknown) is
      // an availability failure. Both abort+compensate; the class distinguishes
      // "actively denied" from "could not reach".
      if (e.httpStatus === 409 || e.httpStatus === 429 || e.httpStatus === 403) {
        throw new GrantRefreshRefusedError(
          `[gatekept-install] the marketplace REFUSED to refresh the grant for ${where} ` +
            `(status ${e.httpStatus}: ${e.message}) — ${compensationNote}.`,
          e.httpStatus,
        );
      }
      throw new GrantRefreshUnavailableError(
        `[gatekept-install] the root grant for ${where} needs a refresh to continue this ` +
          `batch, but the marketplace grant-refresh ability returned an error ` +
          `(status ${e.httpStatus}: ${e.message}) — ${compensationNote}.`,
      );
    }
    throw new GrantRefreshUnavailableError(
      `[gatekept-install] the root grant for ${where} needs a refresh to continue this ` +
        `batch, but the marketplace grant-refresh ability could not be reached ` +
        `(${e instanceof Error ? e.message : String(e)}) — ${compensationNote}.`,
    );
  }

  // ---- Validate the refreshed grant before producing a usable resolution ----

  // Required runtime strings must be present + non-empty.
  for (const [field, value] of [
    ["grant", out.grant],
    ["broker_base_url", out.broker_base_url],
    ["resolved_version", out.resolved_version],
    ["op", out.op],
  ] as const) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new GrantRefreshUnavailableError(
        `[gatekept-install] the grant-refresh response for ${where} is missing a usable ` +
          `"${field}" — failing closed; ${compensationNote}.`,
      );
    }
  }

  // RE-MINT invariant: a refresh MUST produce a FRESH grant (new iat/exp/jti). If
  // the ability echoes the SAME opaque token back, treat it as no refresh — a
  // near-expiry current grant dressed with future metadata must NOT look usable.
  if (out.grant === currentGrant) {
    throw new GrantRefreshRefusedError(
      `[gatekept-install] the grant-refresh for ${where} returned the SAME grant that was ` +
        `presented — refusing (a refresh must re-mint a fresh token); ${compensationNote}.`,
    );
  }

  // ROOT-VERSION drift: refresh must NOT change the authorized version (the saga
  // catches a changed closure ARRAY but not a same-closure root-version drift).
  if (out.resolved_version !== current.authorize.resolvedVersion) {
    throw new GrantRefreshRefusedError(
      `[gatekept-install] the grant-refresh for ${where} returned resolved_version ` +
        `"${out.resolved_version}" but the batch authorized "${current.authorize.resolvedVersion}" ` +
        `— refusing (a refresh must re-mint the SAME authorization); ${compensationNote}.`,
    );
  }

  // CLOSURE drift: the refreshed closure must hash-equal the authorized closure,
  // AND the marketplace's own bound closure_hash must equal that hash. Validate
  // the SHAPE first so a malformed (non-array) closure fails closed as documented
  // (an Unavailable response), not as a raw TypeError from the hash basis.
  if (!Array.isArray(out.closure)) {
    throw new GrantRefreshUnavailableError(
      `[gatekept-install] the grant-refresh response for ${where} returned a malformed closure ` +
        `(not an array) — failing closed; ${compensationNote}.`,
    );
  }
  const refreshedClosureHash = computeClosureHash(out.closure);
  if (refreshedClosureHash !== currentClosureHash) {
    throw new GrantRefreshRefusedError(
      `[gatekept-install] the grant-refresh for ${where} returned a DIFFERENT closure than ` +
        `the authorized set — refusing (the closure-hash binding must hold); ${compensationNote}.`,
    );
  }
  if (out.closure_hash !== currentClosureHash) {
    throw new GrantRefreshRefusedError(
      `[gatekept-install] the grant-refresh for ${where} reported a closure_hash that does ` +
        `not match the authorized closure — refusing; ${compensationNote}.`,
    );
  }

  // EXPIRY: epoch SECONDS → ISO. Fail closed on non-integer / non-finite /
  // non-future / still-inside-the-refresh-margin (an immediately-stale grant is
  // no better than an expired one).
  if (typeof out.expires_at !== "number" || !Number.isInteger(out.expires_at) || out.expires_at <= 0) {
    throw new GrantRefreshUnavailableError(
      `[gatekept-install] the grant-refresh for ${where} returned an unparseable expiry ` +
        `(${String(out.expires_at)}) — failing closed; ${compensationNote}.`,
    );
  }
  const expiresAtMs = out.expires_at * 1000;
  const expiresDate = new Date(expiresAtMs);
  if (Number.isNaN(expiresDate.getTime())) {
    throw new GrantRefreshUnavailableError(
      `[gatekept-install] the grant-refresh for ${where} returned an invalid expiry ` +
        `(${String(out.expires_at)}) — failing closed; ${compensationNote}.`,
    );
  }
  const remainingMs = expiresAtMs - Date.now();
  if (remainingMs < REFRESH_MIN_REMAINING_MS) {
    throw new GrantRefreshUnavailableError(
      `[gatekept-install] the grant-refresh for ${where} returned a grant already at/inside ` +
        `the near-expiry margin — failing closed (refusing to proceed under a stale grant); ` +
        `${compensationNote}.`,
    );
  }
  if (remainingMs > REFRESH_MAX_REMAINING_MS) {
    throw new GrantRefreshUnavailableError(
      `[gatekept-install] the grant-refresh for ${where} returned an implausibly far-future expiry ` +
        `(${String(out.expires_at)}s) — failing closed (likely a unit/skew anomaly; an install grant ` +
        `is short-lived); ${compensationNote}.`,
    );
  }

  const config: VerdaccioConfig = {
    registryUrl: out.broker_base_url,
    // The REFRESH is the ROOT grant; keep the root's scope. Members derive their
    // own scope from the broker base + this token via deriveMemberInstallConfig.
    packageScope: current.config.packageScope,
    token: out.grant,
    uiUrl: null,
  };

  return {
    config,
    authorize: {
      // Refresh has NO kind — preserve the current authorize metadata's kind.
      kind: current.authorize.kind,
      resolvedVersion: out.resolved_version,
      closure: out.closure,
      expiresAt: expiresDate.toISOString(),
    },
  };
}
