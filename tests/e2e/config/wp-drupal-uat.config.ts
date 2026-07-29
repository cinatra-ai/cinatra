/**
 * WordPress + Drupal assistant end-to-end UATs.
 *
 * Proves the Cinatra assistant round-trips end-to-end inside the live docker
 * WordPress (`:8080`) + Drupal (`:8082`) stacks, against a REAL cinatra dev
 * backend with only the LLM provider swapped for the deterministic scripted
 * provider (CINATRA_TEST_LLM_PROVIDER=scripted — no live keys, no network).
 *
 * baseURL is the cinatra dev server (serves the agent stream + token/capability
 * routes; the widget JS itself is the VENDORED plugin/module copy — the dead
 * bundle.js routes were removed, cinatra#977); the specs navigate to the CMS
 * admin URLs where the bundle mounts. global-setup seeds one WP page + one
 * Drupal node (idempotent).
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
  // OUTER RUN BOUND. The per-test `timeout` above bounds one test; nothing
  // bounded the RUN, so a suite that stopped progressing was ended only by the
  // job timeout — with no reporter summary, no HTML report and no failing test
  // name. `globalTimeout` gives the run its own ceiling so it ends itself and
  // reports.
  //
  // HONEST LIMIT: this is an in-process timer in the Playwright runner. It
  // recovers a run that is merely STUCK (a wedged webServer, a test that hangs
  // past its own timeout, a controller that stops advancing) — it CANNOT fire
  // when the host has stopped scheduling the runner process itself, which is
  // what the VM-wide stalls reached. Preventing that state is the job of the
  // dev-server cache opt-out below and the runner headroom the workflow
  // provisions; this ceiling is the reporting backstop, not the cure.
  //
  // Sized against the gate's own budget: the uat-gate job allows 40 minutes and
  // spends ~11 of them on install + `setup dev` + docker bring-up before the
  // suite starts, so 22 minutes leaves headroom for the run to report and for
  // the job to upload artifacts. A healthy full suite takes ~8.5 minutes.
  globalTimeout: 22 * 60_000,
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
    // Bound every individual action/navigation so a step that never becomes
    // actionable ERRORS instead of hanging to the per-test timeout. Playwright's
    // default actionTimeout is 0 (unbounded): a stuck `page.click` on a launcher
    // toggle otherwise waits the full 20-min render-parity budget with no output
    // (cinatra#1998 — the target-3 stall root cause). These are generous relative
    // to the live CMS + hosted-login round-trips (openWidget's own waits are 30s)
    // yet still fail LOUD long before the per-test ceiling.
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },

  webServer: {
    // The deterministic scripted provider makes the assistant offline + key-free.
    // CINATRA_REQUIRE_ACTOR_CONTEXT=false: the widget stream route does not pass
    // an actorContext and there is no ambient ALS frame, so dev/test must opt out
    // of the fail-closed actor gate (it never bypasses in production).
    // CINATRA_E2E_SETUP_BYPASS=true (same as the sibling e2e configs): clears
    // the setup-wizard gate on a fresh instance — without it the #410
    // hosted-login popup redirects to /setup/ai (AI wizard step incomplete)
    // and the consent step never renders, so every login-gated scenario
    // times out.
    // allowedDevOrigins + reactDebugChannel:false are already in next.config.ts
    // for headless dev-mode hydration (see https://docs.cinatra.ai/references/platform/e2e-headless-hydration/).
    // reuseExistingServer:false — ALWAYS boot a fresh server carrying the scripted
    // provider env, so the run can never silently use a non-scripted dev server.
    // CINATRA_TURBOPACK_DEV_FS_CACHE=0 — turn OFF Turbopack's persistent dev
    // filesystem cache for this server (next.config.ts reads the flag). The
    // cache is worthless here (every CI run starts cold, and the server is
    // discarded when the suite ends) while its write + compaction cycle is the
    // marginal load that tipped constrained runners into an unrecoverable stall
    // — output stops mid-suite, no per-test timeout can fire, and the job is
    // killed with no diagnosis. See the rationale block in next.config.ts.
    command: `CINATRA_TEST_LLM_PROVIDER=scripted CINATRA_REQUIRE_ACTOR_CONTEXT=false CINATRA_E2E_SETUP_BYPASS=true CINATRA_TURBOPACK_DEV_FS_CACHE=0 POSTGRES_SYNC_TIMEOUT_MS=90000 PORT=${PORT} pnpm dev`,
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
