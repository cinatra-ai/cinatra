/**
 * Vitest stub for `@/lib/project-co-owners-store`.
 *
 * Handlers use readProjectCoOwners only for the kernel resource envelope.
 * Tests mock it to []. Co-owners are read through projectGrants; there is no
 * auto-migration.
 */
export const readProjectCoOwners = async (
  _projectId: string,
): Promise<Array<{ userId: string }>> => [];
