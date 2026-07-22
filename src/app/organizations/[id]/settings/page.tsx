import type { Metadata } from "next";

import { getAuthSession } from "@/lib/auth-session";
import { betterAuthDb, readUserIsOrgMember } from "@/lib/better-auth-db";
import { sql } from "drizzle-orm";

// Gate-repeating metadata (cinatra#1737, the dashboards pattern): the tab
// title repeats the screen's membership gate before disclosing the org name;
// any failure yields the generic title.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  try {
    const { id } = await params;
    const session = await getAuthSession();
    const userId = session?.user.id;
    if (!userId) return { title: "Organization settings" };
    if (!(await readUserIsOrgMember(userId, id))) {
      return { title: "Organization settings" };
    }
    const rows = await betterAuthDb.execute<{ name: string | null }>(sql`
      SELECT name FROM public."organization" WHERE id = ${id} LIMIT 1
    `);
    const name = rows.rows?.[0]?.name;
    return { title: name ? `Organization settings — ${name}` : "Organization settings" };
  } catch {
    return { title: "Organization settings" };
  }
}

// /organizations/[id]/settings — the single org-management surface (#1734):
// the read-only access model next to the management controls. The detail
// page keeps only the dashboards and links here from its header.
export { OrganizationSettingsPage as default } from "@cinatra-ai/dashboards/screens";
