import "server-only";

import { and, eq } from "drizzle-orm";
import { betterAuthDb, betterAuthUsers } from "@/lib/better-auth-db";
import { sql } from "drizzle-orm";
import {
  deleteOAuthClientByClientId,
  insertOAuthClientWithTx,
  insertOAuthClient,
} from "@/lib/better-auth-oauth-client";

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
// createAssistantUser
// ---------------------------------------------------------------------------

export async function createAssistantUser(params: {
  username: string;
  email?: string;
}): Promise<CreateAssistantResult> {
  const clientId = crypto.randomUUID();
  const clientSecret = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const email = params.email ?? `${params.username}@system.local`;
  const now = new Date();

  // Insert the user row FIRST, then the matching oauthClient row — the FK
  // direction is public."oauthClient"."userId" -> public."user".id. Wrap in
  // a transaction so a unique-username collision on the user INSERT can never
  // leave an orphan oauthClient row behind.
  await betterAuthDb.transaction(async (tx) => {
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
  });

  return { id: userId, username: params.username, email, clientId, userType: "assistant", clientSecret };
}

// ---------------------------------------------------------------------------
// deleteAssistantUser
// ---------------------------------------------------------------------------

export async function deleteAssistantUser(id: string): Promise<void> {
  // 1. Look up clientId before deleting user
  const row = await betterAuthDb
    .select({ clientId: betterAuthUsers.clientId })
    .from(betterAuthUsers)
    .where(and(eq(betterAuthUsers.id, id), eq(betterAuthUsers.userType, "assistant")))
    .limit(1);

  const clientId = row[0]?.clientId;

  // 2. Delete OAuth client
  if (clientId) {
    await deleteOAuthClientByClientId(clientId);
  }

  // 3. Delete user row
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
