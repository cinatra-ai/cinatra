/**
 * The deterministic dev-runtime held-turn flow (chat-hitl S9k, cinatra#2824).
 *
 * MODELLED ON `wp-drupal-uat.config.ts`, because #2824 names it as the pattern
 * that already fits and names why the two alternatives do not: `e2e-rbac` boots a
 * PRODUCTION build, and `agents-run` assumes long-lived infrastructure with real
 * credentials. Neither can host a `CINATRA_RUNTIME_MODE=development` proof that
 * must run on a throwaway database with no keys.
 *
 * WHAT THE SHAPE BUYS:
 *  · a DEV runtime, which is what the capture ruling labels and what the hard
 *    pre-router path is exercised under;
 *  · the deterministic scripted provider — offline, key-free, no model call in the
 *    turn at all, so the dispatch is decided by the pre-router regex rather than by
 *    whatever a model felt like doing;
 *  · its own port and its own server, never reused, so a run can never be
 *    attributed to a server carrying different env.
 */
import { defineConfig } from "@playwright/test";
import { baseUse, desktopChrome, REPO_ROOT, repoPath, suitePath } from "./base";

const PORT = Number(process.env.E2E_CHAT_HITL_PORT ?? 3126);
const BASE_URL = process.env.E2E_CHAT_HITL_BASE_URL ?? `http://localhost:${PORT}`;

/**
 * WAYFLOW POINTED AT AN UNUSED PORT, DELIBERATELY.
 *
 * The `agent_run` handler runs a WayFlow preflight before it creates the run. An
 * UNREACHABLE WayFlow answers `PREFLIGHT_UNAVAILABLE` and the handler proceeds — a
 * REACHABLE one with this agent unregistered answers `WAYFLOW_AGENT_NOT_REGISTERED`
 * and ABORTS the dispatch before `createAgentRunForLaunchFrame`, so no run, no hold
 * and no card. Leaving the variable unset would let a developer's own running
 * WayFlow decide whether this suite passes, which is the opposite of deterministic.
 */
const WAYFLOW_UNREACHABLE = process.env.E2E_CHAT_HITL_WAYFLOW_URL ?? "http://127.0.0.1:59999";

const STORAGE_STATE = suitePath("chat-hitl-held-turn", ".auth", "state.json");

