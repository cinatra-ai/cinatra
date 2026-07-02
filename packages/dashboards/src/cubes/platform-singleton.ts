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
  type RegisteredCube,
} from "@cinatra-ai/sdk-dashboard/adapters/drizzle-cube";

import {
  membersForCube,
  objectsForCube,
  organizationsForCube,
  projectsForCube,
  teamsForCube,
  usageEventsForCube,
} from "./dashboard-cube-bindings";
import {
  buildRuntimeRegisteredCubes,
  listRuntimeCubeIds,
  RUNTIME_CUBE_FROM_ALLOWLIST,
  type RuntimeCubeFromTable,
} from "./runtime-cube-registry";

/**
 * The names of every BUNDLED cube. Derived from the SAME descriptors the
 * `buildBundledCubes` array instantiates, so the catalog can never drift from
 * what is actually compiled.
 *
 * Bundled cubes register at boot; runtime cubes (aliases over an allowlisted
 * bundled cube) register on install via the runtime-cube-registry and are
 * MERGED into the compiled platform on the next (lazy) rebuild.
 */
const BUNDLED_CUBE_NAMES = [
  AGENT_RUNS_CUBE_DESCRIPTOR.id,
  PROJECTS_CUBE_DESCRIPTOR.id,
  TEAMS_CUBE_DESCRIPTOR.id,
  ORGANIZATIONS_CUBE_DESCRIPTOR.id,
  ARTIFACTS_CUBE_DESCRIPTOR.id,
  LLM_USAGE_CUBE_DESCRIPTOR.id,
] as const;

/**
 * Host-owned accessor returning the BUNDLED cube names only (`agent_runs`,
 * `projects`, `teams`, `organizations`, `artifacts`, `llm_usage`). The cube
 * guard uses this as the host catalog of bundled-and-always-present cubes.
 */
export function listBundledCubeNames(): string[] {
  return [...BUNDLED_CUBE_NAMES];
}

/**
 * The full set of cube names CURRENTLY registered into the platform: bundled ∪
 * active-runtime. The runtime extension installer queries this to validate
 * portlet cube references against everything resolvable right now. Returns a
 * fresh array each call.
 */
export function listRegisteredCubeNames(): string[] {
  return [...BUNDLED_CUBE_NAMES, ...listRuntimeCubeIds()];
}

/**
 * Whether `cubeId` is a bundled (host-owned, no install row) cube. The
 * serve-gate uses this to know which cubes skip the install-active assertion
 * (bundled bypass) — the tenant predicate is NEVER skipped for either kind.
 */
export function isBundledCube(cubeId: string): boolean {
  return (BUNDLED_CUBE_NAMES as readonly string[]).includes(cubeId);
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
 * Build the BUNDLED `RegisteredCube` list keyed by host cube id. These are the
 * host-owned cubes whose SQL + tenant predicate runtime aliases reuse. Kept as
 * a map so the runtime-cube registry can resolve a FROM-allowlisted base cube
 * by id (`agent_runs`, `projects`, `teams`, `organizations`) to alias from.
 */
function buildBundledCubesById(): Map<string, RegisteredCube> {
  const cubes: RegisteredCube[] = [
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
  ];
  const byId = new Map<string, RegisteredCube>();
  for (const c of cubes) byId.set(c.descriptor.id, c);
  return byId;
}

/**
 * The published member ids (dimensions ∪ measures) of a FROM-allowlisted base
 * cube. The runtime-cube installer validates that an extension's declared
 * member subset references ONLY members the host already publishes for that
 * table — a runtime cube can never reference a column the host did not expose.
 */
export function publishedMembersOfBaseCube(fromTable: RuntimeCubeFromTable): string[] {
  const byId = buildBundledCubesById();
  const base = byId.get(fromTable);
  if (!base) return [];
  return [
    ...base.descriptor.dimensions.map((d) => d.id),
    ...base.descriptor.measures.map((m) => m.id),
  ];
}

/** A `(fromTable) => publishedMembers` accessor over the FROM-allowlist. */
export function basePublishedMembersAccessor(): (
  fromTable: RuntimeCubeFromTable,
) => string[] {
  // Build the base map ONCE per accessor so a validate-many call doesn't
  // re-instantiate the bundled cubes per descriptor.
  const byId = buildBundledCubesById();
  return (fromTable) => {
    const base = byId.get(fromTable);
    if (!base) return [];
    return [
      ...base.descriptor.dimensions.map((d) => d.id),
      ...base.descriptor.measures.map((m) => m.id),
    ];
  };
}

/**
 * Resolve the process-wide `DashboardCubesPlatform`. Both transports
 * (HTTP cubejs + MCP cube tools) call this — they get the same instance,
 * with the same `SemanticLayerCompiler` and the same cube registrations
 * (bundled ∪ active-runtime).
 */
export function getDashboardCubesPlatform(): DashboardCubesPlatform {
  if (globalThis.__cinatraDashboardsCubePlatform) {
    return globalThis.__cinatraDashboardsCubePlatform;
  }
  const db = drizzle(getPool());
  const bundledById = buildBundledCubesById();
  // Merge runtime cubes (aliases over an allowlisted bundled base cube). A
  // runtime alias whose base table is FROM-allowlisted reuses that base cube's
  // host SQL + tenant predicate verbatim. The allowlist is the only set a
  // runtime cube can derive from.
  const allowlistedBases = new Map<string, RegisteredCube>();
  for (const id of RUNTIME_CUBE_FROM_ALLOWLIST) {
    const base = bundledById.get(id);
    if (base) allowlistedBases.set(id, base);
  }
  const runtimeCubes = buildRuntimeRegisteredCubes(allowlistedBases);
  const platform = createDashboardCubesPlatform({
    drizzle: db,
    // Every Drizzle table referenced by ANY registered cube must appear
    // in `schema` so drizzle-cube's compiler can introspect FROM/JOIN
    // names. The narrow bindings (`projectsForCube`, `organizationsForCube`,
    // etc.) reference the same underlying tables as the canonical bindings
    // — they widen Drizzle's TYPE surface, never the runtime schema. Runtime
    // cubes alias a bundled base, so they introduce NO new FROM table.
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
    cubes: [...bundledById.values(), ...runtimeCubes],
  });
  globalThis.__cinatraDashboardsCubePlatform = platform;
  return platform;
}

/**
 * Reconcile the platform after a runtime cube install/disable/uninstall changed
 * the runtime cube set. Clears the platform singleton (and, via the caller, the
 * MCP cube-tools bridge) so the NEXT `getDashboardCubesPlatform()` rebuilds with
 * the current bundled ∪ active-runtime set. Rebuild-whole-platform (codex-
 * converged) — there is no partial-registration window. The pool is preserved
 * (only the compiled layer is rebuilt).
 *
 * IMPORTANT: the MCP cube-tools bridge caches its own reference to the layer on
 * `globalThis.__cinatraDashboardsMcpCubeTools`; the host must clear that bridge
 * too (see `reconcileRuntimeCubePlatform` in the dashboards barrel) or MCP would
 * keep serving the OLD cube list. This function only clears the platform.
 */
export function clearDashboardCubesPlatformForReconcile(): void {
  globalThis.__cinatraDashboardsCubePlatform = undefined;
}

/** Test-only — clear the global singleton so a fresh build is forced. */
export function __resetDashboardCubesPlatformForTests(): void {
  globalThis.__cinatraDashboardsCubePool = undefined;
  globalThis.__cinatraDashboardsCubePlatform = undefined;
}
