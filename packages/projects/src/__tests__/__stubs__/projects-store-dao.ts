/**
 * Vitest stub for `@/lib/projects-store-dao`.
 *
 * Handler imports: readProjectById, updateProject.
 */
export const readProjectById = async (
  _id: string,
): Promise<{
  id: string;
  name: string;
  description: string | null;
  ownerLevel: string;
  ownerId: string;
  organizationId: string | null;
  visibility: string;
  slug: string;
  createdAt: Date;
} | null> => null;

export const updateProject = async (
  _id: string,
  _patch: Record<string, unknown>,
): Promise<void> => undefined;
