/**
 * AUTH SETUP FOR THE REVIEW FLOOR'S LIVE WALK (cinatra#3080, fix leg 9).
 *
 * WHY THIS FILE EXISTS. The walk beside it is acceptance item 9's live proof —
 * "every mutation is proved on the real surface" — and every surface it opens is
 * behind a session. Its config carried no authenticated state and no setup
 * project, so every navigation was answered by `/sign-in`: the review page, the
 * run page's review step and the chat thread all reported "no card", which reads
 * exactly like a missing floor and is in fact a missing session. Every other
 * live suite in this tree (agents-run, dashboards, notifications, rbac) opens
 * with a setup project that signs in and persists cookie state; this one now
 * does too, modelled on `tests/e2e/agents-run/auth.setup.ts`.
 *
 * IT ALSO RESOLVES THE ACTOR THE WALK SEEDS AS. The gate is minted on a run this
 * user owns and read back through the SAME user's authorization, so the seeding
 * ids and the browser session must be one person. Passing them separately by
 * environment let the two drift silently — a gate seeded for one actor and read
 * by another is a 404, not a floor. So the setup writes the signed-in user's own
 * id and organisation beside the cookie state, and the walk reads them from
 * there unless the environment states them explicitly.
 */
import { expect, test as setup } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Client } from "pg";

import { openRegistrationForFixtures } from "../open-registration";

const EMAIL = process.env.E2E_REVIEW_FLOOR_USER_EMAIL ?? "review-floor-uat@local.test";
const PASSWORD = process.env.E2E_REVIEW_FLOOR_USER_PASSWORD ?? "ReviewFloorUAT2026!";
const BASE_URL = process.env.E2E_REVIEW_FLOOR_BASE_URL ?? "http://localhost:3000";
const DATABASE_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:5434/postgres";

export const REVIEW_FLOOR_STORAGE_PATH = "tests/e2e/review-floor/.auth/state.json";
export const REVIEW_FLOOR_ACTOR_PATH = "tests/e2e/review-floor/.auth/actor.json";

const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra";
/** The harness agent the walk's gate comes from — see review-gate-fixture.ts. */
const FIXTURE_PACKAGE = "@cinatra-review-fixture/marked-review-gate";

const COMMON_HEADERS = { Origin: BASE_URL } as const;

async function withPg<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

async function grantAdminRoleByEmail(email: string): Promise<void> {
  await withPg((c) =>
    c.query(
      `UPDATE public."user" SET role = 'admin' WHERE email = $1 AND COALESCE(role, '') != 'admin'`,
      [email],
    ),
  );
}

async function readUserIdByEmail(email: string): Promise<string | null> {
  return withPg(async (c) => {
    const r = await c.query<{ id: string }>(`SELECT id FROM public."user" WHERE email = $1 LIMIT 1`, [
      email,
    ]);
    return r.rows[0]?.id ?? null;
  });
}

/**
 * THE ORGANISATION THE FIXTURE AGENT IS REGISTERED IN.
 *
 * The walk is a CROSS-ORG refusal away from proving nothing: the run's authority
 * is re-checked against the agent's own scope, so a fresh user in a fresh
 * organisation gets "the agent's scope no longer authorizes this run (cross_org)"
 * and no gate is ever minted. The artifact the gate pins lives there too — an
 * artifact of another organisation is not readable and would refuse for a second
 * reason. So the walk joins the organisation the fixture is registered in rather
 * than inventing one of its own.
 */
async function readFixtureOrgId(): Promise<string | null> {
  return withPg(async (c) => {
    const r = await c.query<{ org_id: string | null }>(
      `SELECT org_id FROM ${SCHEMA}.agent_templates WHERE package_name = $1 LIMIT 1`,
      [FIXTURE_PACKAGE],
    );
    return r.rows[0]?.org_id ?? null;
  });
}

/** Idempotent membership of that organisation, granted the way this harness
 *  grants the admin role: directly, because a fixture user has no other door.
 *  The PLAIN membership role, never an elevated one: the walk needs standing to
 *  run the agent and read the gate it opens, and nothing beyond that. */
async function joinOrganization(userId: string, orgId: string): Promise<void> {
  await withPg((c) =>
    c.query(
      `INSERT INTO public."member" (id, "organizationId", "userId", role, "createdAt")
       SELECT $1, $2, $3, 'member', now()
        WHERE NOT EXISTS (
          SELECT 1 FROM public."member" WHERE "organizationId" = $2 AND "userId" = $3
        )`,
      [randomUUID(), orgId, userId],
    ),
  );
}

setup("authenticate the review-floor walk", async ({ request }) => {
  await openRegistrationForFixtures();

  const signUp = await request.post("/api/auth/sign-up/email", {
    data: { email: EMAIL, password: PASSWORD, name: "Review Floor UAT" },
    headers: COMMON_HEADERS,
    failOnStatusCode: false,
  });
  expect([200, 400, 422]).toContain(signUp.status());

  const signIn = await request.post("/api/auth/sign-in/email", {
    data: { email: EMAIL, password: PASSWORD },
    headers: COMMON_HEADERS,
  });
  expect(signIn.ok()).toBeTruthy();

  await grantAdminRoleByEmail(EMAIL);

  const userId = await readUserIdByEmail(EMAIL);
  expect(userId, `no user row for ${EMAIL} after sign-up`).not.toBeNull();

  const fixtureOrgId = await readFixtureOrgId();
  expect(
    fixtureOrgId,
    `no ${FIXTURE_PACKAGE} template on this instance — stage the fixture and restart the host`,
  ).not.toBeNull();
  await joinOrganization(userId!, fixtureOrgId!);

  // The ACTIVE organisation is what the run is created under, so it has to be
  // the one just joined; a session left on another organisation seeds a run the
  // agent's scope refuses.
  const setActive = await request.post("/api/auth/organization/set-active", {
    data: { organizationId: fixtureOrgId },
    headers: COMMON_HEADERS,
  });
  expect(
    setActive.ok(),
    `organization/set-active failed with ${setActive.status()}: ${await setActive.text()}`,
  ).toBeTruthy();
  const orgId = fixtureOrgId;

  await request.storageState({ path: REVIEW_FLOOR_STORAGE_PATH });
  mkdirSync(dirname(REVIEW_FLOOR_ACTOR_PATH), { recursive: true });
  writeFileSync(
    REVIEW_FLOOR_ACTOR_PATH,
    `${JSON.stringify({ userId, orgId, email: EMAIL }, null, 2)}\n`,
    "utf8",
  );
});
