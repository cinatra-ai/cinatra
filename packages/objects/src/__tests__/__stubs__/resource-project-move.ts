/**
 * Test stub for `@/lib/resource-project-move`.
 *
 * Real module imports postgres-sync / database with pg.Pool init. No-op
 * stub so handler tests pass through the move surface without touching
 * live PG. Tests that exercise the move path stub locally via vi.mock.
 */

export const runResourceProjectMove = (
  _args: Record<string, unknown>,
): { auditId: string } => {
  return { auditId: "stub-audit-id" };
};

export const runAgentRunMoveWithOutputs = (
  _args: Record<string, unknown>,
): { auditId: string; movedOutputIds: string[] } => {
  return { auditId: "stub-audit-id", movedOutputIds: [] };
};

export const buildResourceProjectMoveQueries = (
  _args: Record<string, unknown>,
): Array<{ text: string; values: unknown[] }> => {
  return [];
};

export type ResourceKind = "object" | "agent_run" | "chat_thread" | "project";
