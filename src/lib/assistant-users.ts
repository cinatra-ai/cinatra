import "server-only";

import { and, eq } from "drizzle-orm";
import {
  betterAuthDb,
  betterAuthUsers,
  assistantHandles,
} from "@/lib/better-auth-db";
import { sql, type SQL } from "drizzle-orm";
import {
  deleteOAuthClientByClientId,
  insertOAuthClientWithTx,
  insertOAuthClient,
} from "@/lib/better-auth-oauth-client";
import { entityId } from "@/lib/id-policy";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AssistantUser = {
  id: string;
  username: string | null;
  email: string | null;
  clientId: string | null;
  userType: string | null;
};

export type CreateAssistantResult = AssistantUser & {
  clientSecret: string;
};

/** A transaction-bound executor (the object `betterAuthDb.transaction` yields) —
 *  structurally what `insertOAuthClientWithTx` accepts. Kept local + minimal so
 *  the principal-mint primitive is decoupled from drizzle's concrete tx type. */
export type BetterAuthTxExecutor = { execute: (query: SQL) => Promise<unknown> };

/** Reserved username of the built-in Cinatra assistant PRINCIPAL. The
 *  assistant-agent registration bootstrap (cinatra#1037 P1.3) owns its minting
 *  and its 1:1 template link; deletion is refused (see deleteAssistantUser) so
 *  the host-attribution + registration invariants (I3/I4) cannot be broken from
 *  the admin UI. */
export const BUILT_IN_CINATRA_ASSISTANT_USERNAME = "cinatra";

/** Reserved username of the built-in WordPress assistant PRINCIPAL (cinatra#1823,
 *  epic #1037 P4.1). Minted through the SAME single principal-minting path (I3)
 *  as @cinatra by the assistant-agent registration bootstrap, with its own
 *  distinct `assistant_config`. */
export const BUILT_IN_WORDPRESS_ASSISTANT_USERNAME = "wordpress";

/** Reserved username of the built-in Drupal assistant PRINCIPAL (cinatra#1823,
 *  epic #1037 P4.1). Minted through the SAME single principal-minting path (I3)
 *  as @cinatra by the assistant-agent registration bootstrap, with its own
 *  distinct `assistant_config`. */
export const BUILT_IN_DRUPAL_ASSISTANT_USERNAME = "drupal";

// ---------------------------------------------------------------------------
// listAssistantUsers
// ---------------------------------------------------------------------------

export async function listAssistantUsers(): Promise<AssistantUser[]> {
  const rows = await betterAuthDb
    .select({
      id: betterAuthUsers.id,
      username: betterAuthUsers.username,
      email: betterAuthUsers.email,
      clientId: betterAuthUsers.clientId,
      userType: betterAuthUsers.userType,
    })
    .from(betterAuthUsers)
    .where(eq(betterAuthUsers.userType, "assistant"));
  return rows;
}

// ---------------------------------------------------------------------------
// createAssistantUserWithTx — the assistant PRINCIPAL mint primitive (I3)
// ---------------------------------------------------------------------------
//
// cinatra#1037 P1.3 re-plumb: assistant-agent registration is the ONLY
// principal-minting path. This primitive INSERTs the assistant `public."user"`
// row + its matching `public."oauthClient"` row inside a caller-supplied
// transaction, so the registration bootstrap can hold its advisory lock across
// resolve-or-mint on the SAME connection (a lock on a different connection would
// not serialize this mint). It intentionally does NOT mint the mention handle —
// the caller does that AFTER the tx commits (best-effort; the boot backfill is
// the self-healing net), keeping the handle registry write off the critical mint
// transaction.
//
// The ONLY caller is src/lib/assistant-agent-registration.ts. A single-caller
// grep-gate (principal-minting-single-caller.test.ts) pins this invariant.

