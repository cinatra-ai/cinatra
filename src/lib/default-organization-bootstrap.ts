import { eq } from "drizzle-orm";

import { betterAuthDb, betterAuthOrganizations } from "@/lib/better-auth-db";

const DEFAULT_ORGANIZATION_SLUG = "default";
const DEFAULT_ORGANIZATION_NAME = "Default";

// Idempotent: returns the id of the row with slug="default" in
// public."organization". Safe under concurrent callers — uses
// ON CONFLICT (slug) DO NOTHING + RETURNING id, falling back to a
// re-SELECT when this caller loses the race. Replaces the previous
// SELECT-then-INSERT pattern in ensureInitialAdminBootstrap +
// ensureDefaultOrganizationMembership that tripped the unique
// constraint `organization_slug_key` (pg error 23505) when two
// concurrent root-layout renders on a fresh DB both reached the
// INSERT step.
export async function ensureDefaultOrganizationRow(): Promise<string> {
  const candidateId = crypto.randomUUID();

  const inserted = await betterAuthDb
    .insert(betterAuthOrganizations)
    .values({
      id: candidateId,
      name: DEFAULT_ORGANIZATION_NAME,
      slug: DEFAULT_ORGANIZATION_SLUG,
      createdAt: new Date(),
    })
    .onConflictDoNothing({ target: betterAuthOrganizations.slug })
    .returning({ id: betterAuthOrganizations.id });

  if (inserted.length > 0) {
    return inserted[0].id;
  }

  const existing = await betterAuthDb
    .select({ id: betterAuthOrganizations.id })
    .from(betterAuthOrganizations)
    .where(eq(betterAuthOrganizations.slug, DEFAULT_ORGANIZATION_SLUG))
    .limit(1);

  if (existing.length === 0) {
    throw new Error(
      `ensureDefaultOrganizationRow: row for slug=${DEFAULT_ORGANIZATION_SLUG} disappeared after ON CONFLICT DO NOTHING (concurrent DELETE?)`,
    );
  }

  return existing[0].id;
}
