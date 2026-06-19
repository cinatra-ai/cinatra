/**
 * Process-wide singleton holder for the `DashboardCubesPlatform`. Both the
 * HTTP cubejs route at
 * `src/app/api/dashboards/cubejs-api/v1/[...endpoint]/route.ts` and the
 * MCP cube tools at `packages/dashboards/src/mcp-cubes/cubes-singleton.ts`
 * resolve through this module, guaranteeing they share ONE
 * `SemanticLayerCompiler` with ONE registered cube list.
 *
 * Lazy construction: the first caller wakes the Postgres pool, builds the
 * drizzle-cube layer, and registers cubes; subsequent callers reuse the
 * cached platform. HMR-safe via `globalThis`.
 */
import "server-only";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

import { agentRuns, agentTemplates } from "@cinatra-ai/agents/schema";
import {
  AGENT_RUNS_CUBE_DESCRIPTOR,
  ARTIFACTS_CUBE_DESCRIPTOR,
  LLM_USAGE_CUBE_DESCRIPTOR,
  ORGANIZATIONS_CUBE_DESCRIPTOR,
  PROJECTS_CUBE_DESCRIPTOR,
  TEAMS_CUBE_DESCRIPTOR,
  createAgentRunsCube,
  createArtifactsCube,
  createDashboardCubesPlatform,
  createLlmUsageCube,
  createOrganizationsCube,
  createProjectsCube,
  createTeamsCube,
  type DashboardCubesPlatform,
} from "@cinatra-ai/sdk-dashboard/adapters/drizzle-cube";

import {
  membersForCube,
  objectsForCube,
  organizationsForCube,
  projectsForCube,
  teamsForCube,
  usageEventsForCube,
} from "./dashboard-cube-bindings";

/**
 * The names of every cube registered into the process-wide
 * `DashboardCubesPlatform` below. Derived from the SAME descriptors the
 * literal `cubes: [...]` array in `getDashboardCubesPlatform` instantiates,
 * so the catalog can never drift from what is actually compiled.
 *
 * Cubes register STATICALLY at boot (the literal array in
 * `getDashboardCubesPlatform`). A runtime-installed extension cannot add a
 * new cube — the installer queries this catalog to reject (or flag for
 * rebuild) any extension that references or contributes a cube outside it.
 */
const REGISTERED_CUBE_NAMES = [
  AGENT_RUNS_CUBE_DESCRIPTOR.id,
  PROJECTS_CUBE_DESCRIPTOR.id,
  TEAMS_CUBE_DESCRIPTOR.id,
  ORGANIZATIONS_CUBE_DESCRIPTOR.id,
  ARTIFACTS_CUBE_DESCRIPTOR.id,
  LLM_USAGE_CUBE_DESCRIPTOR.id,
] as const;

/**
 * Host-owned accessor returning the set of cube names registered into the
 * platform (`agent_runs`, `projects`, `teams`, `organizations`,
 * `artifacts`, `llm_usage`). The runtime extension installer calls this to learn the
 * fixed cube catalog before validating an extension's dashboard config /
 * declared cube contributions. Returns a fresh array each call.
 */
export function listRegisteredCubeNames(): string[] {
  return [...REGISTERED_CUBE_NAMES];
}

declare global {
  // eslint-disable-next-line no-var
  var __cinatraDashboardsCubePool: Pool | undefined;
  // eslint-disable-next-line no-var
  var __cinatraDashboardsCubePlatform: DashboardCubesPlatform | undefined;
}

function getPool(): Pool {
  if (globalThis.__cinatraDashboardsCubePool) return globalThis.__cinatraDashboardsCubePool;
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    throw new Error(
      "Dashboard cube platform requires SUPABASE_DB_URL — set it in the host environment",
    );
  }
  const pool = new Pool({ connectionString });
  globalThis.__cinatraDashboardsCubePool = pool;
  return pool;
}

/**
 * Resolve the process-wide `DashboardCubesPlatform`. Both transports
 * (HTTP cubejs + MCP cube tools) call this — they get the same instance,
 * with the same `SemanticLayerCompiler` and the same cube registrations.
 */
