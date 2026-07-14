// Pure, app-graph-free builders for the org member-invitation email
// (cinatra#1565). Kept dependency-free (no imports, no `@/` aliases, no
// `server-only`, no React) so it is unit-testable in isolation AND importable
// from BOTH the server auth callback (src/lib/auth.ts) and the client invite
// dialog (src/components/invite-member-dialog.tsx) without dragging either's
// module graph into the other. Mirrors better-auth-schema.ts's constraints.
//
// WHY the string-building lives here rather than inline in auth.ts: auth.ts
// pulls in the server-only / React boot graph, so its inline callbacks cannot
// be imported by a unit test (the drift-guard test deliberately stubs
// `@/lib/auth` for exactly this reason). Extracting the recipient/link/body
// building keeps the emitted values under direct test
// (see __tests__/org-invitation-email.test.ts), while auth.ts retains only the
// thin `dispatchPlatformEmail` wiring.

// The app mounts better-auth-ui's AcceptInvitationCard at the `accept-invitation`
// AUTH view path — statically generated for every authViewPath by
// `src/app/permissions/[path]/page.tsx`. That card reads the invitation id from
// the `invitationId` query param (`getSearchParam("invitationId")`). Both the
// emailed link (server) and the copyable link in the invite dialog (client)
// derive from this single constant so they cannot drift apart.
export const INVITATION_ACCEPT_PATH = "/permissions/accept-invitation";
export const INVITATION_ID_QUERY_PARAM = "invitationId";

/**
 * Build the absolute accept-invitation link the invitee follows.
 *
 * `origin` is a base URL — the server passes better-auth's own `baseURL`
 * (BETTER_AUTH_URL); the client passes `window.location.origin`. A trailing
 * slash on the origin is tolerated. The canonical shape is
 * `<origin>/permissions/accept-invitation?invitationId=<id>`.
 */
export function buildInvitationAcceptUrl(origin: string, invitationId: string): string {
  const trimmed = (origin ?? "").replace(/\/+$/, "");
  const param = `${INVITATION_ID_QUERY_PARAM}=${encodeURIComponent(invitationId)}`;
  return `${trimmed}${INVITATION_ACCEPT_PATH}?${param}`;
}

/**
 * Build the subject + plain-text body for the invitation email. Mirrors the
 * structure of the reset/verify bodies in auth.ts (a lead line, the actionable
 * URL on its own line, then a "didn't expect this" footer). All inputs are
 * defensively defaulted so a missing org/inviter name never emits a raw
 * "undefined" into a recipient's inbox.
 */
export function buildInvitationEmail(input: {
  organizationName?: string | null;
  inviterLabel?: string | null;
  role?: string | readonly string[] | null;
  acceptUrl: string;
}): { subject: string; text: string } {
  const organizationName = input.organizationName?.trim() || "a Cinatra organization";
  const inviterLabel = input.inviterLabel?.trim() || "A Cinatra organization owner";
  const role = normalizeInviteRole(input.role);

  return {
    subject: `You're invited to join ${organizationName} on Cinatra`,
    text:
      `${inviterLabel} invited you to join ${organizationName} on Cinatra as ${role}.\n\n` +
      `Accept the invitation:\n${input.acceptUrl}\n\n` +
      `If you weren't expecting this, you can safely ignore this email.`,
  };
}

/**
 * Better Auth does not normalize the invitation role before invoking the
 * sendInvitationEmail callback: depending on the invite call it can arrive as
 * a single string, an array of roles, or a comma-separated string. Render all
 * of them as a readable ", "-joined list, defaulting to "member".
 */
function normalizeInviteRole(role: string | readonly string[] | null | undefined): string {
  const parts = (Array.isArray(role) ? role : String(role ?? "").split(","))
    .map((entry) => String(entry).trim())
    .filter(Boolean);
  return parts.join(", ") || "member";
}
