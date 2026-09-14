/**
 * Path-gated Playwright config for the `artifact-markdown-editor` e2e suite
 * (cinatra#3026, epic #3023, lifecycle-c W2).
 *
 * Live-drives the markdown editor on the REAL artifact page: a real dev server,
 * a real sign-in, a real upload through the product's own upload road, the real
 * extension display mounted by the host's resolution ladder, and the real save
 * endpoint writing a real revision. No fixture server and no stub display — a
 * stubbed display would prove the test's own markup, which is the one thing this
 * suite must not do.
 *
 * DEDICATED port + reuseExistingServer:false, like the marketplace-install suite
 * beside it: never attach to an ambient dev server whose env is somebody else's.
 *
 * PRECONDITION: the markdown base extension has to be installed for its display
 * to mount at all (the re-pin of plan item 0.19, cinatra#3025). The spec states
 * that in its first assertion and FAILS on it rather than skipping, so a run of
 * this suite always says which of the two it is.
 *
 * Run locally:
 *   CI= pnpm test:e2e:markdown-editor
 */
import { defineConfig } from "@playwright/test";
import { baseUse, desktopChrome, REPO_ROOT, repoPath, suitePath } from "./base";

const PORT = Number(process.env.E2E_MD_EDITOR_PORT ?? 3226);
const BASE_URL = process.env.E2E_MD_EDITOR_BASE_URL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: suitePath("artifact-markdown-editor"),
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

  webServer: [
    {
      command:
        `CINATRA_E2E_SETUP_BYPASS=true ` +
        // THE SUITE'S SERVER IS ITS OWN DEPLOYMENT, AND ITS AUTH BASE URL HAS TO
        // SAY SO. `.env.local` names an ambient origin, which is neither this
        // port nor, wherever TLS is terminated in front of the app, even this
        // scheme. Two things break when the server under test believes it lives
        // somewhere else:
        //
        //   * Better Auth mints the session cookie with the `__Secure-` prefix
        //     and the Secure attribute whenever its base URL is https. A browser
        //     still sends such a cookie to http://127.0.0.1 — 127.0.0.0/8 is a
        //     trustworthy origin — but a Node-side APIRequestContext, which is
        //     what a test's `request` fixture is, applies the plain rule and
        //     drops it. Every authenticated call from a fixture is then a 401.
        //   * `/api/artifacts/upload` is origin-gated against BETTER_AUTH_URL
        //     (src/app/api/artifacts/upload/route.ts), so a browser-side upload
        //     from this port would be a 403 for the same reason.
        //
        // Pinning the base URL to the suite's own origin fixes both at the cause
        // instead of routing the arrangement around them. The trusted-origins
        // escape hatch stays: it is what the sibling suites set, it is harmless
        // once the origins agree, and it keeps the suite honest if a future
        // `.env.local` re-introduces a mismatch.
        `BETTER_AUTH_URL=${BASE_URL} ` +
        `NEXT_PUBLIC_BETTER_AUTH_URL=${BASE_URL} ` +
        `BETTER_AUTH_TRUSTED_ORIGINS=${BASE_URL} ` +
        // `pnpm dev` under suite load starves the synchronous Postgres worker;
        // the production ceiling false-positives there, as it does for the
        // agents-run and marketplace-install suites.
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
        storageState: suitePath("artifact-markdown-editor", ".auth/owner-state.json"),
      },
      testMatch: /markdown-editor\.spec\.ts/,
      dependencies: ["setup"],
    },
  ],
});
