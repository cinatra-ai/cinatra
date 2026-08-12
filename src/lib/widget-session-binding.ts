import "server-only";

// ---------------------------------------------------------------------------
// THE PARENT SESSION OF A WIDGET TOKEN (cinatra#2684).
//
// WHAT WAS WRONG. A `cwu_` widget token is minted out of an authenticated
// Cinatra sign-in, but nothing on the row remembered WHICH sign-in. Signing out
// deleted the Better Auth session and left the widget rows standing, so a widget
// turn kept working for the rest of the token's fifteen minutes — and everything
// derived from that row (the island credential, the capture capability) kept
// working with it, because each of them re-checks the row and the row was alive.
// Sign-out did not mean signed out.
//
// WHAT THIS LEAF IS. One place that knows two things and nothing else:
//   • THE NAME of the session a widget row belongs to — the `auth_session_id`
//     column, written at the authorization and carried to the token;
//   • WHETHER THAT SESSION IS STILL THERE — one indexed existence read against
//     Better Auth's own `public."session"` table.
// Every reader of `widget_user_tokens` asks THIS function, so "the parent is
// dead" has exactly one definition and no reader can hold a laxer copy of it.
//
// WHY A SEPARATE LEAF AND NOT A FUNCTION IN `widget-user-auth.ts`. Three
// unrelated modules need it: the token verifier, the jti-keyed capture probe,
// and `auth.ts` — which runs inside the Next.js instrumentation hook at boot.
// `widget-user-auth.ts` pulls in the connect-site store, the credential
// validator and the database facade; importing that graph from `auth.ts` would
// put an import cycle on the boot path for the sake of one predicate. This leaf
// imports the three postgres primitives and nothing else, exactly as
// `widget-capture-principal.ts` does, so any of the three may import it freely.
//
// A READ, AND DELIBERATELY NOT A REVOCATION HOOK. Better Auth deletes a session
// row on sign-out, on `revokeSession`, on `revokeSessions` and on
// `revokeUserSessions` — and it also expires rows, and an operator can delete
// one directly. A hook sees only the paths it is wired to; this read sees them
// all, because it asks the question at the moment it matters instead of trying
// to be told. A hook was written and then removed: it was pure hygiene (the rows
// it deleted were already refused), it duplicated a rule that must have one
// definition, and reaching it put `auth.ts` — which `/sign-in`, `/chat`,
// `/api/mcp`, `/api/a2a` and `/api/llm-bridge` all load — on the edge of this
// module's graph, growing five baselined route budgets for a path that runs once
// per sign-out. Dead rows are inert (every reader refuses them) and go on the
// next expiry sweep; a refused token is deleted where it is refused.
//
// FAILS CLOSED, ALWAYS. A blank session id, a missing row, an expired one, an
// auth table that is not there yet (a fresh install before Better Auth's own
// migration runs) or any error at all reads as NOT LIVE. "I could not prove the
// parent is alive" and "the parent is dead" must reach the same answer, because
// only one of them is safe to be wrong about.
// ---------------------------------------------------------------------------

import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";
import { quotePostgresIdentifier, runPostgresQueriesSync } from "@/lib/postgres-sync";

/**
 * The column that names the Better Auth session a widget row belongs to. It is
 * on BOTH short-lived tables — the authorization code and the token it mints —
 * because a revocation between the two must kill the code as surely as it kills
 * a token (cinatra#2684 AC-6).
 */
export const WIDGET_AUTH_SESSION_COLUMN = "auth_session_id";

/** The two widget tables that carry a parent session. */
const USER_TOKEN_TABLE = "widget_user_tokens";
const CODE_TABLE = "widget_auth_codes";

/**
 * Better Auth's session table. Same database, `public` schema — the same place
 * `sessionRowPredatesTransaction` reads (src/lib/widget-user-auth.ts) and the
 * same place the schema SSOT provisions `cinatra_db_created_at`.
 */
const AUTH_SESSION_TABLE = `"public"."session"`;

function qTable(table: string): string {
  return `${quotePostgresIdentifier(postgresSchema)}.${quotePostgresIdentifier(table)}`;
}

/**
 * A usable session id: a non-blank string of sane length. Better Auth ids are
 * short opaque strings; anything else is not one of ours and is refused without
 * touching the database.
 */
export function isWidgetAuthSessionId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 255;
}

/** Normalized form, or "" for anything unusable. */
export function normalizeWidgetAuthSessionId(value: unknown): string {
  return isWidgetAuthSessionId(value) ? value.trim() : "";
}

