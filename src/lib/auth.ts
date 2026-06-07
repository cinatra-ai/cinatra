import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { cinatraAuthAdditionalUserFields } from "./better-auth-schema";
import {
  buildCinatraBetterAuthPlugins,
  type CinatraBetterAuthPlugins,
} from "./better-auth-plugins";
import { and, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import { createMcpServerAuthPlugins } from "@cinatra-ai/mcp-server";
import { getTrustedOriginHostnames } from "@cinatra-ai/mcp-server/credentials";
import { getGoogleOAuthSettings } from "@cinatra-ai/google-oauth-connection";
import {
  betterAuthAccounts,
  betterAuthDb,
  betterAuthPool,
  betterAuthSessions,
  betterAuthUsers,
} from "@/lib/better-auth-db";
import { ensureBetterAuthMembershipRow } from "@/lib/better-auth-membership-bootstrap";
import { ensureDefaultOrganizationRow } from "@/lib/default-organization-bootstrap";
import { insertOAuthClientWithTx } from "@/lib/better-auth-oauth-client";

const authBaseUrl = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const authSecret = process.env.BETTER_AUTH_SECRET;
const betterAuthConsoleUrl = process.env.BETTER_AUTH_CONSOLE_URL;

// This module-level value is read via a TOP-LEVEL await, which runs on every
// module load. Crucially, `auth.ts` is pulled into the Next.js instrumentation
// hook at boot (instrumentation.node.ts → register-transport-connectors /
// register-extension-action-guard → auth-session → auth), so an UNGUARDED
// rejection here propagates out of the hook's module load as
// "An error occurred while loading instrumentation hook: connect ECONNREFUSED …"
// and crashes the dev/prod server (webServer exit 1). That breaks every boot
// without a live DB — `next build` page-data collection, a fresh install before
// the setup wizard, and the design-visual-verify e2e suite (placeholder DB on
// :65535). Skip in build phase; on any DB-unavailable error fall back to empty
// settings. Auth still constructs (just without Google OAuth pre-configured)
// and the value is re-read at runtime via the normal request path.
const emptyGoogleOAuthSettings = {
  clientId: undefined,
  clientSecret: undefined,
  redirectUri: undefined,
};

function isBootDbUnavailableError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "ENOTFOUND") {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  // NOTE: match only unambiguous DB-unavailable signals. Do NOT use a bare
  // `connect` token — it substring-matches the `connector_config` table name, so
  // a reachable-DB permission/schema/query error (e.g. `relation
  // "connector_config" does not exist`) would be wrongly swallowed. The errno
  // strings + full connection-failure phrases below cannot appear in such errors.
  return /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|Timed out while executing Postgres|terminating connection|Connection terminated|the database system is starting up|could not connect to server|Connection refused|SUPABASE_DB_URL|DATABASE_URL/i.test(
    msg,
  );
}

async function readBootGoogleOAuthSettings() {
  if (process.env.NEXT_PHASE === "phase-production-build") {
    return emptyGoogleOAuthSettings;
  }
  try {
    return await getGoogleOAuthSettings();
  } catch (err) {
    if (isBootDbUnavailableError(err)) {
      console.warn(
        "[auth] Google OAuth boot settings unavailable (DB unreachable at boot) — " +
          "auth constructs without boot-time Google OAuth; it is re-read at runtime " +
          "via the normal request path:",
        err instanceof Error ? err.message : err,
      );
      return emptyGoogleOAuthSettings;
    }
    // A non-DB error (e.g. a real misconfiguration) still fails loud.
    throw err;
  }
}

const googleOAuthSettings = await readBootGoogleOAuthSettings();
const mcpServerAuthPlugins = createMcpServerAuthPlugins({
  authBasePath: "/api/auth",
  mcpBasePath: "/api/mcp",
  adminBasePath: "/configuration/mcp",
  handshakeBasePath: "/api/mcp",
  scopes: ["openid", "profile", "email", "offline_access", "mcp:connect", "a2a:connect"],
});

if (!authSecret) {
  throw new Error("Missing BETTER_AUTH_SECRET. Set it in .env.local before starting the app.");
}

