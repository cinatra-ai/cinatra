/**
 * Vitest stub for `@/lib/better-auth-db`. The real module eagerly opens a
 * Postgres pool at import time which throws when SUPABASE_DB_URL is unset
 * — and chains through `projects-store.ts` which also throws. Tests for
 * the dashboards MCP cube path only need `listAccessibleOrgIdsForUser`;
 * everything else stays out of the test graph.
 */
export async function listAccessibleOrgIdsForUser(_userId: string): Promise<string[]> {
  return [];
}

// Sidebar org-switcher reads (consumed via `@/lib/auth-session` /
// `src/components/org-switcher-actions.ts`); stubbed to the no-membership
// defaults so modules importing them load without a DB.
export async function readOrganizationNameForUser(
  _userId: string,
  _orgId: string,
): Promise<string | null> {
  return null;
}

export async function listOrganizationsForUser(
  _userId: string,
): Promise<Array<{ id: string; name: string }>> {
  return [];
}