/**
 * THREE answers, not two (codex round 0, finding 4). A verifier needs to know
 * the difference between "this session is gone" and "I could not find out",
 * because one of them justifies deleting the widget row and the other does not:
 * a two-second database hiccup must not permanently sign somebody out of a
 * credential that was still good.
 *
 *   live      — the row is there and has not passed its own expiry;
 *   dead      — nobody named a session, or the row is gone, or it has expired;
 *   unknown   — the question could not be answered at all.
 *
 * BOTH `dead` AND `unknown` REFUSE. The authorization decision is unchanged and
 * still fails closed; only the CLEANUP is reserved for `dead`.
 */
export type WidgetAuthSessionLiveness = "live" | "dead" | "unknown";

/**
 * Is the named Better Auth session STILL SIGNED IN — and if not, is that a fact
 * or an outage?
 *
 * `live` only when a row with that id exists AND has not passed its own
 * `expiresAt`. Both halves are load-bearing: a deleted row is a sign-out or a
 * revocation, and an expired row is a session Better Auth would itself refuse,
 * so a widget token must not outlive either. The DATABASE clock decides, like
 * every other expiry in this flow — `expiresAt` is `timestamptz` and the
 * comparison is made where the value lives, so no node's clock enters it.
 *
 * A blank or unusable session id is `dead`, not `unknown`: a row that names no
 * session can never be attached to one, so there is nothing indeterminate about
 * it and reaping it is correct.
 *
 * NEVER THROWS. A missing auth table (a fresh install before Better Auth
 * migrates), an unreachable database, a permissions error — each is `unknown`,
 * which refuses without destroying anything.
 *
 * ONE CONFIGURATION INVARIANT, recorded because this predicate would silently
 * become wrong under it (codex round 0, finding E): Better Auth must keep the
 * database as the authority for sessions. With `secondaryStorage` AND
 * `session.preserveSessionInDatabase`, a revoke removes only the secondary
 * entry and leaves a live-LOOKING Postgres row behind. `auth.ts` configures
 * neither, and a structural test pins that.
 */
export function readWidgetAuthSessionLiveness(
  sessionId: unknown,
): WidgetAuthSessionLiveness {
  const id = normalizeWidgetAuthSessionId(sessionId);
  if (!id) return "dead";
  try {
    const [result] = runPostgresQueriesSync({
      connectionString: getPostgresConnectionString(),
      queries: [
        {
          text:
            `SELECT 1 AS alive FROM ${AUTH_SESSION_TABLE} ` +
            `WHERE id = $1 AND "expiresAt" > now() LIMIT 1`,
          values: [id],
        },
      ],
    });
    return (result?.rows?.length ?? 0) > 0 ? "live" : "dead";
  } catch {
    return "unknown";
  }
}

/**
 * The boolean form, for the readers that only ever refuse and never reap. Both
 * `dead` and `unknown` are `false` — the fail-closed direction is the same one
 * it has always been.
 */
export function widgetAuthSessionIsLive(sessionId: unknown): boolean {
  return readWidgetAuthSessionLiveness(sessionId) === "live";
}

/**
 * Read the parent session named on the `cwu_` row with this `jti`, and answer
 * whether it is still signed in.
 *
 * WHY THIS EXISTS SEPARATELY. Not every credential derived from a widget token
 * can present the token: the capture capability seals the `jti`, the review
 * island seals the `jti`, and the run-bound chat RESUME token is handed to the
 * browser after a turn the parent authorized. Each of those has to be able to
 * ask "is the sign-in behind this still there?" from a `jti` alone, and each
 * asking it its own way is how one of them ends up laxer than the others.
 *
 * `dead` for an unknown, expired or unbound row — a credential whose parent
 * cannot be found is not a credential. `unknown` only when the store could not
 * answer, so a blip refuses without anybody concluding a revocation happened.
 */
export function readWidgetTokenParentLiveness(
  jti: unknown,
): WidgetAuthSessionLiveness {
  const id = typeof jti === "string" ? jti.trim() : "";
  if (!id || id.length > 128) return "dead";
  let row: Record<string, unknown> | undefined;
  try {
    ensurePostgresSchema();
    const [result] = runPostgresQueriesSync({
      connectionString: getPostgresConnectionString(),
      queries: [
        {
          text:
            `SELECT ${WIDGET_AUTH_SESSION_COLUMN} FROM ${qTable(USER_TOKEN_TABLE)} ` +
            `WHERE jti = $1 AND expires_at > now() LIMIT 1`,
          values: [id],
        },
      ],
    });
    row = result?.rows?.[0] as Record<string, unknown> | undefined;
  } catch {
    return "unknown";
  }
  if (!row) return "dead";
  return readWidgetAuthSessionLiveness(row[WIDGET_AUTH_SESSION_COLUMN]);
}
