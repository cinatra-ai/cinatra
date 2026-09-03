// Canonical extension manifest types.
//
import type { ExtensionKind as DependencyEdgeKind } from "@cinatra-ai/sdk-extensions/dependencies";
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

/**
 * The CONTENT DIGEST a non-registry source records over the tree it actually
 * delivered (cinatra#3204 D2) — "sha256-" plus 64 lowercase hex, computed by
 * `computeExtensionTreeDigest` over the canonical tree encoding defined in
 * ./extension-package-digest.ts.
 *
 * DISTINCT FROM A REVISION IDENTIFIER, deliberately. `resolvedSha` and
 * `resolvedCommitOrTreeHash` name a point in a history; they say nothing about
 * the bytes that arrived, and a repository can serve a tree no commit of its
 * history contains. This field is the statement about those bytes, and it is
 * what lets a SUPPLIED package be driven through the same install pipeline a
 * registry install uses (which verifies delivered bytes against a digest the
 * caller states in advance).
 *
 * OPTIONAL: rows written before #3204 carry none, and an absent digest keeps
 * its established meaning — no content attestation, so no supplied-source
 * install can be driven from that row. Additive JSONB field, no SQL migration.
 * Never a substitute for the sha512 SRI on a verdaccio source, and never
 * presented as registry attestation (see `describeSourceProvenance`).
 */
/**
 * The grammar every recorded `contentDigest` must satisfy — the canonical
 * extension TREE digest of ./extension-package-digest.ts. Declared here (not
 * imported) so canonical-types stays free of value imports; the digest module
 * re-exports this constant, so there is exactly one regular expression.
 */
export const EXTENSION_CONTENT_DIGEST_RE = /^sha256-[0-9a-f]{64}$/;

export type ExtensionSourceGithub = {
  type: "github";
  repo: string;
  ref: string;
  resolvedSha: string;
  path?: string;
  contentDigest?: string;
};

export type ExtensionSourceLocal = {
  type: "local";
  path: string;
  resolvedCommitOrTreeHash: string;
  contentDigest?: string;
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

/**
 * The EDGE-ROLE vocabulary (cinatra#2090 S3, epic #2086).
 *
 * The separation rule turns a co-located skill bundle into a declared
 * dependency edge. A consumer may declare SEVERAL skill edges (an artifact
 * extension declares both the classifier's rules and the chat's authoring
 * methodology), so the edge has to say WHICH surface it feeds — otherwise the
 * host would have to guess from the provider's name, which is exactly the
 * naming-convention trust the extraction exists to kill.
 *
 *   - `matcher`   — the artifact classifier may honour this skill. It is the
 *                   TRUST ANCHOR that replaces same-package ownership: a
 *                   matcher skill is honoured because it is the resolved
 *                   target of this edge, not because it sits in the
 *                   consumer's own package.
 *   - `authoring` — the chat-driven authoring path follows this skill.
 *
 * A skill edge with NO role is the plain injectable delivery wave 2 landed
 * (`@cinatra-ai/web-research-agent` → `@cinatra-ai/web-research-skill`): the
 * whole bundle is mounted into the consumer's own run. Roles are additive and
 * OPTIONAL — every edge persisted before this vocabulary existed stays valid.
 */
export const DEPENDENCY_SKILL_ROLES = ["matcher", "authoring"] as const;
export type DependencySkillRole = (typeof DEPENDENCY_SKILL_ROLES)[number];

export type VersionConstraint =
  | { kind: "semver-range"; range: string }
  | { kind: "exact"; version: string }
  | { kind: "git-ref"; ref: string };

export type ExtensionDependency = {
  packageName: string;
  // The depended-on extension's kind, so `dependencies` carries cross-kind edges
  // without a separate lookup. Optional for backward compatibility with rows
  // persisted before this field existed. The dependency-edge kind is owned by
  // the SDK draft contract (`@cinatra-ai/sdk-extensions` `dependencies.ts`) so
  // the two dependency shapes stay assignable across the ABI boundary.
  kind?: DependencyEdgeKind;
  /**
   * Which host surface this edge feeds (cinatra#2090). Only meaningful on a
   * `kind:"skill"` edge; absent = the plain injectable delivery. See
   * {@link DEPENDENCY_SKILL_ROLES}.
   */
  role?: DependencySkillRole;
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
  /**
   * The widget-auth token keys this package's SRI-verified manifest DECLARES
   * (`cinatra.widgetStream[.auth].tokenConfigKey`), recorded on the canonical row
   * at the install pipeline's ownership-grant seam (owner ruling 2026-07-23 — the
   * widget-auth delivery fix, path B). This is the TAMPER-PROOF declaration source
   * the marketplace-install-PROVENANCE owner arm (arm (c)) reads for its P5 factor
   * — the writable `/data/extensions` store is NOT trusted for the declaration.
   * `null` for rows persisted before the recorder ran (LEGACY) — arm (c) fails
   * closed on a null column (never guesses / never re-reads the store); `[]` for a
   * package that declares no widget-auth key (an explicit, non-legacy empty
   * declaration, so a re-install that DROPS a key clears a stale non-empty value).
   * OPTIONAL on the type (strictly additive field).
   */
  widgetAuthTokenKeys?: string[] | null;
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
      // `contentDigest` is OPTIONAL (pre-#3204 rows carry none) — but when
      // present it must satisfy the D2 grammar. A malformed digest is worse
      // than an absent one: it would be read as an attestation of bytes it
      // does not describe.
      return str(v.repo) && str(v.ref) && str(v.resolvedSha) && contentDigestOk(v.contentDigest);
    case "local":
      return (
        str(v.path) &&
        str(v.resolvedCommitOrTreeHash) &&
        contentDigestOk(v.contentDigest)
      );
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

/**
 * A non-registry source's OPTIONAL `contentDigest` (cinatra#3204 D2): absent is
 * fine (every row written before #3204), present-and-malformed is not.
 */
function contentDigestOk(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "string" && EXTENSION_CONTENT_DIGEST_RE.test(value))
  );
}

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
      // OPTIONAL, but well-formed when present (cinatra#3204 D2).
      if (!contentDigestOk(v.contentDigest)) errors.push("github.contentDigest");
      break;
    case "local":
      if (!str(v.path)) errors.push("local.path");
      if (!str(v.resolvedCommitOrTreeHash)) errors.push("local.resolvedCommitOrTreeHash");
      if (!contentDigestOk(v.contentDigest)) errors.push("local.contentDigest");
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

