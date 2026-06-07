"use server";

/**
 * Authorization bypass convention.
 *
 * First concrete call site of `withPlatformAdminBypass`. The bypass is
 * the ONLY way a platform_admin may delete a user-owned project. The
 * row in `audit_events` IS the authorization record - there is no
 * silent grant in `EFFECTIVE_GRANTS.platform_admin` for `project.delete`.
 *
 * The reason argument is intentionally NARROWED to a 2-entry subset of
 * AdminBypassReason via `Extract<...>` - projects moderation only accepts
 * `"gdpr_request"` and `"incident_response"`. Other surfaces that need a
 * different subset MUST add their own Extract<> alias rather than
 * widening this one.
 *
 * `ticketRef` is REQUIRED. A moderation delete without an incident /
 * GDPR ticket is a procedural error and we surface it at the type level
 * AND at runtime (server actions are an untrusted input boundary -
 * TypeScript types are erased at runtime so a malformed form POST or
 * stale client-side caller could otherwise slip past the narrowing).
 * The ticket lands inside the audit row's `metadata` JSONB column via
 * the helper's `extraMetadata` parameter.
 *
 * See https://docs.cinatra.ai/references/platform/authz-admin-powers/ for the full convention.
 */

// `requireAuthSession`/`actorFromSession`/`readProjectById`/`deleteProject`/
// `withPlatformAdminBypass` imports are not needed while the moderation-delete
// body is disabled. The `AdminBypassReason` type-only import is preserved for
// the public `ProjectModerationDeleteReason` alias.
import { type AdminBypassReason } from "@/lib/authz/admin-bypass";

// Narrowed reason union for this surface.
export type ProjectModerationDeleteReason = Extract<
  AdminBypassReason,
  "gdpr_request" | "incident_response"
>;

// Runtime allow-list. MUST mirror ProjectModerationDeleteReason exactly. If
// the type is widened, this constant must be widened in the same change. The
// platform-admin-grants-invariant test does not cover this; these two
// declarations must be kept in sync by hand.
const ALLOWED_REASONS: ReadonlyArray<ProjectModerationDeleteReason> = [
  "gdpr_request",
  "incident_response",
] as const;

// `moderationDeleteProject` is DISABLED. Project lifecycle is archive-only.
// The function stays exported because admin tooling may import it at the type
// level, but throws on call so no audit-then-delete can land.
export async function moderationDeleteProject(
  _projectId: string,
  _opts: { reason: ProjectModerationDeleteReason; ticketRef: string },
): Promise<{ ok: true; auditEventId?: string }> {
  throw new Error("project deletion removed - archive only");
}
