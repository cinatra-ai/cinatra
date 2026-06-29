/**
 * Cinatra ↔ drizzle-cube anti-corruption adapter.
 *
 * This directory is the ONLY place in the entire Cinatra repository allowed
 * to import `drizzle-cube/*`. Enforced by ESLint no-restricted-imports
 * (see eslint.config.mjs) with regression tests in
 * src/__tests__/eslint-boundary.test.ts.
 */
export { defineCinatraCube, aliasCinatraCube, type CinatraCubeBuild } from "./define-cube";
export {
  createDrizzleCubeAdapter,
  type AdapterHandle,
  type DrizzleCubeAdapterOptions,
} from "./create-adapter";
export type { RegisteredCube, CinatraCubeBuildSql } from "./types";

// System cubes. Each factory takes the host's Drizzle table reference;
// sdk-dashboard never imports the host schema directly.
export {
  createAgentRunsCube,
  AGENT_RUNS_CUBE_DESCRIPTOR,
  type AgentRunsTable,
  type AgentRunsSecurityContext,
} from "./cubes/agent-runs";
export {
  createProjectsCube,
  PROJECTS_CUBE_DESCRIPTOR,
  type ProjectsTable,
  type OrganizationsTable as ProjectsOrganizationsTable,
  type CreateProjectsCubeOptions,
} from "./cubes/projects";
export {
  createTeamsCube,
  TEAMS_CUBE_DESCRIPTOR,
  type TeamsTable,
  type OrganizationsTable as TeamsOrganizationsTable,
  type CreateTeamsCubeOptions,
} from "./cubes/teams";
export {
  createOrganizationsCube,
  ORGANIZATIONS_CUBE_DESCRIPTOR,
  type OrganizationsTable,
  type MembersTable,
  type CreateOrganizationsCubeOptions,
} from "./cubes/organizations";
export {
  createArtifactsCube,
  ARTIFACTS_CUBE_DESCRIPTOR,
  type ObjectsTable,
  type CreateArtifactsCubeOptions,
} from "./cubes/artifacts";
export {
  createLlmUsageCube,
  LLM_USAGE_CUBE_DESCRIPTOR,
  type UsageEventsTable,
  type CreateLlmUsageCubeOptions,
} from "./cubes/llm-usage";

// MCP bridge — wraps `drizzle-cube/mcp`'s `getCubeTools` into Cinatra-typed
// `{ definitions, handle }` so the Cinatra MCP server registry can host
// `dashboards_cube_discover` / `validate` / `load` over the existing
// /api/mcp auth-gated transport.
export {
  createDrizzleCubeMcpTools,
  type CinatraCubeToolDef,
  type CinatraCubeMcpTools,
  type CinatraCubeMcpResult,
  type CinatraCubeMcpResource,
  type DrizzleCubeMcpToolsOptions,
} from "./mcp-tools";

// Single-source dashboards cube platform. Builds ONE drizzle-cube
// `SemanticLayerCompiler` and exposes BOTH the HTTP cubejs `AdapterHandle`
// and the MCP cube tools bridge — same layer, same cube list, no drift.
export {
  createDashboardCubesPlatform,
  type DashboardCubesPlatformOptions,
  type DashboardCubesPlatform,
} from "./platform";
