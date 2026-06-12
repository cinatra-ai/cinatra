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

export const EXTENSION_SOURCE_TYPES = ["verdaccio", "github", "local"] as const;
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

export type ExtensionSource = ExtensionSourceVerdaccio | ExtensionSourceGithub | ExtensionSourceLocal;

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

export type InstalledExtension = {
  id: string;
  packageName: string;
  ownerLevel: ExtensionOwnerLevel;
  ownerId: string | null;
  organizationId: string | null;
  kind: ExtensionKind;
  status: ExtensionLifecycleStatus;
  source: ExtensionSource;
  requiredInProd: boolean;
  dependencies: ExtensionDependency[];
  manifestHash: string | null;
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
      return str(v.registryUrl) && str(v.packageName) && str(v.version) && str(v.integrity);
    case "github":
      return str(v.repo) && str(v.ref) && str(v.resolvedSha);
    case "local":
      return str(v.path) && str(v.resolvedCommitOrTreeHash);
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
