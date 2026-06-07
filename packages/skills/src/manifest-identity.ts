// Skill ↔ installed_extension identity + parity (PURE).
//
// Manifest-driven skill discovery (replacing the boot fs-scan as the authority)
// requires mapping a catalog skill row to the `installed_extension` manifest that
// governs its lifecycle. Measuring real data surfaced that this mapping is NOT a
// single clean field today:
//
//   1. NORMALIZATION DRIFT — the catalog keys skills by npm-scoped/raw
//      `packageName` (`@cinatra-ai/security-reviewer-agent`,
//      `coreyhaines31-marketingskills`) while `installed_extension.package_name`
//      is a slugified form (`cinatra-ai-security-reviewer-agent`,
//      `marketingskills`). Multiple slugify variants exist across the codebase
//      (skills-store, verdaccio, github, compile-agent-skills), so no one
//      transform matches all rows.
//   2. CROSS-KIND CO-LOCATION — a skill co-located inside an agent / artifact /
//      connector package is governed by THAT package's manifest (kind=agent /
//      artifact / connector), NOT a kind=skill row. So a skill's lifecycle can be
//      owned by a non-skill manifest.
//
// This module is the PURE, DB-free substrate for that mapping + a parity check.
// It does NOT read the catalog, does NOT touch the fs-scan, and is NOT a runtime
// reader — it is the measurement + identity-resolution layer the eventual reader
// and the cutover-readiness gate build on. See computeSkillManifestParity.

/** The minimal skill-row identity projection the resolver needs. */
export type SkillIdentityRow = {
  packageName?: string | null;
  /** Prefixed install identity, e.g. `custom:cinatra-ai-foo-agent`, `github:owner/repo`, `installed:_verdaccio-installs`. */
  packageId?: string | null;
  /** Catalog-side slug, when present. */
  packageSlug?: string | null;
};

// Install-source / owner-level prefixes seen on `packageId`.
const PACKAGE_ID_PREFIX_RE =
  /^(custom|github|installed|verdaccio|zip|workspace|system|personal|team|organization|project|agent):/;

/** The canonical skills-store slug (mirrors `slugify` in skills-store.ts). */
function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function stripPackageIdPrefix(packageId: string): string {
  return packageId.replace(PACKAGE_ID_PREFIX_RE, "");
}

/**
 * The ordered set of plausible `installed_extension.package_name` keys a skill
 * row could match, given the normalization drift documented above. A skill is
 * considered manifest-governed iff ANY candidate matches a live manifest — this
 * is a deliberate best-effort union, not a single authoritative key, because the
 * authoritative key does not exist in the data yet (the fix is to reconcile the
 * install path to write ONE canonical owner-package identity).
 */
export function resolveSkillOwnerPackageCandidates(row: SkillIdentityRow): string[] {
  const out = new Set<string>();
  const add = (v: string | null | undefined) => {
    if (v && v.trim()) out.add(v.trim());
  };
  if (row.packageName) {
    add(row.packageName);
    add(slugify(row.packageName));
  }
  if (row.packageId) {
    const stripped = stripPackageIdPrefix(row.packageId);
    add(stripped);
    add(slugify(stripped));
  }
  add(row.packageSlug);
  return [...out];
}

/** True iff any of the row's candidate keys is in the live-manifest set. */
export function isSkillManifestGoverned(
  row: SkillIdentityRow,
  liveManifestPackageNames: Set<string>,
): boolean {
  return resolveSkillOwnerPackageCandidates(row).some((c) => liveManifestPackageNames.has(c));
}

// ---------------------------------------------------------------------------
// npm-canonical reconciliation: the npm package form — e.g.
// `@cinatra-ai/security-reviewer-agent` — is the ONLY acceptable
// `installed_extension.package_name` for skill manifests; slug-form rows are
// normalized to it, and a slug row that duplicates an existing npm row is
// deleted. Pure planner — the migration SCRIPT applies the plan; this is the
// reviewable + unit-tested decision layer.
// ---------------------------------------------------------------------------

/**
 * Resolve the canonical npm package name for a (possibly slugified) manifest
 * `package_name`, using the skills catalog's npm packageNames as the authority.
 *
 * - Already npm form (`@scope/name`) → returned as-is.
 * - Else: among catalog names whose `slugify(name)` equals the input, PREFER the
 *   npm (`@`-prefixed) candidate. Exactly one npm candidate → it. (This resolves
 *   the catalog-duplication case where the catalog carries BOTH `@scope/x` and
 *   the bare slug `scope-x`.)
 * - Ambiguous (>1 distinct npm candidate) or no npm candidate (orphan) → null.
 *   The caller must NOT guess; npm is only derived from an authoritative source,
 *   never reverse-engineered from a slug.
 */
export function resolveCanonicalNpmName(
  packageName: string,
  catalogNpmNames: Iterable<string>,
): string | null {
  if (!packageName) return null;
  if (packageName.startsWith("@")) return packageName;
  const npmMatches = new Set<string>();
  for (const npm of catalogNpmNames) {
    if (npm.startsWith("@") && slugify(npm) === packageName) npmMatches.add(npm);
  }
  if (npmMatches.size === 1) return [...npmMatches][0];
  return null; // ambiguous (>1) or orphan (0)
}