/**
 * The canonical row-identity tuple an install anchors to —
 * `(organizationId, ownerLevel, ownerId)`. Named `rowOwnership` upstream
 * (NEVER "scope"): this is WHO OWNS the installed row, not who may USE it
 * (that is the audience policy above).
 */
export type InstallRowOwnership = {
  ownerLevel: ExtensionOwnerLevel;
  ownerId: string | null;
  organizationId: string | null;
};

// ---------------------------------------------------------------------------
// The dispatcher-side half of the target→ownership contract (cinatra#2694 /
// S2 #2696): which canonical row identity an install WRITES to. S1 defined the
// CONTRACT in ./install-access-target (accessTargetToRowOwnership /
// resolveInstallAccessTargetContract)
// but nothing persisted it: the dispatcher derived the row anchor solely from
// the actor's active organization, so a "Workspace: All" install still wrote an
// org-anchored row. The helpers below are the seam that closes that gap: the
// install action resolves the tuple, the dependency batch threads it per
// member, and the dispatcher resolves it HERE into the anchor the canonical row
// is created at. They live HERE, next to the canonical row identity and the
// `__platform__` sentinel they normalize to, so the dispatcher's reachable
// graph does not grow by a module (the target contract carries zod).
// PURE (no IO, no server-only).
// ---------------------------------------------------------------------------

/**
 * The ACTOR-DERIVED default anchor — the tuple the dispatcher has always
 * written: an install with an active organization is `organization`-owned; a
 * null-org install is `platform`-owned with a null ownerId the canonical store
 * platformizes on write. Byte-identical to `defaultRowOwnership(orgId)` in
 * src/lib/extension-dependency-plan.ts and to the organization/team/project
 * branch of `accessTargetToRowOwnership` (S1) — one rule, three call sites.
 */
export function actorDerivedRowAnchor(actorOrgId: string | null): InstallRowOwnership {
  const orgId = actorOrgId ?? null;
  return {
    ownerLevel: orgId ? "organization" : "platform",
    ownerId: orgId ?? null,
    organizationId: orgId ?? null,
  };
}

/**
 * Resolve the canonical row anchor an install writes at.
 *
 *  - `planned` ABSENT (every caller that does not thread the contract — the
 *    direct dispatcher paths, restore/reinstall, the MCP surface) → the
 *    actor-derived default. This is the whole pre-#2696 behavior, unchanged.
 *  - `planned` PRESENT → the planned tuple, verbatim. For the two workspace
 *    install targets that is the workspace anchor (`owner_level='workspace'`,
 *    `organization_id NULL`, `owner_id='__platform__'`), which is precisely what
 *    gives the row app-wide reach: the cross-org guard only fences rows that
 *    HAVE an owning org.
 *
 * The ownerId is normalized for the org-NULL tiers so the row satisfies the
 * platform-invariant CHECK (`installed_extension_platform_invariant_chk`) that
 * NAMES the `__platform__` sentinel, rather than depending on the canonical
 * store's downstream `platformizeOwnerId` normalization.
 */
