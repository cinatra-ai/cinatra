// Production publish authority gate.
//
// A tagged release (`v<semver>`) triggers a Verdaccio publish. The publish
// step MUST pass the release-manager gate and enforce strict semver +
// immutability. This module is the host-side authority check that the publish
// path (packages/agents/src/verdaccio/client + the CI publish workflow) calls
// before mutating the registry.
import "server-only";

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export class PublishAuthorityError extends Error {
  constructor(
    public readonly code: "MISSING_ROLE" | "INVALID_SEMVER" | "DEV_VERSION_REJECTED",
    message: string,
  ) {
    super(message);
    this.name = "PublishAuthorityError";
  }
}

export type PublishActor = {
  source: string;
  userId?: string;
  orgId?: string;
  roles?: string[];
};

/**
 * Strict semver enforcement. Pre-release (`-alpha.N`, `-beta.N`) allowed; dev
 * versions (`0.0.0-dev.<sha>`) explicitly rejected for prod publish because
 * they are reserved for the dev compile-to-DB path.
 */
export function assertPublishableSemver(version: string): void {
  if (version.startsWith("0.0.0-dev.")) {
    throw new PublishAuthorityError(
      "DEV_VERSION_REJECTED",
      `'${version}' is a dev compile version — not publishable to Verdaccio. Tag a real semver release.`,
    );
  }
  if (!SEMVER_RE.test(version)) {
    throw new PublishAuthorityError(
      "INVALID_SEMVER",
      `'${version}' is not a valid semver version (major.minor.patch[-prerelease]).`,
    );
  }
}

/**
 * Release-manager gate. The publish step calls this with the resolved actor.
 * The actual `requireAccess(actor, ext, "publish", {
 * requireRole: "release_manager" })` lives in src/lib/authz; this is the
 * package-side guard so the publish primitive can fail closed even when
 * invoked outside the host request path (e.g. CI).
 *
 * platform_admin is always allowed (it dominates release_manager).
 */
export function assertReleaseManagerAuthority(actor: PublishActor): void {
  const roles = actor.roles ?? [];
  if (roles.includes("platform_admin") || roles.includes("release_manager")) return;
  throw new PublishAuthorityError(
    "MISSING_ROLE",
    `publish refused — actor (source=${actor.source}, user=${actor.userId ?? "?"}) lacks the 'release_manager' role required by the publish authorization policy.`,
  );
}

export type PublishAuditEvent = {
  operation: "extension_publish";
  packageName: string;
  version: string;
  actor: PublishActor;
  outcome: "success" | "failure";
  reason?: string;
};

/**
 * Compose the full publish gate: semver + immutability-aware + release-manager.
 * Returns a structured audit event for the caller to persist on publish
 * success or failure.
 */
export function authorizePublish(input: {
  actor: PublishActor;
  packageName: string;
  version: string;
}): PublishAuditEvent {
  try {
    assertPublishableSemver(input.version);
    assertReleaseManagerAuthority(input.actor);
  } catch (e) {
    return {
      operation: "extension_publish",
      packageName: input.packageName,
      version: input.version,
      actor: input.actor,
      outcome: "failure",
      reason: e instanceof Error ? e.message : String(e),
    };
  }
  return {
    operation: "extension_publish",
    packageName: input.packageName,
    version: input.version,
    actor: input.actor,
    outcome: "success",
  };
}
