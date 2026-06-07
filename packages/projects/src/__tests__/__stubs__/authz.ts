/**
 * Vitest stub for `@/lib/authz`.
 *
 * Mirrors packages/objects/src/__tests__/__stubs__/authz.ts. The real
 * barrel pulls `audit.ts` which creates a Postgres pool at module load
 * and throws when SUPABASE_DB_URL is unset (the case in unit tests).
 * The handler tests don't exercise audit logging, so we stub the barrel
 * to an ALLOW-BY-DEFAULT kernel — tests that need a different decision
 * `vi.mock("@/lib/authz")` locally.
 */
export const can = (): boolean => true;
export const canDo = (): boolean => true;
export const buildActorContext = (): Record<string, unknown> => ({});
export class AuthzError extends Error {
  readonly statusCode: number;
  readonly reason: string;
  constructor(opts: { statusCode: number; reason: string; message?: string }) {
    super(opts.message ?? opts.reason);
    this.name = "AuthzError";
    this.statusCode = opts.statusCode;
    this.reason = opts.reason;
  }
}
export const EFFECTIVE_GRANTS = {} as Record<string, unknown>;
export const POLICY_VERSION = "test";
export const logAuditEvent = (): void => undefined;