export function resolveInstallRowAnchor(
  actorOrgId: string | null,
  planned?: InstallRowOwnership | null,
): InstallRowOwnership {
  if (!planned) return actorDerivedRowAnchor(actorOrgId);
  const organizationId = planned.organizationId ?? null;
  const ownerId =
    organizationId === null && planned.ownerLevel !== "user" && planned.ownerLevel !== "team"
      ? (planned.ownerId ?? PLATFORM_OWNER_SENTINEL)
      : (planned.ownerId ?? null);
  return { ownerLevel: planned.ownerLevel, ownerId, organizationId };
}

/**
 * Is this the app-wide WORKSPACE anchor (org-NULL)? The discriminator the write
 * path uses where a workspace-anchored row needs different handling from an
 * org-anchored one — notably the install action's rollback, which cannot route
 * an org-NULL row through the org-pinned lifecycle resolver (that is S4 #2698)
 * and takes the row-scoped inverse instead.
 */
export function isWorkspaceRowAnchor(anchor: InstallRowOwnership): boolean {
  return anchor.ownerLevel === "workspace" && (anchor.organizationId ?? null) === null;
}

/**
 * The WORKSPACE ANCHOR tuple — the app-wide row identity the two workspace
 * targets resolve to. `organizationId` is NULL by construction, which is
 * exactly what makes the row reach every organization: the cross-org guard in
 * enforceExtensionAccess only fences rows that HAVE an owning org, so an
 * org-NULL anchor is evaluated on its audience tier alone (the same mechanism
 * the system's bundled workspace-tier extensions already ride).
 *
 * The DB admits this shape today — no schema change: the platform-invariant
 * CHECK `installed_extension_platform_invariant_chk` explicitly allows
 * `owner_level='workspace' AND organization_id IS NULL AND
 * owner_id='__platform__'` (src/lib/drizzle-store.ts), and the org-NULL
 * partial identity / one-default indexes
 * (`installed_extension_identity_platform_v_idx`,
 * `installed_extension_one_default_platform_idx`, both `WHERE organization_id
 * IS NULL`, keyed on `owner_level`) key workspace rows apart from
 * platform-bundled ones (src/lib/extension-grant-schema.ts).
 *
 * `ownerId` is the `__platform__` sentinel EXPLICITLY rather than null: the
 * canonical store would normalize null at this tier anyway
 * (`platformizeOwnerId`), but the CHECK constraint names the sentinel, so the
 * contract states it rather than depending on a downstream normalization.
 */
export const WORKSPACE_ANCHOR_ROW_OWNERSHIP: InstallRowOwnership = Object.freeze({
  ownerLevel: "workspace",
  ownerId: PLATFORM_OWNER_SENTINEL,
  organizationId: null,
});

// ---------------------------------------------------------------------------
// The WORKSPACE-ANCHORED ROW predicate + identity (cinatra#2694 / S3 #2697).
//
// S1 (#2695) declared the target→ownership contract and S2 (#2696) made the
// write path persist it, so a "Workspace: All" / "Workspace: Admins only"
// install now lands a canonical row at the WORKSPACE ANCHOR:
//
//     owner_level = 'workspace'   organization_id IS NULL   owner_id = '__platform__'
//
// S3 is the READ half — the connector substrate. Four seams have to recognize
// that exact shape (the install chokepoint, the two canonical connector-access
// resolvers, and the runtime card record's trust-anchor + discovery path), so
// the recognition rule lives HERE (with the canonical row identity, so the
// locked route graphs do not grow by a module) instead of being re-spelled:
// a re-spelling that drifted would either fence the workspace row out of one
// surface or admit a shape the DB's platform-invariant CHECK refuses.
//
// PURE (no IO, no server-only) so every seam — including the sync connector
// resolver and the pure row picks — can import it.
// ---------------------------------------------------------------------------

/** The row/tuple fields the anchor predicate reads (DI-friendly, kind-agnostic). */
export type WorkspaceAnchorRowView = {
  ownerLevel: string;
  ownerId: string | null;
  organizationId: string | null;
};

