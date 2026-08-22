// Identity + world for the S9k held-turn flow (chat-hitl S9k, cinatra#2824).
//
// Two jobs, in this order and for this reason:
//
//   1. A REAL account, made through the shipped Better Auth sign-up, promoted to
//      platform admin BEFORE the sign-in whose cookie is persisted (Better Auth
//      mints the role into the session token, so a later grant is invisible to a
//      saved state), given an org, and set active. This is the render-smoke
//      pattern; it is not invented here.
//
//      BOTH OF THOSE ARE PERMANENT PRIVILEGE GRANTS on a real identity — the
//      role string, and an `owner` membership of the agent's organization — so
//      both are snapshotted BEFORE the first write and put back by the same
//      verified teardown that restores the instance configuration. See
//      `account-state.ts`; the account is chosen by an environment variable, so
//      "it is only a test account" is not something this file may assume.
//   2. The instance fixtures, through their SHIPPED writers, in a subprocess —
//      see `fixtures.mts` for why they cannot run inside this file.
//
// NOTHING HERE CREATES A HOLD, A PARK, A RUN OR A DECISION. That is the line this
// slice must not cross, and it is worth stating at the file that seeds the world:
// #2824 asks for a runtime proof, so a fixture that pre-parks a run would make the
// flow assert its own setup. Every one of those rows is written by the runtime,
// while the browser drives it.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Client } from "pg";
import { test as setup, expect } from "@playwright/test";

import { HELD_TURN_AGENT_PACKAGE } from "./constants";
import { DATABASE_URL, SCHEMA } from "./probes";
import {
  markMemberInsertPending,
  memberIdFor,
  recordMemberInsert,
  snapshotAccountState,
  type AccountSnapshot,
} from "./account-state";

const EMAIL = process.env.E2E_CHAT_HITL_USER_EMAIL ?? "chat-hitl-s9k@local.test";
const PASSWORD = process.env.E2E_CHAT_HITL_USER_PASSWORD ?? "ChatHitlS9k!2026";
const STORAGE_PATH = "tests/e2e/chat-hitl-held-turn/.auth/state.json";

function newClient(): Client {
  return new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5_000 });
}

async function userIdByEmail(c: Client, email: string): Promise<string | null> {
  const r = await c.query<{ id: string }>(`SELECT id FROM public."user" WHERE email = $1 LIMIT 1`, [
    email,
  ]);
  return r.rowCount && r.rowCount > 0 ? r.rows[0]!.id : null;
}

/**
 * Better Auth's admin plugin stores roles as a comma-separated string; the
 * platform-admin check comma-splits and looks for "admin". Append rather than
 * clobber, so an existing role set survives a re-run.
 *
 * THIS IS A PERMANENT PRIVILEGE GRANT, so the string it overwrites is recorded
 * VERBATIM first (`snapshotAccountState`) and put back by the verified teardown.
 * See `account-state.ts` for why the reuse path — an account that already carries
 * `admin` — is left alone on both sides.
 */
async function promoteToPlatformAdmin(c: Client, userId: string): Promise<void> {
  await c.query(
    `UPDATE public."user"
        SET role = CASE
          WHEN role IS NULL OR btrim(role) = '' THEN 'admin'
          WHEN ('admin' = ANY (string_to_array(role, ','))
            OR 'admin' = ANY (regexp_split_to_array(role, '\\s*,\\s*'))) THEN role
          ELSE role || ',admin'
        END
      WHERE id = $1`,
    [userId],
  );
}

/**
 * JOIN THE ORG THAT OWNS THE AGENT, rather than minting a fresh one.
 *
 * The dispatch boundary enforces template scope: an `organization`-scoped template
 * refuses a requesting actor from another org with
 * `agent-template-scope: … cross_org`. Boot registers the required-closure
 * templates under the instance's own default organization, so a test user given a
 * brand-new org of their own is, correctly, a stranger to every agent on the
 * instance — the dispatch is refused before any run is created, and the flow then
 * waits for a card that was never going to exist.
 *
 * So the org is LOOKED UP from the template this flow dispatches. That is also the
 * honest shape: a person runs an agent their organization owns.
 *
 * A missing template org is a hard failure rather than a fallback to a new org,
 * because the fallback is exactly the state that produced the misleading red.
 */
