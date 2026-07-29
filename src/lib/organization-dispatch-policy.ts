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
 *    prohibit policy for organization mutation endpoints when the target org
 *    is archived, with a SPLIT read-error polarity (a design-review
 *    ruling): prohibited (mutation) endpoints fail CLOSED, cleanup/exit
 *    endpoints fail OPEN. Fires before the endpoint on BOTH transports (raw
 *    HTTP via the catch-all route; in-process `auth.api.*`).
 *
 * TARGET RESOLUTION IS ENDPOINT-CLASS-AWARE (V2 adversarial-review
 * findings 1 and 2): the org whose `archivedAt` this policy checks
 * is derived EXACTLY the way the endpoint itself derives its target —
 *  - team-target endpoints resolve ONLY via `body.teamId` -> the team's
 *    organization (an extra `body.organizationId` is IGNORED: trusting it
 *    would let a caller point the check at an active org while the endpoint
 *    mutated an archived org's team);
 *  - invitation-target endpoints resolve ONLY via `body.invitationId`;
 *  - organization-target endpoints resolve via `body.organizationId`, else
 *    `body.organizationSlug`, else the caller's active organization (the
 *    same default Better Auth's own org-scoped endpoints apply).
 * A resolution LOOKUP ERROR is treated as "archived state unknown" and takes
 * the SPLIT polarity (prohibited -> refuse, cleanup -> allow) — it never
 * falls back to checking some other org.
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
 * on a read error (design Decision 5) — there is no downstream
 * DB fence for these Better-Auth membership/invitation/furniture writes
 * pre-Stage-E, so this hook IS the fence.
 *
 * The first five are the design's Decision 5 table. The rest were added
 * after the V2 adversarial review (its finding 3): they are
 * the REMAINING Better-Auth organization mutation endpoints — invitation
 * create, member remove / role change, server-only member add, team CRUD,
 * and the org-settings update. Decision 7's per-action inventory already
 * rules every one of these "reject while archived" (manage capabilities are
 * zeroed on an archived org); the Decision 5 endpoint table simply had not
 * enumerated their Better-Auth-endpoint legs, which are directly reachable
 * (e.g. the invite dialog calls `authClient.organization.inviteMember`).
 */
export const ARCHIVED_PROHIBITED_ENDPOINTS = new Set<string>([
  // Design Decision 5's original prohibit table:
  "/organization/add-team-member",
  "/organization/remove-team-member",
  "/organization/set-active",
  "/organization/set-active-team",
  "/organization/accept-invitation",
  // Adversarial-review extension (V2 review finding 3) — same class, same
  // Decision 7 ruling:
  "/organization/invite-member",
  "/organization/remove-member",
  "/organization/update-member-role",
  "/organization/add-member",
  "/organization/create-team",
  "/organization/update-team",
  "/organization/remove-team",
  "/organization/update",
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
 * `"unknown"` when the archivedAt read (or the target resolution it depends
 * on) failed; the SPLIT polarity means the decision differs by
 * endpoint class in that case.
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

// ---- Target-organization resolution (endpoint-class-aware) -----------------

/**
 * How each policed endpoint names the organization it acts on. This mirrors
 * Better Auth's OWN target derivation, which is the anti-spoof property
 * (V2 review finding 1): the policy must check exactly the org the endpoint
 * will mutate, never an unrelated id a caller plants in the body.
 */
export const ENDPOINT_TARGET_CLASS: Record<string, "team" | "invitation" | "organization"> = {
  "/organization/add-team-member": "team",
  "/organization/remove-team-member": "team",
  "/organization/set-active-team": "team",
  "/organization/update-team": "team",
  "/organization/remove-team": "team",
  "/organization/accept-invitation": "invitation",
  "/organization/reject-invitation": "invitation",
  "/organization/cancel-invitation": "invitation",
  "/organization/set-active": "organization",
  "/organization/leave": "organization",
  "/organization/invite-member": "organization",
  "/organization/remove-member": "organization",
  "/organization/update-member-role": "organization",
  "/organization/add-member": "organization",
  "/organization/create-team": "organization",
  "/organization/update": "organization",
};

/**
 * Resolution outcome. `unresolvable` = the request carries no authoritative
 * target (missing/blank id, an explicit `null` unset, or an id that matches
 * no row) — the endpoint's own validation/authorization handles it, and this
 * policy stands aside. `error` = a lookup FAILED — the archived state is
 * unknowable, and the SPLIT polarity governs (prohibited -> refuse, cleanup
 * -> allow). Never a fallback to a different org (V2 review finding 2).
 */
export type DispatchTargetResolution =
  | { kind: "resolved"; organizationId: string }
  | { kind: "unresolvable" }
  | { kind: "error" };

export type ResolveTargetDeps = {
  readTeamOrganizationId: (teamId: string) => Promise<string | null>;
  readInvitationOrganizationId: (invitationId: string) => Promise<string | null>;
  readOrganizationIdBySlug: (slug: string) => Promise<string | null>;
};

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function resolveDispatchTarget(
  path: string,
  body: Record<string, unknown> | null | undefined,
  activeOrganizationId: string | null | undefined,
  deps: ResolveTargetDeps,
): Promise<DispatchTargetResolution> {
  const cls = ENDPOINT_TARGET_CLASS[path];
  if (!cls) return { kind: "unresolvable" };
  const b = body ?? {};

  if (cls === "team") {
    // `set-active-team` with `teamId: null` UNSETS the active team — a
    // cleanup motion with no target org; never police it.
    const teamId = nonEmptyString(b["teamId"]);
    if (!teamId) return { kind: "unresolvable" };
    try {
      const orgId = await deps.readTeamOrganizationId(teamId);
      return orgId ? { kind: "resolved", organizationId: orgId } : { kind: "unresolvable" };
    } catch {
      return { kind: "error" };
    }
  }

  if (cls === "invitation") {
    const invitationId = nonEmptyString(b["invitationId"]);
    if (!invitationId) return { kind: "unresolvable" };
    try {
      const orgId = await deps.readInvitationOrganizationId(invitationId);
      return orgId ? { kind: "resolved", organizationId: orgId } : { kind: "unresolvable" };
    } catch {
      return { kind: "error" };
    }
  }

  // cls === "organization"
  // `set-active` with an explicit `organizationId: null` UNSETS the active
  // organization — the escape hatch a user whose session still points at an
  // archived org needs; policing it (via the active-org fallback below)
  // would trap them. Never police an explicit unset.
  if (path === "/organization/set-active" && b["organizationId"] === null) {
    return { kind: "unresolvable" };
  }
  const explicitOrgId = nonEmptyString(b["organizationId"]);
  if (explicitOrgId) return { kind: "resolved", organizationId: explicitOrgId };
  const slug = nonEmptyString(b["organizationSlug"]);
  if (slug) {
    try {
      const orgId = await deps.readOrganizationIdBySlug(slug);
      return orgId ? { kind: "resolved", organizationId: orgId } : { kind: "unresolvable" };
    } catch {
      return { kind: "error" };
    }
  }
  // Better Auth's org-scoped endpoints default to the caller's active
  // organization when the body names none — mirror exactly that.
  const fallback = nonEmptyString(activeOrganizationId);
  if (fallback) return { kind: "resolved", organizationId: fallback };
  return { kind: "unresolvable" };
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

async function readOrganizationIdBySlugSql(slug: string): Promise<string | null> {
  const [{ betterAuthDb }, { sql }] = await Promise.all([
    import("@/lib/better-auth-db"),
    import("drizzle-orm"),
  ]);
  const rows = await betterAuthDb.execute<{ id: string }>(
    sql`SELECT id FROM public."organization" WHERE slug = ${slug} LIMIT 1`,
  );
  return rows.rows?.[0]?.id ?? null;
}

export type ReadArchivedAt = (organizationId: string) => Promise<Date | string | null>;

export type DispatchPolicyHookDeps = Partial<ResolveTargetDeps & { readArchivedAt: ReadArchivedAt }>;

/**
 * The Better-Auth `{matcher, handler}` before-hook entry for `hooks.before`.
 * `deps` overrides are for tests only — production wiring (`auth.ts`) calls
 * this with no arguments, using the real DB readers.
 */
export function buildOrganizationDispatchPolicyBeforeHook(deps: DispatchPolicyHookDeps = {}) {
  const readArchivedAt = deps.readArchivedAt ?? readOrganizationArchivedAt;
  const resolveDeps: ResolveTargetDeps = {
    readTeamOrganizationId: deps.readTeamOrganizationId ?? readTeamOrganizationIdSql,
    readInvitationOrganizationId:
      deps.readInvitationOrganizationId ?? readInvitationOrganizationIdSql,
    readOrganizationIdBySlug: deps.readOrganizationIdBySlug ?? readOrganizationIdBySlugSql,
  };

  return {
    matcher: (ctx: { path: string }) => POLICED_ENDPOINTS.has(ctx.path),
    handler: createAuthMiddleware(async (ctx) => {
      const session = (ctx.context as { session?: { session?: { activeOrganizationId?: string | null } } })
        .session;
      const resolution = await resolveDispatchTarget(
        ctx.path,
        (ctx.body ?? null) as Record<string, unknown> | null,
        session?.session?.activeOrganizationId ?? null,
        resolveDeps,
      );
      // No authoritative target in the request — the endpoint's own
      // validation/authorization handles it; this policy stands aside.
      if (resolution.kind === "unresolvable") return;

      let archived: boolean | "unknown";
      if (resolution.kind === "error") {
        archived = "unknown";
      } else {
        try {
          const archivedAt = await readArchivedAt(resolution.organizationId);
          archived = archivedAt !== null && archivedAt !== undefined;
        } catch {
          archived = "unknown";
        }
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