/**
 * Is this row/tuple the PRODUCT-INSTALLED workspace anchor — the exact S1
 * contract tuple ({@link WORKSPACE_ANCHOR_ROW_OWNERSHIP})?
 *
 * `ownerId` is accepted as `null` OR the `__platform__` sentinel because the
 * canonical store platformizes a null owner at this tier on write
 * (`platformizeOwnerId`), so both spellings denote the same persisted row. Any
 * OTHER ownerId is refused: the DB's platform-invariant CHECK names the
 * sentinel for an org-NULL row, so a workspace row "owned" by something else is
 * not a shape that can exist — never a shape a read seam should honor.
 *
 * DELIBERATELY NARROW: `owner_level='platform'` is NOT this anchor. Platform
 * rows are the bundled/system tier (the boot seeder's static-bundle anchors and
 * tombstones), whose path S3 leaves exactly as it is.
 */
export function isWorkspaceAnchoredRow(row: WorkspaceAnchorRowView): boolean {
  return (
    row.ownerLevel === WORKSPACE_ANCHOR_ROW_OWNERSHIP.ownerLevel &&
    (row.organizationId ?? null) === null &&
    (row.ownerId === null || row.ownerId === PLATFORM_OWNER_SENTINEL)
  );
}

/**
 * The canonical IDENTITY a workspace-anchored row for `packageName` reads back
 * at — `(organization_id NULL, owner_level 'workspace', owner_id '__platform__',
 * package_name)`. The WORKSPACE-FALLBACK arm of the org-first resolution passes
 * this to `readInstalledExtensionByIdentity`, so the fallback key can never
 * drift from the anchor the write path persists.
 */
export function workspaceAnchorIdentity(packageName: string): {
  organizationId: null;
  ownerLevel: "workspace";
  ownerId: string;
  packageName: string;
} {
  return {
    organizationId: null,
    ownerLevel: "workspace",
    ownerId: PLATFORM_OWNER_SENTINEL,
    packageName,
  };
}

// ---------------------------------------------------------------------------
// The §V RE-ANCHOR rules (cinatra#2694 / S5 #2802) — the PURE half.
//
// Owner ruling 2026-08-16 (entry 350): the settings page's access picker is the
// widening/narrowing surface and must move the row ANCHOR, not just the audience
// label. The decision itself is arithmetic on the canonical row identity, so it
// lives HERE — beside the anchor tuples and the sentinel it normalizes to, and
// beside the identity/default index shapes it mirrors — rather than in a new
// module on an already-locked route graph.
//
// PURE (no IO, no server-only): the store re-runs these predicates INSIDE its
// transaction (after the row locks) and the server action runs them before it,
// so a refusal is decided by exactly one rule in both places.
// ---------------------------------------------------------------------------

/**
 * Does this audience selection ask for the app-wide WORKSPACE anchor?
 *
 * The two workspace audiences are the widening ones: `workspace` reaches every
 * member of the deployment and `admin` reaches the owner-aware admin tier across
 * it. Either token means the row must sit at the org-NULL workspace anchor,
 * because an organization-anchored row is fenced to its organization by the
 * cross-org guard no matter what its policy says — the exact defect S5 closes.
 */
export function policyWidensToWorkspaceAnchor(tokens: readonly string[]): boolean {
  return tokens.some((t) => t === "workspace" || t === "admin");
}

/** The ORGANIZATION anchor tuple for `orgId` — the narrowing destination. */
export function organizationRowAnchor(orgId: string): InstallRowOwnership {
  return { ownerLevel: "organization", ownerId: orgId, organizationId: orgId };
}

/**
 * Normalized owner id for anchor comparison: at the org-NULL tiers the canonical
 * store platformizes a null owner to the sentinel, so `null` and `__platform__`
 * denote the SAME persisted row and must compare equal.
 */
function normalizedAnchorOwnerId(
  ownerLevel: string,
  ownerId: string | null,
  organizationId: string | null,
): string | null {
  if ((organizationId ?? null) !== null) return ownerId;
  if (ownerLevel === "user" || ownerLevel === "team") return ownerId;
  return ownerId ?? PLATFORM_OWNER_SENTINEL;
}

/** Do these two anchors denote the same canonical row identity tuple? */
export function sameRowAnchor(
  a: { ownerLevel: string; ownerId: string | null; organizationId: string | null },
  b: { ownerLevel: string; ownerId: string | null; organizationId: string | null },
): boolean {
  return (
    a.ownerLevel === b.ownerLevel &&
    (a.organizationId ?? null) === (b.organizationId ?? null) &&
    normalizedAnchorOwnerId(a.ownerLevel, a.ownerId, a.organizationId ?? null) ===
      normalizedAnchorOwnerId(b.ownerLevel, b.ownerId, b.organizationId ?? null)
  );
}

/** The row fields the conflict rule reads (DI-friendly; kind-agnostic). */
export type ReanchorRowView = {
  id: string;
  packageName: string;
  ownerLevel: string;
  ownerId: string | null;
  organizationId: string | null;
  version?: string;
  isDefault?: boolean;
};

