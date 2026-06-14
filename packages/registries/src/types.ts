// Consolidated type surface for @cinatra-ai/registries.
// NOTE: this file intentionally has no server-only guard — the package must load in plain Node contexts.

export type PluginType = "agent" | "skill";

export type PluginTypeConfig = {
  type: PluginType;
  /**
   * Allowed scope prefixes for dependency-confusion mitigation, e.g.
   * ["@acme/", "@cinatra-ai/"]. Every node in the resolved tree (root AND
   * transitive deps) must be under one of these prefixes. Keyed on the ROOT
   * package's own vendor scope + the first-party base scope — never on the
   * installing instance's namespace (see dependencyScopePrefixesFor).
   */
  scopePrefixes: readonly string[];
  /** Packument key holding the dependency map. E.g. "agentDependencies" */
  packumentDepKey: string;
  /**
   * Optional override for HOW the resolver reads a node's transitive dependency
   * map from its packument version entry. When provided, the resolver uses this
   * INSTEAD of `cinatra[packumentDepKey]` at every read site (initial enqueue,
   * newer-pick re-enqueue, and the self-describing second pass), so a plugin
   * type can resolve from the canonical `cinatra.dependencies` vocabulary while
   * the legacy `packumentDepKey` path stays the default for callers that do not
   * supply it. The returned map is the SAME `{ packageName: semverRange }` shape
   * the resolver already consumes — the override is responsible for any
   * vocabulary projection (e.g. canonical edge → range) and for fail-loud
   * validation. Receives the full version entry so the override can surface the
   * package name in its diagnostics.
   */
  readPackumentDeps?: (entry: PackumentVersionEntry) => Record<string, string>;
};

export type ResolvedNode = {
  packageName: string;
  resolvedVersion: string;
  tarballUrl: string;
  integrity: string;
  requestedRange: string;
  dependencies: Record<string, string>;
};

export type DependencyTree = {
  root: ResolvedNode;
  all: Map<string, ResolvedNode>;
};

export type PackumentVersionEntry = {
  name: string;
  version: string;
  dist: { tarball: string; integrity: string };
  /**
   * cinatra.<packumentDepKey> is the type-parameterised dep map
   * (agentDependencies for type:"agent"). The resolver reads the
   * exact key via `typeConfig.packumentDepKey`.
   */
  cinatra?: Record<string, Record<string, string> | unknown>;
};

export type Packument = {
  name: string;
  versions: Record<string, PackumentVersionEntry>;
  "dist-tags"?: Record<string, string>;
};

export type FetchPackument = (name: string) => Promise<Packument>;

export type InstallSideEffect<T = void> = (node: ResolvedNode) => Promise<T>;

// ---------------------------------------------------------------------------
// Verdaccio config — lifted (simplified) from verdaccio/config.ts
// ---------------------------------------------------------------------------

export type VerdaccioConfig = {
  registryUrl: string;
  /** e.g. "@cinatra" */
  packageScope: string;
  token: string | null;
  uiUrl: string | null;
};

// ---------------------------------------------------------------------------
// Instance identity snapshot consumed by loadVerdaccioConfigAsync. The host-app
// `instance_identity` row is mapped to this shape before being passed in (the
// registries package does not import from `@/lib/*`).
// ---------------------------------------------------------------------------

export type InstanceIdentitySnapshot = {
  /** Host-app instance namespace. */
  instanceNamespace: string;
  tokenCiphertext: string;
  tokenIv: string;
  registryUrl?: string;
};

// ---------------------------------------------------------------------------
// Lockfile — Zod schema lives in lockfile/lockfile.ts; this is the inferred type
// ---------------------------------------------------------------------------

export type LockfileShape = {
  lockfileVersion: 1;
  root: { packageName: string; packageVersion: string };
  packages: Record<
    string,
    {
      version: string;
      resolved: string;
      integrity: string;
      dependencies?: Record<string, string>;
    }
  >;
};

// ---------------------------------------------------------------------------
// Verdaccio summary / detail shapes — lifted from client.ts
// ---------------------------------------------------------------------------

/**
 * Marketplace origin metadata copied from the published package's
 * `manifest.cinatra.origin` block. Surfaces visibility + owner scope so
 * the catalog page and the `extensions_search` MCP can correctly filter
 * `public` / `locked_public` / `private` packages without having to
 * re-fetch each package's manifest.
 *
 * `null` when the package has no `cinatra.origin` block (e.g. legacy
 * packages published before the visibility convention was introduced) —
 * callers should treat null as "public, grandfather clause."
 */
export type AgentPackageOrigin = {
  /** "public" → anyone can see + install. "locked_public" → same. "private" → same-scope only. */
  visibility: "public" | "locked_public" | "private";
  /** The npm scope that published this package, e.g. "@acme". */
  scope: string;
};

export type AgentPackageSummary = {
  packageName: string;
  packageVersion: string;
  title: string;
  description: string | null;
  changelog: string | null;
  riskLevel: "low" | "medium" | "high" | "critical";
  hasApprovalGates: boolean;
  toolAccess: string[];
  executionMode: "agentic"; // registry summaries currently expose agentic execution
  ownerOrgId: string | null;
  publishedAt: string;
  registryUrl: string;
  registryUiUrl: string;
  deprecated: boolean;
  // Marketplace metadata
  author: string | null;
  kind: "agent" | "skill" | "connector" | "artifact" | "workflow" | null;
  /**
   * Marketplace origin metadata (visibility + scope). Null when the
   * published manifest has no `cinatra.origin` block (legacy grandfathered
   * packages); callers should default a null origin to "public."
   */
  origin: AgentPackageOrigin | null;
};

export type AgentPackageDetail = AgentPackageSummary & {
  // Manifest and payload are left as `unknown` at this layer — the
  // package-specific Zod validation (agentPackageManifestSchema,
  // agentPackagePayloadSchema) stays in packages/agents and is
  // re-applied by install-from-package.ts after extraction. This avoids
  // a @cinatra-ai/registries → @cinatra-ai/agents circular dependency.
  manifest: unknown;
  payload: unknown;
  readme: string | null;
  distTags: Record<string, string>;
  availableVersions: Array<{
    version: string;
    deprecated: boolean;
  }>;
};
