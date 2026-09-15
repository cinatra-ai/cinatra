// Test stub for `@/lib/auth-session` (cinatra#1377).
//
// `packages/objects/src/mcp/registry.ts` resolves the caller's canonical
// project-grant axis for the request frame's own identity pair through
// `resolveActorGrantsForUserInOrg`. The real module pulls better-auth plus the
// Postgres bridge at import; route to this stub so every test that loads the
// registry resolves the specifier. The default resolves to NO grants (the
// fail-closed shape); the grant-forwarding test overrides it via
// `vi.mock("@/lib/auth-session")`.

export type StubProjectGrant = {
  projectId: string;
  effectiveRole: "read" | "write" | "admin" | "owner";
  accessSource: "owner" | "user" | "team" | "organization" | "workspace";
};

export async function resolveActorGrantsForUserInOrg(
  _userId: string,
  _orgId: string,
): Promise<{ projectGrants: StubProjectGrant[]; teamIds: string[] }> {
  return { projectGrants: [], teamIds: [] };
}