/**
 * A destination slot that is already occupied.
 *
 *  - `identity` — the destination IDENTITY tuple `(organization_id, owner_level,
 *    owner_id, package_name, version)` is taken
 *    (`installed_extension_identity_org_v_idx` /
 *    `installed_extension_identity_platform_v_idx`).
 *  - `default` — the moved row is the DEFAULT version and the destination's
 *    one-default slot `(organization_id, owner_level, owner_id, package_name)`
 *    is taken (`installed_extension_one_default_org_idx` /
 *    `installed_extension_one_default_platform_idx`).
 */
export type ReanchorConflict = {
  rowId: string;
  reason: "identity" | "default";
};

/**
 * Is the destination identity/default slot FREE for this row?
 *
 * Mirrors the four partial unique indexes EXACTLY, including the fact that NONE
 * of them filters on lifecycle status: an ARCHIVED row occupies its identity and
 * (when it is the default) its default slot just as a live one does. Per the
 * owner ruling the answer to an occupied slot is a refusal — never a
 * restore-instead, a relocation or a delete.
 *
 * The org-NULL indexes key on `owner_level`, which is why a bundled `platform`
 * row and a product-installed `workspace` row of the same package coexist: a
 * re-anchor to the workspace tier does NOT collide with the bundled platform
 * anchor beside it.
 *
 * `rows` is every canonical row of the package (the caller reads them under the
 * row locks); the moved row itself is skipped by id.
 */
export function findReanchorConflict(
  rows: readonly ReanchorRowView[],
  moved: ReanchorRowView,
  destination: { ownerLevel: string; ownerId: string | null; organizationId: string | null },
): ReanchorConflict | null {
  const destOrg = destination.organizationId ?? null;
  const destOwnerId = normalizedAnchorOwnerId(
    destination.ownerLevel,
    destination.ownerId,
    destOrg,
  );
  const movedVersion = moved.version ?? null;
  const movedIsDefault = moved.isDefault !== false;

  const sitsAtDestination = (row: ReanchorRowView): boolean =>
    (row.organizationId ?? null) === destOrg &&
    row.ownerLevel === destination.ownerLevel &&
    normalizedAnchorOwnerId(row.ownerLevel, row.ownerId, row.organizationId ?? null) ===
      destOwnerId;

  for (const row of rows) {
    if (row.id === moved.id) continue;
    if (row.packageName !== moved.packageName) continue;
    if (!sitsAtDestination(row)) continue;
    // IDENTITY slot — same version at the destination tuple.
    if ((row.version ?? null) === movedVersion) {
      return { rowId: row.id, reason: "identity" };
    }
    // ONE-DEFAULT slot — a different version, but both are the default.
    if (movedIsDefault && row.isDefault !== false) {
      return { rowId: row.id, reason: "default" };
    }
  }
  return null;
}

/**
 * Is a proposed audience token within an INSTALLED CONNECTOR's declared
 * `access.scope.only` ceiling?
 *
 * The installed-row twin of the per-connection ceiling check. It is written
 * separately ON PURPOSE (owner direction, S5 change 5): the connection
 * validator reasons about a connection identity — its owner user, its org
 * anchor, its person-grants — none of which applies to an install row, whose
 * anchor is exactly what this operation MOVES. The organization the tokens are
 * measured against is therefore the DESTINATION organization of the re-anchor,
 * not the row's current one.
 *
 * `admin` is WITHIN the `workspace` ceiling: "Workspace: Admins only" is a
 * strictly narrower audience than "Workspace: All", so a connector that caps
 * itself at workspace reach must still admit the admin-only selection.
 */
export function installedAudienceWithinDeclaredCeiling(
  token: string,
  scope: ConnectorAccessDeclarationScope,
  destinationOrganizationId: string | null,
): boolean {
  if (token === "owner") return true; // owner is within every ceiling
  switch (scope) {
    case "user":
      return false;
    case "project":
      return token.startsWith("project:");
    case "team":
      return token.startsWith("team:");
    case "organization":
      if (token === "org") return true;
      return (
        token.startsWith("org:") &&
        destinationOrganizationId != null &&
        token.slice("org:".length) === destinationOrganizationId
      );
    case "workspace":
      return (
        token === "workspace" ||
        token === "admin" ||
        token === "org" ||
        token.startsWith("org:") ||
        token.startsWith("team:") ||
        token.startsWith("project:")
      );
    case "admin":
      return token === "admin";
    default:
      return false; // unknown scope vocabulary — fail closed
  }
}
