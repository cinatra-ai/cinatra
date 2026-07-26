import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";

// ---------------------------------------------------------------------------
// Public types shared by extension packages for dependency inversion.
// ---------------------------------------------------------------------------

export type PackageRef = {
  registryUrl: string;
  packageName: string;
  version?: string;
};

export type ValidationResult = {
  valid: boolean;
  errors?: string[];
};

export type Actor = PrimitiveActorContext;

/**
 * Minimal projection of an `installed_extension` manifest row — the UNIFORM
 * active-gate identity the runtime-discovery dispatcher hands to a kind's
 * reader facet. The full canonical row lives in `@cinatra-ai/extensions`; this
 * leaf type stays dependency-free for the dep-inversion boundary.
 *
 * `status` is the effective lifecycle status; the dispatcher only ever passes
 * rows in the DISCOVERABLE set (`active` | `locked`).
 */
export type ActiveExtensionManifest = {
  id: string;
  packageName: string;
  /** One of the five canonical kinds: agent | connector | artifact | skill | workflow. */
  kind: string;
  ownerLevel: string;
  ownerId: string | null;
  organizationId: string | null;
  status: string;
};

/**
 * The RESOLVED visibility scope a reader facet uses to choose which native rows
 * the actor may see. It is deliberately NOT derived from `Actor`
 * (`PrimitiveActorContext` is an audit/actor envelope, not a membership
 * envelope): the host resolves this from the session + Better Auth + vendor
 * config and passes it into discovery. A missing/empty scope must FAIL CLOSED to
 * public/platform-only visibility — never "all active".
 *
 * The `installed_extension` active gate is only a coarse *lifecycle* candidate
 * set ("is this package/kind live?"); per-kind native readers are the authority
 * for "may this actor see this row?" and apply this scope.
 */
export type ExtensionDiscoveryScope = {
  userId: string | null;
  organizationId: string | null;
  teamIds: string[];
  projectIds?: string[];
  /** npm vendor scope whose private rows the actor may see (e.g. "@acme-private"). */
  vendorScope?: string | null;
  platformRole?: "platform_admin" | "member";
  /**
   * The actor's Better Auth role in their active org. Threaded through so the
   * manifest gate admits an org_owner/org_admin to EVERY row anchored to their
   * org (organization / team / user owner levels) — the catalog/list-side mirror
   * of the P1 evaluator's `hasAdminStandingOverExtension`. Absent ⇒ treated as a
   * plain member (fail closed: no admin standing).
   */
  orgRole?: "org_owner" | "org_admin" | "member";
};

export interface ExtensionTypeHandler {
  typeId: string;
  /** options.destination selects the publish registry ("private" | "public").
   *  The parameter is optional for backward compatibility; implementations
   *  that do not need destination routing can omit it. */
  install(
    ref: PackageRef,
    actor: Actor,
    options?: { destination?: "private" | "public" },
  ): Promise<void>;
  update(ref: PackageRef, actor: Actor): Promise<void>;
  uninstall(ref: PackageRef, actor: Actor): Promise<void>;
  archive(ref: PackageRef, actor: Actor): Promise<void>;
  restore(ref: PackageRef, actor: Actor): Promise<void>;
  validate?(spec: unknown): Promise<ValidationResult>;

  // -------------------------------------------------------------------------
  // Reader facet (true-IoC re-scope).
  //
  // Runtime discovery of "what capabilities are active" flows EXCLUSIVELY
  // through the active-manifest dispatcher → these methods. A kind's native
  // store (agent_templates / skills catalog / object registry / workflow_template)
  // remains the capability authority, but it is read ONLY for the manifests the
  // uniform `installed_extension` gate reports active — never discovered
  // independently (the split-brain guard). `TActive` is the kind's NATIVE
  // descriptor shape (agent template / skill descriptor / object-artifact
  // descriptor / workflow+dashboard descriptor / connector capability set).
  //
  // Optional during the per-kind cutover: a handler that has not yet adopted the
  // facet simply contributes no dynamically-discovered capabilities (its surface
  // stays on the legacy static path until migrated). When every kind implements
  // it and the static lists are deleted, the system is extensible by construction.
  // -------------------------------------------------------------------------