export async function createAssistantUserWithTx(
  tx: BetterAuthTxExecutor,
  params: { username: string; email?: string },
): Promise<CreateAssistantResult> {
  const clientId = crypto.randomUUID();
  const clientSecret = crypto.randomUUID();
  // The user row is an ENTITY id (policy: src/lib/id-policy.ts, cinatra#1907);
  // clientId/clientSecret above are OAuth credentials, not entity ids.
  const userId = entityId();
  const email = params.email ?? `${params.username}@system.local`;
  const now = new Date();

  // Insert the user row FIRST, then the matching oauthClient row — the FK
  // direction is public."oauthClient"."userId" -> public."user".id. Both writes
  // ride the caller's transaction so a unique-username collision on the user
  // INSERT can never leave an orphan oauthClient row behind.
  await tx.execute(sql`
    INSERT INTO public."user" (id, name, email, username, "userType", "clientId", "createdAt", "updatedAt", "emailVerified")
    VALUES (
      ${userId},
      ${params.username},
      ${email},
      ${params.username},
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
    name: `assistant-${params.username}`,
  });

  return { id: userId, username: params.username, email, clientId, userType: "assistant", clientSecret };
}

// ---------------------------------------------------------------------------
// deleteAssistantUser
// ---------------------------------------------------------------------------

/** True when `id` is the built-in Cinatra assistant PRINCIPAL — the one
 *  registration-owned principal that must never be deleted (it is load-bearing
 *  for host-reply attribution (I4) and the single-registration invariant (I3)).
 *  Every user-deletion path guards on this: the /configuration/assistants delete
 *  (deleteAssistantUser, below) AND the /configuration/permissions Better-Auth
 *  removeUser path — deleting it would strand @cinatra's handle + template link
 *  until the next boot re-seed. */
export async function isBuiltInCinatraAssistantUserId(id: string): Promise<boolean> {
  const row = await betterAuthDb
    .select({ username: betterAuthUsers.username })
    .from(betterAuthUsers)
    .where(and(eq(betterAuthUsers.id, id), eq(betterAuthUsers.userType, "assistant")))
    .limit(1);
  return row[0]?.username === BUILT_IN_CINATRA_ASSISTANT_USERNAME;
}

/** Directing message shown when a delete is refused because the principal is
 *  owned by an installed extension (cinatra#1880 W5 AC#3). */
export const EXTENSION_OWNED_ASSISTANT_DELETE_MESSAGE =
  "This assistant is owned by an installed extension. Uninstall the package to remove it.";

/** True when `id` is an EXTENSION-OWNED assistant principal — its registry handle
 *  carries `origin='extension'` (cinatra#1874 W1). An extension-owned principal's
 *  lifecycle is exclusively package install/archive, so it must be non-deletable
 *  from BOTH the Assistants surface (deleteAssistantUser) AND the Permissions
 *  surface (removeUser). Standalone principals (origin='standalone') are
 *  unaffected — they remain deletable. The builtin Cinatra principal is guarded
 *  separately (isBuiltInCinatraAssistantUserId); its handle is 'standalone', so
 *  this check does not cover it. */
export async function isExtensionOwnedAssistantPrincipal(id: string): Promise<boolean> {
  const row = await betterAuthDb
    .select({ origin: assistantHandles.origin })
    .from(assistantHandles)
    .where(eq(assistantHandles.assistantUserId, id))
    .limit(1);
  return row[0]?.origin === "extension";
}

export async function deleteAssistantUser(id: string): Promise<void> {
  // Refuse to delete the built-in Cinatra principal from ANY path (see
  // isBuiltInCinatraAssistantUserId).
  if (await isBuiltInCinatraAssistantUserId(id)) {
    throw new Error("The built-in Cinatra assistant cannot be deleted.");
  }
  // Refuse to delete an extension-owned principal — its lifecycle is package
  // install/archive only (cinatra#1880 W5 AC#3). Standalone principals pass.
  if (await isExtensionOwnedAssistantPrincipal(id)) {
    throw new Error(EXTENSION_OWNED_ASSISTANT_DELETE_MESSAGE);
  }

  // 1. Look up clientId before deleting user
  const row = await betterAuthDb
    .select({ clientId: betterAuthUsers.clientId })
    .from(betterAuthUsers)
    .where(and(eq(betterAuthUsers.id, id), eq(betterAuthUsers.userType, "assistant")))
    .limit(1);

  const clientId = row[0]?.clientId;

  // 2. Release the registry handle FIRST (cinatra#1037 P1.2), before the
  //    principal — so a mid-delete failure leaves the principal WITHOUT a handle
  //    (not mentionable; re-minted by the boot backfill) rather than an ORPHAN
  //    handle that resolution would still return as a live assistant.
  await betterAuthDb.delete(assistantHandles).where(eq(assistantHandles.assistantUserId, id));

  // 3. Delete OAuth client
  if (clientId) {
    await deleteOAuthClientByClientId(clientId);
  }

  // 4. Delete user row
  await betterAuthDb.execute(sql`
    DELETE FROM public."user" WHERE id = ${id} AND "userType" = 'assistant'
  `);
}

// ---------------------------------------------------------------------------
// rotateAssistantClient
// ---------------------------------------------------------------------------

export async function rotateAssistantClient(id: string): Promise<{ clientId: string; clientSecret: string }> {
  // 1. Look up current clientId
  const row = await betterAuthDb
    .select({ clientId: betterAuthUsers.clientId, username: betterAuthUsers.username })
    .from(betterAuthUsers)
    .where(and(eq(betterAuthUsers.id, id), eq(betterAuthUsers.userType, "assistant")))
    .limit(1);

  if (!row[0]) throw new Error(`Assistant user not found: ${id}`);

  const oldClientId = row[0].clientId;
  const username = row[0].username ?? id;

  // 2. Delete old OAuth client
  if (oldClientId) {
    await deleteOAuthClientByClientId(oldClientId);
  }

  // 3. Create new OAuth client — the assistant user row already exists,
  // so the FK to user(id) is satisfied; no transaction wrap needed here.
  const newClientId = crypto.randomUUID();
  const newClientSecret = crypto.randomUUID();
  await insertOAuthClient({
    id,
    userId: id,
    clientId: newClientId,
    clientSecret: newClientSecret,
    name: `assistant-${username}`,
  });

  // 4. Update user row
  await betterAuthDb
    .update(betterAuthUsers)
    .set({ clientId: newClientId })
    .where(eq(betterAuthUsers.id, id));

  return { clientId: newClientId, clientSecret: newClientSecret };
}
