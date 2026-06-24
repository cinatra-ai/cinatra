/**
 * WordPress + Drupal assistant end-to-end UATs.
 *
 * Proves the Cinatra assistant round-trips end-to-end inside the live docker
 * WordPress (`:8080`) + Drupal (`:8082`) stacks, against a REAL cinatra dev
 * backend with only the LLM provider swapped for the deterministic scripted
 * provider (CINATRA_TEST_LLM_PROVIDER=scripted — no live keys, no network).
 *
 * baseURL is the cinatra dev server (serves /api/{wordpress,drupal}/bundle.js +
 * the agent stream); the specs navigate to the CMS admin URLs where the bundle
 * mounts. global-setup seeds one WP page + one Drupal node (idempotent).
 *
 * PREREQUISITES (see tests/e2e/wp-drupal-uat/README.md):
 *   - docker WP + Drupal up and wired to this cinatra instance (`cinatra setup dev`
 *     has cloned dev/wordpress-plugin/ + dev/drupal-module/cinatra/ and dev-auto-setup
 *     has minted the widget auth keys).
 *   - The cinatra dev server is started by this config with the scripted provider.
 *
 * CI: the WP/Drupal UAT Gate workflow provisions the app-service env this suite
 * needs (SUPABASE_DB_URL + a live Postgres/Redis, BETTER_AUTH_SECRET, the
 * CINATRA_RUNTIME_MODE=development scripted-provider gate, and an OPENAI_API_KEY
 * presence placeholder) entirely from in-repo, non-secret values — see
 * .github/workflows/wp-drupal-uat.yml (cinatra#173).
 */
import { defineConfig } from "@playwright/test";
import { baseUse, desktopChrome, REPO_ROOT, repoPath, suitePath } from "./base";

const PORT = Number(process.env.E2E_WP_DRUPAL_PORT ?? 3000);
const BASE_URL = process.env.E2E_WP_DRUPAL_BASE_URL ?? `http://localhost:${PORT}`;

// cinatra#410 — the saved Cinatra session for the deterministic dev UAT user
// (established by global-setup). Both projects load it so the widget's hosted
// `/widget-auth` login popup inherits the session and lands on consent directly
// (the cookies are scoped to the cinatra instance origin, where the popup opens,
// NOT the CMS admin origin the spec navigates to).
const STORAGE_STATE = suitePath("wp-drupal-uat", ".auth", "state.json");

export default defineConfig({
  testDir: suitePath("wp-drupal-uat"),
  outputDir: repoPath("test-results"),
  timeout: 120_000,
  expect: { timeout: 20_000 },
  retries: process.env.CI ? 1 : 0,
  fullyParallel: false,
  workers: 1,
  globalSetup: suitePath("wp-drupal-uat", "global-setup.ts"),

  reporter: process.env.CI
    ? [["github"], ["html", { open: "never", outputFolder: repoPath("playwright-report") }]]
    : [["list"]],

  use: {
    baseURL: BASE_URL,
    ...baseUse,
  },

  webServer: {
    // The deterministic scripted provider makes the assistant offline + key-free.
    // CINATRA_REQUIRE_ACTOR_CONTEXT=false: the widget stream route does not pass
    // an actorContext and there is no ambient ALS frame, so dev/test must opt out
    // of the fail-closed actor gate (it never bypasses in production).
    // allowedDevOrigins + reactDebugChannel:false are already in next.config.ts
    // for headless dev-mode hydration (see https://docs.cinatra.ai/references/platform/e2e-headless-hydration/).
    // reuseExistingServer:false — ALWAYS boot a fresh server carrying the scripted
    // provider env, so the run can never silently use a non-scripted dev server.
    command: `CINATRA_TEST_LLM_PROVIDER=scripted CINATRA_REQUIRE_ACTOR_CONTEXT=false POSTGRES_SYNC_TIMEOUT_MS=90000 PORT=${PORT} pnpm dev`,
    cwd: REPO_ROOT,
    url: BASE_URL,
    timeout: 240_000,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
  },

  projects: [
    {
      name: "wordpress",
      testMatch: /wordpress\/.*\.spec\.ts/,
      use: { ...desktopChrome, storageState: STORAGE_STATE },
    },
    {
      name: "drupal",
      testMatch: /drupal\/.*\.spec\.ts/,
      use: { ...desktopChrome, storageState: STORAGE_STATE },
    },
  ],
});
