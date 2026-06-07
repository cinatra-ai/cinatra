/**
 * Vendored TS types for the Cinatra Marketplace MCP primitives.
 *
 * SOURCE OF TRUTH: marketplace/packages/marketplace-mcp-contract/.
 * Keep this file in sync until that package is publishable to
 * registry.cinatra.ai — at which point delete this file and import via
 *   `import type { ... } from "@cinatra-ai/marketplace-mcp-contract";`
 *
 * The long-term plan is a single source of truth (the contract package).
 * This vendoring is a documented short-term workaround so the Cinatra-side
 * sync worker + UI can land before the Verdaccio publish path is functional.
 */

// ---------------------------------------------------------------------------
// Common shapes (mirrors src/schemas/common.ts in the contract package)
// ---------------------------------------------------------------------------

export type ExtensionKind = "agent" | "skill" | "connector" | "artifact" | "workflow";

export type ListingCategory = "agent" | "skill" | "connector" | "context" | "dashboard";

export type VendorApplicationStatus =
  | "pending"
  | "under_review"
  | "approved"
  | "rejected"
  | "active"
  | "suspended"
  | "reinstated";

export type ListingPublicationState =
  | "draft"
  | "pending"
  | "published"
  | "hidden"
  | "taken_down";

export type PackageVersionState = "approved" | "rejected" | "yanked";

export type TokenState = "none" | "active" | "rotated" | "revoked";

export interface TermsAcceptance {
  termsVersion: string;
  termsAcceptedAt: string;
  termsDigest: string;
  termsUrl: string;
}

export interface MarketplaceAsset {
  /** Path RELATIVE to the package root (no URL fetching). */
  path: string;
  role: "hero" | "screenshot" | "icon";
}

export interface PaginationInput {
  page?: number;
  pageSize?: number;
}

