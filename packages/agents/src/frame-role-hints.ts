// ---------------------------------------------------------------------------
// THE FRAME'S OWN STANDING (cinatra#2935, lifecycle-b W5d).
//
// A delegated frame — the site widget's OBO credential, or the chat bearer —
// carries the acting person's standing already RESOLVED and transport-verified.
// This leaf turns that envelope into the `ActorRoleHints` the kernel reads.
//
// WHY IT IS PREFERRED OVER THE COOKIE, and why that is a correctness fix rather
// than an optimisation. The widget's embed frame is same-origin to the Cinatra
// app, so a cookie-borne lookup made while serving it answers as WHOEVER ELSE is
// signed in on that browser. A run's execute gate evaluated against those hints
// is evaluated against the wrong person's teams and project grants. The envelope
// is server-only and unforgeable — only upstream server-only code stamps these
// axes — exactly as `resolveOrgIdFromSession` and
// `resolveIsPlatformAdminFromSession` already document for `orgId` and
// `platformRole`. This makes all three read ONE identity per frame.
//
// AN ORG ALONE IS NOT ENOUGH, and getting that wrong would have been a
// REGRESSION rather than a fix (convergence round 1, finding 4). `orgId` is the
// axis that makes the rest meaningful — teams and project grants are resolved
// inside one organization — but the ordinary model/chat MCP envelope carries
// `orgId`, `orgRole` and `platformRole` and forwards NEITHER `teamIds` NOR
// `projectGrants` (`./mcp/registry.ts`, `buildActorFromMcpContext`, the model
// branch). Treating that envelope as authoritative would have handed the kernel
// two empty arrays where the cookie session resolves the caller's real teams and
// project grants — silently denying a person whose access to an agent comes
// through a team or a project.
//
// So the envelope wins ONLY when it carries a RESOLVED standing: both membership
// axes present, which is what a caller that did the live resolution itself
// supplies. Everything else falls back to the session lookup, unchanged.
// ---------------------------------------------------------------------------

import type { ActorRoleHints } from "@/lib/authz/build-actor-context";

/** The transport-verified axes an in-process primitive actor envelope carries. */
export type FrameRoleHintsEnvelope = {
  orgId?: string | null;
  platformRole?: string;
  orgRole?: "org_owner" | "org_admin" | "member";
  teamIds?: string[];
  projectGrants?: unknown[];
};

/** The frame's standing, or null when the frame carries no RESOLVED standing. */
export function roleHintsFromActorEnvelope(
  actor?: FrameRoleHintsEnvelope | null | undefined,
): ActorRoleHints | null {
  const orgId =
    typeof actor?.orgId === "string" && actor.orgId.length > 0 ? actor.orgId : null;
  if (!orgId) return null;
  // A RESOLVED standing, not merely an org. See the header: an envelope missing
  // either membership axis is one whose axes were never resolved, and answering
  // with empty arrays would be NARROWER than the session lookup it displaced.
  if (!Array.isArray(actor?.teamIds) || !Array.isArray(actor?.projectGrants)) {
    return null;
  }
  return {
    platformRole: actor?.platformRole === "platform_admin" ? "platform_admin" : "member",
    ...(actor?.orgRole ? { orgRole: actor.orgRole } : {}),
    actorOrganizationId: orgId,
    teamIds: actor?.teamIds ?? [],
    projectGrants: (actor?.projectGrants ?? []) as ActorRoleHints["projectGrants"],
  };
}
