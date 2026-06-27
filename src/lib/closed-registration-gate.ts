/**
 * Decision authority for the closed-registration `user.create.before` gate
 * (D1–D5). This is the SINGLE source of truth for the allow/block decision: the
 * production hook in `src/lib/auth.ts` routes through `resolveRegistrationDecision`
 * here (injecting its real `isRegistrationClosed` / `countHumanUsers` deps), so
 * the unit tests exercise the EXACT production decision path rather than a
 * reconstruction.
 *
 * Extracted from auth.ts because auth.ts has a top-level await + the full
 * better-auth plugin tuple and so is always mocked (never imported for real) in
 * the vitest sandbox. This module imports NEITHER `betterAuthDb` NOR
 * `instance-mode`; the side effects (DB count, toggle read) are dependency-
 * injected, and the APIError throw stays in auth.ts. That keeps this module
 * lightweight and the decision logic directly testable.
 */
import "server-only";

/** The better-auth admin plugin's create-user endpoint path (D1). */
export const ADMIN_CREATE_USER_PATH = "/admin/create-user";

/** Stable code surfaced on the FORBIDDEN APIError thrown when blocking (D2). */
export const REGISTRATION_CLOSED_CODE = "REGISTRATION_CLOSED";

/** User-facing message surfaced on the FORBIDDEN APIError (D2). */
export const REGISTRATION_CLOSED_MESSAGE =
  "New account registration is closed on this instance. Contact your administrator.";

/**
 * Human = userType is anything other than "assistant" (D3). The field is often
 * omitted on input (schema default "human"), so only an explicit "assistant"
 * is treated as non-human.
 */
export function isHumanUserType(userType: unknown): boolean {
  return userType !== "assistant";
}

/**
 * D1 — is THIS creation an authenticated-admin context (the admin plugin's
 * create-user endpoint) that must always be allowed? SIGNAL: `ctx.path`.
 * better-auth dispatches each endpoint with a stable leading-slash path and the
 * db before-hook receives that endpoint's auth context, so matching
 * `/admin/create-user` reliably distinguishes admin-created users from public
 * sign-up (`/sign-up/email`) and OAuth first-login (`/callback/:id`). A null /
 * non-string path (no endpoint context — e.g. a direct internal-adapter call)
 * is treated as public and remains subject to the gate.
 */
export function isAdminCreateContext(path: unknown): boolean {
  return path === ADMIN_CREATE_USER_PATH;
}

/**
 * Pure gate decision once the inputs are resolved. Returns "allow" or "block".
 * Inputs:
 *   - userType:   the candidate user's userType (assistant → always allow, D3)
 *   - path:       ctx.path of the creating endpoint (admin path → allow, D1)
 *   - closed:     the resolved closed-registration flag (false → allow, D5)
 *   - humanCount: definitive human-user count (0 → allow first-human bootstrap, D4)
 *
 * NOTE: the orchestrator handles the count-read FAILURE separately (it FAILS
 * CLOSED while the flag is closed — D4). This function only sees a successful
 * count, so a negative/NaN count should never reach it; it treats `> 0` as
 * "humans exist".
 */
export function decideRegistration(input: {
  userType: unknown;
  path: unknown;
  closed: boolean;
  humanCount: number;
}): "allow" | "block" {
  if (!isHumanUserType(input.userType)) return "allow"; // D3
  if (isAdminCreateContext(input.path)) return "allow"; // D1
  if (!input.closed) return "allow"; // D5 (open)
  if (input.humanCount === 0) return "allow"; // D4 first-human bootstrap
  return "block"; // closed + ≥1 human + public path
}

/** Structured decision returned by the production orchestrator. */
export type RegistrationDecision = "allow" | "block";

/**
 * PRODUCTION orchestrator for the gate (D1–D5). The `user.create.before` hook in
 * auth.ts calls THIS — there is no parallel decision logic in auth.ts. It applies
 * the SAME `decideRegistration` branch authority and performs the side-effectful
 * steps via injected deps (so this module never imports betterAuthDb /
 * instance-mode and stays testable):
 *
 *   - `isClosed()`   — reads the DB-backed toggle. MUST fail OPEN on its own
 *                      read error (D5): `isRegistrationClosed` already swallows
 *                      read errors to `false`, so an unavailable metadata store
 *                      does not reach the block path.
 *   - `countHumans()`— definitive human-user count (D3/D4). MUST THROW on
 *                      inspection failure; this orchestrator catches that throw
 *                      and FAILS CLOSED (returns "block") while the flag is
 *                      closed, because an explicit closed flag is a strong
 *                      operator signal (D4).
 *
 * Returns "allow" | "block". The caller (auth.ts) throws the FORBIDDEN APIError
 * on "block" (D2) — the throw is deliberately NOT here so this module needs no
 * better-auth import.
 *
 * Short-circuit order matters: assistant (D3) and admin-context (D1) are decided
 * BEFORE `isClosed()` is read, and `isClosed()` is read BEFORE `countHumans()` —
 * so the DB count is only ever run for a public, human creation on a closed
 * instance, never for the common open-instance or admin paths.
 */
export async function resolveRegistrationDecision(deps: {
  user: { userType?: unknown } & Record<string, unknown>;
  ctx: { path?: unknown } | null;
  isClosed: () => Promise<boolean>;
  countHumans: () => Promise<number>;
}): Promise<RegistrationDecision> {
  // D3 — assistant creations are never gated (the raw-SQL seed bypasses this
  // hook anyway; guard regardless).
  if (!isHumanUserType(deps.user.userType)) return "allow";

  // D1 — admin-context creation (`/admin/create-user`) is always allowed; only
  // PUBLIC registration (email `/sign-up/email`, OAuth first-login
  // `/callback/:id`) is gated. SIGNAL: ctx.path. A null ctx (no endpoint
  // context) is treated as public.
  if (isAdminCreateContext(deps.ctx?.path)) return "allow";

  // D5 — config-read failure fails OPEN inside isClosed(); a `false` here means
  // open and we allow.
  if (!(await deps.isClosed())) return "allow";

  // Flag is closed → resolve the human count for the first-human bootstrap
  // exception (D4). countHumans() THROWS on inspection failure; FAIL CLOSED.
  let humanCount: number;
  try {
    humanCount = await deps.countHumans();
  } catch {
    // D4 — explicit closed flag + unknown count → block rather than risk
    // opening the door on an unconfirmed count.
    return "block";
  }

  // Reuse the pure branch authority for the final allow/block (first-human → allow).
  return decideRegistration({
    userType: deps.user.userType,
    path: deps.ctx?.path,
    closed: true,
    humanCount,
  });
}