export interface PaginationResult {
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// Extension primitives
// ---------------------------------------------------------------------------

export interface ExtensionCard {
  packageName: string;
  name: string;
  description: string | null;
  kind: ExtensionKind;
  category: ListingCategory;
  latestVersion: string | null;
  vendorSlug: string;
  iconAssetUrl: string | null;
  publicationState: ListingPublicationState;
}

/**
 * The caller-visible listing visibility, as decided by the marketplace for the
 * requesting principal. A consumer / INSTANCE principal can only ever see
 * `"public"`; `"private"` (listed but not visible to this principal) and
 * `"unknown"` (no such listing) are the not-found signals. The marketplace
 * `extension_get` ability returns 200 with `current_visibility:"unknown"` for a
 * missing package (it does NOT throw 404), so the consuming page treats anything
 * other than `"public"` as not-found.
 */
export type ExtensionVisibility = "public" | "private" | "unknown";

export interface ExtensionDetail extends ExtensionCard {
  /**
   * Caller-visible visibility of this listing (wire: `current_visibility`).
   * `"public"` is the only value a consumer principal will ever see; anything
   * else (`"private"` / `"unknown"`) means the package is not publicly listed
   * for this caller and the consuming page treats it as not-found.
   *
   * Optional so legacy camelCase fixtures (which predate this field) stay valid;
   * the http-client {@link MarketplaceExtensionGetOutput} mapper ALWAYS populates
   * it (defaulting to `"unknown"`), and the page fails closed when it is absent.
   */
  currentVisibility?: ExtensionVisibility;
  longDescription: string | null;
  readmeMarkdown: string | null;
  marketplaceAssets: MarketplaceAsset[];
  license: string | null;
  versionHistory: Array<{ version: string; releasedAt: string; state: PackageVersionState }>;
}

export interface MarketplaceExtensionGetInput {
  packageName: string;
  versionRange?: string;
}
export type MarketplaceExtensionGetOutput = ExtensionDetail;

/**
 * Raw `extension_get` ability output on the wire — snake_case, faithful to the
 * PHP ability. The `extension_get` ability returns 200 (NOT a 404 throw) for an
 * unlisted/missing package, with `current_visibility:"unknown"` and the
 * kind/version fields null. The http-client maps this to the camelCase
 * {@link ExtensionDetail} the cinatra-side consumers read (page, gatekept-install).
 *
 * Fields are optional/nullable because the not-found shape (200 +
 * `current_visibility:"unknown"`) carries null kind/version and may omit the
 * descriptive fields entirely.
 */
export interface MarketplaceExtensionGetWire {
  package_name?: string | null;
  name?: string | null;
  description?: string | null;
  kind?: ExtensionKind | null;
  category?: ListingCategory | null;
  latest_version?: string | null;
  vendor_slug?: string | null;
  icon_asset_url?: string | null;
  publication_state?: ListingPublicationState | null;
  current_visibility?: ExtensionVisibility | string | null;
  long_description?: string | null;
  readme_markdown?: string | null;
  marketplace_assets?: MarketplaceAsset[] | null;
  license?: string | null;
  version_history?: Array<{
    version: string;
    released_at?: string;
    releasedAt?: string;
    state: PackageVersionState;
  }> | null;
}

// ---------------------------------------------------------------------------
// Extension catalog listing (storefront browse parity)
//
// snake_case on the wire: these match the marketplace
// `extension_list` ability output verbatim (CardModelBuilder in
// marketplace). camelCase mapping, if any, is explicit on the cinatra
// side. Public-only: NO tarball url, credentials, raw SVG, or raw price HTML.
// Every returned entry is install-ready — the ability omits products lacking a
// valid {package_name, version}, so both are guaranteed non-empty here.
// ---------------------------------------------------------------------------

export type CatalogKindSlug = ExtensionKind | "unknown";

export interface MarketplaceCatalogBadge {
  /** "Open source" / "Free" / a plain formatted price amount (never price HTML). */
  text: string;
  variant: "oss" | "free" | "price";
  /** SPDX id when variant is "oss", else null. */
  license: string | null;
}

export interface MarketplaceCatalogEntry {
  /** Full scoped npm name (meta cinatra_package_name) — the install identifier. */
  package_name: string;
  /** Scope WITHOUT the leading "@" (parsed from package_name). */
  scope: string;
  /** Name after the "/" (parsed from package_name). */
  extension_name: string;
  /** Listed version (meta cinatra_package_version) — the install version. Non-empty. */
  version: string;
  /** Normalized singular kind; "unknown" for contexts/dashboards/unmapped. */
  kind_slug: CatalogKindSlug;
  /** Human label derived centrally in the builder (no PHP/TS drift). */
  kind_label: string;
  /** Display name (get_name()) — display only, NOT the install identifier. */
  display_name: string;
  description: string | null;
  badge: MarketplaceCatalogBadge;
  /** ISO-8601 UTC ("…Z") or null — validated freshness timestamp. */
  freshness_at: string | null;
  rating: { average: number; count: number };
  /** Allowlisted vendor-logo key (gmail/slack/…) or null — never raw SVG. */
  vendor_logo_key: string | null;
  permalink: string;
}

export interface MarketplaceExtensionListInput {
  /**
   * Filter to a single kind (singular). Empty/absent → no kind filter; an
   * invalid/unknown kind matches NOTHING (empty result), mirroring the
   * `extension_list` ability (it returns `{items:[], total:0}` for an unknown
   * kind rather than ignoring the filter).
   */
  kind?: string;
  /** Case-insensitive substring over display_name + package_name + description. */
  query?: string;
  /** Page size; clamped server-side to a sane max. */
  limit?: number;
  /** Page offset (>= 0). */
  offset?: number;
}

export interface MarketplaceExtensionListOutput {
  items: MarketplaceCatalogEntry[];
  /** Pre-pagination count of returnable items matching the filter. */
  total: number;
}

// ---------------------------------------------------------------------------
// Gatekept-install authorize primitive (marketplace-gatekept install)
//
// `extension_install_authorize` mints a short-lived signed grant for installing
// a specific listed version of an extension. The grant is an OPAQUE bearer token
// on the cinatra (TS) side — it is presented to the broker install read-proxy as
// `Authorization: Bearer <grant>` and is NEVER parsed/decoded here. Wire shapes
// are snake_case (faithful pass-through of the PHP ability output), matching the
// other extension types.
// ---------------------------------------------------------------------------

/** One pinned `{name, version}` member of the install closure. */
export interface MarketplaceInstallClosureEntry {
  name: string;
  version: string;
}

export interface MarketplaceExtensionInstallAuthorizeInput {
  /** Full scoped npm name being installed, e.g. "@scope/ext". */
  package_name: string;
  /** Exact listed version — entitlement is per exact storefront-listed version. */
  version: string;
}

export interface MarketplaceExtensionInstallAuthorizeOutput {
  /**
   * OPAQUE bearer grant (RS256 compact JWS). Presented to the broker install
   * read-proxy as `Authorization: Bearer <grant>`. NEVER parsed/decoded on the
   * cinatra side; NEVER logged.
   */
  grant: string;
  /** Extension kind of the authorized root (mirrors the storefront listing). */
  kind: ExtensionKind;
  /** The storefront-listed version that was authorized (== input version). */
  resolved_version: string;
  /** Broker install read-proxy base URL — the registry the install reads through. */
  broker_base_url: string;
  /** Transitive dependency closure, exact-version-pinned. */
  closure: MarketplaceInstallClosureEntry[];
  /** Grant expiry (ISO-8601 UTC) — short TTL; presentational/audit only here. */
  expires_at: string;
}

// ---------------------------------------------------------------------------
// Vendor primitives
// ---------------------------------------------------------------------------

export interface VendorToken {
  state: TokenState;
  tokenSuffix: string | null;
  issuedAt: string | null;
  rotatedAt: string | null;
  revokedAt: string | null;
}

export interface VendorRecord {
  vendorSlug: string;
  displayName: string;
  status: VendorApplicationStatus;
  approvedScopes: string[];
  token: VendorToken;
  termsAcceptance: TermsAcceptance | null;
  publicContact: {
    email: string | null;
    websiteUrl: string | null;
  };
  createdAt: string;
  updatedAt: string;
}

export interface MarketplaceVendorGetInput {
  vendorSlug: string;
}
export type MarketplaceVendorGetOutput = VendorRecord;

export interface MarketplaceVendorApplyInput {
  vendorSlug: string;
  displayName: string;
  requestedScopes: string[];
  publicContact: {
    email: string | null;
    websiteUrl: string | null;
  };
  termsAcceptance: TermsAcceptance;
  idempotencyKey: string;
}
export interface MarketplaceVendorApplyOutput {
  vendor: VendorRecord;
}

// ---------------------------------------------------------------------------
// Vendor self-service primitives (extender abilities)
//
// These shapes mirror the live ability outputs 1:1 and are intentionally
// snake_case to match the wire (the WP MCP adapter returns the PHP ability's
// array verbatim) — the client is a faithful typed pass-through, no transform.
// (The older camelCase vendor types above predate the live abilities and are
// reconciled separately.)
// ---------------------------------------------------------------------------

/** One-time registry token grant — the plaintext bearer is shown exactly once. */
export interface MarketplaceRegistryTokenGrant {
  plaintext_token: string;
  token_id: string;
  is_stub: boolean;
}

export interface MarketplaceVendorRegisterSelfInput {
  /** Desired vendor namespace, e.g. "@acme" (== the Cinatra instance namespace). */
  namespace: string;
  terms_version: string;
  /** sha256 hex of the accepted ToS bytes. */
  terms_digest: string;
  terms_url?: string;
  store_name?: string;
  display_name?: string;
}

export interface MarketplaceVendorRegisterSelfOutput {
  vendor_id: number;
  namespace: string;
  tier: string;
  state: string;
  profile_visibility: string;
  published_count: number;
  has_registry_token: boolean;
  registry_url: string;
  /** Present only on first issuance (one-time plaintext); null on idempotent re-register. */
  registry_token: MarketplaceRegistryTokenGrant | null;
}

export interface MarketplaceVendorGetSelfOutput {
  vendor_id: number;
  namespace: string | null;
  tier: string | null;
  state: string;
  profile_visibility: string;
  published_count: number;
  has_registry_token: boolean;
  registry_url: string;
}

export type MarketplaceVendorVisibility = "private" | "public";

export interface MarketplaceVendorProfileVisibilitySetInput {
  visibility: MarketplaceVendorVisibility;
}

export interface MarketplaceVendorProfileVisibilitySetOutput {
  namespace: string;
  /** "private" | "public" | "locked_public" (locked once the vendor has published). */
  profile_visibility: string;
}

export interface MarketplaceVendorRegistryTokenRotateSelfOutput {
  plaintext_token: string;
  token_id: string;
  scope: string;
  created_at: string;
  is_stub: boolean;
}

// ---------------------------------------------------------------------------
// Extension-version submission primitives (extender abilities)
//
// Vendor submits a built tarball for `@<ns>/<extension>@<version>`. The
// marketplace stages it into a hidden scope + records a pending submission.
// Wire shapes are snake_case (faithful pass-through of the PHP ability output).
// ---------------------------------------------------------------------------

export interface MarketplaceExtensionSubmitForReviewInput {
  /** Vendor scope (the instance namespace), e.g. "@acme". */
  namespace: string;
  /** Extension stem (bare name, no leading scope), e.g. "foo". */
  extension_name: string;
  /** Semver of the version being submitted. */
  version: string;
  /** sha256 hex of the tarball bytes the marketplace will receive. */
  artifact_digest_sha256: string;
  /** Decoded tarball size in bytes (marketplace verifies this matches). */
  artifact_size_bytes: number;
  /** Base64-encoded tarball bytes. The marketplace decodes + verifies. */
  tarball_base64: string;
  description?: string;
  /** Declared dependencies (informational); deep validation happens at approval. */
  deps?: string[];
  /**
   * GitHub Actions OIDC ID token (a GitHub-signed JWT) proving the submission's
   * source identity — repository, owner, public visibility, and the blessed
   * release workflow. Optional and back-compatible: when present the marketplace
   * may auto-approve a first-party submission via the public-repo predicate; when
   * absent (manual/local submit) the submission falls to manual moderation. The
   * marketplace owns size/shape validation; never log the value.
   */
  source_identity_token?: string;
}

export interface MarketplaceExtensionSubmitForReviewOutput {
  submission_id: string;
  target_final_identity: string;
  /** `pending` on first submit; the same `pending` row on idempotent replay. */
  status: string;
  /** True when the same-digest submission was already pending — no new staging publish happened. */
  idempotent_replay: boolean;
}

/** Vendor-facing submission row — the admin-only `staging_artifact_path` is stripped. */
export interface MarketplaceVendorSubmission {
  submission_id: string;
  namespace: string;
  extension_name: string;
  version: string;
  status: string;
  target_final_identity: string;
  artifact_digest: string;
  submitted_at: string;
  decided_at: string | null;
  decision_reason: string | null;
  /**
   * Promotion-saga state for rows in `status='approved'`. The marketplace
   * reflects this even on vendor-facing list rows so a vendor sees
   * "approved, promotion in flight" vs. "approved, promotion failed" without
   * needing to invent it from `status` alone (admin decision is preserved
   * across saga failures).
   *
   * Possible values: `none` | `in_flight` | `complete` | `failed`. The
   * marketplace string type is left open here so future states (e.g.
   * `superseded_by_retry`) don't require a client-side type bump.
   */
  promotion_state: string;
  /** Recorded reason when promotion_state is `failed`; otherwise null. */
  promotion_error: string | null;
  /** sha256 of the final-scope tarball after a successful publish. */
  final_artifact_digest: string | null;
}

export interface MarketplaceExtensionSubmissionListSelfOutput {
  submissions: MarketplaceVendorSubmission[];
}

/** Admin-facing submission row — includes `staging_artifact_path` for review. */
export interface MarketplaceAdminSubmission extends MarketplaceVendorSubmission {
  vendor_id: number;
  staging_artifact_path: string;
  artifact_size_bytes: number;
  submitter_id: number;
  decided_by_admin_id: number | null;
  description: string | null;
  deps_json: string | null;
}

export interface MarketplaceExtensionSubmissionListAdminInput {
  status?: "pending" | "approved" | "rejected" | "withdrawn" | "superseded" | "promoted";
  limit?: number;
  offset?: number;
}

export interface MarketplaceExtensionSubmissionListAdminOutput {
  submissions: MarketplaceAdminSubmission[];
}

// ---------------------------------------------------------------------------
// Extension submission mutations.
// ---------------------------------------------------------------------------

/** Vendor withdraws their own pending submission. */
export interface MarketplaceExtensionSubmissionWithdrawInput {
  submission_id: string;
}
export interface MarketplaceExtensionSubmissionWithdrawOutput {
  submission_id: string;
  status: string;
}

/** Admin approves a pending submission; starts the promotion saga. */
export interface MarketplaceExtensionSubmissionApproveInput {
  submission_id: string;
}
export interface MarketplaceExtensionSubmissionApproveOutput {
  submission_id: string;
  status: string;
  promotion_state: string;
  target_final_identity: string;
  promotion_error: string | null;
}

/** Admin rejects a pending submission with a non-empty reason. */
export interface MarketplaceExtensionSubmissionRejectInput {
  submission_id: string;
  reason: string;
}
export interface MarketplaceExtensionSubmissionRejectOutput {
  submission_id: string;
  status: string;
}

/** Admin retries the promotion saga on a row stuck at approved+failed. */
export interface MarketplaceExtensionSubmissionPromotionRetryInput {
  submission_id: string;
}
export interface MarketplaceExtensionSubmissionPromotionRetryOutput {
  submission_id: string;
  status: string;
  promotion_state: string;
  promotion_error: string | null;
}

// ---------------------------------------------------------------------------
// Instance-attach primitive. PRINCIPAL_PUBLIC +
// rate-limited; minted by the marketplace `instance_attach_self` ability on
// first call from a fresh consumer-tier instance. Idempotent on re-attach
// (proof-of-ownership rotation; existing row preserved).
// ---------------------------------------------------------------------------

export interface MarketplaceInstanceAttachSelfInput {
  /** UUIDv4 from `instance_identity.instanceId`. */
  instance_id: string;
  /** Plaintext base64url(32) attach secret — decrypted at call time only. */
  instance_attach_secret: string;
  /** Human-readable instance display name (mirrored to the WP user). */
  display_name: string;
  /**
   * Gatekept-capable declaration. OPTIONAL + backward-compatible.
   * When `true`, the attaching instance is telling the marketplace it routes
   * install reads through the broker (per-install grants) and does NOT need a
   * deployment-wide Verdaccio read token — the marketplace then OMITS
   * `verdaccio_read_token`/`verdaccio_username` from its response. Sent by the
   * cinatra client ONLY when `CINATRA_GATEKEPT_INSTALL` is ON. When absent (the
   * default / flag-OFF), the marketplace keeps minting the Verdaccio read token
   * exactly as before, so deploying the marketplace side never strands a
   * flag-OFF cinatra instance.
   */
  gatekept_install?: boolean;
}

export interface MarketplaceInstanceAttachSelfOutput {
  /** WP user id for the cinatra-instance principal. */
  marketplace_user_id: number;
  /** `cinatra-instance-<short-uuid>`. */
  marketplace_username: string;
  /**
   * `ci-<short-uuid>` Verdaccio htpasswd user (read-side). OPTIONAL/nullable:
   * the marketplace OMITS it in gatekept mode (when the attach input carried
   * `gatekept_install: true`) because no deployment-wide Verdaccio read
   * principal is minted. Present on the legacy direct-read path.
   */
  verdaccio_username?: string | null;
  /** WP Application Password (plaintext, returned ONCE). */
  marketplace_token: string;
  /**
   * Verdaccio read-side token (plaintext, returned ONCE). OPTIONAL/nullable:
   * the marketplace OMITS it in gatekept mode (install reads route through the
   * broker via per-install grants). Present on the legacy direct-read path; a
   * flag-OFF instance still REQUIRES it (the consume side fails closed when it
   * is absent while the flag is OFF).
   */
  verdaccio_read_token?: string | null;
  /** ISO timestamp; mirrors the `cinatra_instance_principals.attached_at`. */
  attached_at: string;
  /** Whether this call rotated an existing attachment (vs. fresh attach). */
  rotated: boolean;
}

// ---------------------------------------------------------------------------
// Vendor application primitives.
//
// 8 abilities that govern the namespace-reservation lifecycle on the cm side
// (`cinatra_namespace_reservations` rows with `status IN
// ('applied','approved','rejected','cancelled','reset')`). Snake_case on the
// wire (faithful pass-through of the PHP ability output).
//
// Default principal for the first three (apply/status/cancel) is
// PRINCIPAL_VENDOR. The five
// admin/sync_worker abilities are admin-bound (`vendor_application_*` admin
// queue) or sync-worker-bound (`vendor_application_complete_recovery`).
// ---------------------------------------------------------------------------

/** Tiers supported by a vendor application. */
export type MarketplaceVendorApplicationTier = "free" | "commercial";

/** Lifecycle states for a `cinatra_namespace_reservations` row, plus `"none"`
 *  for "no row exists for this caller". Mirrors VendorState collapsing rules
 *  in the cinatra-side `InstanceIdentity` block. */
export type MarketplaceVendorApplicationState =
  | "none"
  | "applied"
  | "approved"
  | "rejected"
  | "cancelled"
  | "reset";

export interface MarketplaceVendorApplicationApplyInput {
  /** Client-generated UUIDv4 idempotency key (REQUIRED for idempotent apply). */
  application_id: string;
  /** npm-scope notation `"@scope"` (the operator's `instanceNamespace`). */
  proposed_scope: string;
  tier: MarketplaceVendorApplicationTier;
  terms_version: string;
  /** sha256 hex of the accepted ToS body. */
  terms_digest: string;
  display_name: string;
}

/**
 * Discriminated union — apply may resolve inline (free-tier auto-approve),
 * stay applied (commercial-tier pending review), or return a structured
 * stale-terms error.
 */
export type MarketplaceVendorApplicationApplyOutput =
  | {
      state: "approved";
      application_id: string;
      scope: string;
      tier: MarketplaceVendorApplicationTier;
      decided_at: string;
      decided_by_admin_id: number | null;
      /** Free-tier inline auto-approve returns the Verdaccio publish token
       *  directly to the applicant; commercial-tier approve returns null
       *  here (delivery via `vendor_registry_token_rotate_self`).
       *
       *  NOTE: field name `publish_token` matches the cm-side
       *  `vendor_application_apply` ability return shape
       *  (wp-plugins/cinatra-marketplace-extender/src/Abilities/
       *  VendorApplicationApply.php). The shape (plaintext_token /
       *  token_id / is_stub) is identical to
       *  `MarketplaceRegistryTokenGrant`; only the field name differs by
       *  ability (apply uses `publish_token`, register uses
       *  `registry_token`). */
      publish_token: MarketplaceRegistryTokenGrant | null;
    }
  | {
      state: "applied";
      application_id: string;
      scope: string;
      tier: MarketplaceVendorApplicationTier;
      applied_at: string;
    }
  | {
      error_code: "TERMS_VERSION_STALE";
      current_version: string;
      current_digest: string;
      terms_url: string;
    }
  | {
      error_code: "TERMS_DIGEST_MISMATCH";
      current_version: string;
      current_digest: string;
      terms_url: string;
    };

export interface MarketplaceVendorApplicationStatusOutput {
  state: MarketplaceVendorApplicationState;
  scope?: string;
  application_id?: string;
  tier?: MarketplaceVendorApplicationTier;
  decided_at?: string;
  decision_reason?: string;
  terms_version?: string;
  /**
   * Set (ISO timestamp) when the recovery saga for this application has been
   * marked terminally stuck on the marketplace side (recovery-attempt cap
   * exhausted). Null/absent otherwise. Surfaced so the operator-triggered
   * refresh + boot reconcile can mirror the stuck flag onto the local
   * identity row instead of hammering a dead application forever.
   */
  repair_stuck_at?: string | null;
}

export interface MarketplaceVendorApplicationCancelInput {
  application_id: string;
}
export interface MarketplaceVendorApplicationCancelOutput {
  state: "cancelled";
  application_id: string;
}

export interface MarketplaceVendorApplicationResetInput {
  application_id: string;
  decision_reason?: string;
}
export interface MarketplaceVendorApplicationResetOutput {
  state: "reset";
  application_id: string;
  decided_at: string;
  decided_by_admin_id: number;
  decision_reason: string;
}

export interface MarketplaceVendorApplicationListAdminInput {
  /**
   * Status filter. The first five map directly to
   * `cinatra_namespace_reservations.status`. `"stuck"` is a PSEUDO-filter the
   * marketplace resolves server-side to "rows whose recovery saga is
   * terminally stuck (repair_stuck_at is set)" — there is no `stuck` row
   * status; it is a cross-cutting attribute on `applied`/`approved` rows.
   */
  status?: Array<"applied" | "approved" | "rejected" | "cancelled" | "reset" | "stuck">;
  limit?: number;
  /** Opaque cursor; `reserved_at DESC` ordering. */
  cursor?: string;
}

/** Admin-facing application row (richer than the public status output). */
export interface MarketplaceVendorApplicationAdminRow {
  application_id: string;
  scope: string;
  vendor_id: number;
  status: "applied" | "approved" | "rejected" | "cancelled" | "reset";
  tier: MarketplaceVendorApplicationTier;
  terms_version: string;
  terms_digest: string;
  display_name: string;
  applicant_user_id: number;
  applied_at: string;
  decided_at: string | null;
  decided_by_admin_id: number | null;
  decision_reason: string | null;
  reserved_at: string;
  /**
   * Count of recovery-saga attempts the marketplace has made for this row.
   * Bounded by the marketplace-side attempt cap; surfaced so the admin queue
   * can show how close a row is to (or past) the terminal-stuck threshold.
   */
  recovery_attempts: number;
  /**
   * ISO timestamp set when the recovery saga was marked terminally stuck
   * (attempt cap exhausted); null while the row is still recoverable.
   */
  repair_stuck_at: string | null;
}

export interface MarketplaceVendorApplicationListAdminOutput {
  rows: MarketplaceVendorApplicationAdminRow[];
  next_cursor: string | null;
}

export interface MarketplaceVendorApplicationApproveInput {
  application_id: string;
  decision_reason?: string;
}
/** Approve output NEVER contains the publish token (admin must
 *  never see the applicant's credentials). The applicant retrieves their
 *  token via `vendor_registry_token_rotate_self`. */
export interface MarketplaceVendorApplicationApproveOutput {
  state: "approved";
  application_id: string;
  scope: string;
  decided_at: string;
  decided_by_admin_id: number;
}

export interface MarketplaceVendorApplicationRejectInput {
  application_id: string;
  /** REQUIRED — admin must supply. */
  decision_reason: string;
}
export interface MarketplaceVendorApplicationRejectOutput {
  state: "rejected";
  application_id: string;
  decided_at: string;
  decided_by_admin_id: number;
  decision_reason: string;
}

export interface MarketplaceVendorApplicationCompleteRecoveryInput {
  application_id: string;
}
/**
 * Discriminated union over the recovery-saga outcome. The marketplace returns
 * exactly one variant per call:
 *
 *   - `state: "approved"` — the saga finished the `applied` → `approved` flip
 *     this run. `already_approved` distinguishes a fresh flip (false/absent)
 *     from an idempotent re-run that found the row already approved (true).
 *     Both count as recovered.
 *   - `state: "stuck"` — the recovery-attempt cap is exhausted; the saga is
 *     terminally stuck and will NOT auto-retry. `repair_stuck_at` records when
 *     it was marked. Requires admin intervention; the worker must stop
 *     attempting it.
 *   - `state: "applied"` + `retriable: true` — the saga started (or restarted)
 *     this run but the row has not yet flipped and the cap is not yet reached.
 *     Retry on the next reconcile cycle.
 *   - `state: "applied"` + `recovery_not_applicable: true` — no saga is
 *     in-flight (e.g. commercial-tier pending review, or pre-broker). A benign
 *     skip, NOT a failure.
 *
 * `recovery_attempts` accompanies the non-`approved` variants so the worker /
 * UI can reason about cap proximity.
 */
export type MarketplaceVendorApplicationCompleteRecoveryOutput =
  | {
      state: "approved";
      application_id: string;
      completed_at: string;
      already_approved?: boolean;
    }
  | {
      state: "stuck";
      application_id: string;
      recovery_attempts: number;
      repair_stuck_at: string;
    }
  | {
      state: "applied";
      application_id: string;
      recovery_attempts: number;
      retriable: true;
    }
  | {
      state: "applied";
      application_id: string;
      recovery_attempts: number;
      recovery_not_applicable: true;
    };

// ---------------------------------------------------------------------------
// Package sync primitives
// ---------------------------------------------------------------------------

export interface PackageMetadata {
  packageName: string;
  version: string;
  description: string | null;
  longDescription: string | null;
  kind: ExtensionKind;
  license: string | null;
  marketplaceAssets: MarketplaceAsset[];
  readmeMarkdown: string | null;
}

export interface MarketplacePackageSyncFromRegistryInput {
  metadata: PackageMetadata;
  versions: Array<{ version: string; releasedAt: string }>;
  idempotencyKey: string;
}

export interface MarketplacePackageSyncFromRegistryOutput {
  catalogEntryId: string;
  changed: boolean;
  warnings: string[];
}
