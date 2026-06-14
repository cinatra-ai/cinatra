/**
 * `MarketplaceMcpClient` — typed interface for calling the Cinatra Marketplace
 * MCP abilities from Cinatra-side code.
 *
 * This module is PURE (no `server-only`, no MCP SDK) so it can be imported
 * anywhere — including tests and (the interface/types) client components. The
 * real network client lives in `./http-client` (server-only, uses the MCP SDK)
 * and is reached via the `@cinatra-ai/marketplace-mcp-client/http-client`
 * sub-entry; the in-memory mock below is the drop-in for tests + dev.
 *
 * Transport (real client): the marketplace exposes its abilities via the
 * wordpress/mcp-adapter (StreamableHTTP) at `/wp-json/cinatra/mcp`, NOT as
 * per-primitive REST routes. The WP ability id is `cinatra/<kebab>`, but the
 * over-the-wire MCP tool name flattens `/`→`-` (the adapter's McpNameSanitizer),
 * so the tool is called as `cinatra-<kebab>`, e.g. `cinatra-vendor-register-self`.
 */

import type {
  MarketplaceCatalogEntry,
  MarketplaceExtensionGetInput,
  MarketplaceExtensionGetOutput,
  MarketplaceExtensionInstallAuthorizeInput,
  MarketplaceExtensionInstallAuthorizeOutput,
  MarketplaceExtensionInstallGrantRefreshInput,
  MarketplaceExtensionInstallGrantRefreshOutput,
  MarketplaceExtensionListInput,
  MarketplaceExtensionListOutput,
  MarketplaceExtensionSubmissionApproveInput,
  MarketplaceExtensionSubmissionApproveOutput,
  MarketplaceExtensionSubmissionListAdminInput,
  MarketplaceExtensionSubmissionListAdminOutput,
  MarketplaceExtensionSubmissionListSelfOutput,
  MarketplaceExtensionSubmissionPromotionRetryInput,
  MarketplaceExtensionSubmissionPromotionRetryOutput,
  MarketplaceExtensionSubmissionRejectInput,
  MarketplaceExtensionSubmissionRejectOutput,
  MarketplaceExtensionSubmissionWithdrawInput,
  MarketplaceExtensionSubmissionWithdrawOutput,
  MarketplaceExtensionSubmitForReviewInput,
  MarketplaceExtensionSubmitForReviewOutput,
  MarketplaceInstanceAttachSelfInput,
  MarketplaceInstanceAttachSelfOutput,
  MarketplacePackageSyncFromRegistryInput,
  MarketplacePackageSyncFromRegistryOutput,
  MarketplaceVendorApplicationApplyInput,
  MarketplaceVendorApplicationApplyOutput,
  MarketplaceVendorApplicationApproveInput,
  MarketplaceVendorApplicationApproveOutput,
  MarketplaceVendorApplicationCancelInput,
  MarketplaceVendorApplicationCancelOutput,
  MarketplaceVendorApplicationCompleteRecoveryInput,
  MarketplaceVendorApplicationCompleteRecoveryOutput,
  MarketplaceVendorApplicationListAdminInput,
  MarketplaceVendorApplicationListAdminOutput,
  MarketplaceVendorApplicationRejectInput,
  MarketplaceVendorApplicationRejectOutput,
  MarketplaceVendorApplicationResetInput,
  MarketplaceVendorApplicationResetOutput,
  MarketplaceVendorApplicationStatusOutput,
  MarketplaceVendorApplyInput,
  MarketplaceVendorApplyOutput,
  MarketplaceVendorGetInput,
  MarketplaceVendorGetOutput,
  MarketplaceVendorGetSelfOutput,
  MarketplaceVendorProfileVisibilitySetInput,
  MarketplaceVendorProfileVisibilitySetOutput,
  MarketplaceVendorRegisterSelfInput,
  MarketplaceVendorRegisterSelfOutput,
  MarketplaceVendorRegistryTokenRotateSelfOutput,
  MarketplaceVendorSubmission,
} from "./types";