  /**
   * Return this kind's native descriptors that are BOTH visible to `scope` AND
   * lifecycle-live per `manifests` (the coarse status-candidate set). The reader
   * is the VISIBILITY AUTHORITY: it must choose visible rows via the actor's
   * resolved `scope` (e.g. the kind's own vendor/owner-level reader), then keep
   * only those whose package is in the lifecycle-live `manifests` set. It must
   * NOT trust `manifests` for visibility (the manifest gate cannot answer "may
   * this actor see this row").
   */
  listActive?(input: {
    actor: Actor;
    scope: ExtensionDiscoveryScope;
    manifests: ActiveExtensionManifest[];
  }): Promise<unknown[]>;

  /**
   * Archived twin of `listActive` (cinatra#948 — the Installed-extensions
   * management surface lists archived rows for every kind, not just agents).
   * Return this kind's descriptors that are BOTH visible to `scope` AND
   * lifecycle-ARCHIVED per `manifests` (the coarse archived-candidate set,
   * already excluding identities that are still live elsewhere — "live wins").
   * The same visibility-authority contract as `listActive` applies: the reader
   * owns "may this actor see this row"; it must never trust `manifests` for
   * visibility. A kind whose native store retains no archived rows (e.g. the
   * in-memory artifact registry, which deregisters on archive) may fall back to
   * package-level descriptors derived from the scope-visible manifests — that
   * preserves exactly the visibility its `listActive` applies (the shared
   * owner-scope gate), so archived rows are never MORE visible than active ones.
   */
  listArchived?(input: {
    actor: Actor;
    scope: ExtensionDiscoveryScope;
    manifests: ActiveExtensionManifest[];
  }): Promise<unknown[]>;

  /** Return the native descriptor for a single lifecycle-live manifest if it is
   *  visible to `scope`, else null. */
  readActive?(input: {
    actor: Actor;
    scope: ExtensionDiscoveryScope;
    manifest: ActiveExtensionManifest;
  }): Promise<unknown | null>;
}

// ---------------------------------------------------------------------------
// Shared visibility gate for reader facets.
//
// Every kind's reader facet must answer "is this manifest's owner-scope visible
// to the actor?" identically — the manifest gate is a coarse lifecycle-live
// candidate set, and a facet must NOT surface another owner's row just because
// the package name happens to be live somewhere. This leaf-level helper is the
// single source of truth for that rule so connector / artifact / skill / workflow
// readers (whose native catalogs carry no per-owner visibility of their own) all
// gate identically. It FAILS CLOSED: an unknown owner level is never visible.
// ---------------------------------------------------------------------------

/**
 * Does `scope` hold ADMIN STANDING over a manifest owned by `manifestOrgId`?
 * The catalog-side mirror of the P1 evaluator's `hasAdminStandingOverExtension`
 * (`@cinatra-ai/extensions`), expressed purely over the leaf
 * `ExtensionDiscoveryScope` so this package imports no server code:
 *   - a `platform_admin` holds standing over every manifest; and
 *   - an `org_owner`/`org_admin` holds standing over every manifest anchored to
 *     THEIR active org.
 * Keyed on the MANIFEST's own org (not merely the actor's), so it is cross-org
 * safe: an admin of org A never gains standing over an org-B manifest. A manifest
 * with no org (platform/workspace) yields standing only for a platform admin —
 * there is no org to be an admin of (fail closed).
 */
export function scopeHasAdminStandingOverManifest(
  scope: ExtensionDiscoveryScope,
  manifestOrgId: string | null,
): boolean {
  if (scope.platformRole === "platform_admin") return true;
  return (
    manifestOrgId != null &&
    scope.organizationId != null &&
    manifestOrgId === scope.organizationId &&
    (scope.orgRole === "org_owner" || scope.orgRole === "org_admin")
  );
}

/**
 * True iff `manifest`'s owner scope is visible to `scope`.
 *
 * - ADMIN STANDING (checked first): a platform admin, or an org_owner/org_admin
 *   of the manifest's owning org, sees EVERY row of that org regardless of owner
 *   level — so two admins of the same org see the identical catalog. Independent
 *   of the installer pointer / owner level, role-derived (a newly-promoted admin
 *   needs no per-row grant; a demotion reverts it).
 * - `platform` / `workspace`: deployment-wide rows (e.g. bundled, locked
 *   extensions, or the implicit Workspace tier) — visible to every actor.
 * - `organization`: visible only when the actor's active org matches.
 * - `team`: visible only when the actor's active org matches AND the actor
 *   belongs to the owning team.
 * - `user`: visible only to the owning user.
 * - anything else: fail closed (not visible).
 */