function decodeJwtPayload(token: string) {
  const payload = token.split(".")[1];

  if (!payload) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getGoogleAvatarUrlFromIdToken(idToken?: string | null) {
  if (!idToken) {
    return null;
  }

  const payload = decodeJwtPayload(idToken);
  const picture = payload?.picture;

  return typeof picture === "string" && picture.length > 0 ? picture : null;
}

async function syncGoogleAvatarForUser(userId: string) {
  const userResult = await betterAuthDb
    .select({ image: betterAuthUsers.image })
    .from(betterAuthUsers)
    .where(eq(betterAuthUsers.id, userId))
    .limit(1);

  if (userResult[0]?.image) {
    return false;
  }

  const accountResult = await betterAuthDb
    .select({ idToken: betterAuthAccounts.idToken })
    .from(betterAuthAccounts)
    .where(and(eq(betterAuthAccounts.userId, userId), eq(betterAuthAccounts.providerId, "google")))
    .orderBy(desc(betterAuthAccounts.createdAt))
    .limit(1);

  const image = getGoogleAvatarUrlFromIdToken(accountResult[0]?.idToken);

  if (!image) {
    return false;
  }

  await betterAuthDb
    .update(betterAuthUsers)
    .set({ image })
    .where(and(eq(betterAuthUsers.id, userId), or(isNull(betterAuthUsers.image), eq(betterAuthUsers.image, ""))));

  return true;
}

// trustedOrigins is now a function — re-evaluated per request so that the public
// base URL (set via /configuration/development?tab=tunnel and persisted to the
// `connector_config:mcp_server.publicBaseUrl` DB row) is picked up without a
// dev-server restart.
//
// `BETTER_AUTH_TRUSTED_ORIGINS` (comma-separated env var) remains as a legacy
// escape hatch for CI / containerized dev where setting a UI value is
// impractical. It is NOT the recommended path; UI-driven config is preferred.
function getDynamicTrustedOrigins(): string[] {
  const out = new Set<string>();
  for (const hostname of getTrustedOriginHostnames()) {
    if (hostname) out.add(hostname);
  }
  return Array.from(out);
}

// Fire-and-forget platform-email dispatch for Better Auth hooks. Returns
// immediately (does NOT await the send) so the auth response time does not
// reveal whether a recipient exists or how the mail provider is performing —
// Better Auth's documented timing-attack guidance. `@/lib/email-system` is
// loaded via dynamic import to keep the email stack (registry/database) out of
// auth.ts's boot-time module graph. Errors are logged, never thrown.
function dispatchPlatformEmail(input: {
  to: string;
  subject: string;
  text: string;
  context: string;
}): void {
  void (async () => {
    try {
      const { sendPlatformEmail } = await import("@/lib/email-system");
      await sendPlatformEmail({ to: input.to, subject: input.subject, text: input.text });
    } catch (err) {
      console.error(
        `[auth] ${input.context} email dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  })();
}

// Build the Better Auth plugin tuple via the shared factory + append the
// Next.js cookie integration. The explicit annotation is load-bearing: it
// pins the array's static type at the call site so Better Auth's `$Infer`
// remains precise, AND it fails typecheck if anyone pushes a stray plugin
// outside `buildCinatraBetterAuthPlugins` (the regression this prevents).
// `nextCookies()` has no schema — it only intercepts Next.js Set-Cookie —
// and is intentionally NOT inside the shared factory (the migration runner
// has no Next.js to integrate with).
type CinatraRuntimeBetterAuthPlugins = [
  ...CinatraBetterAuthPlugins,
  ReturnType<typeof nextCookies>,
];
const authPlugins: CinatraRuntimeBetterAuthPlugins = [
  ...buildCinatraBetterAuthPlugins({
    admin: {
      allowImpersonatingAdmins: process.env.CINATRA_RUNTIME_MODE === "development",
    },
    organization: {
      allowUserToCreateOrganization: async (user) => {
        // Server-enforced single-org gate. When single-org compatibility mode
        // is on, org creation is blocked
        // for EVERYONE (including admins). This is the authoritative gate;
        // the layout's `canCreateOrganizations` only hides the UI control.
        try {
          const { isSingleOrgMode } = await import("@/lib/authz/instance-mode");
          if (await isSingleOrgMode()) return false;
        } catch {
          // Metadata store unavailable → fall through to the role check
          // (fail-open is acceptable here: the default is multi-org).
        }
        const roles = String(user.role ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
        return roles.includes("admin");
      },
    },
    mcpAuthPlugins: mcpServerAuthPlugins,
  }),
  nextCookies(),
];

export const auth = betterAuth({
  appName: "Cinatra",
  baseURL: authBaseUrl,
  secret: authSecret,
  trustedOrigins: getDynamicTrustedOrigins,
  database: betterAuthPool,
  user: {
    changeEmail: {
      // Enabled now that the platform mailer is wired (sendPlatformEmail
      // routes through @cinatra-ai/email-connector → the provider assigned to
      // the "platform" purpose at /connectors/email). The confirmation token
      // is sent to the CURRENT (verified) address so the existing owner
      // authorizes the change — the OLD permissive default (enabled + no
      // verification) was an identity-takeover vector. `sendChangeEmailConfirmation`
      // below is required for this to be safe; do NOT set
      // updateEmailWithoutVerification:true.
      enabled: true,
      sendChangeEmailConfirmation: async ({
        user,
        newEmail,
        url,
      }: {
        user: { email: string };
        newEmail: string;
        url: string;
        token: string;
      }) => {
        // Fire-and-forget: do NOT await. Awaiting leaks user existence /
        // provider latency through response timing (Better Auth's documented
        // timing-attack guidance). The send runs in the background; failures
        // are logged, never surfaced to the caller.
        dispatchPlatformEmail({
          to: user.email,
          subject: "Confirm your new email for Cinatra",
          text:
            `A request was made to change your Cinatra account email to ${newEmail}.\n\n` +
            `Confirm the change:\n${url}\n\n` +
            `If you didn't request this, ignore this email and your address won't change.`,
          context: "sendChangeEmailConfirmation",
        });
      },
    },
    additionalFields: cinatraAuthAdditionalUserFields,
  },
  account: {
    accountLinking: {
      // Disallow linking a social account whose email differs from the
      // primary account's email. Without this guard an attacker who controls
      // a victim's social login (eg. spoofed OAuth claims, takeover of a
      // secondary email at a less-protected provider) can attach to the
      // victim's primary account.
      allowDifferentEmails: false,
    },
  },
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
    // 12 is the OWASP password-policy floor and matches the operator's
    // 1Password-managed practice. Existing accounts with shorter passwords
    // continue to work on login (the hash check passes) but cannot be
    // re-created at <12 chars. Customer-onboarding migration path:
    // gate weak-pw accounts behind a forced reset on next login.
    minPasswordLength: 12,
    // Platform mailer (routes via @cinatra-ai/email-connector → the provider
    // assigned to the "platform" purpose). Dynamic import keeps the email
    // stack out of auth.ts's boot-time module graph (avoids a cycle through
    // database/registry). Without this, /forgot-password 400s.
    sendResetPassword: async ({ user, url }: { user: { email: string }; url: string; token: string }) => {
      dispatchPlatformEmail({
        to: user.email,
        subject: "Reset your Cinatra password",
        text:
          `Someone requested a password reset for your Cinatra account (${user.email}).\n\n` +
          `Reset it here:\n${url}\n\n` +
          `If you didn't request this, you can ignore this email — your password won't change.`,
        context: "sendResetPassword",
      });
    },
  },
  emailVerification: {
    // Send-on-demand verification (NOT sendOnSignUp). We do NOT set
    // requireEmailVerification — existing accounts created before this wiring
    // have emailVerified=false and must still be able to password-login.
    // Enforcement can be turned on later after a backfill/admin flow.
    sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string; token: string }) => {
      dispatchPlatformEmail({
        to: user.email,
        subject: "Verify your email for Cinatra",
        text:
          `Confirm your email address (${user.email}) for Cinatra:\n\n${url}\n\n` +
          `If you didn't create this account, you can ignore this email.`,
        context: "sendVerificationEmail",
      });
    },
  },
  socialProviders:
    googleOAuthSettings.clientId && googleOAuthSettings.clientSecret
      ? {
          google: {
            clientId: googleOAuthSettings.clientId,
            clientSecret: googleOAuthSettings.clientSecret,
          },
        }
      : undefined,
  databaseHooks: {
    account: {
      create: {
        async after(account) {
          if (account?.providerId === "google" && account.userId) {
            await syncGoogleAvatarForUser(account.userId);
          }
        },
      },
      update: {
        async after(account) {
          if (account?.providerId === "google" && account.userId) {
            await syncGoogleAvatarForUser(account.userId);
          }
        },
      },
    },
  },
  // The plugin tuple is built through the SHARED factory at
  // `./better-auth-plugins.ts` — the SINGLE SOURCE OF TRUTH consumed by both
  // this runtime config AND `scripts/better-auth-migrate.mts`. A one-sided
  // edit is impossible: any plugin add / remove / reorder shows up in both
  // places at once, and the drift-guard test
  // (`src/lib/__tests__/better-auth-schema.test.ts`) deep-equals the
  // resulting Better Auth schema.
  //
  // The local `authPlugins` binding has an EXPLICIT tuple type that pins
  // length + per-slot return type — Better Auth derives `auth.$Infer` (and
  // its typed server API) from the static type of this array, so widening
  // to `BetterAuthPlugin[]` would erase plugin-contributed fields
  // (`session.activeOrganizationId`, `user.role`, `team.slug`, ...). The
  // explicit annotation fails typecheck if anyone pushes / appends a plugin
  // outside the factory, which is the regression this annotation exists to prevent.
  plugins: authPlugins,
});

