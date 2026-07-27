import "server-only";
/**
 * The AUTHORIZATION half of the lifecycle policy write path and the gate-volume
 * read (cinatra#2047 — defect D-3 + row 9; epic #2037 S0 lattice layer 1).
 *
 * The store leaf (`@cinatra-ai/agents/lifecycle-policy-store`) is deliberately a
 * set of plain org-scoped ports — the `listReviewGatesForRun` precedent, where
 * "access enforcement is the aggregate reader's job". THIS module is that job. It
 * is the ONLY place the two lifecycle-admin powers are decided, so the page, the
 * server actions and the reviewer surface can never drift apart:
 *
 *   WRITE a bound  → `settings.update` — the platform's org-administration write
 *     power (org_admin / org_owner / platform_admin). An org bound is a policy
 *     FLOOR or CEILING over every producing agent in the org; it is org
 *     administration, not resource CRUD, so it takes the platform-level
 *     settings power rather than any `artifact.*` grant. NOTE the two gates are
 *     independent: a Next.js server action is a POST endpoint invocable WITHOUT
 *     the page that renders its form, so THIS check — not the console page's own
 *     `requireAdminSession` — is the authoritative boundary on the write. (The
 *     console page is platform-admin-gated today, which is strictly narrower;
 *     widening it to org admins is a product decision about the console's three
 *     other tabs, not this gate's.)
 *   READ the volume → `settings.read` — held by `member` as well, because the
 *     backlog question row 9 exists to answer ("how many reviews are open?") is a
 *     REVIEWER's question, and every org member can hold `run.approveHitl`. The
 *     read exposes gate identity, age and the policy axes — never artifact
 *     content and never a decision affordance.
 *
 * TWO fail-closed properties this module exists to hold:
 *
 *  1. THE ORG IS NEVER A CLIENT INPUT. `orgId` comes from the caller's session
 *     (`session.session.activeOrganizationId`); a session with no active org is
 *     REFUSED, never silently widened to "all orgs".
 *  2. THE ROLE-LESS ACTOR IS DENIED, LOUDLY. This is the #1625 D3 trap — a
 *     principal that carries no role made `filterByAuthz` silently drop every row
 *     and the caller CONTINUED with an empty result. Two things stop that here.
 *     First, every refusal is an explicit `{ ok: false, reason }` the caller must
 *     branch on; nothing "continues without a role". Second — and this is the
 *     subtle half — the kernel SYNTHESIZES a `member` floor when membership does
 *     not resolve (`buildActorContext` defaults `orgRole` to "member"), and
 *     `member` DOES hold `settings.read`. Relying on that would let a stale
 *     `activeOrganizationId` (membership since revoked) read another org's
 *     backlog. So this gate REQUIRES a genuinely resolved membership for the
 *     org-scoped read; only a platform admin is exempt, and that exemption is
 *     explicit rather than a synthesized default.
 */
import { canDo } from "@/lib/authz/enforce";
import {
  buildCanDoOptsFromSession,
  getAuthSession,
  isPlatformAdmin,
} from "@/lib/auth-session";

/** Why a lifecycle-admin capability was refused. Distinguished so a surface can
 * say "sign in" vs "pick an organization" vs "you lack the power" — and so tests
 * can assert WHICH guard fired, not merely that access was denied. */
export type LifecycleAccessDenial = "no-session" | "no-active-org" | "forbidden";

export type LifecycleAccess =
  | { ok: true; orgId: string; userId: string }
  | { ok: false; reason: LifecycleAccessDenial };

/**
 * The STRUCTURAL slice of a Better Auth session this module reads — the same
 * shape the authz kernel's own `BetterAuthSessionLike` accepts. Declared
 * structurally (rather than as `Awaited<ReturnType<typeof getAuthSession>>`) so
 * the gate is callable with any session-shaped value: the real session, a
 * route-resolved one, or a test fixture. It cannot widen authority — every
 * decision below still runs through the real kernel.
 */
export type LifecycleAccessSession = {
  user: { id: string; role?: string | null };
  session?: { activeOrganizationId?: string | null } | null;
} | null;

type SessionLike = LifecycleAccessSession;

/**
 * The shared gate. Resolves the session, REFUSES an org-less one, resolves the
 * caller's active-org role, and asks the kernel for the named permission. Pure
 * fail-closed: every non-`ok` path is an explicit reason, never a permissive
 * fallthrough.
 */
async function resolveLifecycleAccess(
  permission: "settings.update" | "settings.read",
  session: SessionLike,
): Promise<LifecycleAccess> {
  if (!session?.user?.id) return { ok: false, reason: "no-session" };
  const orgId = session.session?.activeOrganizationId ?? null;
  // Fail closed rather than widen: a lifecycle bound and a gate backlog are both
  // org-scoped concepts; without an org there is nothing legitimate to read or
  // write, and "no org" must never resolve to "every org".
  if (!orgId) return { ok: false, reason: "no-active-org" };

  const opts = await buildCanDoOptsFromSession({
    user: { id: session.user.id },
    session: { activeOrganizationId: orgId },
  });

  // MEMBERSHIP MUST RESOLVE. `buildCanDoOptsFromSession` returns `{}` when the
  // caller has no membership row in the active org; the kernel would then
  // synthesize its `member` default, which holds `settings.read` — so a session
  // still naming an org it was removed from could read that org's backlog. Fail
  // closed instead. Platform admins are the ONE explicit exemption (they carry a
  // real platform role, not a synthesized org one).
  if (!opts.orgRole && !isPlatformAdmin(session)) {
    return { ok: false, reason: "forbidden" };
  }
  // Pass the ALREADY-RESOLVED org, never the raw (optionally absent) session
  // shape: the kernel scopes its synthetic platform resource to the actor's org,
  // and the refusal above has already proven one exists.
  if (
    !canDo(
      { user: session.user, session: { activeOrganizationId: orgId } },
      permission,
      undefined,
      opts,
    )
  ) {
    return { ok: false, reason: "forbidden" };
  }
  return { ok: true, orgId, userId: session.user.id };
}

/** May the caller WRITE this org's lifecycle policy bounds? (`settings.update`) */
export async function resolvePolicyBoundWriteAccess(
  session?: SessionLike,
): Promise<LifecycleAccess> {
  // `undefined` means "resolve the ambient session"; an EXPLICIT `null` means
  // "there is no session" and must stay a refusal, never a silent re-resolve.
  return resolveLifecycleAccess(
    "settings.update",
    session === undefined ? await getAuthSession() : session,
  );
}

/** May the caller READ this org's review-gate volume? (`settings.read` — held by
 * a plain member, i.e. by a reviewer.) */
export async function resolveGateVolumeReadAccess(
  session?: SessionLike,
): Promise<LifecycleAccess> {
  return resolveLifecycleAccess(
    "settings.read",
    session === undefined ? await getAuthSession() : session,
  );
}

/** A one-line, non-leaking explanation for a refused lifecycle-admin surface. */
export function lifecycleAccessMessage(reason: LifecycleAccessDenial): string {
  switch (reason) {
    case "no-session":
      return "Sign in to view this.";
    case "no-active-org":
      return "Select an organization to view this.";
    case "forbidden":
      return "You do not have permission to view this.";
    default: {
      const _exhaustive: never = reason;
      void _exhaustive;
      return "You do not have permission to view this.";
    }
  }
}
