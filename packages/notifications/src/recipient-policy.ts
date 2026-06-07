import "server-only";

import type { NotificationRecipient } from "./types";
import { getNotificationsHostAdapters } from "./host-adapters";

// ---------------------------------------------------------------------------
// Recipient resolution
//
// Topic / admin / team / org / project recipients fan out to per-user rows
// at write time. Recipient rows always target concrete users; there is no
// nullable user_id fallback or join table. Resolution helpers MUST be
// defensive — they read from public."user" (better-auth) and from scope-tables.
// If a join query fails, callers fall back to "no recipient" rather than
// crashing the worker.
//
// Admins resolution matches isPlatformAdmin() exactly: any user whose
// comma-separated `role` column contains "admin".
//
// HOST-SCHEMA-AWARE BY DESIGN: this module legitimately encodes host schema
// knowledge — it queries Better Auth `public."user"` /
// `public."teamMember"` / `public."member"` and the host's
// `{schema}."project_co_owners"` table. The SQL strings stay HERE (they are
// the policy). Only the DB *access primitives* (connection string + sync
// query runner) and the project schema *name* are injected via
// `getNotificationsHostAdapters()`; the host adapter provides the same
// `process.env.SUPABASE_SCHEMA?.trim() || "cinatra"` schema resolution used
// by the application.
// ---------------------------------------------------------------------------

export function topicForRecipient(recipient: NotificationRecipient): string {
  switch (recipient.kind) {
    case "user":
      return `user:${recipient.userId}`;
    case "team":
      return `team:${recipient.teamId}`;
    case "organization":
      return `organization:${recipient.organizationId}`;
    case "project":
      return `project:${recipient.projectId}`;
    case "admins":
      return "admins";
  }
}

export async function resolveRecipientToUserIds(
  recipient: NotificationRecipient,
): Promise<string[]> {
  getNotificationsHostAdapters().ensurePostgresSchema();
  switch (recipient.kind) {
    case "user":
      return recipient.userId ? [recipient.userId] : [];
    case "admins":
      return resolvePlatformAdminUserIds();
    case "team":
      return resolveTeamMemberUserIds(recipient.teamId);
    case "organization":
      return resolveOrganizationMemberUserIds(recipient.organizationId);
    case "project":
      return resolveProjectMemberUserIds(recipient.projectId);
  }
}

function resolvePlatformAdminUserIds(): string[] {
  try {
    const host = getNotificationsHostAdapters();
    const [result] = host.runPostgresQueriesSync({
      connectionString: host.getPostgresConnectionString(),
      queries: [
        {
          // role is a comma-separated string per better-auth admin plugin.
          // Mirror isPlatformAdmin()'s split+trim+filter logic exactly so a
          // role value like "user, admin" (with whitespace) still matches.
          text: `SELECT id FROM public."user"
            WHERE role IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM unnest(string_to_array(role, ',')) AS r
                WHERE btrim(r) = 'admin'
              )`,
          values: [],
        },
      ],
    });
    const rows = (result?.rows ?? []) as Array<{ id: string }>;
    return rows.map((r) => r.id).filter((id) => typeof id === "string");
  } catch {
    return [];
  }
}

function resolveTeamMemberUserIds(teamId: string): string[] {
  if (!teamId) return [];
  try {
    const host = getNotificationsHostAdapters();
    const [result] = host.runPostgresQueriesSync({
      connectionString: host.getPostgresConnectionString(),
      queries: [
        {
          text: `SELECT "userId" AS id FROM public."teamMember" WHERE "teamId" = $1`,
          values: [teamId],
        },
      ],
    });
    const rows = (result?.rows ?? []) as Array<{ id: string }>;
    return rows.map((r) => r.id).filter((id) => typeof id === "string");
  } catch {
    return [];
  }
}

function resolveOrganizationMemberUserIds(organizationId: string): string[] {
  if (!organizationId) return [];
  try {
    const host = getNotificationsHostAdapters();
    const [result] = host.runPostgresQueriesSync({
      connectionString: host.getPostgresConnectionString(),
      queries: [
        {
          text: `SELECT "userId" AS id FROM public."member" WHERE "organizationId" = $1`,
          values: [organizationId],
        },
      ],
    });
    const rows = (result?.rows ?? []) as Array<{ id: string }>;
    return rows.map((r) => r.id).filter((id) => typeof id === "string");
  } catch {
    return [];
  }
}

