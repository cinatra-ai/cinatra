// FIXTURE — POSITIVE CONTROL. This file lives outside the adapter
// directory (in __tests__/fixtures/) but is named like an "in-adapter"
// scenario. The boundary test lints THIS file from the adapter rule scope
// and asserts NO no-restricted-imports error fires.
//
// To simulate "inside the adapter," the boundary test copies this file
// into a tempdir at packages/sdk-dashboard/src/adapters/drizzle-cube/
// before linting it.
//
// eslint-disable-next-line no-unused-vars
import { defineCube } from "drizzle-cube/server";

export const used = defineCube;
