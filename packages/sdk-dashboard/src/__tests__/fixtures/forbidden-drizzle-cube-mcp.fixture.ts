// FIXTURE — ESLint should flag this. Imports drizzle-cube/mcp anywhere in
// the repo — would bypass Cinatra's MCP actor-context model per ADR 0044.
//
// eslint-disable-next-line no-unused-vars
import { something } from "drizzle-cube/mcp";

export const used = something;