async function orgOwningAgent(
  c: Client,
  userId: string,
  packageName: string,
  snapshot: AccountSnapshot,
): Promise<string> {
  const r = await c.query<{ org_id: string | null }>(
    `SELECT org_id FROM "${SCHEMA}"."agent_templates" WHERE package_name = $1 LIMIT 1`,
    [packageName],
  );
  const orgId = r.rowCount ? r.rows[0]!.org_id : null;
  if (!orgId) {
    throw new Error(
      `no organization owns ${packageName} in this instance — boot registers the required-closure ` +
        "templates under the default organization, so its absence means the extension closure " +
        "was never materialized (run scripts/ci/sync-dev-extensions.mjs and reboot)",
    );
  }
  // OWNERSHIP IS CLAIMED BEFORE THE WINDOW IS ENTERED. The pre-read and the
  // `pending` mark are persisted BEFORE the insert, so a crash inside it still
  // leaves the teardown an accurate answer to "may I delete this row?" — the same
  // discipline `fixtures.mts` uses for the assigned-skill row, and for the same
  // reason (removing somebody else's membership is the mirror of leaving behind
  // one this fixture made).
  await markMemberInsertPending(c, snapshot, orgId);
  // A DIRECT insert rather than the Better Auth organization API: the team
  // plugin's `team.slug NOT NULL` bug rejects that call for a fresh user, and the
  // notifications suite takes the same route for the same reason.
  //
  // `RETURNING id` is what separates "this fixture created the row" from "the
  // conflict arm took it": `ON CONFLICT DO NOTHING` returns no row when the
  // membership was already there, and that row belongs to somebody else.
  const inserted = await c.query(
    `INSERT INTO public."member" (id, "userId", "organizationId", role, "createdAt")
       VALUES ($1, $2, $3, 'owner', now()) ON CONFLICT (id) DO NOTHING RETURNING id`,
    [memberIdFor(userId), userId, orgId],
  );
  recordMemberInsert(snapshot, (inserted.rowCount ?? 0) > 0 ? "inserted" : "already_present");
  return orgId;
}

