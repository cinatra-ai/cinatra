/**
 * Auth setup for the dashboards live-verify smoke.
 *
 * Playwright's "setup" project runs this once before the chromium
 * project starts. It:
 *
 *   1. Signs up a deterministic test user via Better Auth's
 *      email/password endpoint.
 *   2. Triggers the Cinatra root layout's auto-bootstrap by GETting
 *      `/not-authorized` once — that page is layout-rendered + has no
 *      page-level `getAuthSession()`, so only the ROOT layout's
 *      `getAuthSession()` runs. That call invokes
 *      `ensureInitialAdminBootstrap` (grants `role='admin'` to the
 *      FIRST user) + `ensureDefaultOrganizationMembership` (creates a
 *      `"default"` org + makes the user its owner + writes
 *      `activeOrganizationId` on the session). No explicit
 *      `POST /api/auth/organization/create` call needed. See the
 *      inline comment at step 3 for why `/agents` is NOT used here
 *      (concurrent bootstrap writers).
 *   3. Seeds the agent_runs/agent_templates fixtures so the
 *      `/agents` portlets have data to render. Runs LAST among the
 *      DB writes because it reads `public."user"` + `public."member"`
 *      via direct pg, which both require the user + org rows from
 *      step 2.
 *   4. Warms the Next.js dev-mode per-route compile of `/agents` AND
 *      the cube API route `[...endpoint]/route.ts` by issuing two
 *      APIRequestContext GETs (post-seed, post-bootstrap). NOT used
 *      for initial bootstrap (that's step 2's `/not-authorized` GET) —
 *      used only as a warm-up so the chromium project's first
 *      `page.goto("/agents")` does not pay the cold-compile cost
 *      (drizzle-cube + recharts + DC bundle) AND the cube `/v1/load`
 *      fetch fires within the test's 15s `waitForResponse` window.
 *   5. Stores the resulting cookie state in
 *      `tests/e2e/dashboards/.auth/state.json` so chromium project
 *      tests inherit the session.
 *
 * The default credentials below are local-only deterministic; CI
 * overrides via `E2E_USER_EMAIL` / `E2E_USER_PASSWORD` env vars when
 * the workflow needs a specific identity.
 */
import { test as setup, expect, type APIResponse } from "@playwright/test";

import {
  APIVERSION_V12,
  seedDashboardFixtures,
  seedV12AnalyticsDashboard,
  V12_ANALYTICS_DASHBOARD_ID,
} from "./seed-data";

const EMAIL = process.env.E2E_USER_EMAIL ?? "option-a-test@local.test";
const PASSWORD = process.env.E2E_USER_PASSWORD ?? "OptionATest2026!";
const STORAGE_PATH = "tests/e2e/dashboards/.auth/state.json";
const DATABASE_URL =
  process.env.SUPABASE_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5434/postgres";
const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra";

/** Snapshot a failed response's status + body so the CI log shows the
 * Better Auth error code instead of just `Received: false`. */
async function describe(response: APIResponse): Promise<string> {
  let body = "<no body>";
  try { body = await response.text(); } catch { /* ignore */ }
  return `status=${response.status()} body=${body.slice(0, 500)}`;
}

