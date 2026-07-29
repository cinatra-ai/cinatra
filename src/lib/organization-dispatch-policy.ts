import "server-only";
import { createAuthMiddleware, APIError } from "better-auth/api";
import { readOrganizationArchivedAt } from "@/lib/organization-archive-guard";

/**
 * Better-Auth dispatch-hook endpoint policy (cinatra#1942 archive V2,
 * Decision 5, mechanisms 2 + 3). Wired into `src/lib/auth.ts`'s top-level
 * `hooks:` config — the FIRST such layer on the `betterAuth()` call (see the
 * design doc's Decision 5 / GROUNDING.md §5.B). Kept in this plain,
 * non-`auth*`-named module so the decision logic is unit-testable without
 * constructing a live `betterAuth()` instance; `auth.ts` only wires the two
 * builders below into `hooks.before` / `hooks.after`.
 *
 * Two mechanisms:
 *  - Mechanism 2 — the `/organization/list` AFTER-hook: strips archived rows
 *    from the response on BOTH transports (raw HTTP +
 *    `auth.api.listOrganizations`). Fails OPEN on an unrecognized response
 *    shape (never hides on uncertainty, only on a confirmed archived row).
 *  - Mechanism 3 — the dispatch-hook BEFORE-hook: a per-endpoint allow/
 *    prohibit policy for organization membership/invitation endpoints when
 *    the target org is archived, with a SPLIT read-error polarity (codex r0
 *    finding #6): prohibited (membership-write) endpoints fail CLOSED,
 *    cleanup/exit endpoints fail OPEN. Fires before the endpoint on BOTH
 *    transports (raw HTTP via the catch-all route; in-process `auth.api.*`).
 */

// ---------------------------------------------------------------------------
// Mechanism 2 — /organization/list after-hook
// ---------------------------------------------------------------------------

export const ORGANIZATION_LIST_ENDPOINT = "/organization/list";

/** The shape of one row Better Auth's `/organization/list` returns — only the
 *  field this hook reads. `archivedAt` rides the response via the
 *  `additionalFields` declaration (`better-auth-schema.ts`, cinatra#1937). */
export type ListedOrganizationRow = { archivedAt?: unknown } & Record<string, unknown>;

/**
 * Pure filter — never show archived organizations in the default list
 * (Decision 3: visibility surfaces read `archivedAt` directly, not the
 * activation gate — this hook has nothing to do while the gate is off,
 * because no org can be archived yet, and starts behaving correctly the
 * instant the first org is archived post-flip).
 */
export function filterArchivedOrganizations<T extends ListedOrganizationRow>(
  rows: readonly T[],
): T[] {
  return rows.filter((row) => row.archivedAt === null || row.archivedAt === undefined);
}

/**
 * Best-effort extraction of the organization array from whatever shape
 * `ctx.context.returned` holds after `/organization/list` runs. Better
 * Auth's `listOrganizations` endpoint returns an array directly; this
 * defensively also accepts a `{organizations: [...]}` wrapper in case a
 * future version changes the envelope. Returns `null` for an unrecognized
 * shape — the after-hook then fails OPEN (Decision 5): never hide anything
 * when the response shape can't be confirmed.
 */
export function extractOrganizationListPayload(
  returned: unknown,
): ListedOrganizationRow[] | null {
  if (Array.isArray(returned)) return returned as ListedOrganizationRow[];
  if (
    returned &&
    typeof returned === "object" &&
    Array.isArray((returned as { organizations?: unknown }).organizations)
  ) {
    return (returned as { organizations: ListedOrganizationRow[] }).organizations;
  }
  return null;
}

/** The Better-Auth `{matcher, handler}` after-hook entry for `hooks.after`. */
export function buildOrganizationListAfterHook() {
  return {
    matcher: (ctx: { path: string }) => ctx.path === ORGANIZATION_LIST_ENDPOINT,
    handler: createAuthMiddleware(async (ctx) => {
      const returned = (ctx.context as { returned?: unknown }).returned;
      const organizations = extractOrganizationListPayload(returned);
      // Fail OPEN on an unrecognized shape (Decision 5) — never throw here;
      // worst case a stale archived org briefly shows in a picker, never a
      // broken /organization/list response.
      if (!organizations) return;
      const filtered = filterArchivedOrganizations(organizations);
      if (filtered.length === organizations.length) return; // nothing to strip
      if (Array.isArray(returned)) {
        (ctx.context as { returned: unknown }).returned = filtered;
      } else {
        (ctx.context as { returned: unknown }).returned = {
          ...(returned as object),
          organizations: filtered,
        };
      }
    }),
  };
}