export function manifestVisibleToScope(
  manifest: ActiveExtensionManifest,
  scope: ExtensionDiscoveryScope,
): boolean {
  // platform_admin sees every row (mirrors the P1 evaluator's isPlatformAdmin
  // short-circuit, which admits platform admins ahead of every tier check).
  if (scope.platformRole === "platform_admin") return true;

  // org_owner/org_admin standing over the manifest's OWN org. Applied ONLY
  // inside the org-anchored owner levels below (team / user) — an unknown or
  // corrupt owner level stays fail-closed even for an admin (the default case).
  // For `organization` rows the standing is redundant (every same-org member
  // already sees them), so the org-match branch carries it.
  const orgAdminStanding = scopeHasAdminStandingOverManifest(
    scope,
    manifest.organizationId,
  );

  switch (manifest.ownerLevel) {
    case "platform":
    case "workspace":
      // Deployment-wide. The Workspace tier is the implicit platform-instance
      // level (no per-row owner); platform rows are the bundled/locked set.
      return true;
    case "organization":
      return (
        manifest.organizationId != null &&
        scope.organizationId != null &&
        manifest.organizationId === scope.organizationId
      );
    case "team":
      return (
        orgAdminStanding ||
        (manifest.organizationId != null &&
          scope.organizationId != null &&
          manifest.organizationId === scope.organizationId &&
          manifest.ownerId != null &&
          scope.teamIds.includes(manifest.ownerId))
      );
    case "user":
      return (
        orgAdminStanding ||
        (manifest.ownerId != null &&
          scope.userId != null &&
          manifest.ownerId === scope.userId)
      );
    default:
      return false;
  }
}

/**
 * The set of package names from `manifests` that are visible to `scope`. Reader
 * facets intersect their native catalog against this set so a row is surfaced
 * only when it is BOTH lifecycle-live (in `manifests`) AND owner-visible.
 */
export function visibleManifestPackageNames(
  manifests: ActiveExtensionManifest[],
  scope: ExtensionDiscoveryScope,
): Set<string> {
  const names = new Set<string>();
  for (const manifest of manifests) {
    if (manifestVisibleToScope(manifest, scope)) {
      names.add(manifest.packageName);
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Skill ROLE — the manifest-carried cinatra semantics (cinatra#2089, epic
// #2086 S2).
//
// An Anthropic-clean `SKILL.md` carries only Anthropic-valid frontmatter, so
// every cinatra semantic that used to live there moves to the extension
// manifest. The role is the first of them and the one the injection contract
// (S4, cinatra#2091) binds to:
//
//   - `injectable` — a knowledge/behaviour skill. Counts toward the hard
//     injection cap and is eligible for upload to a provider.
//   - `matcher`    — consumed by artifact/agent MATCHING, never injected as
//     prose into a run.
//   - `internal`   — pipeline-consumed (e.g. the HITL prompt drive core reads
//     by path). NEVER injected, NEVER uploaded.
//
// Declared as `cinatra.skillRole` on a `kind:"skill"` package. The shared
// packaging verdict rejects any other value at CI, store install and publish.
// ---------------------------------------------------------------------------

/** The three roles a skill extension may declare. */
export const SKILL_EXTENSION_ROLES = ["injectable", "matcher", "internal"] as const;

export type SkillExtensionRole = (typeof SKILL_EXTENSION_ROLES)[number];

/**
 * Resolve a skill extension's role from its `cinatra` manifest block.
 *
 * DEFAULT is `injectable`: a skill extension exists to be used by a run, and
 * defaulting to the most restricted role would silently stop today's skills
 * from being delivered. The two restricted roles are opt-in and explicit.
 *
 * TRANSITIONAL: the pre-S2 convention was a boolean `internal: true` on the
 * manifest (core consumes `chat-hitl-prompt-drive` by exact repository path).
 * That flag is honoured as `internal` so a package that has not yet migrated
 * keeps its meaning; an explicit `skillRole` always wins.
 *
 * An UNKNOWN `skillRole` value resolves to `null` — the caller decides, and the
 * packaging verdict has already refused such a package at every install and
 * publish point, so a null here means a manifest that bypassed the gate.
 */
export function resolveSkillExtensionRole(
  cinatra: Record<string, unknown> | null | undefined,
): SkillExtensionRole | null {
  if (!cinatra || typeof cinatra !== "object") return "injectable";
  const declared = (cinatra as { skillRole?: unknown }).skillRole;
  if (typeof declared === "string") {
    return (SKILL_EXTENSION_ROLES as readonly string[]).includes(declared)
      ? (declared as SkillExtensionRole)
      : null;
  }
  if (declared !== undefined) return null;
  if ((cinatra as { internal?: unknown }).internal === true) return "internal";
  return "injectable";
}