export default defineConfig({
  testDir: suitePath("chat-hitl-held-turn"),
  /**
   * ONE RUN TOKEN, MINTED BEFORE THE WORKERS EXIST.
   *
   * `globalSetup` runs once in the runner process, so the token it puts in the
   * environment is inherited by the setup worker, the teardown worker and every
   * fixture subprocess — and is invisible to a concurrent run. The account and
   * instance snapshots are stamped with it, and each teardown consumes only a
   * snapshot carrying its own stamp. Without that, a run REFUSED by the exclusive
   * snapshot create still ran this config's teardown project, which restored from
   * and then deleted the FIRST run's snapshot while that run was live.
   */
  globalSetup: suitePath("chat-hitl-held-turn", "run-token.global-setup.ts"),
  /**
   * The suite's unit tier is NOT Playwright's. `__tests__/state-rules.test.ts`
   * covers the pure decision rules under vitest (it rides `pnpm test:root`), and
   * its filename matches Playwright's DEFAULT `testMatch`. Every project below
   * declares its own `testMatch`, so nothing collects it today; stating the ignore
   * keeps that true if one ever stops.
   */
  testIgnore: ["**/__tests__/**"],
  outputDir: repoPath("test-results"),
  // The flow drives two full cold turns end to end. The per-test ceiling has to
  // clear the cold-compile budget the spec documents, or the ceiling fires before
  // the thing being measured has happened.
  timeout: 25 * 60_000,
  // OUTER RUN BOUND, for the reason the wp-drupal-uat config gives: without one, a
  // run that stops progressing is ended only by the job timeout, with no reporter
  // summary and no failing test name. Sized under the workflow's own shell timeout.
  globalTimeout: 40 * 60_000,
  expect: { timeout: 30_000 },
  // NO RETRIES, ON PURPOSE — including on CI. #2824 asks for a DETERMINISTIC proof.
  // A retry converts an intermittent runtime defect into a green check, which is
  // exactly the failure mode a required gate must not have. If this suite is flaky,
  // that is a finding about the runtime and it should be read as one.
  retries: 0,
  fullyParallel: false,
  workers: 1,

  reporter: process.env.CI
    ? [["github"], ["html", { open: "never", outputFolder: repoPath("playwright-report") }]]
    : [["list"]],

  use: {
    baseURL: BASE_URL,
    ...baseUse,
    // Bound every action and navigation, so a step that never becomes actionable
    // ERRORS instead of silently consuming the (large) per-test budget.
    actionTimeout: 60_000,
    navigationTimeout: 180_000,
  },

  webServer: {
    // CINATRA_TEST_LLM_PROVIDER=scripted — offline + key-free.
    // CINATRA_REQUIRE_ACTOR_CONTEXT=false — dev/test opt-out of the fail-closed
    //   actor gate, exactly as the sibling dev-runtime config does; it never
    //   bypasses in production.
    // CINATRA_E2E_SETUP_BYPASS=true — clears the setup-wizard gate on a fresh
    //   instance, which otherwise redirects every route to /setup.
    // CINATRA_TURBOPACK_DEV_FS_CACHE=0 — the persistent dev FS cache is worthless
    //   here (every run starts cold, the server is discarded) and its write cycle
    //   is the marginal load that tips constrained runners into a stall.
    // CINATRA_LIFECYCLE_RECOMMENDATION_CHIP_ROW=on — the hold is ON by default
    //   (only the literal "off" deactivates it); stating it makes the suite's
    //   precondition READABLE instead of inherited.
    // reuseExistingServer:false — ALWAYS a fresh server carrying this env, so the
    //   run can never be attributed to a server started with something else.
    command:
      `CINATRA_TEST_LLM_PROVIDER=scripted ` +
      `CINATRA_REQUIRE_ACTOR_CONTEXT=false ` +
      `CINATRA_E2E_SETUP_BYPASS=true ` +
      `CINATRA_TURBOPACK_DEV_FS_CACHE=0 ` +
      `CINATRA_LIFECYCLE_RECOMMENDATION_CHIP_ROW=on ` +
      `CINATRA_RUNTIME_MODE=development ` +
      `WAYFLOW_BASE_URL=${WAYFLOW_UNREACHABLE} ` +
      `POSTGRES_SYNC_TIMEOUT_MS=90000 PORT=${PORT} pnpm dev`,
    cwd: REPO_ROOT,
    /**
     * READINESS IS `/api/health`, NOT THE ROOT — and this is a determinism fix,
     * not a preference.
     *
     * Playwright's `webServer.url` probe accepts 2xx, 3xx and 4xx up to 403; a
     * 404 reads as NOT READY. The root of a fresh instance redirects
     * `/` -> `/sign-in?next=%2F` -> `/setup/account`, and that last hop answers
     * 404 on a boot where the setup bypass is on — so the probe polls a
     * permanently-404 URL for the full ten minutes and the suite dies as
     * "Timed out waiting from config.webServer", with no test name and nothing
     * to read. Observed on a clean database on 2026-08-23, on a stack where the
     * server itself was up and answering in 522 ms.
     *
     * `/api/health` is the endpoint the app publishes for exactly this question:
     * it answers 200 with the boot's own readiness, it never redirects, and it
     * does not depend on which wizard route a fresh instance would send a
     * browser to.
     */
    url: `${BASE_URL}/api/health`,
    // TEN MINUTES, sized to a FRESH database rather than a warm one. This suite's
    // whole premise is a throwaway instance, so its boot is never the cheap case:
    // it creates the `cinatra` schema, activates the extension closure, registers
    // the agent templates and rebuilds the skills catalog before it answers at all.
    // Measured at 5-7 minutes on a contended machine, which walked straight into
    // the 5-minute ceiling the sibling configs use for warm instances — and a
    // webServer timeout reports as an infrastructure failure with no test name,
    // which is the least diagnosable red available.
    timeout: 600_000,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
  },

  projects: [
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
      // PUT THE INSTANCE BACK, PASS OR FAIL. The setup changes instance
      // configuration (a provider presence placeholder, the MCP public base URL,
      // one assigned skill) and this suite is meant to run on a developer's own
      // dev instance. A project's `teardown` runs after that project and everything
      // depending on it finishes — including after a failure, which is the run that
      // most needs putting back.
      teardown: "restore",
      use: { ...desktopChrome },
    },
    {
      name: "restore",
      testMatch: /restore\.teardown\.ts/,
      use: { ...desktopChrome },
    },
    {
      name: "held-turn",
      testMatch: /held-turn\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...desktopChrome,
        storageState: STORAGE_STATE,
        // A stable, generous viewport: the provisional captures are full-page and
        // a cramped one crops the transcript out of its own evidence.
        viewport: { width: 1440, height: 1200 },
      },
    },
  ],
});