setup("create test user + seed dashboard fixtures + save session", async ({ request }) => {
  // 1. Sign up. Better Auth's `autoSignIn: true` sets a session cookie
  //    on this APIRequestContext when the user is newly created. On a
  //    retry the user exists and we get 400/422 (no session minted —
  //    we explicitly sign in below).
  const signUp = await request.post("/api/auth/sign-up/email", {
    data: { email: EMAIL, password: PASSWORD, name: "Option A Test" },
    failOnStatusCode: false,
  });
  expect(
    [200, 400, 422],
    `sign-up status unexpected: ${await describe(signUp)}`,
  ).toContain(signUp.status());

  // 2. Probe Better Auth's get-session. If sign-up auto-signed us in
  //    (200 path), we have a session cookie already and skip the
  //    explicit sign-in. On retries (422 path) there is no session
  //    yet — sign in to mint one.
  const probe = await request.get("/api/auth/get-session");
  let probeHasSession = false;
  if (probe.ok()) {
    try {
      const probeBody = await probe.json();
      probeHasSession = Boolean(probeBody?.user?.id);
    } catch { /* not JSON / empty body → no session */ }
  }

  if (!probeHasSession) {
    const signIn = await request.post("/api/auth/sign-in/email", {
      data: { email: EMAIL, password: PASSWORD },
      failOnStatusCode: false,
    });
    expect(
      signIn.ok(),
      `sign-in failed: ${await describe(signIn)}`,
    ).toBeTruthy();
  }

  // 3. Trigger the Cinatra root-layout auto-bootstrap (rather than
  //    calling Better Auth's organization/create API explicitly). The
  //    layout's `getAuthSession()` runs `ensureInitialAdminBootstrap`
  //    (grants `role='admin'` to the FIRST user — covers the dashboard's
  //    `allowUserToCreateOrganization` admin gate) + then runs
  //    `ensureDefaultOrganizationMembership` (creates `"default"` org +
  //    makes the user its owner + sets `activeOrganizationId` on the
  //    session). A single GET to any layout-rendered page is enough.
  //
  //    We use `/not-authorized` (not `/agents`) for the bootstrap GET
  //    because the agents page component ALSO calls `getAuthSession()`
  //    at `packages/dashboards/src/screens/agents-dashboard.tsx:95` —
  //    so a GET there would run TWO `getAuthSession` writers (root
  //    layout + page) on the same request, each potentially racing to
  //    create the default-org row. `/not-authorized` is layout-rendered
  //    AND has no page-level auth call (see `src/app/not-authorized/
  //    page.tsx` — a pure static React server component). The HTML
  //    body is discarded; the side effect is the layout's bootstrap
  //    chain.
  const layoutBootstrap = await request.get("/not-authorized");
  expect(
    layoutBootstrap.ok(),
    `layout bootstrap GET /not-authorized failed: ${await describe(layoutBootstrap)}`,
  ).toBeTruthy();

  // 4. Verify the auto-bootstrap actually created an org. If this
  //    fails, the layout's `ensureDefaultOrganizationMembership` did
  //    NOT run (e.g. `canManageWorkspaceBootstrap` short-circuited on
  //    user-count !== 1) and the test environment is misconfigured
  //    rather than the test fixture being wrong.
  const orgs = await request.get("/api/auth/organization/list");
  expect(orgs.ok(), `org list failed: ${await describe(orgs)}`).toBeTruthy();
  const orgsBody = await orgs.json();
  expect(
    Array.isArray(orgsBody) && orgsBody.length > 0,
    `expected at least one org after layout auto-bootstrap; got ${JSON.stringify(orgsBody).slice(0, 200)}`,
  ).toBeTruthy();

  // 5. Seed dashboard fixtures via direct pg (Better Auth has no
  //    public surface for `cinatra.agent_runs`/`agent_templates`
  //    writes). Requires the user + member rows from step 3 — that's
  //    why seed runs LAST in this fixture, not before auth.
  const seeded = await seedDashboardFixtures({
    email: EMAIL,
    databaseUrl: DATABASE_URL,
    schema: SCHEMA,
  });
  expect(seeded.templateCount).toBeGreaterThanOrEqual(3);
  expect(seeded.runCount).toBeGreaterThanOrEqual(3);

  // 5b. Seed one published apiVersion 1.2 analytics dashboard owned by this
  //     user so the #326 render smoke can open it at `/dashboards/[id]` and
  //     prove the seed→persist→render path (PortletHost → analytics view → DC
  //     grid) that #325 could not exercise until #326 enabled apiVersion 1.2 writes.
  const v12 = await seedV12AnalyticsDashboard({
    databaseUrl: DATABASE_URL,
    schema: SCHEMA,
    userId: seeded.userId,
    organizationId: seeded.organizationId,
  });
  expect(
    v12.configVersion,
    `seeded apiVersion 1.2 analytics row must persist its config_version (got "${v12.configVersion}")`,
  ).toBe(APIVERSION_V12);

  // 6. Preflight `/agents` (200) — and, under a local `pnpm dev`, warm its per-route compile — so the
  //    chromium project's first `page.goto("/agents")` does NOT pay the
  //    cold-compile cost. In dev mode Next.js compiles each page on first
  //    request; the `/agents` route pulls drizzle-cube + recharts + the DC
  //    client bundle, which historically exceeded the 10s assertion
  //    timeout on the chromium test's `getByRole("heading", { name: "Agents" })`
  //    expect. Bootstrap (step 3) ran via `/not-authorized` which compiles a
  //    different — much smaller — route bundle; this warm-up exercises the
  //    actual dashboard surface. By the time chromium runs, the cached
  //    compile is fast (<2s). Reusing this fixture's APIRequestContext is
  //    safe because the session cookie is already populated (steps 1–4).
  //
  //    Race-safety note: bootstrap is COMPLETE by step 5, so this GET will
  //    not re-trigger the layout's `ensureDefaultOrganizationMembership`
  //    write race. The page-level `getAuthSession` inside
  //    `AgentsDashboardPage` is a READ at this point — no writes.
  const agentsWarmup = await request.get("/agents", {
    failOnStatusCode: false,
    maxRedirects: 0,
  });
  expect(
    agentsWarmup.status(),
    `warm-up GET /agents failed: ${await describe(agentsWarmup)}`,
  ).toBe(200);
  await agentsWarmup.text();

  // 7. Preflight the cube API route (`/v1/meta` → 200); under a local
  //    `pnpm dev` this also warms its compile. The page warm-up above only
  //    compiles the /agents page module; the API route handler at
  //    `src/app/api/dashboards/cubejs-api/v1/[...endpoint]/route.ts` is a
  //    SEPARATE module that Next.js dev mode compiles lazily on first
  //    request. The DC client fires `POST /v1/load` after hydration; if
  //    the route hasn't been compiled yet, that compile (drizzle-cube +
  //    cube platform + SemanticLayerCompiler) can exceed the test's 15s
  //    `waitForResponse` timeout. Probing GET `/v1/meta` here forces the
  //    catch-all route module to compile up-front. Read-only: builds
  //    SecurityContext + returns cube schema metadata; no DB writes, no
  //    audit log.
  const cubeMetaWarmup = await request.get(
    "/api/dashboards/cubejs-api/v1/meta",
    { failOnStatusCode: false },
  );
  expect(
    cubeMetaWarmup.status(),
    `cube meta warm-up failed: ${await describe(cubeMetaWarmup)}`,
  ).toBe(200);
  await cubeMetaWarmup.text();

  // 7b. Preflight the `/dashboards/[id]` detail route (200) for the seeded
  //     apiVersion 1.2 analytics row; under a local `pnpm dev` this also warms
  //     its per-route compile (a different module from `/agents`) so the #326
  //     render smoke's first `page.goto` does not pay the cold-compile cost.
  const v12RenderWarmup = await request.get(
    `/dashboards/${V12_ANALYTICS_DASHBOARD_ID}`,
    { failOnStatusCode: false, maxRedirects: 0 },
  );
  expect(
    v12RenderWarmup.status(),
    `apiVersion 1.2 detail warm-up GET failed: ${await describe(v12RenderWarmup)}`,
  ).toBe(200);
  await v12RenderWarmup.text();

  // 8. Persist the cookie state for chromium project tests.
  await request.storageState({ path: STORAGE_PATH });
});