// ---------------------------------------------------------------------------
// Mechanism 3 — dispatch-hook endpoint policy (SPLIT polarity)
// ---------------------------------------------------------------------------

/**
 * Endpoints that must REFUSE while the target org is archived. Fail CLOSED
 * on a read error (Decision 5 / codex r0 finding #6) — there is no
 * downstream DB fence for these Better-Auth membership/invitation writes
 * pre-Stage-E, so this hook IS the fence.
 */
export const ARCHIVED_PROHIBITED_ENDPOINTS = new Set<string>([
  "/organization/add-team-member",
  "/organization/remove-team-member",
  "/organization/set-active",
  "/organization/set-active-team",
  "/organization/accept-invitation",
]);

/**
 * Cleanup/exit endpoints that stay ALLOWED even while the target org is
 * archived. Fail OPEN on a read error — a user must never be trapped in an
 * archived org by a transient read failure.
 */
export const ARCHIVED_CLEANUP_ENDPOINTS = new Set<string>([
  "/organization/leave",
  "/organization/reject-invitation",
  "/organization/cancel-invitation",
]);

const POLICED_ENDPOINTS = new Set<string>([
  ...ARCHIVED_PROHIBITED_ENDPOINTS,
  ...ARCHIVED_CLEANUP_ENDPOINTS,
]);

export type DispatchPolicyDecision = "allow" | "refuse" | "not-policed";

/**
 * Pure decision function — no I/O, fully unit-testable. `archived` is
 * `"unknown"` when the archivedAt read failed; the SPLIT polarity (codex r0
 * finding #6) means the decision differs by endpoint class in that case.
 */
export function decideDispatchPolicy(
  path: string,
  archived: boolean | "unknown",
): DispatchPolicyDecision {
  const isProhibited = ARCHIVED_PROHIBITED_ENDPOINTS.has(path);
  const isCleanup = ARCHIVED_CLEANUP_ENDPOINTS.has(path);
  if (!isProhibited && !isCleanup) return "not-policed";
  if (archived === "unknown") return isProhibited ? "refuse" : "allow";
  if (!archived) return "allow"; // active org — the policy is a no-op
  return isProhibited ? "refuse" : "allow"; // archived: cleanup stays allowed
}

// ---- Target-organization-id resolution -------------------------------------

export type DispatchPolicyRequest = {
  path: string;
  body: Record<string, unknown> | null | undefined;
  activeOrganizationId?: string | null;
};

export type ResolveOrgIdDeps = {
  readTeamOrganizationId: (teamId: string) => Promise<string | null>;
  readInvitationOrganizationId: (invitationId: string) => Promise<string | null>;
};

/**
 * Resolve the organization a policed request TARGETS, trying the body shapes
 * Better Auth's org+teams endpoints actually carry (grounded against this
 * repo's own `auth.api.*` call sites — `setActiveOrganization({body:
 * {organizationId}})` in `src/app/teams/new/actions.ts`, `cancelInvitation(
 * {body:{invitationId}})` in `organization-manage-actions.ts`):
 *   1. an explicit `body.organizationId`;
 *   2. `body.teamId` -> the team's organization (add/remove-team-member, set-active-team);
 *   3. `body.invitationId` -> the invitation's organization (accept/reject/cancel-invitation);
 *   4. the caller's current active organization (best-effort fallback only).
 * Returns `null` when no target can be determined — the caller must then
 * treat the request as un-policeable (never guess and block/allow blindly;
 * the endpoint's own validation/authorization still runs normally).
 */
