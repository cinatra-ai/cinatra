/**
 * Test stub for `@/lib/project-writable` consumed by the objects
 * MCP handler tests (and by `src/lib/objects-store.ts` which the
 * objects-store-postgres-primary suite imports via the
 * @/lib/objects-store alias).
 *
 * Mirror of packages/projects/src/__tests__/__stubs__/project-writable.ts.
 * No-ops the helper surface so the existing write-path / handler tests
 * pass through the gate. Tests that exercise archive-reject stub their
 * own vi.mock locally.
 */

export const assertProjectWritable = async (
  _actor: unknown,
  _projectId: string,
  _mode: "read" | "write" | "admin",
): Promise<void> => {
  // no-op
};

export const assertProjectWritableSync = (_projectId: string): void => {
  // no-op
};

export const assertProjectWritableForRow = (
  _actor: unknown,
  _row: unknown,
  _mode: "read" | "write" | "admin",
): void => {
  // no-op
};

export type WritableProjectRow = {
  id: string;
  archivedAt: Date | null;
};

export type ReadProjectRow = (
  projectId: string,
) => Promise<WritableProjectRow | null>;
