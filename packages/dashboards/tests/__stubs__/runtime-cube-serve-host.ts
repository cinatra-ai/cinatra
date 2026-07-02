/**
 * Vitest stub for `@/lib/dashboards/runtime-cube-serve-host`. The real module
 * chains through the installed-extension read-model → canonical-store → the
 * Postgres-backed extension store, which throws under a missing SUPABASE_DB_URL
 * in the dashboards package unit env. The MCP cube-path tests here exercise
 * BUNDLED cubes (which the gate always allows) + the vanilla dispatch shape, so
 * the stub allows every cube. Cross-org runtime-cube DENIAL is covered by the
 * host-level test `src/lib/__tests__/runtime-cube-serve-host.test.ts` (which
 * mocks the read-model), not here.
 */
export type McpCubeActor = { userId: string; organizationId: string };

export async function assertMcpRuntimeCubeServeable(): Promise<{ ok: true }> {
  return { ok: true };
}

export async function assertRuntimeCubeServeable(): Promise<{ ok: true }> {
  return { ok: true };
}

export async function filterCubeIdsForActor(cubeIds: readonly string[]): Promise<string[]> {
  return [...cubeIds];
}

export async function filterMcpCubeIdsForActor(cubeIds: readonly string[]): Promise<string[]> {
  return [...cubeIds];
}