export interface MarketplaceMcpClient {
  extensionGet(input: MarketplaceExtensionGetInput): Promise<MarketplaceExtensionGetOutput>;
  /**
   * Storefront browse catalog. Returns the visible/published storefront
   * products as install-ready card models. Used by `/configuration/marketplace`.
   */
  extensionList(input?: MarketplaceExtensionListInput): Promise<MarketplaceExtensionListOutput>;
  /**
   * Marketplace-gatekept install authorize. Mints a short-lived signed
   * grant for installing a specific listed version, returning the broker
   * read-proxy base URL + the exact dependency closure. The `grant` is an opaque
   * bearer presented to the broker; it is never parsed on the cinatra side.
   */
  extensionInstallAuthorize(
    input: MarketplaceExtensionInstallAuthorizeInput,
  ): Promise<MarketplaceExtensionInstallAuthorizeOutput>;
  /**
   * Marketplace-gatekept install grant REFRESH (#162 / P2-5). Extends an
   * in-progress batch's read window by re-minting the ROOT grant bound to the
   * SAME {subject, root, op, op_iat, closure_hash}. Entitlement is NOT re-run;
   * a changed closure is refused (409). The presented `grant` is the CURRENT
   * opaque grant; the returned `grant` is opaque too.
   *
   * NOTE the wire-shape differences vs `extensionInstallAuthorize`: refresh has
   * NO `kind`, and its `expires_at` is an INTEGER (Unix epoch SECONDS), not an
   * ISO string. Callers (gatekept-install) reconcile both before mapping into a
   * `GatekeptInstallResolution`.
   */
  extensionInstallGrantRefresh(
    input: MarketplaceExtensionInstallGrantRefreshInput,
  ): Promise<MarketplaceExtensionInstallGrantRefreshOutput>;
  vendorGet(input: MarketplaceVendorGetInput): Promise<MarketplaceVendorGetOutput>;
  vendorApply(input: MarketplaceVendorApplyInput): Promise<MarketplaceVendorApplyOutput>;
  packageSyncFromRegistry(
    input: MarketplacePackageSyncFromRegistryInput,
  ): Promise<MarketplacePackageSyncFromRegistryOutput>;

  // Vendor self-service.
  vendorRegisterSelf(
    input: MarketplaceVendorRegisterSelfInput,
  ): Promise<MarketplaceVendorRegisterSelfOutput>;
  vendorGetSelf(): Promise<MarketplaceVendorGetSelfOutput>;
  vendorProfileVisibilitySet(
    input: MarketplaceVendorProfileVisibilitySetInput,
  ): Promise<MarketplaceVendorProfileVisibilitySetOutput>;
  vendorRegistryTokenRotateSelf(): Promise<MarketplaceVendorRegistryTokenRotateSelfOutput>;

  // Extension-version submission (extender abilities).
  extensionSubmitForReview(
    input: MarketplaceExtensionSubmitForReviewInput,
  ): Promise<MarketplaceExtensionSubmitForReviewOutput>;
  extensionSubmissionListSelf(): Promise<MarketplaceExtensionSubmissionListSelfOutput>;
  extensionSubmissionListAdmin(
    input?: MarketplaceExtensionSubmissionListAdminInput,
  ): Promise<MarketplaceExtensionSubmissionListAdminOutput>;
  extensionSubmissionWithdraw(
    input: MarketplaceExtensionSubmissionWithdrawInput,
  ): Promise<MarketplaceExtensionSubmissionWithdrawOutput>;
  extensionSubmissionApprove(
    input: MarketplaceExtensionSubmissionApproveInput,
  ): Promise<MarketplaceExtensionSubmissionApproveOutput>;
  extensionSubmissionReject(
    input: MarketplaceExtensionSubmissionRejectInput,
  ): Promise<MarketplaceExtensionSubmissionRejectOutput>;
  extensionSubmissionPromotionRetry(
    input: MarketplaceExtensionSubmissionPromotionRetryInput,
  ): Promise<MarketplaceExtensionSubmissionPromotionRetryOutput>;

  // Instance-attach — PRINCIPAL_PUBLIC + rate-limited.
  instanceAttachSelf(
    input: MarketplaceInstanceAttachSelfInput,
  ): Promise<MarketplaceInstanceAttachSelfOutput>;