export type SkillManifestRow = {
  id: string;
  packageName: string;
  ownerLevel?: string | null;
  ownerId?: string | null;
  organizationId?: string | null;
};

export type SkillManifestNpmPlan = {
  /** in-scope (extension) slug rows that become their npm form (no existing npm row at the same identity). */
  renames: Array<{ id: string; from: string; to: string }>;
  /** in-scope (extension) slug rows whose npm identity is ALREADY occupied (by an
   *  existing npm row of any kind, or a prior planned rename) → delete the
   *  redundant slug row (cross-kind co-location / same-identity duplicate). */
  deletes: Array<{ id: string; from: string; duplicateOf: string }>;
  /** rows already in npm form AND an extension — untouched. */
  alreadyCanonical: string[];
  /** rows whose package is NOT an extension in `extensions/` (resolved-but-non-
   *  extension, or orphan that maps to no extension) → DELETED. `installed_extension`
   *  is the EXTENSION lifecycle table; these are backfill over-reach (the
   *  backfill seeded from ALL `skill_packages`: legacy code-agent co-located
   *  skills, internal modules, test fixtures, install artifacts, loose github
   *  skills). Deleting the manifest row does NOT delete the skill (catalog +
   *  on-disk `SKILL.md` are untouched). Empty when no `extensionPackageNames`
   *  scope is supplied. */
  nonExtensionDeletes: Array<{ id: string; packageName: string; resolvedNpm: string | null }>;
  /** AMBIGUOUS slug rows (>1 distinct npm candidate) — cannot be safely classified
   *  as extension-or-not, so NEVER auto-deleted/renamed; left untouched + reported
   *  for owner review. (In practice empty after the prefer-`@` resolution.) */
  needsReview: Array<{ id: string; packageName: string }>;
  /** EXTERNAL third-party rows the owner has chosen to LEAVE untouched (vendored
   *  `@anthropics/skills`, github-sourced third-party skills). Not an extension,
   *  but explicitly NOT deleted: do not mint cinatra extensions for external
   *  repos, and do not purge them. */
  external: Array<{ id: string; packageName: string }>;
};

function identityKey(row: { ownerLevel?: string | null; ownerId?: string | null; organizationId?: string | null }, pkg: string): string {
  return `${row.ownerLevel ?? ""}|${row.ownerId ?? ""}|${row.organizationId ?? ""}|${pkg}`;
}

/**
 * Plan the npm-canonical reconciliation of `kind=skill` manifest rows.
 * PURE — no DB. Deterministic + idempotent (re-running on an already-migrated
 * set yields all-`alreadyCanonical`, empty renames/deletes).
 *
 * `catalogNpmNames` is the authoritative npm-name source (the skills catalog's
 * `packageName`s). A row with no authoritative npm resolution is reported as
 * `unresolved`, never renamed/deleted.
 *
 * `crossKindNpmRows` — npm-form `installed_extension` rows of OTHER kinds
 * (agent/artifact/connector). The `installed_extension` uniqueness key is
 * `(owner_level, owner_id, organization_id, package_name)` and **excludes
 * `kind`**, so a skill slug renamed to npm could collide with an existing
 * non-skill npm row at the same identity. That collision is exactly the
 * cross-kind co-location case: the owning agent/artifact manifest already
 * governs the co-located skill, so the separate skill row is REDUNDANT and is
 * DELETED (never renamed into a unique-constraint violation). Pass every
 * non-skill npm row so these are seeded as occupied identities.
 *
 * `extensionPackageNames` — npm names of packages that ARE extensions (the
 * `extensions/` folder set). The migration is SCOPED to extension skills:
 * - a row resolving to (or already at) an extension npm name → normalize/dedupe;
 * - a row that is NOT an extension (resolves to a non-extension npm, or an orphan
 *   that maps to no extension) → DELETE (`nonExtensionDeletes`): it is
 *   backfill over-reach in the EXTENSION lifecycle table (anything that is not
 *   already in an extension is deleted as a duplicate).
 *   Deleting the manifest row never touches the skill catalog / on-disk content;
 * - an AMBIGUOUS slug (>1 npm candidate) → `needsReview` (never auto-deleted).
 *
 * When `extensionPackageNames` is omitted, no scoping/deletion-of-non-extension is
 * applied — every resolvable row normalizes, orphans go to `needsReview` (used by
 * unit isolation only). Resolution uses `catalogNpmNames ∪ extensionPackageNames`
 * so an extension whose npm name is absent from the catalog still resolves.
 */
