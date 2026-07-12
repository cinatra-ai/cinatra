// Canonical extension manifest types.
//
// The single source of truth for "what extension is installed and from where".
// One canonical row per (org, owner, package) carries status instead of
// per-kind shadow status columns (agent_templates / skill_packages /
// workflow_template / etc).
//
// All writes flow through transitionExtensionLifecycle (see lifecycle-primitive.ts);
// the canonical gate (canonical-gate.ts) is the entry point before any per-kind
// activation adapter dispatch.

export const EXTENSION_KINDS = ["agent", "connector", "artifact", "skill", "workflow"] as const;
export type ExtensionKind = (typeof EXTENSION_KINDS)[number];

export const EXTENSION_LIFECYCLE_STATUSES = ["active", "archived", "locked"] as const;
export type ExtensionLifecycleStatus = (typeof EXTENSION_LIFECYCLE_STATUSES)[number];

export const EXTENSION_OWNER_LEVELS = ["user", "team", "organization", "workspace", "platform"] as const;
export type ExtensionOwnerLevel = (typeof EXTENSION_OWNER_LEVELS)[number];

export const EXTENSION_SOURCE_TYPES = ["verdaccio", "github", "local", "bundled"] as const;
export type ExtensionSourceType = (typeof EXTENSION_SOURCE_TYPES)[number];

export type ExtensionSourceVerdaccio = {
  type: "verdaccio";
  registryUrl: string;
  packageName: string;
  version: string;
  /**
   * The sha512 SRI (`sha512-...`) — the materialize/boot-verify ROOT OF TRUST.
   * Verified over the exact tarball bytes by pacote (`EINTEGRITY`) and re-checked
   * at boot. NEVER replaced by a weaker digest.
   */
  integrity: string;
  /**
   * Content hash of the materialized package dir, recorded by the runtime
   * installer when it materializes the verified tarball. Present only for
   * packages installed through the live runtime pipeline (the boot loader's
   * trusted anchor); absent for legacy/dispatcher installs.
   */
  contentHash?: string;
  /**
   * The marketplace-attested sha256 (hex) of the tarball, when the registry
   * carries one. ADDITIVE authenticity attestation only — NOT a replacement for
   * `integrity` (sha512 SRI stays the root of trust). Optional so legacy rows
   * still validate; a future signing check can compare it to the materialized
   * bytes.
   */
  attestedSha256?: string;
  /**
   * base64 Ed25519 signature over the canonical `packageName+version+integrity`
   * payload, when the producer signed the tarball. ADDITIVE: the boot
   * trust gate verifies it against the host's configured trusted public keys
   * (`CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS`) — undefined means unsigned (no-op
   * unless `CINATRA_EXTENSION_REQUIRE_SIGNATURES=true`). Optional so legacy rows
   * still validate. See `src/lib/extension-signature.ts`.
   */
  signature?: string;
  /**
   * The 128-hex sha512 over the canonical MATERIALIZATION-PLAN bytes
   * (cinatra#181 — library dependency closure), recorded at install when the
   * package carried a signed plan. The boot trust gate threads it into the v2
   * signature verdict (a closure package can never activate on a v1/absent
   * signature). Absent = closure-less (v1 semantics unchanged). ADDITIVE JSONB
   * field — no SQL migration; legacy rows still validate.
   */
  closureHash?: string;
  /**
   * The DB-authoritative ACTIVE tarball digest (cinatra#792) — the 128-hex
   * sha512 store digest (`<root>/<kind>/<slug>/<digest>/`) of the install this
   * row currently pins. Written ONLY at the install pipeline/saga
   * finalize/rollback OUTCOME seam (`recordProvenance`), mirrored to the
   * plain-text `current` store file on every write. JOURNAL-GATED at read
   * time: selection honors it ONLY when it equals the finalized install-op
   * journal digest (`selectActiveDigest`) — a crash between the provenance
   * write and the journal finalize can never leave this field outranking the
   * journal. Absent on legacy rows (selection falls back to the journal digest
   * alone). ADDITIVE JSONB field — no SQL migration.
   */
  activeDigest?: string;
};

export type ExtensionSourceGithub = {
  type: "github";
  repo: string;
  ref: string;
  resolvedSha: string;
  path?: string;
};

export type ExtensionSourceLocal = {
  type: "local";
  path: string;
  resolvedCommitOrTreeHash: string;
};

