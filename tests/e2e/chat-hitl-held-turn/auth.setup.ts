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
  recordMemberInsert,
  snapshotAccountState,
  type AccountSnapshot,
} from "./account-state";
import { PROMOTE_ADMIN_ROLE_SQL, memberIdFor } from "./state-rules";
import {
  ROUTE_READY_BOUND_MS,
  isRuntimeNotFoundDocument,
  retryWhileRouteMissing,
  waitForRouteReady,
} from "./route-readiness";

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
 *
 * ONE PREDICATE DECIDES, AND IT ALREADY DID. `roleCarriesAdmin` answered "does
 * this account already carry `admin`?" from the PRE-READ, and `roleChanged` is
 * that answer — the same answer the restore is gated on. This file no longer
 * decides it a second time: it writes only when the snapshot says the promotion
 * changes something. That is what closed the drift, where a role spelled
 * `" admin"` made the SQL append a duplicate token while the restore recorded the
 * role as never changed and asserted nothing. The statement's own `EXISTS` arm is
 * a pure idempotency belt for the window after the pre-read, and it is built from
 * the SAME token expression the strip uses (`state-rules.ts`).
 */
async function promoteToPlatformAdmin(c: Client, snapshot: AccountSnapshot): Promise<void> {
  if (!snapshot.roleChanged) return;
  await c.query(PROMOTE_ADMIN_ROLE_SQL, [snapshot.userId]);
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
  //
  // THE CONFLICT TARGET IS THE IDENTITY, not the synthetic id. Production enforces
  // `member_org_user_uniq ON public."member" ("organizationId", "userId")`
  // (`src/lib/drizzle-store.ts`), so arbitrating on the id asked a question the
  // database does not answer: an account already a member of this organization
  // under a normally minted id took the INSERT arm and hit the unique violation,
  // failing the setup outright. Now the pre-read above and this statement key on
  // the same pair, so an existing membership takes the do-nothing arm and is
  // correctly recorded as somebody else's.
  const inserted = await c.query(
    `INSERT INTO public."member" (id, "userId", "organizationId", role, "createdAt")
       VALUES ($1, $2, $3, 'owner', now())
       ON CONFLICT ("organizationId", "userId") DO NOTHING RETURNING id`,
    [memberIdFor(userId, orgId), userId, orgId],
  );
  recordMemberInsert(snapshot, (inserted.rowCount ?? 0) > 0 ? "inserted" : "already_present");
  return orgId;
}

