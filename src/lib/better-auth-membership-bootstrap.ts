import { and, eq } from "drizzle-orm";

import { betterAuthDb, betterAuthMembers } from "@/lib/better-auth-db";

export type EnsureMembershipResult = {
  /** id of the surviving membership row for (organizationId, userId). */
  id: string;
  /** role of the surviving row after arbitration. */
  role: string | null;
  /** true on net mutation (row inserted OR promoted to owner); false on no-op. */
  changed: boolean;
};

// Idempotent, race-safe single-membership writer for public."member".
//
// The member_org_user_uniq UNIQUE index enforces one row per
// (organizationId, userId), so two concurrent callers can no longer both
// INSERT — the loser's INSERT becomes a no-op via ON CONFLICT DO NOTHING.
// Without this single writer, ensureInitialAdminBootstrap +
// ensureDefaultOrganizationMembership could both miss a SELECT and both
// INSERT, leaving duplicate membership rows (and, worse, letting a "member"
// insert beat the "owner" insert for the first user).
//
// Role arbitration is PROMOTE-ONLY — it NEVER downgrades. `insertRole` is
// the role used iff this caller wins the INSERT. `promoteToOwner` decides
// whether, on the conflict path, a surviving non-owner row is upgraded to
// "owner". A caller must pass promoteToOwner=false unless it has authority
// to make this user the org owner (instance bootstrap, or a platform-admin
// landing in the Default org) — otherwise a legitimately-set 'owner'/'admin'
// row would be at risk of an unwanted write.
export async function ensureBetterAuthMembershipRow(
  userId: string,
  organizationId: string,
  insertRole: string,
  promoteToOwner: boolean,
): Promise<EnsureMembershipResult> {
  const inserted = await betterAuthDb
    .insert(betterAuthMembers)
    .values({
      id: crypto.randomUUID(),
      organizationId,
      userId,
      role: insertRole,
      createdAt: new Date(),
    })
    .onConflictDoNothing({
      target: [betterAuthMembers.organizationId, betterAuthMembers.userId],
    })
    .returning({ id: betterAuthMembers.id });

  if (inserted.length > 0) {
    // Won the INSERT — the row was created with insertRole.
    return { id: inserted[0].id, role: insertRole, changed: true };
  }

  // Lost the race (or a row already existed). Recover the surviving row so
  // the promote-only arbitration has something to operate on.
  const existing = await betterAuthDb
    .select({ id: betterAuthMembers.id, role: betterAuthMembers.role })
    .from(betterAuthMembers)
    .where(and(eq(betterAuthMembers.organizationId, organizationId), eq(betterAuthMembers.userId, userId)))
    .limit(1);

  if (existing.length === 0) {
    throw new Error(
      `ensureBetterAuthMembershipRow: member row for (organizationId=${organizationId}, userId=${userId}) disappeared after ON CONFLICT DO NOTHING (concurrent DELETE?)`,
    );
  }

  const row = existing[0];

  // PROMOTE-ONLY. Only ever write "owner", and only when authorized and the
  // surviving row is not ALREADY owner-capable. The owner check is comma-aware:
  // Better Auth stores multi-role membership as comma-joined text and splits
  // member.role on commas in its permission checks, so a row of 'owner,admin'
  // already grants owner — clobbering it down to plain 'owner' would drop the
  // 'admin' token. Never write insertRole over an existing row — that is the
  // downgrade this writer exists to prevent.
  const alreadyOwner = String(row.role ?? "")
    .split(",")
    .map((r) => r.trim())
    .includes("owner");
  if (promoteToOwner && !alreadyOwner) {
    await betterAuthDb
      .update(betterAuthMembers)
      .set({ role: "owner" })
      .where(eq(betterAuthMembers.id, row.id));
    return { id: row.id, role: "owner", changed: true };
  }

  return { id: row.id, role: row.role, changed: false };
}