/**
 * A BUNDLED (image-compiled) package's typed provenance (cinatra#792) — the
 * static-bundle lifecycle ANCHOR row's source shape. Replaces the retired
 * stringly encoding (`type:"local"`, `path:"static-bundle:<name>"`,
 * `resolvedCommitOrTreeHash:"bundled@<version>"`): provenance is now a
 * first-class discriminant, so readers switch on `type` instead of parsing
 * path prefixes.
 *
 * `digest` is the image-recorded content hash of the bundled payload
 * (cinatra#795): the prod image build records one per sealed extension payload
 * (scripts/extensions/record-bundled-digests.mjs) and the boot seeder stamps
 * it here — completing `<kind>/<slug>/<digest>` identity parity with
 * store-installed packages while the import path stays the sealed static
 * manifest (no store read). STILL OPTIONAL by design (staged deviation from
 * the epic's non-optional wording): a dev boot has no sealed image to hash,
 * and a placeholder value would be worse than an absent field. Absent = a dev
 * boot, or a row seeded before the image recorded a hash. When present it
 * must satisfy BUNDLED_SOURCE_DIGEST_RE. Trust-neutral: never an activation
 * or store-selection input.
 */
export type ExtensionSourceBundled = {
  type: "bundled";
  packageName: string;
  version: string;
  digest?: string;
};

export type ExtensionSource =
  | ExtensionSourceVerdaccio
  | ExtensionSourceGithub
  | ExtensionSourceLocal
  | ExtensionSourceBundled;

/**
 * The `bundled.digest` identity grammar — a LITERAL MIRROR of
 * `isStoreDigestSegment` (src/lib/extension-package-store-core.ts): hex
 * sha256..sha512 output lengths. This package cannot import the host store
 * module, so the mirror is parity-tested
 * (packages/extensions/src/__tests__/canonical-types-source-validators.test.ts)
 * — do not change one without the other.
 */
export const BUNDLED_SOURCE_DIGEST_RE = /^[0-9a-f]{64,128}$/;

export const DEPENDENCY_EDGE_TYPES = ["runtime", "install-time", "peer"] as const;
export type DependencyEdgeType = (typeof DEPENDENCY_EDGE_TYPES)[number];

export const DEPENDENCY_REQUIREMENTS = ["required", "optional"] as const;
export type DependencyRequirement = (typeof DEPENDENCY_REQUIREMENTS)[number];

export type VersionConstraint =
  | { kind: "semver-range"; range: string }
  | { kind: "exact"; version: string }
  | { kind: "git-ref"; ref: string };

export type ExtensionDependency = {
  packageName: string;
  // The depended-on extension's kind, so `dependencies` carries cross-kind edges
  // without a separate lookup. Optional for backward compatibility with rows
  // persisted before this field existed. Structurally mirrors the SDK draft
  // contract (`@cinatra-ai/sdk-extensions` `dependencies.ts`); the two unify at
  // the ABI freeze with the SDK as the single owner.
  kind?: ExtensionKind;
  edgeType: DependencyEdgeType;
  versionConstraint: VersionConstraint;
  requirement: DependencyRequirement;
};

/**
 * A dependency edge as PERSISTED in the `extension_dependency_edge` table
 * (cinatra#1040 S2 — edges moved off the `installed_extension.dependencies`
 * row jsonb into first-class rows). The declared half is exactly
 * `ExtensionDependency`; the resolved half pins WHICH installed row satisfied
 * the edge at write time:
 *
 *  - `resolvedInstallId` — the `installed_extension.id` the edge resolved to
 *    (FK, ON DELETE SET NULL), or `null` when no live target existed at write
 *    time. Resolution follows the DECLARING row's scope (its own org's live
 *    row first, then the platform row; a platform dependent binds only
 *    platform rows), preferring the DEFAULT version, deterministic id
 *    tie-break. The closure gates VALIDATE a resolved edge against the pinned
 *    row (status + version constraint) and fall back to the scoped
 *    name-lookup for unresolved edges — so a dependency installed AFTER its
 *    dependent still heals the closure exactly as before.
 *  - `resolutionReason` — free-form provenance of the resolution decision
 *    (e.g. `scoped:org`, `scoped:platform`, `backfill:org`), `null` when
 *    unresolved. Diagnostics only — never a gate input.
 */
export type ResolvedDependencyEdge = ExtensionDependency & {
  resolvedInstallId: string | null;
  resolutionReason: string | null;
};

/**
 * The RESOLVED connector access declaration cached on the canonical row at
 * registration/materialize (cinatra#951) — the validated `cinatra/config.json`
 * outcome. STRUCTURAL MIRROR of `ResolvedConnectorAccessDeclaration` in
 * `@cinatra-ai/sdk-extensions/access-config` (this package deliberately
 * imports no SDK module — same decoupling as BUNDLED_SOURCE_DIGEST_RE); the
 * two are pinned in agreement by
 * packages/extensions/src/__tests__/access-declaration-mirror.test.ts —
 * do not change one without the other.
 */
export const CONNECTOR_ACCESS_DECLARATION_SCOPES = [
  "user",
  "project",
  "team",
  "organization",
  "workspace",
  "admin",
] as const;
export type ConnectorAccessDeclarationScope =
  (typeof CONNECTOR_ACCESS_DECLARATION_SCOPES)[number];

