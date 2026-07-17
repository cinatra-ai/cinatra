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
    if (!userId) return { title: "Organization" };
    if (!(await readUserIsOrgMember(userId, id))) return { title: "Organization" };
    const rows = await betterAuthDb.execute<{ name: string | null }>(sql`
      SELECT name FROM public."organization" WHERE id = ${id} LIMIT 1
    `);
    const name = rows.rows?.[0]?.name;
    return { title: name || "Organization" };
  } catch {
    return { title: "Organization" };
  }
}

// /organizations/[id] renders a per-org detail DC dashboard (read-only, scoped
// to the single org). The /organizations linked table now links rows here.
export { OrganizationDetailDashboardPage as default } from "@cinatra-ai/dashboards/screens";