setup("create the owner, the org and the instance fixtures", async ({ request, baseURL }) => {
  const origin = baseURL ?? "http://localhost:3000";
  const headers = { Origin: origin } as const;

  // 0. THE ROUTES THIS SETUP AND THE FLOW DEPEND ON — WAITED FOR, BOUNDED, AND
  //    WITHOUT CREATING ANY STATE.
  //
  //    `webServer.url` polls `/api/health`, which answers as soon as the server is
  //    up. That is NOT the claim the next step needs. The development runtime
  //    compiles a route on its FIRST hit and answers 404 until that compile lands,
  //    and this very route's cold compile has been measured at 41 s on a contended
  //    runner — so a single unretried status assertion against it can fail the
  //    whole job for a reason that has nothing to do with holds. That is how this
  //    setup died once already.
  //
  //    NEITHER PROBE MAY CREATE STATE, and that constraint is what picks the
  //    request. Neither route publishes a HEAD or an OPTIONS handler, so the
  //    side-effect-free signal is a body the route rejects before it does anything:
  //
  //      * `POST /api/auth/sign-up/email` with an EMPTY body — Better Auth
  //        validates the body before it touches the store, so no user is written.
  //        A VALID sign-up here would seed the very account step 1 exists to
  //        arbitrate over, which is the one thing a readiness probe must not do.
  //      * `POST /api/assistants/chat/capabilities` with an empty body — the
  //        handler's first statement is `const session = await getAuthSession(); if
  //        (!session?.user?.id) return Response.json({ error: "Unauthorized" }, {
  //        status: 401 })`, and this probe runs BEFORE the sign-in, so it is
  //        answered by that line having read nothing and written nothing. (With a
  //        session it would be the `clientHelloSchema` parse answering 400
  //        instead. Both are answers; only a 404 is not.)
  //
  //    A 404 is therefore the ONLY status treated as "not yet"; every other status
  //    proves the route compiled and ran, which is all readiness asks. The bound
  //    spent without an answer fails the setup NAMING THE ROUTE — a two-minute
  //    report instead of a twenty-minute mystery.
  //
  //    AND THE ANSWER'S MEDIA TYPE IS READ WITH ITS STATUS, because a 404 has two
  //    different senders and a status cannot name which one answered. When the
  //    runtime cannot route a path it resolves it in the PAGE tree and renders the
  //    application's not-found page, so its 404 is an HTML DOCUMENT; a handler's
  //    own 404 is that handler's media type. Neither of these two routes can answer
  //    404 from its handler at all — the capabilities POST answers 401/400/200 and
  //    Better Auth's sign-up 400 — so this changes NOTHING about what either probe
  //    waits for; it changes what the failure is able to say it saw, and it keeps
  //    the rule true for a route whose handler does 404 (the widget's thread read
  //    404s across tenants by design).
  for (const path of ["/api/auth/sign-up/email", "/api/assistants/chat/capabilities"]) {
    const ready = await waitForRouteReady(
      `POST ${path}`,
      async (_attemptIndex, remainingMs) => {
        // The request carries the REST OF THE BOUND as its own timeout, so the
        // two-minute promise is a wall-clock promise and not merely a loop
        // condition: a call begun just inside the bound cannot run past it on the
        // transport's own default. `remainingMs` is always at least 1 — Playwright
        // reads a timeout of 0 as "no timeout at all", which is the one value that
        // would silently undo this.
        const response = await request.post(path, {
          data: {},
          headers,
          failOnStatusCode: false,
          timeout: remainingMs,
        });
        return { status: response.status(), contentType: response.headers()["content-type"] ?? null };
      },
      {
        timeoutMs: ROUTE_READY_BOUND_MS,
        // Before the first successful request a refused connection genuinely is
        // "not up yet", so the PROBE — and only the probe — retries a thrown
        // attempt too. Every later call site keeps its instant transport failure.
        retryOnError: true,
        onRetry: ({ attempts, delayMs, status, contentType, lastError }) =>
          console.log(
            `[S9k setup] ${path} is not ready after ${attempts} attempt(s) — ` +
              (status === null
                ? `no response at all (${lastError ?? "unknown error"})`
                : `HTTP ${status}${contentType ? ` (${contentType})` : ""}`) +
              "; " +
              (isRuntimeNotFoundDocument(contentType)
                ? "that is the dev runtime's own not-found PAGE, so the route is not routable yet"
                : "the dev runtime has not compiled it yet") +
              `, retrying in ${delayMs}ms`,
          ),
      },
    );
    console.log(
      `[S9k setup] ${path} ready — HTTP ${ready.status}` +
        `${ready.contentType ? ` (${ready.contentType})` : ""} after ${ready.attempts} attempt(s), ` +
        `${ready.elapsedMs}ms`,
    );
  }

  // 1. The account. Idempotent — an existing user answers 400/422.
  //
  //    RETRIED WHILE THE ANSWER IS 404, and only then. The probe above has already
  //    seen this route answer, so a 404 here is a straggler rather than a cold
  //    boot, and it gets the shorter in-flight bound. EVERY OTHER STATUS IS LEFT
  //    EXACTLY AS IT WAS: the assertion below is the same three-status assertion,
  //    still the thing that decides whether the sign-up was acceptable, and a 500
  //    or a 403 still reaches it on the first attempt — and a TRANSPORT fault still
  //    throws out of here immediately, as it did before this change, because
  //    `retryOnError` is left off everywhere except the readiness probe.
  const signUp = await retryWhileRouteMissing(
    async (_attemptIndex, remainingMs) => {
      const response = await request.post("/api/auth/sign-up/email", {
        data: { email: EMAIL, password: PASSWORD, name: "Chat HITL S9k Owner" },
        headers,
        failOnStatusCode: false,
        timeout: remainingMs,
      });
      return { status: response.status(), contentType: response.headers()["content-type"] ?? null };
    },
    {
      onRetry: ({ attempts, delayMs }) =>
        console.log(
          `[S9k setup] POST /api/auth/sign-up/email answered 404 (attempt ${attempts}) — ` +
            `retrying in ${delayMs}ms`,
        ),
    },
  );
  expect(
    [200, 400, 422],
    `POST /api/auth/sign-up/email answered ` +
      `${signUp.status === null ? `nothing at all (last error: ${signUp.lastError})` : signUp.status}` +
      ` after ${signUp.attempts} attempt(s) over ${signUp.elapsedMs}ms`,
  ).toContain(signUp.status);

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
    await promoteToPlatformAdmin(c, snapshot);
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
