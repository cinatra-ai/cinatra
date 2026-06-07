/**
 * Authorization kernel — typed AuthzError.
 *
 * `can()`/`canDo()` do not throw AuthzError; they return boolean. Callers
 * (server actions, route handlers, MCP handlers) decide to throw and choose
 * the statusCode based on resource visibility:
 *   - 400 owner_implicit — owner is implicit; caller attempted a write
 *                          that would store the owner as an access row
 *   - 401 no_session     — caller had no valid session
 *   - 403 forbidden      — resource is visible to the actor but action denied
 *   - 404 hidden         — resource exists but its existence must not be
 *                          revealed (cross-org ID lookups, system resources
 *                          for non-admins)
 *
 * `400 owner_implicit` covers owner-self-insert rejection in
 * `project_access_grant`. This is a CLIENT-INPUT validation error (the
 * principal/owner identity collides with the project's own owner) —
 * semantically a 400 rather than a 403, because the caller is not denied based
 * on auth/scope but on the data model invariant. Kept inside `AuthzError`
 * (vs. a new error class) so every existing throw-site continues to surface
 * the same envelope.
 */

export type AuthzErrorCode = "no_session" | "forbidden" | "hidden" | "owner_implicit";

export class AuthzError extends Error {
  readonly statusCode: 400 | 401 | 403 | 404;
  readonly reason: AuthzErrorCode;

  constructor(opts: {
    statusCode: 400 | 401 | 403 | 404;
    reason: AuthzErrorCode;
    message?: string;
  }) {
    super(opts.message ?? `Authorization failed: ${opts.reason}`);
    this.name = "AuthzError";
    this.statusCode = opts.statusCode;
    this.reason = opts.reason;
  }
}
