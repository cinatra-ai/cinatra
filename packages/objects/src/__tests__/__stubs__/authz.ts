/**
 * Vitest stub for `@/lib/authz`.
 *
 * The real barrel pulls `audit.ts`, which creates a Postgres pool at
 * module load and throws when SUPABASE_DB_URL is unset (the case in
 * unit tests). The handler tests don't exercise audit logging, so we
 * stub the barrel to an ALLOW-BY-DEFAULT kernel. Handler tests assume
 * authz is "open" because they exercise read/write plumbing, not access
 * control.
 *
 * Tests that need a different decision can `vi.mock("@/lib/authz")`
 * locally (the local mock wins over this alias). Dedicated authz handler
 * tests override this with a `can: vi.fn(() => false)` stub so the deny
 * path is exercised.
 */
// Allow-by-default: handler tests assume authz is "open" because they
// exercise read/write plumbing, not access control. Dedicated authz handler
// tests override this with a local `vi.mock("@/lib/authz")` to deny by
// default.
export const can = (): boolean => true;
export const canDo = (): boolean => true;
export const buildActorContext = (): Record<string, unknown> => ({});
export class AuthzError extends Error {
  readonly statusCode: 401 | 403 | 404;
  readonly reason: "no_session" | "forbidden" | "hidden";
  constructor(opts: {
    statusCode: 401 | 403 | 404;
    reason: "no_session" | "forbidden" | "hidden";
    message?: string;
  }) {
    super(opts.message ?? opts.reason);
    this.name = "AuthzError";
    this.statusCode = opts.statusCode;
    this.reason = opts.reason;
  }
}
export const EFFECTIVE_GRANTS = {} as Record<string, unknown>;
export const POLICY_VERSION = "test";
export const logAuditEvent = (): void => undefined;
