"use server";

// ---------------------------------------------------------------------------
// Guest access server actions (cinatra#1501 — ratified: email only, no CRM).
//
// A guest grant is the existing customer grant, unchanged: role_grant(
// role="customer", scopeLevel="project", expiresAt) for the read-mostly
// capability ceiling + project_access(user, read) for sealed-room visibility
// (src/lib/authz/customer-grant-store.ts). The authz kernel role name stays
// "customer"; only the UI says "Guest". Guests are NEVER org members.
//
// Invite is by EMAIL. Existing accounts are CLASSIFIED before any grant —
// an organization member or an already-authorized project user must never be
// relabeled a "guest" (false copy, ambiguous revoke):
//   - any org membership            → { error: "already-member" }
//   - existing guest grant here     → idempotent refresh (expiry updated)
//   - other project access here     → { error: "already-has-access" }
//   - truly external account        → guest grant
//
// Unknown emails create an account through SANCTIONED paths only — the
// closed-registration gate (auth.ts user.create.before →
// closed-registration-gate.ts) is honored, never tunneled:
//   - signUpEmail (public-path semantics; allowed while registration is open)
//   - on REGISTRATION_CLOSED: a PLATFORM-admin inviter retries via the admin
//     plugin's /admin/create-user (the gate's always-allowed D1 context, with
//     the actor's own headers); anyone else gets a structured
//     "registration-closed" error (existing accounts stay grantable).
// The new guest then receives a password-reset email (existing
// sendResetPassword wiring) to set their own password. A send failure does
// NOT unwind the invite — it is surfaced as resetEmailSent: false.
// ---------------------------------------------------------------------------

import { randomBytes } from "node:crypto";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { auth } from "@/lib/auth";
import {
  isPlatformAdmin,
  requireAuthSession,
  resolveOrgRoleForSession,
} from "@/lib/auth-session";
import {
  readProjectGrantsForUser,
  readTeamsForUser,
  readUserByEmail,
  readUserIsOrgMember,
  readUsersByIds,
} from "@/lib/better-auth-db";
import { readProjectById } from "@/lib/projects-store";
import { AuthzError } from "@/lib/authz/errors";
import {
  grantCustomerAccess,
  revokeCustomerAccess,
  listCustomerGrantsForProject,
} from "@/lib/authz/customer-grant-store";

/** Kept in sync with better-auth's REGISTRATION_CLOSED_CODE (closed-registration-gate.ts). */
const REGISTRATION_CLOSED_CODE = "REGISTRATION_CLOSED";

/** The better-auth-ui reset-password view (same static family as accept-invitation). */
const RESET_PASSWORD_PATH = "/permissions/reset-password";

export type GuestRow = {
  subjectUserId: string;
  name: string | null;
  email: string | null;
  grantedAt: string;
  expiresAt: string | null;
};

export type GuestInviteResult =
  | {
      ok: true;
      guest: { userId: string; email: string; name: string | null; existed: boolean };
      /** false when the account was created but the set-password email failed to send. */
      resetEmailSent: boolean;
    }
  | {
      ok: false;
      error:
        | "invalid-email"
        | "already-member"
        | "already-has-access"
        | "registration-closed"
        | "forbidden"
        | "unknown";
    };

// Same authority as the retired customers actions: only a project admin/owner
// (or platform admin) manages guest access. The tenant is the TARGET
// PROJECT's organization (row tenant id — the enforceResourceAccess
// precedent), never the actor's active org: a platform admin or an actor with
// a stale active org must not write the grant under the wrong tenant.
async function assertProjectAdmin(
  projectId: string,
): Promise<{ orgId: string; userId: string; platformAdmin: boolean }> {
  const session = await requireAuthSession();
  const userId = session.user.id;
  const project = await readProjectById(projectId);
  const orgId = project?.organizationId ?? null;
  if (!project || !orgId) {
    throw new AuthzError({ statusCode: 403, reason: "forbidden", message: "Project not found." });
  }
  if (isPlatformAdmin(session)) return { orgId, userId, platformAdmin: true };
  const teamRows = await readTeamsForUser(userId, orgId).catch(() => []);
  const orgRole = await resolveOrgRoleForSession(session).catch(() => null);
  const grants = await readProjectGrantsForUser(userId, orgId, {
    teamIds: teamRows.map((t) => t.id),
    ...(orgRole ? { orgRole } : {}),
  }).catch(() => []);
  const here = grants.find((g) => g.projectId === projectId);
  if (!here || (here.effectiveRole !== "admin" && here.effectiveRole !== "owner")) {
    throw new AuthzError({ statusCode: 403, reason: "forbidden", message: "Project admin required." });
  }
  return { orgId, userId, platformAdmin: false };
}

// Light shape check only — the address is proven by the invite email itself.
function isPlausibleEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isRegistrationClosedError(err: unknown): boolean {
  const body = (err as { body?: { code?: unknown } } | null)?.body;
  return body?.code === REGISTRATION_CLOSED_CODE;
}

/**
 * Create the guest's user row through the sanctioned creation paths (see the
 * module header). Returns the created/raced user id.
 */
