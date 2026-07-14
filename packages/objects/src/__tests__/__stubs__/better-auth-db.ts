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