export function planSkillManifestNpmMigration(
  rows: SkillManifestRow[],
  catalogNpmNames: Iterable<string>,
  crossKindNpmRows: SkillManifestRow[] = [],
  extensionPackageNames?: Iterable<string>,
  externalLeaveAlone?: Iterable<string>,
): SkillManifestNpmPlan {
  const extSet = extensionPackageNames ? new Set(extensionPackageNames) : null;
  // External rows (vendored @anthropics/skills + github third-party) are left
  // untouched — never deleted, never renamed. Matched on the row's raw
  // package_name (the script supplies both npm + slug forms).
  const externalSet = externalLeaveAlone ? new Set(externalLeaveAlone) : null;
  // Resolution source includes the extension names so an extension slug resolves
  // even when the catalog lacks the npm row (prevents a valid extension skill
  // being misclassified non-extension → deleted).
  const catalog = [...catalogNpmNames, ...(extSet ?? [])];
  const isExtension = (npm: string): boolean => extSet === null || extSet.has(npm);
  const isExternal = (pkg: string): boolean => externalSet !== null && externalSet.has(pkg);
  const plan: SkillManifestNpmPlan = {
    renames: [],
    deletes: [],
    alreadyCanonical: [],
    nonExtensionDeletes: [],
    needsReview: [],
    external: [],
  };
  // Seed occupied identities from (a) cross-kind npm rows (the owning
  // agent/artifact/connector manifest — a skill resolving here is redundant) and
  // (b) skill rows ALREADY in npm form (they win; a slug row at the same
  // identity is the duplicate to delete).
  const occupied = new Set<string>();
  for (const r of crossKindNpmRows) {
    if (r.packageName.startsWith("@")) occupied.add(identityKey(r, r.packageName));
  }
  for (const r of rows) {
    if (r.packageName.startsWith("@")) occupied.add(identityKey(r, r.packageName));
  }
  for (const r of rows) {
    // External (owner-leave-alone) rows are never touched — checked first so an
    // external package that happens not to be an extension is NOT deleted.
    if (isExternal(r.packageName)) {
      plan.external.push({ id: r.id, packageName: r.packageName });
      continue;
    }
    if (r.packageName.startsWith("@")) {
      // Already npm form. Keep iff it is an extension; else it is backfill residue.
      if (isExtension(r.packageName)) plan.alreadyCanonical.push(r.id);
      else plan.nonExtensionDeletes.push({ id: r.id, packageName: r.packageName, resolvedNpm: r.packageName });
      continue;
    }
    const npm = resolveCanonicalNpmName(r.packageName, catalog);
    if (!npm) {
      // >1 npm candidate = ambiguous → needsReview (never auto-classify).
      // 0 candidates = orphan: maps to no extension → delete as non-extension WHEN
      // an extension scope is in force; without a scope we cannot assert
      // non-extension, so leave for review.
      let npmCandidates = 0;
      for (const n of catalog) if (n.startsWith("@") && slugify(n) === r.packageName) npmCandidates++;
      if (npmCandidates > 1 || extSet === null) plan.needsReview.push({ id: r.id, packageName: r.packageName });
      else plan.nonExtensionDeletes.push({ id: r.id, packageName: r.packageName, resolvedNpm: null });
      continue;
    }
    if (!isExtension(npm)) {
      // Resolves to a real npm name, but that package is NOT an extension → delete.
      plan.nonExtensionDeletes.push({ id: r.id, packageName: r.packageName, resolvedNpm: npm });
      continue;
    }
    const key = identityKey(r, npm);
    if (occupied.has(key)) {
      plan.deletes.push({ id: r.id, from: r.packageName, duplicateOf: npm });
    } else {
      occupied.add(key);
      plan.renames.push({ id: r.id, from: r.packageName, to: npm });
    }
  }
  return plan;
}

export type SkillManifestParity = {
  /** Distinct catalog skill packages with ≥1 candidate matching a live manifest. */
  resolved: string[];
  /** Distinct catalog skill packages with NO candidate match — the cutover blocker. */
  unresolved: string[];
  total: number;
};

/**
 * Pure parity over a set of skill rows + the live manifest package-name set
 * (ALL kinds — cross-kind co-location means a skill may be governed by an
 * agent/artifact/connector manifest, so callers must pass the union, not just
 * kind=skill). De-dupes by the catalog package key (`packageName ?? packageId`).
 *
 * `unresolved` is the cutover blocker: while it is non-empty, the
 * `installed_extension` manifest cannot replace the fs-scan as the skill
 * discovery authority without dropping those packages.
 */
export function computeSkillManifestParity(
  skills: SkillIdentityRow[],
  liveManifestPackageNames: Set<string>,
): SkillManifestParity {
  const byPackage = new Map<string, SkillIdentityRow>();
  for (const s of skills) {
    const key = s.packageName ?? s.packageId ?? "";
    if (key && !byPackage.has(key)) byPackage.set(key, s);
  }
  const resolved: string[] = [];
  const unresolved: string[] = [];
  for (const [key, row] of byPackage) {
    (isSkillManifestGoverned(row, liveManifestPackageNames) ? resolved : unresolved).push(key);
  }
  return { resolved: resolved.sort(), unresolved: unresolved.sort(), total: byPackage.size };
}
