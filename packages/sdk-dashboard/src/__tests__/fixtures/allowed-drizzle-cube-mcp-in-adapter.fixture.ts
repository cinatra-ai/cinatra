// FIXTURE — POSITIVE CONTROL. This verifies a Layer-3 carve-out
// for `drizzle-cube/mcp` inside the adapter directory. This fixture is
// linted from inside the adapter glob (the boundary test copies it into
// packages/sdk-dashboard/src/adapters/drizzle-cube/) and asserts NO
// no-restricted-imports error fires for drizzle-cube/mcp imports.
//
// eslint-disable-next-line no-unused-vars
import { getCubeTools } from "drizzle-cube/mcp";

export const used = getCubeTools;