export type ResolvedConnectorAccessDeclaration = {
  formatVersion: 1;
  mode: "default" | "only";
  scope: ConnectorAccessDeclarationScope;
  source: "declared" | "absent";
};

/** Structural guard for a persisted declaration (jsonb round-trip). */
export function isResolvedConnectorAccessDeclaration(
  value: unknown,
): value is ResolvedConnectorAccessDeclaration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    v.formatVersion === 1 &&
    (v.mode === "default" || v.mode === "only") &&
    typeof v.scope === "string" &&
    (CONNECTOR_ACCESS_DECLARATION_SCOPES as readonly string[]).includes(v.scope) &&
    (v.source === "declared" || v.source === "absent") &&
    Object.keys(v).length === 4
  );
}

/**
 * 2-tier projection of a resolved declaration onto the connector-card
 * visibility axis (cinatra#955): the `admin` scope stays admin-only; every
 * non-admin scope projects to the `workspace` tier. STRUCTURAL MIRROR of the
 * SDK's `connectorAccessVisibilityTier` (this package deliberately imports no
 * SDK module at runtime) — the access-declaration-mirror test pins the two in
 * agreement across the full scope vocabulary.
 */
export function connectorAccessDeclarationTier(
  declaration: Pick<ResolvedConnectorAccessDeclaration, "scope">,
): "admin" | "workspace" {
  return declaration.scope === "admin" ? "admin" : "workspace";
}

export type InstalledExtension = {
  id: string;
  packageName: string;
  ownerLevel: ExtensionOwnerLevel;
  ownerId: string | null;
  organizationId: string | null;
  kind: ExtensionKind;
  status: ExtensionLifecycleStatus;
  source: ExtensionSource;
  /**
   * The installed package VERSION — part of the storage identity (cinatra#1040
   * S1: multiple versions of one package can be installed side by side, each its
   * own canonical row). Derived from the source's own version for verdaccio /
   * bundled sources; github / local sources carry no version, so the store and
   * the core__0022 backfill floor them to `0.0.0`. ALWAYS present on a row read
   * from the DB (the column is NOT NULL) — `rowToCanonical` always sets it;
   * OPTIONAL on the type only as an additive-compat measure (the same shape as
   * `accessDeclaration` below) so existing install-row fixtures/writers need not
   * thread it, and the store re-derives it at insert.
   */
  version?: string;
  /**
   * Whether THIS version is the DEFAULT that owns the package's unversioned
   * global name (cinatra#1040 S1). Exactly one default per (org, owner, package)
   * — DB-enforced by a partial-unique index. ALWAYS present on a DB read (the
   * column is NOT NULL DEFAULT true); OPTIONAL on the type only for additive
   * compat (as above). The two DB-query projection seams (connectors-registry,
   * agent-mount-projection) read only the default row for a global name — they
   * drop a row ONLY when it is EXPLICITLY non-default (`isDefault === false`), so
   * a legacy/single-version row (true, or an unset fixture) is always kept.
   * Selection of a non-default version is a later slice.
   */
  isDefault?: boolean;
  requiredInProd: boolean;
  /**
   * The DECLARED manifest dependency edges. Since cinatra#1040 S2 this is a
   * PROJECTION of `dependencyEdges` (the `extension_dependency_edge` rows,
   * declared order) — the row jsonb column was dropped by core__0025. Kept
   * REQUIRED so every existing consumer (planner dual-read, closure engine,
   * dependents UX, cross-kind graph) is unchanged.
   */
  dependencies: ExtensionDependency[];
  /**
   * The PERSISTED dependency edges incl. write-time resolution
   * (cinatra#1040 S2). ALWAYS present on a DB read (the store hydrates every
   * row); OPTIONAL on the type only as an additive-compat measure (same shape
   * as `version` above) so hand-built fixtures/engine unit inputs need not
   * thread it — the closure engine falls back to `dependencies` + the scoped
   * name-lookup when absent.
   */
  dependencyEdges?: ResolvedDependencyEdge[];
  manifestHash: string | null;
  /**
   * The RESOLVED connector access declaration (cinatra#951), cached by the
   * host config reader at registration/materialize. `null` for non-connector
   * kinds and for rows persisted before the reader ran. OPTIONAL on the type
   * (strictly additive field).
   */
  accessDeclaration?: ResolvedConnectorAccessDeclaration | null;
  createdAt: Date;
  updatedAt: Date;
};

export const PLATFORM_OWNER_SENTINEL = "__platform__" as const;

export function isExtensionKind(value: unknown): value is ExtensionKind {
  return typeof value === "string" && (EXTENSION_KINDS as readonly string[]).includes(value);
}