export async function resolveDispatchTargetOrganizationId(
  req: DispatchPolicyRequest,
  deps: ResolveOrgIdDeps,
): Promise<string | null> {
  const body = req.body ?? {};

  const explicitOrgId = body["organizationId"];
  if (typeof explicitOrgId === "string" && explicitOrgId.length > 0) {
    return explicitOrgId;
  }

  const teamId = body["teamId"];
  if (typeof teamId === "string" && teamId.length > 0) {
    try {
      const orgId = await deps.readTeamOrganizationId(teamId);
      if (orgId) return orgId;
    } catch {
      // fall through to other resolution strategies — never crash the hook.
    }
  }

  const invitationId = body["invitationId"];
  if (typeof invitationId === "string" && invitationId.length > 0) {
    try {
      const orgId = await deps.readInvitationOrganizationId(invitationId);
      if (orgId) return orgId;
    } catch {
      // fall through
    }
  }

  if (typeof req.activeOrganizationId === "string" && req.activeOrganizationId.length > 0) {
    return req.activeOrganizationId;
  }

  return null;
}

// ---- Real I/O (default deps; injectable for tests) -------------------------

async function readTeamOrganizationIdSql(teamId: string): Promise<string | null> {
  const [{ betterAuthDb }, { sql }] = await Promise.all([
    import("@/lib/better-auth-db"),
    import("drizzle-orm"),
  ]);
  const rows = await betterAuthDb.execute<{ organizationId: string }>(
    sql`SELECT "organizationId" FROM public."team" WHERE id = ${teamId} LIMIT 1`,
  );
  return rows.rows?.[0]?.organizationId ?? null;
}

async function readInvitationOrganizationIdSql(invitationId: string): Promise<string | null> {
  const [{ betterAuthDb }, { sql }] = await Promise.all([
    import("@/lib/better-auth-db"),
    import("drizzle-orm"),
  ]);
  const rows = await betterAuthDb.execute<{ organizationId: string }>(
    sql`SELECT "organizationId" FROM public."invitation" WHERE id = ${invitationId} LIMIT 1`,
  );
  return rows.rows?.[0]?.organizationId ?? null;
}

export type ReadArchivedAt = (organizationId: string) => Promise<Date | string | null>;

export type DispatchPolicyHookDeps = Partial<ResolveOrgIdDeps & { readArchivedAt: ReadArchivedAt }>;

/**
 * The Better-Auth `{matcher, handler}` before-hook entry for `hooks.before`.
 * `deps` overrides are for tests only — production wiring (`auth.ts`) calls
 * this with no arguments, using the real DB readers.
 */
export function buildOrganizationDispatchPolicyBeforeHook(deps: DispatchPolicyHookDeps = {}) {
  const readArchivedAt = deps.readArchivedAt ?? readOrganizationArchivedAt;
  const readTeamOrganizationId = deps.readTeamOrganizationId ?? readTeamOrganizationIdSql;
  const readInvitationOrganizationId =
    deps.readInvitationOrganizationId ?? readInvitationOrganizationIdSql;

  return {
    matcher: (ctx: { path: string }) => POLICED_ENDPOINTS.has(ctx.path),
    handler: createAuthMiddleware(async (ctx) => {
      const session = (ctx.context as { session?: { session?: { activeOrganizationId?: string | null } } })
        .session;
      const orgId = await resolveDispatchTargetOrganizationId(
        {
          path: ctx.path,
          body: (ctx.body ?? null) as Record<string, unknown> | null,
          activeOrganizationId: session?.session?.activeOrganizationId ?? null,
        },
        { readTeamOrganizationId, readInvitationOrganizationId },
      );
      // Never guess: if the target org cannot be determined, this hook does
      // not police the request — the endpoint's own validation/authorization
      // still runs normally.
      if (!orgId) return;

      let archived: boolean | "unknown";
      try {
        const archivedAt = await readArchivedAt(orgId);
        archived = archivedAt !== null && archivedAt !== undefined;
      } catch {
        archived = "unknown";
      }

      const decision = decideDispatchPolicy(ctx.path, archived);
      if (decision === "refuse") {
        throw APIError.from("FORBIDDEN", {
          code: "ORGANIZATION_ARCHIVED",
          message: "This organization is archived; that action is unavailable.",
        });
      }
      // "allow" / "not-policed" — no-op, let the endpoint proceed.
    }),
  };
}