setup("create the owner, the org and the instance fixtures", async ({ request, baseURL }) => {
  const origin = baseURL ?? "http://localhost:3000";
  const headers = { Origin: origin } as const;

  // 1. The account. Idempotent — an existing user answers 400/422.
  const signUp = await request.post("/api/auth/sign-up/email", {
    data: { email: EMAIL, password: PASSWORD, name: "Chat HITL S9k Owner" },
    headers,
    failOnStatusCode: false,
  });
  expect([200, 400, 422]).toContain(signUp.status());

  // 2. Admin + org, BEFORE the sign-in that gets persisted.
  const c = newClient();
  await c.connect();
  let orgId: string;
  try {
    const userId = await userIdByEmail(c, EMAIL);
    if (!userId) throw new Error(`S9k owner not found after sign-up: ${EMAIL}`);
    // READ FIRST, WRITE SECOND — persisted before the promotion, so a crash
    // between here and the teardown still leaves the grants undoable.
    const snapshot = await snapshotAccountState(c, userId, EMAIL);
    await promoteToPlatformAdmin(c, userId);
    orgId = await orgOwningAgent(c, userId, HELD_TURN_AGENT_PACKAGE, snapshot);
  } finally {
    await c.end();
  }

  // 3. The session that carries the role.
  const signIn = await request.post("/api/auth/sign-in/email", {
    data: { email: EMAIL, password: PASSWORD },
    headers,
  });
  expect(signIn.ok()).toBeTruthy();

  await request.post("/api/auth/organization/set-active", {
    data: { organizationId: orgId },
    headers,
    failOnStatusCode: false,
  });

  // 4. The instance fixtures, through their shipped writers.
  //
  //    FAIL LOUD. A silently skipped fixture is the worst outcome available here:
  //    without the assigned skill the run dispatches UNHELD, the card correctly
  //    draws nothing, and the flow fails much later with "no held card" and no
  //    hint that the cause was a fixture. So the subprocess's exit code is the
  //    setup's exit code, and its output is printed either way.
  //
  //    `apply` snapshots the instance configuration it is about to change BEFORE
  //    its first write; the `restore` teardown project puts it back and reads it
  //    back to prove it. See `fixtures.mts` and `restore.teardown.ts`.
  const fixtureOut = execFileSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--env-file-if-exists=.env.local",
      "--import",
      "tsx",
      "tests/e2e/chat-hitl-held-turn/fixtures.mts",
      "apply",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, CINATRA_HELD_TURN_BASE_URL: origin },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  console.log(fixtureOut.trim());
  expect(fixtureOut).toContain("fixtures done");

  // 5. WARM `/api/mcp`, AND REFUSE TO PROCEED UNTIL IT IS FAST.
  //
  //    This is not a convenience. The assistant runtime probes the public MCP URL
  //    before it will use platform tools, with a HARD 2500 ms budget, and Turbopack
  //    compiles that route cold on its first hit. On a cold instance the probe
  //    therefore loses a race it cannot win, the turn is answered with "Cinatra
  //    tools are unavailable", and the pre-router never dispatches — so the flow
  //    waits out its whole cold-compile budget for a card that was never going to
  //    appear, and reports "no held card" for a cause that has nothing to do with
  //    holds.
  //
  //    So the route is compiled here, and then MEASURED: the loop below does not
  //    stop when the route merely answers, it stops when the route answers inside
  //    the same budget the runtime's own probe uses. A route that never gets there
  //    fails the SETUP, loudly, naming the reason — which is the difference between
  //    a diagnosis and a mystery.
  //
  //    A RESPONSE IS REQUIRED BEFORE AN ELAPSED TIME MEANS ANYTHING. A request that
  //    fails immediately — connection refused, or a route that throws before it
  //    compiles — also takes a few milliseconds, and grading that as warm would
  //    turn this measurement into "it failed quickly". The STATUS stays
  //    deliberately unread (a 401 is a perfectly good warm: the route compiled and
  //    answered); the ABSENCE of a response is what may not pass.
  const MCP_PROBE_BUDGET_MS = 2_500;
  const WARM_DEADLINE = Date.now() + 180_000;
  // Space the attempts, so a genuinely slow route is polled rather than hammered
  // continuously for the whole three minutes.
  const WARM_RETRY_DELAY_MS = 1_000;
  let fastest = Number.POSITIVE_INFINITY;
  let warm = false;
  let lastFailure: string | null = null;
  let answered = false;
  while (Date.now() < WARM_DEADLINE) {
    const started = Date.now();
    const response = await request
      .get("/api/mcp", { failOnStatusCode: false })
      .catch((err: unknown) => {
        lastFailure = err instanceof Error ? err.message : String(err);
        return undefined;
      });
    const elapsed = Date.now() - started;
    if (response) {
      answered = true;
      lastFailure = null;
      fastest = Math.min(fastest, elapsed);
      if (elapsed < MCP_PROBE_BUDGET_MS) {
        warm = true;
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, WARM_RETRY_DELAY_MS));
  }
  expect(
    warm,
    `/api/mcp never answered inside the runtime's own ${MCP_PROBE_BUDGET_MS}ms reachability ` +
      `budget (${
        answered
          ? `fastest response: ${fastest}ms`
          : `the route never produced a response at all${lastFailure ? ` — last error: ${lastFailure}` : ""}`
      }). Every chat turn would be answered with "Cinatra tools are unavailable" and no run ` +
      "would be dispatched.",
  ).toBe(true);
  console.log(`[S9k setup] /api/mcp warm — fastest response ${fastest}ms`);

  mkdirSync(dirname(STORAGE_PATH), { recursive: true });
  await request.storageState({ path: STORAGE_PATH });
});
