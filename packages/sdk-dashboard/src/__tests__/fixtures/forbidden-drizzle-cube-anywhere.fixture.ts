// FIXTURE — ESLint should flag this. The "drizzle-cube only in adapter" ban
// (DRIZZLE_CUBE_BAN in eslint.config.mjs Layer 1) is repo-wide — this
// fixture proves the rule fires outside sdk-dashboard too. The ban applies
// across the whole repo, not just packages/sdk-dashboard/src/**, so
// `drizzle-cube/server` is not importable from anywhere else.
//
// eslint-disable-next-line no-unused-vars
import { defineCube } from "drizzle-cube/server";

export const used = defineCube;
