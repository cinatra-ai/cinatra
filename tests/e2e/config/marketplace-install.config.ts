/**
 * Path-gated Playwright config for the `marketplace-install` e2e suite (#836).
 *
 * Live-drives the `/configuration/marketplace` Install click end-to-end through
 * the REAL screen + server action + install path, made HERMETIC by env
 * injection (no publishing, no real install-bearer, no external network):
 *
 *   - A dependency-free fixture server (fixture-server.mjs) stands in for the
 *     storefront public catalog AND the package registry: it serves one listable
 *     SKILL card, then 404s every registry/packument path so the install fails
 *     CLOSED — exercising the graceful-degradation contract (#356 no-crash /
 *     #685 non-technical toast) at the browser layer.
 *   - MARKETPLACE_BASE_URL points the catalog fetch at the fixture (honored only
 *     outside NODE_ENV=production, i.e. this `pnpm dev` server).
 *   - CINATRA_AGENT_REGISTRY_URL/_TOKEN make registryConnected=true so the
 *     Install CTA is LIVE (enabled) and actually dispatches.
 *   - CINATRA_GATEKEPT_INSTALL=false pins the deterministic direct-registry-read
 *     install path (not the broker authorize/grant path).
 *
 * This suite does NOT prove a SUCCESSFUL real install+activation — that needs a
 * real published artifact + real registry + install-bearer + public MCP URL
 * (operator-gated). It proves the Install CLICK + fail-closed UX contract, the
 * CI-forward coverage cinatra#836 asks for.
 *
 * DEDICATED port + reuseExistingServer:false (never attach to an ambient dev
 * server that lacks the fixture env — that would silently break hermeticity).
 *
 * Run locally:
 *   CI= pnpm test:e2e:marketplace-install
 */
import path from "node:path";
import { defineConfig } from "@playwright/test";
import { baseUse, desktopChrome, REPO_ROOT, repoPath, suitePath } from "./base";

const PORT = Number(process.env.E2E_MP_PORT ?? 3219);
const BASE_URL = process.env.E2E_MP_BASE_URL ?? `http://127.0.0.1:${PORT}`;
const FIXTURE_PORT = Number(process.env.E2E_MP_FIXTURE_PORT ?? 4599);
const FIXTURE_URL = `http://127.0.0.1:${FIXTURE_PORT}`;
const FIXTURE_SCRIPT = path.join(REPO_ROOT, "tests/e2e/marketplace-install/fixture-server.mjs");

export default defineConfig({
  testDir: suitePath("marketplace-install"),
  outputDir: repoPath("test-results"),
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  fullyParallel: false,
  workers: 1,

  reporter: process.env.CI
    ? [["github"], ["list"], ["html", { open: "never", outputFolder: repoPath("playwright-report") }]]
    : [["list"]],

  use: {
    baseURL: BASE_URL,
    ...baseUse,
  },

  // Two managed servers: the catalog/registry fixture, then the app under test
  // wired to it. Both dedicated + non-reused so the suite is fully hermetic.
  webServer: [
    {
      command: `E2E_MP_FIXTURE_PORT=${FIXTURE_PORT} node ${FIXTURE_SCRIPT}`,
      cwd: REPO_ROOT,
      url: `${FIXTURE_URL}/-/health`,
      timeout: 30_000,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      // Env is inlined in the command (inherits full process.env + adds these);
      // set in the real process env, they win over any `.env.local` value
      // (@next/env never overrides an already-set variable). POSTGRES_SYNC_
      // TIMEOUT_MS mirrors the agents-run suite: `pnpm dev` under load starves
      // the sync Postgres worker and the 30s prod ceiling false-positives.
      command:
        `MARKETPLACE_BASE_URL=${FIXTURE_URL} ` +
        `CINATRA_AGENT_REGISTRY_URL=${FIXTURE_URL} ` +
        `CINATRA_AGENT_REGISTRY_TOKEN=e2e-marketplace-install-fixture-token ` +
        `CINATRA_GATEKEPT_INSTALL=false ` +
        `CINATRA_E2E_SETUP_BYPASS=true ` +
        // The suite runs on a dedicated port/host, so Better Auth's own baseURL
        // (localhost:3000 in .env.local) does not match the request Origin. This
        // is the DOCUMENTED CI escape hatch (see src/lib/auth.ts): trust the
        // suite's exact origin so sign-up/sign-in/set-active aren't 403'd.
        `BETTER_AUTH_TRUSTED_ORIGINS=${BASE_URL} ` +
        `POSTGRES_SYNC_TIMEOUT_MS=90000 ` +
        `PORT=${PORT} pnpm dev`,
      cwd: REPO_ROOT,
      url: BASE_URL,
      timeout: 240_000,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],

  projects: [
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: "chromium",
      use: {
        ...desktopChrome,
        storageState: suitePath("marketplace-install", ".auth/admin-state.json"),
      },
      testMatch: /marketplace-install\.spec\.ts/,
      dependencies: ["setup"],
    },
  ],
});