async function createGuestAccount(input: {
  email: string;
  platformAdmin: boolean;
}): Promise<{ userId: string } | { error: "registration-closed" | "unknown" }> {
  const name = input.email.split("@")[0] || input.email;
  // ≥ minPasswordLength (12); the guest never learns it — they set their own
  // via the reset email. base64url of 24 bytes = 32 chars.
  const password = randomBytes(24).toString("base64url");
  try {
    const signedUp = await auth.api.signUpEmail({
      body: { email: input.email, password, name },
    });
    const userId = signedUp?.user?.id;
    if (userId) return { userId };
  } catch (err) {
    if (isRegistrationClosedError(err)) {
      if (!input.platformAdmin) return { error: "registration-closed" };
      try {
        // Sanctioned D1 context: the admin plugin's /admin/create-user, under
        // the acting platform admin's own session headers.
        const created = await auth.api.createUser({
          body: { email: input.email, password, name, role: "user" },
          headers: await headers(),
        });
        const adminCreatedId = created?.user?.id;
        if (adminCreatedId) return { userId: adminCreatedId };
      } catch {
        // fall through to the race re-read below
      }
    }
    // Duplicate/race (a concurrent invite may have created the row between
    // our read and the signUp — dev-auto-setup.ts precedent): re-read by email.
  }
  const raced = await readUserByEmail(input.email);
  if (raced) return { userId: raced.id };
  return { error: "unknown" };
}

export async function inviteGuestByEmailAction(
  projectId: string,
  emailRaw: string,
  expiresAtRaw?: string | null,
): Promise<GuestInviteResult> {
  try {
    const email = String(emailRaw ?? "").trim().toLowerCase();
    if (!projectId || !isPlausibleEmail(email)) return { ok: false, error: "invalid-email" };
    const { orgId, userId: actorId, platformAdmin } = await assertProjectAdmin(projectId);
    const expiresAt = expiresAtRaw ? new Date(expiresAtRaw) : null;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) return { ok: false, error: "unknown" };

    const existing = await readUserByEmail(email);
    if (existing) {
      // Classification (order matters — a member of the TARGET org is a
      // member even if a stray guest grant exists; membership in some other
      // org does not disqualify an external collaborator):
      if (await readUserIsOrgMember(existing.id, orgId)) {
        return { ok: false, error: "already-member" };
      }
      const guestGrants = await listCustomerGrantsForProject(projectId);
      const alreadyGuest = guestGrants.some((g) => g.subjectUserId === existing.id);
      if (!alreadyGuest) {
        // Any effective access WITHOUT a guest grant = standard authorization
        // (a direct user-level Project access row) — do not relabel it.
        const subjectGrants = await readProjectGrantsForUser(existing.id, orgId, {
          teamIds: [],
        }).catch(() => []);
        if (subjectGrants.some((g) => g.projectId === projectId)) {
          return { ok: false, error: "already-has-access" };
        }
      }
      // Idempotent grant/refresh (expiry updated by the upsert).
      await grantCustomerAccess({
        subjectUserId: existing.id,
        projectId,
        orgId,
        grantedBy: actorId,
        expiresAt,
      });
      revalidatePath(`/projects/${projectId}/permissions`);
      // An existing account has a login path already — no reset email.
      return {
        ok: true,
        guest: { userId: existing.id, email, name: existing.name, existed: true },
        resetEmailSent: false,
      };
    }

    const created = await createGuestAccount({ email, platformAdmin });
    if ("error" in created) return { ok: false, error: created.error };

    await grantCustomerAccess({
      subjectUserId: created.userId,
      projectId,
      orgId,
      grantedBy: actorId,
      expiresAt,
    });

    let resetEmailSent = true;
    try {
      await auth.api.requestPasswordReset({
        body: { email, redirectTo: RESET_PASSWORD_PATH },
      });
    } catch {
      // Do NOT unwind the invite — surface honestly; the guest can still use
      // "Forgot password", or the admin can re-invite to retry the email.
      resetEmailSent = false;
    }

    revalidatePath(`/projects/${projectId}/permissions`);
    return {
      ok: true,
      guest: { userId: created.userId, email, name: null, existed: false },
      resetEmailSent,
    };
  } catch (err) {
    if (err instanceof AuthzError) return { ok: false, error: "forbidden" };
    return { ok: false, error: "unknown" };
  }
}

export async function revokeGuestAction(
  projectId: string,
  subjectUserId: string,
): Promise<{ ok: boolean }> {
  try {
    if (!projectId || !subjectUserId) return { ok: false };
    await assertProjectAdmin(projectId);
    // Removes exactly the two rows the guest grant wrote (role_grant +
    // project_access), keyed per (subjectUserId, projectId) — unrelated
    // grants are untouched.
    await revokeCustomerAccess({ subjectUserId, projectId });
    revalidatePath(`/projects/${projectId}/permissions`);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/**
 * Guest rows for the permissions page loader — PROJECT-ADMIN-ONLY (guest
 * emails are not shown to read-only members; the caller gates on canEdit and
 * this re-asserts server-side).
 */
export async function listGuestRows(projectId: string): Promise<GuestRow[]> {
  await assertProjectAdmin(projectId);
  const grants = await listCustomerGrantsForProject(projectId);
  const users = await readUsersByIds(grants.map((g) => g.subjectUserId));
  const byId = new Map(users.map((u) => [u.id, u]));
  return grants.map((g) => ({
    subjectUserId: g.subjectUserId,
    name: byId.get(g.subjectUserId)?.name ?? null,
    email: byId.get(g.subjectUserId)?.email ?? null,
    grantedAt: g.grantedAt.toISOString(),
    expiresAt: g.expiresAt ? g.expiresAt.toISOString() : null,
  }));
}