export function getDashboardCubesPlatform(): DashboardCubesPlatform {
  if (globalThis.__cinatraDashboardsCubePlatform) {
    return globalThis.__cinatraDashboardsCubePlatform;
  }
  const db = drizzle(getPool());
  const platform = createDashboardCubesPlatform({
    drizzle: db,
    // Every Drizzle table referenced by ANY registered cube must appear
    // in `schema` so drizzle-cube's compiler can introspect FROM/JOIN
    // names. The narrow bindings (`projectsForCube`, `organizationsForCube`,
    // etc.) reference the same underlying tables as the canonical bindings
    // — they widen Drizzle's TYPE surface, never the runtime schema.
    schema: {
      agentRuns,
      agentTemplates,
      projectsForCube,
      organizationsForCube,
      teamsForCube,
      membersForCube,
      objectsForCube,
      usageEventsForCube,
    },
    cubes: [
      createAgentRunsCube({
        // Drizzle-cube introspects the full Drizzle Table for the FROM
        // clause, so this must be the table reference rather than a column map.
        tableRef: agentRuns,
        columns: {
          id: agentRuns.id,
          templateId: agentRuns.templateId,
          status: agentRuns.status,
          createdAt: agentRuns.createdAt,
          orgId: agentRuns.orgId,
          runBy: agentRuns.runBy,
        },
        // LEFT JOIN target for the agent_name dimension.
        templatesTableRef: agentTemplates,
        templateColumns: {
          id: agentTemplates.id,
          name: agentTemplates.name,
        },
      }),
      createProjectsCube({
        tableRef: projectsForCube,
        columns: {
          id: projectsForCube.id,
          name: projectsForCube.name,
          slug: projectsForCube.slug,
          organizationId: projectsForCube.organizationId,
          archivedAt: projectsForCube.archivedAt,
          createdAt: projectsForCube.createdAt,
        },
        organizationsTableRef: organizationsForCube,
        organizationColumns: {
          id: organizationsForCube.id,
          name: organizationsForCube.name,
        },
      }),
      createTeamsCube({
        tableRef: teamsForCube,
        columns: {
          id: teamsForCube.id,
          name: teamsForCube.name,
          organizationId: teamsForCube.organizationId,
          createdAt: teamsForCube.createdAt,
        },
        organizationsTableRef: organizationsForCube,
        organizationColumns: {
          id: organizationsForCube.id,
          name: organizationsForCube.name,
        },
      }),
      createOrganizationsCube({
        tableRef: organizationsForCube,
        columns: {
          id: organizationsForCube.id,
          name: organizationsForCube.name,
          slug: organizationsForCube.slug,
          createdAt: organizationsForCube.createdAt,
        },
        membersTableRef: membersForCube,
        memberColumns: {
          organizationId: membersForCube.organizationId,
          userId: membersForCube.userId,
          role: membersForCube.role,
        },
      }),
      createArtifactsCube({
        tableRef: objectsForCube,
        columns: {
          id: objectsForCube.id,
          type: objectsForCube.type,
          orgId: objectsForCube.orgId,
          data: objectsForCube.data,
          createdAt: objectsForCube.createdAt,
          deletedAt: objectsForCube.deletedAt,
        },
      }),
      createLlmUsageCube({
        tableRef: usageEventsForCube,
        columns: {
          id: usageEventsForCube.id,
          costUsd: usageEventsForCube.costUsd,
          inputTokens: usageEventsForCube.inputTokens,
          outputTokens: usageEventsForCube.outputTokens,
          cachedInputTokens: usageEventsForCube.cachedInputTokens,
          reasoningOutputTokens: usageEventsForCube.reasoningOutputTokens,
          model: usageEventsForCube.model,
          provider: usageEventsForCube.provider,
          agentLabel: usageEventsForCube.agentLabel,
          skillLabel: usageEventsForCube.skillLabel,
          operation: usageEventsForCube.operation,
          occurredAt: usageEventsForCube.occurredAt,
        },
      }),
    ],
  });
  globalThis.__cinatraDashboardsCubePlatform = platform;
  return platform;
}

/** Test-only — clear the global singleton so a fresh build is forced. */
export function __resetDashboardCubesPlatformForTests(): void {
  globalThis.__cinatraDashboardsCubePool = undefined;
  globalThis.__cinatraDashboardsCubePlatform = undefined;
}
