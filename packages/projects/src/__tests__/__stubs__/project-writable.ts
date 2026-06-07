/**
 * Test stub for `@/lib/project-writable`.
 *
 * The real module imports `@/lib/postgres-sync` + `@/lib/database`,
 * which spin up pg.Pool at module-load. The projects MCP handler tests
 * don't exercise the archive gate's I/O (they assert the SQL emission
 * shape of the binding handlers). This stub returns no-op
 * `assertProjectWritable` / `assertProjectWritableSync` /
 * `assertProjectWritableForRow` so the bindings tests still get the
 * canonical authz path under exercise (assertProjectGrantRole runs
 * first; this stub just lets the gate pass).
 *
 * Tests that want to exercise the archive-reject path stub their own
 * implementation via vi.mock at the test level (mirror the pattern
 * used for projects-store-dao).
 */

export const assertProjectWritable = async (
  _actor: unknown,
  _projectId: string,
  _mode: "read" | "write" | "admin",
): Promise<void> => {
  // no-op — let the SUT proceed past the gate.
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