  // Vendor application lifecycle. The first three are
  // PRINCIPAL_VENDOR; the
  // rest are PRINCIPAL_ADMIN except `vendorApplicationCompleteRecovery`
  // which is PRINCIPAL_SYNC_WORKER-only (called by the BullMQ reconcile
  // loop, never from a UI surface).
  vendorApplicationApply(
    input: MarketplaceVendorApplicationApplyInput,
  ): Promise<MarketplaceVendorApplicationApplyOutput>;
  vendorApplicationStatus(): Promise<MarketplaceVendorApplicationStatusOutput>;
  vendorApplicationCancel(
    input: MarketplaceVendorApplicationCancelInput,
  ): Promise<MarketplaceVendorApplicationCancelOutput>;
  vendorApplicationReset(
    input: MarketplaceVendorApplicationResetInput,
  ): Promise<MarketplaceVendorApplicationResetOutput>;
  vendorApplicationListAdmin(
    input?: MarketplaceVendorApplicationListAdminInput,
  ): Promise<MarketplaceVendorApplicationListAdminOutput>;
  vendorApplicationApprove(
    input: MarketplaceVendorApplicationApproveInput,
  ): Promise<MarketplaceVendorApplicationApproveOutput>;
  vendorApplicationReject(
    input: MarketplaceVendorApplicationRejectInput,
  ): Promise<MarketplaceVendorApplicationRejectOutput>;
  vendorApplicationCompleteRecovery(
    input: MarketplaceVendorApplicationCompleteRecoveryInput,
  ): Promise<MarketplaceVendorApplicationCompleteRecoveryOutput>;
}

export class MarketplaceMcpError extends Error {
  constructor(message: string, public httpStatus: number, public responseBody: string) {
    super(message);
    this.name = "MarketplaceMcpError";
  }
}

// ---------------------------------------------------------------------------
// Mock client — for tests + dev
// ---------------------------------------------------------------------------

export interface MockFixtures {
  extensions?: Record<string, MarketplaceExtensionGetOutput>;
  /** Storefront browse catalog fixtures for `extensionList`. */
  catalog?: MarketplaceCatalogEntry[];
  vendors?: Record<string, MarketplaceVendorGetOutput>;
  /** Self-service vendor record for the calling instance (merged over defaults). */
  self?: Partial<MarketplaceVendorGetSelfOutput>;
  /** Optional spy — invoked on every `packageSyncFromRegistry` call. */
  onSync?: (input: MarketplacePackageSyncFromRegistryInput) => void;
  /**
   * Install-authorize fixtures for `extensionInstallAuthorize`, keyed by either
   * `"<packageName>@<version>"` (exact match, preferred) or `"<packageName>"`
   * (any version). When no fixture matches, the mock auto-grants a deterministic
   * stub (all live extensions are free/OSS → auto-grant), so most consumer tests
   * need no fixtures. Supply a fixture to assert the closure/kind, or pass a
   * `MarketplaceMcpError` to simulate a denial (it is thrown).
   */
  installAuthorizations?: Record<
    string,
    MarketplaceExtensionInstallAuthorizeOutput | MarketplaceMcpError
  >;
  /** Optional spy — invoked on every `extensionInstallAuthorize` call. */
  onInstallAuthorize?: (input: MarketplaceExtensionInstallAuthorizeInput) => void;
  /**
   * Grant-refresh fixtures for `extensionInstallGrantRefresh`, keyed by the
   * presented grant (`input.grant`). When no fixture matches, the mock
   * auto-extends a deterministic stub. Supply a fixture to assert the refreshed
   * closure/expiry, or a `MarketplaceMcpError` to simulate a refusal (it is
   * thrown — e.g. `httpStatus 409` closure_changed, `429` rate_limited).
   */
  installGrantRefreshes?: Record<
    string,
    MarketplaceExtensionInstallGrantRefreshOutput | MarketplaceMcpError
  >;
  /** Optional spy — invoked on every `extensionInstallGrantRefresh` call. */
  onInstallGrantRefresh?: (input: MarketplaceExtensionInstallGrantRefreshInput) => void;
}

const DEFAULT_SELF: MarketplaceVendorGetSelfOutput = {
  vendor_id: 0,
  namespace: null,
  tier: null,
  state: "unregistered",
  profile_visibility: "private",
  published_count: 0,
  has_registry_token: false,
  registry_url: "https://registry.cinatra.ai",
};

