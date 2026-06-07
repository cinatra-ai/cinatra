/**
 * POSITIVE CONTROL fixture for ADR 0045 — eslint Layer 4 carve-out.
 *
 * This file lives inside `packages/dashboards/src/components/**` (recursively),
 * so the Layer 4 carve-out in `eslint.config.mjs` MUST allow it to import
 * from `drizzle-cube/client`. ESLint emits zero `no-restricted-imports`
 * violations on this file.
 *
 * The companion negative-control fixture lives at
 * `packages/sdk-dashboard/src/__tests__/fixtures/forbidden-drizzle-cube-client.fixture.ts`
 * (OUTSIDE the carve-out — still flagged).
 *
 * Assertion runs in `packages/sdk-dashboard/src/__tests__/eslint-boundary.test.ts`.
 */
import type { CubeProvider } from "drizzle-cube/client";

export type AllowedComponent = typeof CubeProvider;