export function isExtensionLifecycleStatus(value: unknown): value is ExtensionLifecycleStatus {
  return (
    typeof value === "string" && (EXTENSION_LIFECYCLE_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Structural validation of a discriminated source union. Unlike a bare
 * `type` check, this validates that every required
 * provenance field is present + a non-empty string for the declared
 * source type. Used at install AND load so provenance is verified, not
 * asserted.
 */
export function isExtensionSource(value: unknown): value is ExtensionSource {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const str = (x: unknown): x is string =>
    typeof x === "string" && x.length > 0 && !PROVENANCE_PLACEHOLDERS.has(x);
  switch (v.type) {
    case "verdaccio":
      return (
        str(v.registryUrl) &&
        str(v.packageName) &&
        str(v.version) &&
        str(v.integrity) &&
        // `activeDigest` is OPTIONAL (additive, cinatra#792) — but when present
        // it must be a real value, never an empty/placeholder string.
        (v.activeDigest === undefined || str(v.activeDigest))
      );
    case "github":
      return str(v.repo) && str(v.ref) && str(v.resolvedSha);
    case "local":
      return str(v.path) && str(v.resolvedCommitOrTreeHash);
    case "bundled":
      // `digest` is OPTIONAL (dev boots and pre-#795 rows carry none) — but
      // when present it must satisfy the store digest-segment grammar: #795
      // made it an IDENTITY field (the bundled half of `<kind>/<slug>/<digest>`
      // parity), so a placeholder or truncated value must never validate.
      return (
        str(v.packageName) &&
        str(v.version) &&
        (v.digest === undefined || (typeof v.digest === "string" && BUNDLED_SOURCE_DIGEST_RE.test(v.digest)))
      );
    default:
      return false;
  }
}

/**
 * Returns the list of missing/invalid provenance fields for a source, or
 * an empty array if the source is fully valid. Callers surface these in
 * structured install/load errors.
 */
// Placeholder sentinels emitted by the add-from-chat proposal builder before
// real resolution. A source carrying ANY of these must NOT pass validation —
// the install path resolves them first.
const PROVENANCE_PLACEHOLDERS = new Set(["pending-resolution", "latest", "HEAD"]);

export function validateExtensionSource(value: unknown): string[] {
  if (!value || typeof value !== "object") return ["source is not an object"];
  const v = value as Record<string, unknown>;
  const str = (x: unknown): x is string =>
    typeof x === "string" && x.length > 0 && !PROVENANCE_PLACEHOLDERS.has(x);
  const errors: string[] = [];
  switch (v.type) {
    case "verdaccio":
      if (!str(v.registryUrl)) errors.push("verdaccio.registryUrl");
      if (!str(v.packageName)) errors.push("verdaccio.packageName");
      if (!str(v.version)) errors.push("verdaccio.version");
      if (!str(v.integrity)) errors.push("verdaccio.integrity");
      // `attestedSha256` is OPTIONAL (additive attestation) — do NOT require it
      // here or legacy rows + the sha256-less registry path would fail to validate.
      // `activeDigest` is OPTIONAL (additive, cinatra#792) — required to be a
      // real value only when present.
      if (v.activeDigest !== undefined && !str(v.activeDigest)) errors.push("verdaccio.activeDigest");
      break;
    case "github":
      if (!str(v.repo)) errors.push("github.repo");
      if (!str(v.ref)) errors.push("github.ref");
      if (!str(v.resolvedSha)) errors.push("github.resolvedSha");
      break;
    case "local":
      if (!str(v.path)) errors.push("local.path");
      if (!str(v.resolvedCommitOrTreeHash)) errors.push("local.resolvedCommitOrTreeHash");
      break;
    case "bundled":
      if (!str(v.packageName)) errors.push("bundled.packageName");
      if (!str(v.version)) errors.push("bundled.version");
      // `digest` is OPTIONAL; when present it must be a well-formed identity
      // digest (#795) — see BUNDLED_SOURCE_DIGEST_RE.
      if (
        v.digest !== undefined &&
        !(typeof v.digest === "string" && BUNDLED_SOURCE_DIGEST_RE.test(v.digest))
      ) {
        errors.push("bundled.digest");
      }
      break;
    default:
      errors.push(`unknown source type '${String(v.type)}'`);
  }
  return errors;
}

export type LifecycleTransitionOp =
  | "install"
  | "archive"
  | "activate"
  | "uninstall"
  | "force_delete"
  | "purge"
  | "registry_remove"
  | "update"
  | "lock"
  | "unlock"
  | "source_switch";

export const DESTRUCTIVE_OPS: ReadonlySet<LifecycleTransitionOp> = new Set([
  "archive",
  "uninstall",
  "force_delete",
  "purge",
  "registry_remove",
]);

export const LOCKED_REJECTED_OPS: ReadonlySet<LifecycleTransitionOp> = new Set([
  "archive",
  "uninstall",
  "force_delete",
  "purge",
  "registry_remove",
]);
