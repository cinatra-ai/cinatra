// Read MCP handlers: dashboards_list, dashboards_get.
// Write handlers: dashboards_create, dashboards_update, dashboards_archive.
// Cube handlers: dashboard_cubes_list, dashboard_cube_propose.
// AI handlers: dashboards_generation_start, dashboards_generation_status.
//
// Only the CREATE write is exported, for the agent passthrough, which admits
// `dashboards_create` for a proven run (cinatra#3092). The handler factory
// (update, publish, archive) stays unexported.
export { createDashboardForRun } from "./handlers";
