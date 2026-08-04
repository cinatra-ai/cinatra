import "server-only";

// ---------------------------------------------------------------------------
// Session-derived actor construction for the extension lifecycle UI paths.
//
// Extracted verbatim from `actions.ts` (cinatra#2416) so that BOTH the surface
// that RENDERS the lifecycle affordances (the settings page — a Server
// Component) and the surface that ENFORCES them (the `"use server"` form
// actions) build the caller's actor with the SAME code. The settings page's
// per-affordance capability is only trustworthy if it is evaluated against the
// exact actor the later submission will be enforced against; a second builder
// would reintroduce the drift class by another door.
//
// This module carries `server-only` and NOT a top-level `"use server"`: a
// `"use server"` module's exports become callable Server Functions (RPC
// endpoints), which an actor BUILDER must never be. `server-only` is the
// correct marker — Next.js fails the build if it ever enters a client graph.
//
// ── Why the roles matter (cinatra#2400) ────────────────────────────────────
// Before #2400 every wrapper hand-rolled `{actorType, userId, source, orgId}` —
// an audit envelope with NO standing — so:
//   * force-delete, whose dispatcher gate reads ONLY `platformRole`, refused
//     every real platform admin's submission while the button rendered enabled
//     ("force_delete is platform-admin-only … — refusing");
//   * the archive/restore/reinstall family was rejected even earlier, at
//     `resolveLifecycleTargetRow → assertActorWriteStandingOverRow`, which needs
//     `orgRole` (or platform standing) over the resolved row — so those actions
//     could not act at all (no branch was taken, no archive fallback occurred).
// The programmatic primitives (the MCP lifecycle handlers) dispatch with a
// fully-roled actor resolved from their transport, so only the UI paths were
// broken; `buildLifecycleActorFromSession` closes that divergence.
//
// BOTH role fields are derived from the TRUSTED SERVER SESSION:
//   * `platformRole` ← `isPlatformAdmin(session)`, the canonical predicate over
//     Better Auth's comma-separated role string ("user,admin");
//   * `orgRole`      ← `buildCanDoOptsFromSession(session)`, a membership-table
//     read for the session's ACTIVE org.
// A form action's `input` is client-controlled and NEVER contributes a role —
// a crafted request cannot supply, spoof or widen either field.
// ---------------------------------------------------------------------------

import type { Actor } from "@cinatra-ai/extension-types";
import { isPlatformAdmin, requireAdminSession } from "@/lib/auth-session";

export type LifecycleActorSession = Awaited<ReturnType<typeof requireAdminSession>>;

// Operator-side diagnostic for a degraded actor build. Own logger (not
// actions.ts's marketplace-failure logger, which classifies against an INSTALL
// taxonomy this has nothing to do with). CWE-134-safe: a CONSTANT format string
// with the dynamic values passed as separate %s arguments, never interpolated
// into the format position.
function logActorBuildDegraded(
  operation: string,
  packageName: string,
  err: unknown,
): void {
  console.warn(
    "[lifecycle-actor] %s could not resolve the org role for %s — the actor degrades to platform standing + identity:",
    operation,
    packageName,
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
}

/**
 * The AUDIT ENVELOPE: who is acting, from where, in which org. Standing-free by
 * construction and shared by every extension form action.
 */
export function buildActorEnvelope(session: LifecycleActorSession): Actor {
  const orgId = session.session?.activeOrganizationId ?? null;
  return {
    actorType: "human",
    userId: session.user.id,
    source: "ui",
    // Forward the active org so extension lifecycle has organization context
    // from the UI server-action path.
    ...(orgId ? { orgId } : {}),
  };
}

/**
 * THE shared lifecycle actor builder — the envelope PLUS the caller's real
 * standing (`platformRole` + `orgRole`). Used by every lifecycle form action
 * (archive / restore / reinstall / force-delete) AND by the settings page that
 * renders their affordances.
 *
 * DELIBERATELY NOT used by the install/update wrappers. Their actor is handed to
 * the dependency BATCH (`installExtensionWithDependencies`), whose abort path
 * compensates member installs through `uninstallMember` →
 * `extensionRegistry.uninstall(…, actor)`. Platform standing there would route a
 * freshly-installed, never-used dependency into the PACKAGE-GLOBAL hard-delete
 * branch — tearing down every OTHER org's row for that dependency during a
 * single org's failed install. Install/update therefore keep the standing-free
 * envelope; their access-target rollback attaches org-scoped standing at
 * rollback time (see buildInstallRollbackActor) and never platform standing.
 *
 * TOTAL by contract — must NEVER throw. Callers invoke it before (and outside)
 * their own error handling, and the org-role resolution is a DB read. On a
 * resolution failure the actor degrades to platform standing + audit identity
 * only: a platform admin is unaffected, and an org admin is then refused by the
 * P5 standing gate (fail-closed) instead of the action dying with a
 * production-masked server-action error.
 *
 * NOTE: this guarantees identical actor CONSTRUCTION, not an identical actor
 * snapshot. Membership can change between the render that computed a capability
 * and the submission that acts on it — which is exactly why the server keeps
 * enforcing independently and re-resolves the actor on the action request.
 */
export async function buildLifecycleActorFromSession(
  session: LifecycleActorSession,
  operation: string,
  packageName: string,
): Promise<Actor> {
  const actor: Actor = {
    ...buildActorEnvelope(session),
    // Platform standing from the session's own role string — the ONLY field
    // `isPlatformAdminActor` (lifecycle-target-resolver) reads.
    ...(isPlatformAdmin(session) ? { platformRole: "platform_admin" as const } : {}),
  };
  try {
    const { buildCanDoOptsFromSession } = await import("@/lib/auth-session");
    const { orgRole } = await buildCanDoOptsFromSession(session);
    return orgRole ? { ...actor, orgRole } : actor;
  } catch (roleErr) {
    logActorBuildDegraded(operation, packageName, roleErr);
    return actor;
  }
}