function resolveProjectMemberUserIds(projectId: string): string[] {
  if (!projectId) return [];
  try {
    // project_co_owners lives in the cinatra schema; owner_id on the project
    // row itself is implicit and may map to user/team/org. This resolver fans
    // out explicit co-owner shares. Owner-level fanout should be added when
    // project ownership routing lands.
    //
    // The project schema name is the host-injected `postgresSchema` adapter
    // field. The host sets the adapter to
    // `process.env.SUPABASE_SCHEMA?.trim() || "cinatra"`, so the resolved SQL
    // matches the application schema selection.
    const host = getNotificationsHostAdapters();
    const schema = host.postgresSchema;
    const [result] = host.runPostgresQueriesSync({
      connectionString: host.getPostgresConnectionString(),
      queries: [
        {
          text: `SELECT user_id AS id FROM "${schema.replaceAll('"', '""')}"."project_co_owners" WHERE project_id = $1`,
          values: [projectId],
        },
      ],
    });
    const rows = (result?.rows ?? []) as Array<{ id: string }>;
    return rows.map((r) => r.id).filter((id) => typeof id === "string");
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Job → recipient mapping
//
// User-launched jobs: notify the initiator when present, otherwise skip.
// System jobs: success → no notification; failure → admins.
// ---------------------------------------------------------------------------

const USER_INITIATED_JOBS = new Set<string>([
  "blog-post-idea-generation",
  "blog-post-draft-generation",
  "blog-post-image-regeneration",
  "blog-post-wordpress-draft-creation",
  "blog-post-linkedin-draft-creation",
  "blog-post-linkedin-draft-publish",
  "agent-builder-execution",
  "skill-prefill-generation",
  "skill-match-inline-for-skill",
  "skill-match-inline-for-agent",
]);

const SYSTEM_JOBS = new Set<string>([
  "litellm-pricing-sync",
  "graphiti-projection-repair",
  // Periodic self-rescheduling maintenance loops (boot-seeded, canonical-id
  // re-delay). Silent on success; unhandled failure fans out to admins.
  "artifact-provider-cache-evict",
  "audit-retention-enforce",
  "registry-poll",
  "agent-run-trigger-release",
  "skill-match-batch-submit",
  "skill-match-batch-poll",
  // Marketplace catalog Verdaccio→catalog reconciliation. Two modes:
  // hourly full-sweep loop (canonical-id re-delay) + on-approval
  // single-package one-shot. Both are system-initiated.
  "marketplace-catalog-sync",
  // Vendor-application state reconciliation. 5-minute self-rescheduling
  // loop that finishes broker-OK-but-DB-failed approval transitions via the
  // sync-worker-only complete-recovery ability. System-initiated.
  "vendor-application-state-reconcile",
]);

// `started` is included so worker.on("active") can resolve a recipient for
// the in-progress notification row using the same policy as terminal events.
// Recipient resolution is identical for `started` and `completed` (user-init
// → initiator; system → null; unknown → null) so users only see in-progress
// rows for jobs whose terminal events they would also see.
type JobStatus = "started" | "completed" | "failed";

/**
 * Extract initiatorUserId from job.data if present. Worker callers should
 * include `initiatorUserId` at the top level of `job.data` for user-launched
 * jobs. Missing initiator on a user job means no notification; failures still
 * warn so attribution bugs are visible without crashing the worker.
 */
function extractInitiatorUserId(jobData: unknown): string | undefined {
  if (!jobData || typeof jobData !== "object") return undefined;
  const data = jobData as Record<string, unknown>;
  if (typeof data.initiatorUserId === "string" && data.initiatorUserId)
    return data.initiatorUserId;
  // ActorContext is also attached by enqueueBackgroundJob — fall back to its
  // principalId when the principal is a User.
  const actorContext = data.__actorContext as
    | { principalType?: string; principalId?: string }
    | undefined;
  // Only HumanUser principals carry a real user id (see ActorContext spec).
  if (
    actorContext &&
    actorContext.principalType === "HumanUser" &&
    typeof actorContext.principalId === "string"
  ) {
    return actorContext.principalId;
  }
  return undefined;
}

export function getRecipientForJob(args: {
  jobName: string | undefined;
  jobData: unknown;
  status: JobStatus;
}): NotificationRecipient | null {
  const jobName = args.jobName ?? "";
  if (USER_INITIATED_JOBS.has(jobName)) {
    const initiator = extractInitiatorUserId(args.jobData);
    if (initiator) {
      return { kind: "user", userId: initiator };
    }
    // `enqueueBackgroundJob` runs an auto-attribution cascade (ALS frame →
    // request session → undefined) so a user-job that lands here without an
    // initiator was enqueued from a non-user context: a worker child-enqueue
    // that opted out of inheritance, an admin/system path that should have
    // been classified as a system job, or a code path outside any request/ALS
    // frame. We still warn on failure so the mis-categorisation is visible in
    // worker logs.
    if (args.status === "failed") {
      console.warn(
        `[notifications] user-initiated job '${jobName}' failed but no initiator could be resolved (enqueued outside a request/ALS frame, or the site opted out of auto-attribution).`,
      );
    }
    return null;
  }
  if (SYSTEM_JOBS.has(jobName)) {
    if (args.status === "failed") {
      return { kind: "admins" };
    }
    return null;
  }
  // Unknown job — opt out to avoid surprise spam. Worker only logs when the
  // policy maker did not register a new job name.
  //
  // Suppress the warning for `started` status so worker.on("active") (which
  // fires for every picked job, including unclassified background jobs that
  // intentionally don't notify) doesn't log on every activation. The warning
  // still fires at `failed` time, keeping misclassification visible at
  // terminal events where it actually matters.
  if (jobName && args.status !== "started") {
    console.warn(
      `[notifications] unknown job '${jobName}' — policy returns null. Update USER_INITIATED_JOBS / SYSTEM_JOBS in recipient-policy.ts.`,
    );
  }
  return null;
}
