/**
 * Playwright config for the setup-flow ACCEPTANCE suite (cinatra#2392, epic
 * #2385 S7) — the fresh-instance walks, the routing/state matrices, and the
 * error-channel assertions over the REAL setup wizard.
 *
 * `CINATRA_E2E_SETUP_BYPASS` is deliberately NOT set: the setup wizard itself
 * is the surface under proof, so bypassing it would prove nothing.
 *
 * The managed server boots with the provider HTTP-boundary stub
 * (tests/e2e/setup/support/provider-boundary-stub.mjs) preloaded via
 * NODE_OPTIONS --import: everything inside the app is real; only outbound
 * HTTP to api.openai.com / api.anthropic.com is answered from the scripted
 * table, and every provider-host call lands in an egress ledger the specs
 * assert against. `pnpm dev` is NOT used as the webServer command because the
 * package script pins its own NODE_OPTIONS, which would drop the --import.
 *
 * DATABASE: point SUPABASE_DB_URL at a DEDICATED database (Better Auth lives
 * in its `public` schema — a shared database can never reach the zero-humans
 * fresh-instance state). The reset helper additionally REFUSES to run without
 * `E2E_SETUP_ALLOW_DB_RESET=1` (see ../setup/support/instance-state.ts): it
 * truncates every `public` table, so it must never be able to fire against a
 * developer's ordinary local database by default.
 *
 * Run locally:
 *   E2E_SETUP_ALLOW_DB_RESET=1 E2E_SETUP_PORT=3304 pnpm test:e2e:setup
 * Against an externally managed (e.g. production-build) server that was booted
 * with the same stub preload:
 *   E2E_REUSE_SERVER=1 E2E_BASE_URL=<url> pnpm test:e2e:setup
 */
import { pathToFileURL } from "node:url";

import { defineConfig } from "@playwright/test";
import { baseUse, REPO_ROOT, repoPath, suitePath } from "./base";

// Parse strictly: `Number(undefined-ish)`/`Number("abc")` yields NaN, which
// Playwright would pass to the server as `PORT=NaN` (a random port) while the
// specs waited on an unreachable BASE_URL until the 180 s boot timeout.
const PORT = Number.parseInt(process.env.E2E_SETUP_PORT ?? "3104", 10);
if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65_535) {
  throw new Error(
    `E2E_SETUP_PORT must be a valid TCP port, received "${process.env.E2E_SETUP_PORT}".`,
  );
}
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

const EXTERNAL_SERVER = process.env.E2E_REUSE_SERVER === "1";
// A managed server is booted on PORT; an E2E_BASE_URL pointing anywhere else
// is a misconfiguration that would otherwise present as a boot timeout.
if (!EXTERNAL_SERVER && new URL(BASE_URL).port !== String(PORT)) {
  throw new Error(
    `E2E_BASE_URL (${BASE_URL}) does not target the managed server's port (${PORT}). ` +
      `Set E2E_REUSE_SERVER=1 to drive an externally managed server instead.`,
  );
}

// One shared stub-control/ledger dir for the server AND the specs. It lives
// OUTSIDE `outputDir` on purpose — Playwright wipes outputDir before the run,
// which would delete the control file the booted server already has open and
// the ledger the specs assert against.
const STUB_DIR =
  process.env.LANE_STUB_DIR ?? repoPath("test-results", "setup-acceptance-stub");
process.env.LANE_STUB_DIR = STUB_DIR;

export default defineConfig({
  testDir: suitePath("setup"),
  // A DEDICATED subdirectory, never the shared `test-results` root: Playwright
  // removes outputDir at the start of the run, and the stub dir + the
  // screenshot dir are siblings under `test-results`.
  outputDir: repoPath("test-results", "setup-acceptance-output"),
  // The walks traverse the whole wizard (sign-up → name → LLM provider →
  // commit → assistant turn) with Turbopack cold compiles on the way.
  timeout: 300_000,
  expect: { timeout: 15_000 },
  retries: 0,
  // STRICTLY sequential: the suite mutates one shared instance state
  // (fresh-instance resets, claim seeds, stub-control flips).
  fullyParallel: false,
  workers: 1,
  globalTimeout: process.env.CI ? 30 * 60_000 : undefined,

  reporter: process.env.CI
    ? [["github"], ["list"], ["html", { open: "never", outputFolder: repoPath("playwright-report") }]]
    : [["list"]],

  use: {
    baseURL: BASE_URL,
    viewport: { width: 1440, height: 1100 },
    ...baseUse,
  },

  webServer: EXTERNAL_SERVER
    ? undefined
    : {
        command: "node scripts/dev-server.mjs",
        cwd: REPO_ROOT,
        url: BASE_URL,
        timeout: 180_000,
        reuseExistingServer: !process.env.CI,
        env: {
          PORT: String(PORT),
          LANE_STUB_DIR: STUB_DIR,
          // `--import` follows ESM resolution: a bare absolute path works on
          // POSIX but is ambiguous once the path contains characters that need
          // percent-encoding (and is not a valid specifier on Windows). A
          // file: URL is the unambiguous form.
          NODE_OPTIONS: `--disable-warning=DEP0169 --max-old-space-size=8192 --import ${pathToFileURL(
            suitePath("setup", "support", "provider-boundary-stub.mjs"),
          ).href}`,
        },
      },
});
