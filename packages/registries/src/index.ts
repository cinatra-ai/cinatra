// Public barrel for @cinatra-ai/registries.
// Uses explicit named re-exports per AGENTS.md (never star-re-exports).
// Intentionally no Next.js server-guard — the package must load in plain
// Node contexts (CLI, vitest, scripts).

export { resolveDependencyTree } from "./dep-resolver/resolver";

// Vendor-scope helpers for the install-time dependency-confusion gate:
// the allowlist is keyed on the ROOT package's own vendor scope + the
// first-party base scope, never on the installing instance's namespace.
export {
  FIRST_PARTY_PACKAGE_SCOPE,
  vendorScopeOfPackage,
  dependencyScopePrefixesFor,
} from "./scope";

export {
  PluginDependencyCycleError,
  PluginDependencyConflictError,
  PluginDependencyResolutionError,
  PluginDependencyLimitError,
  PluginDependencyScopeError,
} from "./dep-resolver/errors";

export { installResolvedTree } from "./install/install-tree";

export { installPackageWithDependencies } from "./install/install-with-deps";

export {
  readLockfile,
  writeLockfile,
  lockfileFromTree,
  stableStringifyLockfile,
  LOCKFILE_VERSION,
  lockfileShapeSchema,
} from "./lockfile/lockfile";

export { comparePluginVersions } from "./version-compare";
export type { VersionComparisonResult } from "./version-compare";

export {
  listAgentPackages,
  getAgentPackage,
  getPublishedExtensionKind,
  extractAgentPackage,
  cleanupExtractedAgentPackage,
  // Fail-fast DI guard helper. Re-exported so packages/agents
  // can use the same helper without duplicating the body.
  ensureConfig,
} from "./verdaccio/client";
export type { ExtractedAgentPackage } from "./verdaccio/client";

// Kind-agnostic extractor for skill/connector/artifact installs.
export {
  extractExtensionPackage,
  cleanupExtractedPackage,
  // Generic kind-agnostic README extractor.
  readReadmeFromExtractedPackage,
  getPackageReadme,
  DEFAULT_README_SIZE_CAP_BYTES,
} from "./verdaccio/client";
export type { ExtractedReadme } from "./verdaccio/client";
export type { ExtractedExtensionPackage } from "./verdaccio/client";

// Exact tarball-bytes fetch for the runtime installer's
// SRI-verified package-store materializer.
export { fetchExtensionTarballBytes } from "./verdaccio/client";

// Resolve the published tarball's sha512 dist
// integrity (+ optional additive sha256 attestation) for the install pipeline.
export { resolveExtensionDistIntegrity } from "./verdaccio/client";

// Kind-agnostic packument summary for lifecycle dispatch.
export { getPublishedExtensionSummary } from "./verdaccio/client";
export type { PublishedExtensionSummary } from "./verdaccio/client";

// Kind-agnostic + multi-scope catalog lister so vendored bundles
// surface via extensions_search.
export { listExtensionPackages } from "./verdaccio/client";

export {
  loadVerdaccioConfig,
  requireVerdaccioConfig,
  requireVerdaccioToken,
  // Async loader + typed errors.
  loadVerdaccioConfigAsync,
  InstanceNamespaceNotConfiguredError,
  VerdaccioUnexpectedResponseError,
} from "./verdaccio/config";

// npm user provisioning helper + typed errors.
export {
  createNpmUser,
  VerdaccioUserAlreadyRegisteredError,
  VerdaccioRegistrationDisabledError,
} from "./verdaccio/user-provisioning";
export type { CreateNpmUserOptions } from "./verdaccio/user-provisioning";

export type {
  PluginType,
  PluginTypeConfig,
  ResolvedNode,
  DependencyTree,
  Packument,
  PackumentVersionEntry,
  FetchPackument,
  InstallSideEffect,
  VerdaccioConfig,
  LockfileShape,
  AgentPackageOrigin,
  AgentPackageSummary,
  AgentPackageDetail,
  // Instance identity snapshot type.
  InstanceIdentitySnapshot,
} from "./types";
