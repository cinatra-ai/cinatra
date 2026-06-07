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
 * True iff `manifest`'s owner scope is visible to `scope`.
 *
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
        manifest.organizationId != null &&
        scope.organizationId != null &&
        manifest.organizationId === scope.organizationId &&
        manifest.ownerId != null &&
        scope.teamIds.includes(manifest.ownerId)
      );
    case "user":
      return (
        manifest.ownerId != null &&
        scope.userId != null &&
        manifest.ownerId === scope.userId
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
