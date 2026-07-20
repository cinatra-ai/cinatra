"use server";

import { sql } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { requireAuthSession } from "@/lib/auth-session";
import {
  betterAuthDb,
  readTeamCreatableOrganizationsForUser,
  teamMemberRoleColumnExists,
} from "@/lib/better-auth-db";
import { entityId } from "@/lib/id-policy";
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

  const teamId = entityId();
  const teamMemberId = entityId();
  const now = new Date();
  const slugBase = toTeamSlugBase(name);

  // The creator becomes the team's admin (cinatra#1566). On a deployment
  // where the app-owned role column is not provisioned yet, fall back to the
  // roleless insert — the provisioning backfill promotes the earliest member
  // (= this creator) to 'admin' when `pnpm auth:migrate` next runs, so the
  // degrade self-heals. Probed OUTSIDE the transaction: a failed statement
  // would abort the whole tx.
  const hasRoleColumn = await teamMemberRoleColumnExists();

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

    if (hasRoleColumn) {
      await tx.execute(sql`
        INSERT INTO public."teamMember" (id, "teamId", "userId", "role", "createdAt")
        VALUES (${teamMemberId}, ${teamId}, ${session.user.id}, 'admin', ${now})
      `);
    } else {
      await tx.execute(sql`
        INSERT INTO public."teamMember" (id, "teamId", "userId", "createdAt")
        VALUES (${teamMemberId}, ${teamId}, ${session.user.id}, ${now})
      `);
    }
    return { ok: true as const };
  });

  if (!result.ok) {
    redirect("/teams/new?error=slug-conflict");
  }

  // /teams is ACTIVE-organization scoped (its cube hard-filters teams to the
  // session's active org), but a team can be created in ANY org the caller
  // owns/administers — not necessarily the active one. Without switching, a
  // team created in a non-active org would land nowhere visible (#1495). So
  // set the session's active organization to the new team's org before landing
  // on /teams. Better Auth's server-side set-active endpoint re-validates
  // membership (guaranteed here — the org came from the owner/admin creatable
  // set above) and propagates the refreshed session cookie via the nextCookies
  // plugin. Skip the round-trip when the chosen org is already active (no-op,
  // identical to the prior behavior).
  if (organizationId !== session.session?.activeOrganizationId) {
    await auth.api.setActiveOrganization({
      headers: await headers(),
      body: { organizationId },
    });
  }

  redirect("/teams");
}