export function getBetterAuthConsoleSettings() {
  return {
    consoleUrl: betterAuthConsoleUrl ?? null,
    configured: Boolean(betterAuthConsoleUrl),
    quickstartUrl: "https://better-auth-console.com/docs/quickstart",
  };
}

async function canManageBootstrapState() {
  try {
    const [userTableResult, roleColumnResult] = await Promise.all([
      betterAuthDb.execute<{ exists: string | null }>(sql`select to_regclass('public."user"') as exists`),
      betterAuthDb.execute<{ exists: boolean }>(sql`
        select exists (
          select 1
          from information_schema.columns
          where table_schema = 'public'
            and table_name = 'user'
            and column_name = 'role'
        ) as exists
      `),
    ]);

    return Boolean(userTableResult.rows[0]?.exists) && Boolean(roleColumnResult.rows[0]?.exists);
  } catch (err) {
    // Fail-safe. A DB *connection* error (transient outage, or a no-DB render
    // context such as the prod-standalone /design-fixtures pixel-diff harness)
    // means we cannot confirm the better-auth tables exist — so we CANNOT manage
    // bootstrap state. Return false (skip bootstrap) rather than letting the
    // throw escape into the React Server Components render and 500 the page.
    // Bootstrap mutations gated by this guard safely no-op and retry on a later
    // request once the DB is reachable. (`to_regclass` itself returns NULL for a
    // missing table — this catch only fires on a connection/query failure.)
    console.warn(
      "[auth] canManageBootstrapState check failed (DB unreachable?) — assuming cannot manage:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

async function canManageWorkspaceBootstrap() {
  try {
    const [organizationTableResult, memberTableResult, sessionColumnResult] = await Promise.all([
      betterAuthDb.execute<{ exists: string | null }>(sql`select to_regclass('public.organization') as exists`),
      betterAuthDb.execute<{ exists: string | null }>(sql`select to_regclass('public.member') as exists`),
      betterAuthDb.execute<{ exists: boolean }>(sql`
        select exists (
          select 1
          from information_schema.columns
          where table_schema = 'public'
            and table_name = 'session'
            and column_name = 'activeOrganizationId'
        ) as exists
      `),
    ]);

    return (
      Boolean(organizationTableResult.rows[0]?.exists) &&
      Boolean(memberTableResult.rows[0]?.exists) &&
      Boolean(sessionColumnResult.rows[0]?.exists)
    );
  } catch (err) {
    // Fail-safe (see canManageBootstrapState): a DB connection/query failure
    // means we cannot confirm the workspace tables exist, so we cannot manage
    // workspace bootstrap. Return false (skip) rather than throwing into render.
    console.warn(
      "[auth] canManageWorkspaceBootstrap check failed (DB unreachable?) — assuming cannot manage:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

export async function hasAnyBetterAuthUsers() {
  if (!(await canManageBootstrapState())) {
    return false;
  }

  const result = await betterAuthDb.execute<{ count: string }>(
    sql`select count(*)::text as count from public."user"`,
  );

  return Number(result.rows[0]?.count ?? "0") > 0;
}

export async function ensureInitialAdminBootstrap(userId: string) {
  if (!(await canManageBootstrapState()) || !(await canManageWorkspaceBootstrap())) {
    return false;
  }

  // Exclude assistant users (e.g. cinatra@system.local seeded by
  // ensureBuiltInCinatraAssistant) — otherwise the first human registrant
  // lands with userCount=2 and never gets promoted to admin, so the setup
  // wizard (requireAdminSession) is unreachable on a fresh instance.
  const userCountResult = await betterAuthDb.execute<{ count: string }>(
    sql`select count(*)::text as count from public."user" where "userType" is distinct from 'assistant'`,
  );

  if (Number(userCountResult.rows[0]?.count ?? "0") !== 1) {
    return false;
  }

  await betterAuthDb
    .update(betterAuthUsers)
    .set({ role: "admin" })
    .where(and(eq(betterAuthUsers.id, userId), or(isNull(betterAuthUsers.role), ne(betterAuthUsers.role, "admin"))));

  const organizationId = await ensureDefaultOrganizationRow();

  // First user MUST end up as the Default org owner. Race-safe + promote-only:
  // if ensureDefaultOrganizationMembership wins the INSERT with role='member',
  // the ON CONFLICT here no-ops, the re-SELECT finds 'member', and the
  // promote-to-owner UPDATE fires.
  await ensureBetterAuthMembershipRow(userId, organizationId, "owner", true);

  await betterAuthDb
    .update(betterAuthSessions)
    .set({ activeOrganizationId: organizationId })
    .where(
      and(
        eq(betterAuthSessions.userId, userId),
        or(isNull(betterAuthSessions.activeOrganizationId), ne(betterAuthSessions.activeOrganizationId, organizationId)),
      ),
    );

  // Ensure assistant user schema columns + built-in @cinatra assistant are present
  await ensureAssistantBootstrap();

  return true;
}

export async function ensureDefaultOrganizationMembership(userId: string) {
  if (!(await canManageWorkspaceBootstrap())) {
    return false;
  }

  const organizationId = await ensureDefaultOrganizationRow();

  // Platform admins (Better Auth admin-plugin role containing "admin") who
  // land in the Default org ARE the operator and must be Default's owner —
  // they're the instance-bootstrap admin. This heals legacy installs where
  // ensureInitialAdminBootstrap ran AFTER the user already had a "member"
  // row (or never ran because userCount > 1 by the time it shipped), and
  // belt-and-suspenders the serialized ordering in auth-session.ts.
  const userRow = await betterAuthDb
    .select({ role: betterAuthUsers.role })
    .from(betterAuthUsers)
    .where(eq(betterAuthUsers.id, userId))
    .limit(1);
  const isPlatformAdmin = String(userRow[0]?.role ?? "")
    .split(",")
    .map((r) => r.trim())
    .includes("admin");
  const targetMembershipRole = isPlatformAdmin ? "owner" : "member";

  let changed = false;

  // Promote-only arbitration: a non-platform-admin NEVER overwrites an
  // existing role (preserves any legitimately-set 'owner'/'admin'); a
  // platform admin is promoted to 'owner' if not already.
  const membership = await ensureBetterAuthMembershipRow(
    userId,
    organizationId,
    targetMembershipRole,
    isPlatformAdmin,
  );
  if (membership.changed) {
    changed = true;
  }

  const sessionUpdateResult = await betterAuthDb
    .update(betterAuthSessions)
    .set({ activeOrganizationId: organizationId })
    .where(
      and(
        eq(betterAuthSessions.userId, userId),
        isNull(betterAuthSessions.activeOrganizationId),
      ),
    );

  if ((sessionUpdateResult as any).rowCount > 0) {
    changed = true;
  }

  return changed;
}

export async function ensureGoogleAvatarSync(userId: string) {
  return syncGoogleAvatarForUser(userId);
}

// ---------------------------------------------------------------------------
// Assistant user schema migration
// ---------------------------------------------------------------------------

async function ensureAssistantUserSchema() {
  try {
    await betterAuthDb.execute(sql`
      ALTER TABLE public."user" ADD COLUMN IF NOT EXISTS "userType" text DEFAULT 'human'
    `);
    await betterAuthDb.execute(sql`
      ALTER TABLE public."user" ADD COLUMN IF NOT EXISTS "clientId" text
    `);
    await betterAuthDb.execute(sql`
      CREATE INDEX IF NOT EXISTS user_client_id_idx ON public."user" ("clientId") WHERE "clientId" IS NOT NULL
    `);
  } catch (err) {
    // Non-fatal — the app can still run without the columns; they will be added on next bootstrap
    console.warn("[assistant-schema] Could not add assistant columns:", err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------------
// Assistant user resolver
// ---------------------------------------------------------------------------

export async function resolveAssistantUserByClientId(clientId: string) {
  const result = await betterAuthDb
    .select({ id: betterAuthUsers.id, username: betterAuthUsers.username })
    .from(betterAuthUsers)
    .where(and(eq(betterAuthUsers.clientId, clientId), eq(betterAuthUsers.userType, "assistant")))
    .limit(1);
  return result[0] ?? null;
}

// ---------------------------------------------------------------------------
// Built-in @cinatra assistant seed
// ---------------------------------------------------------------------------

async function ensureBuiltInCinatraAssistant() {
  // Serialize the seed via a pg advisory transaction lock so two concurrent
  // callers (boot instrumentation + getAuthSession's fire-and-forget at
  // auth-session.ts) cannot both generate distinct (clientId, clientSecret,
  // userId) triples and create orphaned oauthClient rows. The two-int4 key
  // form is the canonical bigint-compatible advisory-lock shape; both inputs
  // hash to a stable int4 and the pair becomes the 64-bit lock id. The lock
  // releases automatically at transaction end (commit OR rollback).
  //
  // Repair-on-drift: an earlier seeder targeted the wrong table name and
  // silently failed at INSERT, leaving installs with a valid assistant
  // user row but NO matching oauthClient. The flow below detects that
  // drift state and repairs it — re-issues a new clientId/clientSecret
  // pair, updates the user row's "clientId" column, and inserts the
  // matching oauthClient row — all inside the locked transaction so
  // concurrent callers cannot fight over the repair.
  try {
    await betterAuthDb.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('cinatra'), hashtext('builtin-assistant-seed'))`,
      );

      const userRow = await tx.execute<{ id: string; clientId: string | null }>(
        sql`SELECT id, "clientId" FROM public."user" WHERE username = 'cinatra' AND "userType" = 'assistant' LIMIT 1`,
      );
      const existingUser = userRow.rows[0];

      if (existingUser) {
        // User exists — check whether the oauthClient row exists too.
        const oauthRow = await tx.execute<{ count: string }>(
          sql`SELECT count(*)::text as count FROM public."oauthClient" WHERE "userId" = ${existingUser.id}`,
        );
        if (Number(oauthRow.rows[0]?.count ?? "0") > 0) {
          // Steady state — nothing to do.
          return;
        }

        // Drift state — assistant user has no matching oauthClient row
        // (legacy seeder's INSERT targeted the wrong table name and was
        // silently dropped). Repair by issuing a fresh clientId /
        // clientSecret pair, updating the user row's clientId column, and
        // inserting the oauthClient.
        const clientId = crypto.randomUUID();
        const clientSecret = crypto.randomUUID();
        const now = new Date();

        await tx.execute(sql`
          UPDATE public."user"
          SET "clientId" = ${clientId}, "updatedAt" = ${now}
          WHERE id = ${existingUser.id}
        `);

        await insertOAuthClientWithTx(tx, {
          id: existingUser.id,
          userId: existingUser.id,
          clientId,
          clientSecret,
          name: "cinatra-built-in",
        });

        console.log(
          "[cinatra-assistant] Repaired drift — existing assistant user had no oauthClient row.",
        );
        console.log(`  CINATRA_BUILTIN_CLIENT_ID=${clientId}`);
        console.log(`  CINATRA_BUILTIN_CLIENT_SECRET=${clientSecret}`);
        return;
      }

      // Fresh install — no assistant user row exists yet.
      const clientId = crypto.randomUUID();
      const clientSecret = crypto.randomUUID();
      const userId = crypto.randomUUID();
      const now = new Date();

      // INSERT user FIRST — the FK direction is
      // public."oauthClient"."userId" -> public."user".id. The advisory
      // lock guarantees no concurrent caller is inside this critical
      // section, so the user-INSERT cannot race itself for the unique
      // username 'cinatra'.
      await tx.execute(sql`
        INSERT INTO public."user" (id, name, email, username, "userType", "clientId", "createdAt", "updatedAt", "emailVerified")
        VALUES (
          ${userId},
          'cinatra',
          'cinatra@system.local',
          'cinatra',
          'assistant',
          ${clientId},
          ${now},
          ${now},
          true
        )
      `);

      await insertOAuthClientWithTx(tx, {
        id: userId,
        userId,
        clientId,
        clientSecret,
        name: "cinatra-built-in",
      });

      console.log("[cinatra-assistant] Built-in @cinatra assistant seeded.");
      console.log(`  CINATRA_BUILTIN_CLIENT_ID=${clientId}`);
      console.log(`  CINATRA_BUILTIN_CLIENT_SECRET=${clientSecret}`);
    });
  } catch (err) {
    console.warn(
      "[cinatra-assistant] Could not seed built-in @cinatra assistant:",
      err instanceof Error ? err.message : err,
    );
  }
}

// The additional built-in assistant is not seeded for new installs.
// Existing rows in public."user" remain so any chat threads / mentions stay valid.

export async function ensureAssistantBootstrap() {
  await ensureAssistantUserSchema();
  await ensureBuiltInCinatraAssistant();
}