export function createMockMarketplaceMcpClient(fixtures: MockFixtures = {}): MarketplaceMcpClient {
  let nextCatalogId = 1;
  let nextSubmissionId = 0;
  let self: MarketplaceVendorGetSelfOutput = { ...DEFAULT_SELF, ...(fixtures.self ?? {}) };
  const mockSubmissions: MarketplaceVendorSubmission[] = [];

  return {
    async extensionGet(input) {
      const detail = fixtures.extensions?.[input.packageName];
      if (!detail) {
        throw new MarketplaceMcpError(`Mock: ${input.packageName} not found`, 404, "");
      }
      return detail;
    },
    async extensionList(input = {}) {
      // Mirror the ability's filter/sort/paginate semantics so consumers can be
      // exercised without a live marketplace. Fixtures are already install-ready
      // (the real ability fails closed on missing package_name/version).
      const all = fixtures.catalog ?? [];
      const kind = typeof input.kind === "string" ? input.kind.trim() : "";
      const query = typeof input.query === "string" ? input.query.trim().toLowerCase() : "";
      const filtered = all.filter((e) => {
        if (kind && e.kind_slug !== kind) return false;
        if (!query) return true;
        return (
          e.display_name.toLowerCase().includes(query) ||
          e.package_name.toLowerCase().includes(query) ||
          (e.description ?? "").toLowerCase().includes(query)
        );
      });
      const total = filtered.length;
      const offset = Math.max(0, input.offset ?? 0);
      const limit = input.limit != null ? Math.max(0, Math.min(100, input.limit)) : filtered.length;
      return { items: filtered.slice(offset, offset + limit), total };
    },
    async extensionInstallAuthorize(input) {
      fixtures.onInstallAuthorize?.(input);
      const exactKey = `${input.package_name}@${input.version}`;
      const fixture =
        fixtures.installAuthorizations?.[exactKey] ??
        fixtures.installAuthorizations?.[input.package_name];
      if (fixture instanceof MarketplaceMcpError) {
        throw fixture;
      }
      if (fixture) {
        return fixture;
      }
      // No fixture → auto-grant a deterministic stub. The grant is opaque on the
      // TS side, so the value only needs to round-trip; tests never decode it.
      const now = Date.now();
      return {
        grant: `mock-install-grant.${input.package_name}.${input.version}.${now}`,
        kind: "agent",
        resolved_version: input.version,
        broker_base_url: "https://marketplace.cinatra.ai/install/v1",
        closure: [],
        expires_at: new Date(now + 120_000).toISOString(),
      };
    },
    async extensionInstallGrantRefresh(input) {
      fixtures.onInstallGrantRefresh?.(input);
      const fixture = fixtures.installGrantRefreshes?.[input.grant];
      if (fixture instanceof MarketplaceMcpError) {
        throw fixture;
      }
      if (fixture) {
        return fixture;
      }
      // No fixture → auto-extend a deterministic stub. `expires_at` is Unix epoch
      // SECONDS (matching the PHP ability), NOT an ISO string. The empty-closure
      // `closure_hash` is the sha256 of the empty closure basis (the host
      // recomputes + cross-checks it).
      const nowSec = Math.floor(Date.now() / 1000);
      return {
        grant: `mock-refreshed-grant.${input.grant}.${nowSec}`,
        resolved_version: "1.0.0",
        broker_base_url: "https://marketplace.cinatra.ai/install/v1",
        closure: [],
        expires_at: nowSec + 120,
        // sha256("") — the basis for an empty (newline-joined) closure.
        closure_hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        op: `mock-op.${input.grant}`,
      };
    },
    async vendorGet(input) {
      const vendor = fixtures.vendors?.[input.vendorSlug];
      if (!vendor) {
        throw new MarketplaceMcpError(`Mock: vendor ${input.vendorSlug} not found`, 404, "");
      }
      return vendor;
    },
    async vendorApply(input) {
      const now = new Date().toISOString();
      const vendor: MarketplaceVendorGetOutput = {
        vendorSlug: input.vendorSlug,
        displayName: input.displayName,
        status: "pending",
        approvedScopes: [],
        token: { state: "none", tokenSuffix: null, issuedAt: null, rotatedAt: null, revokedAt: null },
        termsAcceptance: input.termsAcceptance,
        publicContact: input.publicContact,
        createdAt: now,
        updatedAt: now,
      };
      return { vendor };
    },
    async packageSyncFromRegistry(input) {
      fixtures.onSync?.(input);
      return { catalogEntryId: `mock-catalog-${nextCatalogId++}`, changed: true, warnings: [] };
    },
    async vendorRegisterSelf(input) {
      self = {
        ...self,
        vendor_id: self.vendor_id || 1,
        namespace: input.namespace,
        tier: "free",
        state: "active",
        has_registry_token: true,
      };
      return {
        vendor_id: self.vendor_id,
        namespace: input.namespace,
        tier: "free",
        state: "active",
        profile_visibility: self.profile_visibility,
        published_count: self.published_count,
        has_registry_token: true,
        registry_url: self.registry_url,
        registry_token: {
          plaintext_token: `mock-registry-token-${input.namespace}`,
          token_id: `mock-token-id-${input.namespace}`,
          is_stub: true,
        },
      };
    },
    async vendorGetSelf() {
      return { ...self };
    },
    async vendorProfileVisibilitySet(input) {
      if (self.published_count > 0) {
        self = { ...self, profile_visibility: "locked_public" };
      } else {
        self = { ...self, profile_visibility: input.visibility };
      }
      return { namespace: self.namespace ?? "", profile_visibility: self.profile_visibility };
    },
    async vendorRegistryTokenRotateSelf() {
      const ns = self.namespace ?? "@mock";
      self = { ...self, has_registry_token: true };
      return {
        plaintext_token: `mock-rotated-token-${ns}`,
        token_id: `mock-rotated-id-${ns}`,
        scope: ns,
        created_at: new Date().toISOString(),
        is_stub: true,
      };
    },
    async extensionSubmitForReview(input) {
      const submissionId = `mock-sub-${++nextSubmissionId}`;
      const target = `${input.namespace}/${input.extension_name}@${input.version}`;
      mockSubmissions.push({
        submission_id: submissionId,
        namespace: input.namespace,
        extension_name: input.extension_name,
        version: input.version,
        status: "pending",
        target_final_identity: target,
        artifact_digest: input.artifact_digest_sha256,
        submitted_at: new Date().toISOString(),
        decided_at: null,
        decision_reason: null,
        promotion_state: "none",
        promotion_error: null,
        final_artifact_digest: null,
      });
      return {
        submission_id: submissionId,
        target_final_identity: target,
        status: "pending",
        idempotent_replay: false,
      };
    },
    async extensionSubmissionListSelf() {
      return { submissions: [...mockSubmissions] };
    },
    async extensionSubmissionListAdmin(input) {
      const wanted = input?.status ?? "pending";
      const subset = mockSubmissions
        .filter((s) => s.status === wanted)
        // Admin rows carry richer fields than vendor ones; the mock returns the
        // vendor fields padded out with the admin-only ones (defaults).
        .map((s) => ({
          ...s,
          vendor_id: 1,
          staging_artifact_path: `@cinatra-p-mock/${s.extension_name}-${s.submission_id}@${s.version}`,
          artifact_size_bytes: 0,
          submitter_id: 1,
          decided_by_admin_id: null,
          description: null,
          deps_json: null,
        }));
      return { submissions: subset };
    },
    async extensionSubmissionWithdraw(input) {
      const row = mockSubmissions.find((s) => s.submission_id === input.submission_id);
      if (!row) throw new Error(`Mock: submission "${input.submission_id}" not found.`);
      if (row.status !== "pending") {
        throw new Error(`Mock: submission "${input.submission_id}" is not pending (status=${row.status}).`);
      }
      row.status = "withdrawn";
      row.decided_at = new Date().toISOString();
      return { submission_id: row.submission_id, status: row.status };
    },
    async extensionSubmissionApprove(input) {
      const row = mockSubmissions.find((s) => s.submission_id === input.submission_id);
      if (!row) throw new Error(`Mock: submission "${input.submission_id}" not found.`);
      if (row.status !== "pending") {
        throw new Error(`Mock: submission "${input.submission_id}" is not pending (status=${row.status}).`);
      }
      // Stub saga: jump straight to promoted+complete. Real bridge does this
      // via the 9-step flow against Verdaccio; the mock just shortcircuits so
      // downstream test code can observe the final state.
      row.status = "promoted";
      row.promotion_state = "complete";
      row.final_artifact_digest = row.artifact_digest;
      row.decided_at = new Date().toISOString();
      return {
        submission_id: row.submission_id,
        status: row.status,
        promotion_state: row.promotion_state,
        target_final_identity: row.target_final_identity,
        promotion_error: null,
      };
    },
    async extensionSubmissionReject(input) {
      const row = mockSubmissions.find((s) => s.submission_id === input.submission_id);
      if (!row) throw new Error(`Mock: submission "${input.submission_id}" not found.`);
      if (row.status !== "pending") {
        throw new Error(`Mock: submission "${input.submission_id}" is not pending (status=${row.status}).`);
      }
      if (!input.reason || input.reason.trim() === "") {
        throw new Error("Mock: reject requires a non-empty reason.");
      }
      row.status = "rejected";
      row.decided_at = new Date().toISOString();
      row.decision_reason = input.reason;
      return { submission_id: row.submission_id, status: row.status };
    },
    async extensionSubmissionPromotionRetry(input) {
      const row = mockSubmissions.find((s) => s.submission_id === input.submission_id);
      if (!row) throw new Error(`Mock: submission "${input.submission_id}" not found.`);
      if (row.status !== "approved" || row.promotion_state !== "failed") {
        throw new Error(`Mock: submission "${input.submission_id}" is not retryable (status=${row.status} promotion_state=${row.promotion_state}).`);
      }
      // Stub saga retry: jump to promoted+complete.
      row.status = "promoted";
      row.promotion_state = "complete";
      row.promotion_error = null;
      row.final_artifact_digest = row.artifact_digest;
      return {
        submission_id: row.submission_id,
        status: row.status,
        promotion_state: row.promotion_state,
        promotion_error: null,
      };
    },
    async instanceAttachSelf(input) {
      const short = input.instance_id.slice(0, 8);
      const now = new Date().toISOString();
      return {
        marketplace_user_id: 100,
        marketplace_username: `cinatra-instance-${short}`,
        verdaccio_username: `ci-${short}`,
        marketplace_token: `mock-marketplace-token-${short}`,
        verdaccio_read_token: `mock-verdaccio-read-token-${short}`,
        attached_at: now,
        rotated: false,
      };
    },
    async vendorApplicationApply(input) {
      // Free-tier auto-approves inline; commercial-tier stays applied.
      const now = new Date().toISOString();
      if (input.tier === "free") {
        return {
          state: "approved",
          application_id: input.application_id,
          scope: input.proposed_scope,
          tier: "free",
          decided_at: now,
          decided_by_admin_id: null,
          publish_token: {
            plaintext_token: `mock-publish-token-${input.proposed_scope}`,
            token_id: `mock-publish-id-${input.application_id}`,
            is_stub: true,
          },
        };
      }
      return {
        state: "applied",
        application_id: input.application_id,
        scope: input.proposed_scope,
        tier: "commercial",
        applied_at: now,
      };
    },
    async vendorApplicationStatus() {
      return { state: "none" };
    },
    async vendorApplicationCancel(input) {
      return { state: "cancelled", application_id: input.application_id };
    },
    async vendorApplicationReset(input) {
      return {
        state: "reset",
        application_id: input.application_id,
        decided_at: new Date().toISOString(),
        decided_by_admin_id: 1,
        decision_reason: input.decision_reason ?? "admin reset",
      };
    },
    async vendorApplicationListAdmin() {
      return { rows: [], next_cursor: null };
    },
    async vendorApplicationApprove(input) {
      return {
        state: "approved",
        application_id: input.application_id,
        scope: "@mock-scope",
        decided_at: new Date().toISOString(),
        decided_by_admin_id: 1,
      };
    },
    async vendorApplicationReject(input) {
      if (!input.decision_reason || input.decision_reason.trim() === "") {
        throw new Error("Mock: reject requires a non-empty decision_reason.");
      }
      return {
        state: "rejected",
        application_id: input.application_id,
        decided_at: new Date().toISOString(),
        decided_by_admin_id: 1,
        decision_reason: input.decision_reason,
      };
    },
    async vendorApplicationCompleteRecovery(input) {
      return {
        state: "approved",
        application_id: input.application_id,
        completed_at: new Date().toISOString(),
      };
    },
  };
}
