import "server-only";

// ---------------------------------------------------------------------------
// upload-install-authorization.ts — installer AUTHORITY on the upload road
// (cinatra#3204, acceptance criterion 14).
//
// The picker on the Upload screen is an AFFORDANCE. Its disabled rows and their
// tooltips describe a decision made somewhere else: the server's. This module is
// where the upload road asks that question, and it asks it with the SAME
// functions the marketplace install action asks it with, in the same order:
//
//   1. resolve the picked value into a target at all (a non-target — "owner", an
//      empty tail, a session without an active organization — is refused here,
//      before any role is read);
//   2. RE-DERIVE the tenant id for the two workspace targets from the SESSION,
//      discarding whatever the client sent. The audience for those levels IS the
//      authenticated tenant, so a client-supplied id is a cross-tenant risk and
//      is never read;
//   3. validate the target against the shared schema;
//   4. the tenancy gate — does this target belong to the active organization;
//   5. the authority assertion — may THIS actor install at it.
//
// It runs BEFORE any mutation, so a denied or malformed target installs nothing.
//
// The dependencies are injectable so the ORDER above is directly testable
// without a session, a database or a role table. Production passes none of them
// and gets the real functions.
// ---------------------------------------------------------------------------

import { InstallAccessTargetSchema } from "@cinatra-ai/extensions/install-access-target";

import { resolveUploadInstallScope, type UploadInstallScopeDecision } from "./upload-install-scope";

type SessionLike = {
  user: { id: string; role?: string | null };
  session?: { activeOrganizationId?: string | null } | null;
};

export type UploadInstallAuthzDeps = {
  buildCanDoOptsFromSession: (
    session: SessionLike,
  ) => Promise<{ orgRole?: "org_owner" | "org_admin" | "member" }>;
  readActorRolesForInstall: (
    session: SessionLike,
    activeOrgId: string,
    orgRole: "org_owner" | "org_admin" | "member" | undefined,
  ) => unknown;
  assertTargetBelongsToActiveOrg: (
    actor: never,
    target: never,
    activeOrgId: string,
  ) => Promise<{ projectOwnership?: unknown }>;
  assertCanInstallAtTarget: (
    actor: never,
    target: never,
    projectOwnership?: unknown,
  ) => Promise<void>;
};

async function realDeps(): Promise<UploadInstallAuthzDeps> {
  const [{ buildCanDoOptsFromSession }, authz] = await Promise.all([
    import("@/lib/auth-session"),
    import("./install-target-authz"),
  ]);
  return {
    buildCanDoOptsFromSession: buildCanDoOptsFromSession as never,
    readActorRolesForInstall: authz.readActorRolesForInstall as never,
    assertTargetBelongsToActiveOrg: authz.assertTargetBelongsToActiveOrg as never,
    assertCanInstallAtTarget: authz.assertCanInstallAtTarget as never,
  };
}

/**
 * Resolve and AUTHORIZE the install scope an upload was submitted with.
 *
 * Throws `UploadInstallScopeError` for a value that is not an installable
 * scope, and whatever the authz layer throws (an `AuthzError`) for a target the
 * actor may not install at. Returns the two halves the install then uses: the
 * canonical row anchor and the audience policy.
 */
export async function authorizeUploadInstallScope(
  session: SessionLike,
  pickerValue: string,
  injected?: Partial<UploadInstallAuthzDeps>,
): Promise<UploadInstallScopeDecision> {
  const activeOrgId = session.session?.activeOrganizationId ?? null;

  // (1) A non-target refuses HERE — before a role is read, let alone a row
  // written. `resolveUploadInstallScope` also refuses a session with no active
  // organization, which is the state in which no install target exists at all.
  const decision = resolveUploadInstallScope({ pickerValue, activeOrganizationId: activeOrgId });
  const orgId = activeOrgId as string; // non-null: the resolver refused otherwise

  // (2) The two workspace levels name the authenticated tenant itself. Re-derive
  // the id from the session and discard the submitted one.
  const target =
    decision.target.level === "workspace" || decision.target.level === "admin"
      ? { level: decision.target.level, id: orgId }
      : decision.target;

  // (3) The same schema the marketplace install action parses with.
  const parsed = InstallAccessTargetSchema.parse(target);

  const deps = { ...(await realDeps()), ...injected };
  const { orgRole } = await deps.buildCanDoOptsFromSession(session);
  const roleBag = deps.readActorRolesForInstall(session, orgId, orgRole);

  // (4) tenancy, then (5) authority — never the other way round: an authority
  // answer about a target from another tenant is not an answer.
  const tenantCheck = await deps.assertTargetBelongsToActiveOrg(
    roleBag as never,
    parsed as never,
    orgId,
  );
  await deps.assertCanInstallAtTarget(
    roleBag as never,
    parsed as never,
    tenantCheck.projectOwnership,
  );

  return { ...decision, target: parsed };
}
