"use server";

import { randomUUID } from "crypto";
import { sql } from "drizzle-orm";
import { redirect } from "next/navigation";
import { requireAuthSession } from "@/lib/auth-session";
import {
  betterAuthDb,
  readTeamCreatableOrganizationsForUser,
} from "@/lib/better-auth-db";
import { toTeamSlugBase } from "./team-slug";

/** Max slug-allocation attempts within an org before giving up (matches the
 *  project slug allocation budget). */
const MAX_SLUG_ATTEMPTS = 100;

export async function createTeamAction(formData: FormData) {
  const session = await requireAuthSession();
  const name = String(formData.get("name") ?? "").trim();
  const organizationId = String(formData.get("organizationId") ?? "").trim();

  if (!name || !organizationId) {
    redirect("/teams/new?error=missing-fields");
  }

  const organizations = await readTeamCreatableOrganizationsForUser(
    session.user.id,
    session.user.role,
  );
  const organization = organizations.find((item) => item.id === organizationId);

  if (!organization) {
    redirect("/not-authorized");
  }

  const teamId = randomUUID();
  const teamMemberId = randomUUID();
  const now = new Date();
  const slugBase = toTeamSlugBase(name);

  // team + teamMember are one semantic unit — wrap in a transaction so a
  // failure leaves no orphan team. `slug` is NOT NULL + unique per org, so
  // allocate it race-safely via ON CONFLICT DO NOTHING + an incrementing
  // suffix (querying the max suffix would race without locking). Redirects
  // are kept OUTSIDE the transaction (Next's `redirect()` throws to unwind).
  const result = await betterAuthDb.transaction(async (tx) => {
    let allocatedSlug: string | null = null;
    for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS && allocatedSlug === null; attempt += 1) {
      const candidate = attempt === 0 ? slugBase : `${slugBase}-${attempt + 1}`;
      const inserted = await tx.execute(sql`
        INSERT INTO public.team (id, name, slug, "organizationId", "createdAt", "updatedAt")
        VALUES (${teamId}, ${name}, ${candidate}, ${organizationId}, ${now}, ${now})
        ON CONFLICT ("organizationId", slug) DO NOTHING
        RETURNING id
      `);
      if ((inserted.rows?.length ?? 0) > 0) {
        allocatedSlug = candidate;
      }
    }
    if (allocatedSlug === null) {
      return { ok: false as const };
    }

    await tx.execute(sql`
      INSERT INTO public."teamMember" (id, "teamId", "userId", "createdAt")
      VALUES (${teamMemberId}, ${teamId}, ${session.user.id}, ${now})
    `);
    return { ok: true as const };
  });

  if (!result.ok) {
    redirect("/teams/new?error=slug-conflict");
  }

  redirect("/teams");
}
