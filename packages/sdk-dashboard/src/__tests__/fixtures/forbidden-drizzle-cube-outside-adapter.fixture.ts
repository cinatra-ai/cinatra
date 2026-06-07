// FIXTURE — ESLint should flag this. Imports drizzle-cube/server from
// outside the adapter directory, which is forbidden by ADR 0044.
//
// This file lives in __tests__/fixtures (NOT inside adapters/drizzle-cube/)
// so the "drizzle-cube imports must live in the adapter" rule should fire.
//
// eslint-disable-next-line no-unused-vars
import { defineCube } from "drizzle-cube/server";

export const used = defineCube;
