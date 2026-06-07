// Canonical cross-kind extension dependency contract.
//
// STATUS: v2.0 FROZEN (self-contained; the SDK is a leaf contract package and
// must not import host core). This is structurally identical to the host's
// `@cinatra-ai/extensions` `canonical-types.ts` `ExtensionDependency`, which
// gains the same `kind` field in-place. The two are UNIFIED at the ABI freeze,
// with this SDK module becoming the single owner and `canonical-types.ts`
// re-exporting from here. Additive-only until then (no consumer migration before
// the freeze).
//
// What changes vs today:
//  - ONE canonical field `cinatra.dependencies: ExtensionDependency[]` carries
//    ALL edges, including cross-kind (agent→connector, artifact→connector,
//    connector→connector). The `kind` field below is what makes it cross-kind.
//  - Legacy `cinatra.agentDependencies` (a Record<pkg, versionRange>, 9
//    extensions today) and the unused `cinatra.connectorDependencies` become
//    migration shims: publish/install normalizes them into `dependencies`
//    (see `normalizeLegacyDependencies`). A later CI drift gate fails on
//    disagreement — not enforced here.

export const EXTENSION_KINDS = ["agent", "connector", "artifact", "skill", "workflow"] as const;
export type ExtensionKind = (typeof EXTENSION_KINDS)[number];

export const DEPENDENCY_EDGE_TYPES = ["runtime", "install-time", "peer"] as const;
export type DependencyEdgeType = (typeof DEPENDENCY_EDGE_TYPES)[number];

export const DEPENDENCY_REQUIREMENTS = ["required", "optional"] as const;
export type DependencyRequirement = (typeof DEPENDENCY_REQUIREMENTS)[number];

export type VersionConstraint =
  | { kind: "semver-range"; range: string }
  | { kind: "exact"; version: string }
  | { kind: "git-ref"; ref: string };

/**
 * A single dependency edge from one extension to another.
 *
 * `kind` records the DEPENDED-ON extension's kind so the graph is cross-kind
 * without a separate lookup. It is optional for backward compatibility with
 * older rows persisted without it (`dependencies: []`).
 *
 * Required-vs-optional:
 *  - `required`: the depender's NORMAL successful capability cannot work
 *    without it. A missing package fails install/boot; an unconfigured-but-
 *    present connector fails run-start / opens setup-HITL.
 *  - `optional`: a valid degraded path exists. Missing does not fail
 *    install/boot; the runtime records a skipped capability.
 *
 * Capability-based, not provider-pinned: e.g. `email-delivery-agent` depends on
 * the email-send FACADE (`@cinatra-ai/email-connector`) + a provider-resolution
 * rule requiring ≥1 concrete provider (gmail OR resend) — NOT a hard Gmail pin.
 */
export type ExtensionDependency = {
  packageName: string;
  /** The depended-on extension's kind. Optional for older rows. */
  kind?: ExtensionKind;
  edgeType: DependencyEdgeType;
  versionConstraint: VersionConstraint;
  requirement: DependencyRequirement;
};

/** Parse a semver-ish version string into a `VersionConstraint`. */
export function parseVersionConstraint(raw: string): VersionConstraint {
  const v = raw.trim();
  if (v.startsWith("git+") || v.includes("#")) return { kind: "git-ref", ref: v };
  if (/^[\^~><=]|\s|\*|x/i.test(v) || v === "" || v === "latest") {
    return { kind: "semver-range", range: v || "*" };
  }
  return { kind: "exact", version: v };
}

export type LegacyDependencySources = {
  /** Already-canonical edges (highest precedence; never overwritten). */
  dependencies?: ExtensionDependency[];
  /** @deprecated agent→agent map. */
  agentDependencies?: Record<string, string>;
  /** @deprecated unused today; connector→connector map. */
  connectorDependencies?: Record<string, string>;
};

/**
 * Normalize the legacy dependency shims into canonical `ExtensionDependency[]`.
 *
 * Pure + deterministic (sorted output) so the drift gate can assert
 * `agentDependencies`/`connectorDependencies` normalize EXACTLY to the
 * committed `cinatra.dependencies`. Any already-canonical edge for a package
 * wins over a legacy-shim edge for the same package (no duplicate edges).
 *
 * `kindResolver` maps a package name → its kind (from the inventory/registry).
 * When omitted, edges carry no `kind` (still valid; the older shape).
 */
export function normalizeLegacyDependencies(
  sources: LegacyDependencySources,
  kindResolver?: (packageName: string) => ExtensionKind | undefined,
): ExtensionDependency[] {
  const byPackage = new Map<string, ExtensionDependency>();

  const add = (packageName: string, versionRaw: string, edgeType: DependencyEdgeType) => {
    if (byPackage.has(packageName)) return; // canonical / earlier source wins
    byPackage.set(packageName, {
      packageName,
      kind: kindResolver?.(packageName),
      edgeType,
      versionConstraint: parseVersionConstraint(versionRaw),
      requirement: "required",
    });
  };

  // 1) canonical edges first (precedence) — keep their declared fields verbatim
  for (const dep of sources.dependencies ?? []) {
    if (!byPackage.has(dep.packageName)) {
      byPackage.set(dep.packageName, {
        ...dep,
        kind: dep.kind ?? kindResolver?.(dep.packageName),
      });
    }
  }
  // 2) legacy agent→agent edges (a Record<pkg, versionRange>)
  for (const [pkg, ver] of Object.entries(sources.agentDependencies ?? {})) {
    add(pkg, ver, "runtime");
  }
  // 3) legacy connector→connector edges
  for (const [pkg, ver] of Object.entries(sources.connectorDependencies ?? {})) {
    add(pkg, ver, "runtime");
  }

  return [...byPackage.values()].sort((a, b) => a.packageName.localeCompare(b.packageName));
}

export function isExtensionKind(value: unknown): value is ExtensionKind {
  return typeof value === "string" && (EXTENSION_KINDS as readonly string[]).includes(value);
}
