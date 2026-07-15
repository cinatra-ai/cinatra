// Test stub for `@/lib/better-auth-db` (cinatra#1379). The objects_list handler
// imports `readTeamsForUser` to resolve the actor's org-scoped team lanes for a
// memory recall (AC4). The real module constructs a pg Pool / drizzle bridge at
// import; route to this lightweight stub so every handler test can load
// handlers.ts without a live DB. The default resolves to NO teams; the recall
// test overrides it via `vi.mock("@/lib/better-auth-db")`.

export async function readTeamsForUser(
  _userId: string,
  _orgId: string,
): Promise<Array<{ id: string; name: string }>> {
  return [];
}

// Sidebar org-switcher reads (consumed via `@/lib/auth-session` /
// `src/components/org-switcher-actions.ts`); stubbed to the no-membership
// defaults so any handler test that pulls those modules loads without a DB.
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
