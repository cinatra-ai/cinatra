/**
 * THE FRAME'S TOKEN RENEWAL — against a REAL Postgres (cinatra#4217).
 *
 * The unit suite interprets the renewal statement in memory. That proves the
 * logic and nothing about the statement: whether one data-modifying CTE may
 * delete a primary key and write it back in the same statement, whether two
 * connections renewing the same bearer at once really leave ONE successor,
 * whether the guards against the statement's clock mean what the code assumes, and whether
 * the jti readers pick the live row while a spent one lingers. Those are
 * database facts, so they are proved here, through the SHIPPED functions and
 * the SHIPPED statement text, with no mocks anywhere in the store path.
 *
 * Only `connect_sites` and the connector config are stubbed, exactly as in
 * widget-session-cascade.integration.test.ts.
 *
 * Runs under CINATRA_DB_INTEGRATION_TESTS=1 with SUPABASE_DB_URL pointing at a
 * disposable database. Self-skips when the URL is absent.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";

const HAVE_DB = Boolean(process.env.SUPABASE_DB_URL);
const d = HAVE_DB ? describe : describe.skip;

const site = {
  siteId: "",
  client: "wordpress",
  orgId: "org-1",
  widgetOrigin: "https://wp.integration.test",
  credentialVersion: 1,
};
vi.mock("@/lib/connect-sites-store", () => ({
  getActiveConnectSiteById: (id: string) => (id === site.siteId ? { ...site } : null),
}));
vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: (key: string, fallback: unknown) =>
    key === "wordpress"
      ? { instances: [{ id: "inst-1", siteUrl: "https://wp.integration.test" }] }
      : fallback,
  readMetadataValueFromDatabase: () => null,
}));

import {
  __testing,
  consumeUserWidgetToken,
  createAuthTransaction,
  issueUserAuthCode,
  redeemUserAuthCode,
} from "@/lib/widget-user-auth";
import * as widgetUserAuth from "@/lib/widget-user-auth";
import { readLiveWidgetCapturePrincipal } from "@/lib/lifecycle/widget-capture-principal";
import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";

const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra";
const TABLE = `"${SCHEMA}"."widget_user_tokens"`;
const CHAT_PATH = "/api/assistants/chat";
const AGENT = "wordpress-content-editor";
const VERIFIER = "v".repeat(64);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const testing = __testing as unknown as Record<string, unknown>;

type RenewResult =
  | { ok: true; token: string; tokenType: "Bearer"; expiresIn: number; scope: string }
  | { ok: false; reason: string };

let client: Client;
let other: Client;

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");
const siteContext = () => ({
  siteId: site.siteId,
  client: site.client,
  orgId: site.orgId,
  siteOrigin: site.widgetOrigin,
  credentialVersion: site.credentialVersion,
});

function renew(token: string): RenewResult {
  const fn = (widgetUserAuth as unknown as Record<string, unknown>).renewUserWidgetToken;
  expect(typeof fn, "widget-user-auth exports renewUserWidgetToken").toBe("function");
  return (fn as (i: { token: string; agentSlug: string; site: ReturnType<typeof siteContext> }) => RenewResult)({
    token,
    agentSlug: AGENT,
    site: siteContext(),
  });
}

function statement(): string {
  const build = testing.renewClaimStatement;
  expect(typeof build, "the module exposes its renewal statement").toBe("function");
  return (build as () => string)();
}

function use(token: string) {
  return consumeUserWidgetToken({
    token,
    agentSlug: AGENT,
    routePath: CHAT_PATH,
    requestOrigin: site.widgetOrigin,
  });
}

async function signIn(): Promise<string> {
  const txn = createAuthTransaction({
    site: siteContext(),
    agentSlug: AGENT,
    instancesConfigKey: "wordpress",
    codeChallenge: CHALLENGE,
    state: "state-" + randomUUID().slice(0, 12),
  });
  if (!txn.ok) throw new Error(`txn: ${txn.reason}`);
  const issued = issueUserAuthCode({ txnId: txn.txnId, userId: "user-1", authSessionId: "s-1" });
  if (!issued.ok) throw new Error(`issue: ${issued.reason}`);
  const redeemed = redeemUserAuthCode({
    code: issued.code,
    codeVerifier: VERIFIER,
    site: siteContext(),
    issuerBaseUrl: "https://cinatra.integration.test",
  });
  if (!redeemed.ok) throw new Error(`redeem: ${redeemed.reason}`);
  return redeemed.token;
}

async function rowsOfJti(jti: string) {
  const r = await client.query(
    `SELECT token_hash, jti, created_at, expires_at, (expires_at > now()) AS live
       FROM ${TABLE} WHERE jti = $1 ORDER BY expires_at`,
    [jti],
  );
  return r.rows as Array<{ token_hash: string; jti: string; created_at: Date; expires_at: Date; live: boolean }>;
}

async function jtiOf(token: string): Promise<string> {
  const r = await client.query(`SELECT jti FROM ${TABLE} WHERE token_hash = $1`, [hashOf(token)]);
  return String(r.rows[0]?.jti ?? "");
}

beforeAll(async () => {
  if (!HAVE_DB) return;
  client = new Client({ connectionString: process.env.SUPABASE_DB_URL });
  other = new Client({ connectionString: process.env.SUPABASE_DB_URL });
  await client.connect();
  await other.connect();
  await client.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
  await client.query(
    `INSERT INTO "public"."user" (id, name, email, "emailVerified")
     VALUES ('user-1', 'Widget Person', 'widget-person@integration.test', true)
     ON CONFLICT (id) DO NOTHING`,
  );
  for (const q of buildCreateStoreSchemaQueries(SCHEMA)) {
    const head = q.text.trim().slice(0, 6).toUpperCase();
    if (head !== "CREATE" && head !== "ALTER ") continue;
    try {
      await client.query(q.text, q.values ?? []);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("does not exist") && !msg.includes("already exists")) throw err;
    }
  }
  site.siteId = randomUUID();
});

afterAll(async () => {
  if (!HAVE_DB) return;
  await other?.end();
  await client?.end();
});

beforeEach(async () => {
  if (!HAVE_DB) return;
  await client.query(`DELETE FROM ${TABLE}`);
  await client.query(`DELETE FROM "${SCHEMA}"."widget_auth_codes"`);
  await client.query(`DELETE FROM "${SCHEMA}"."widget_auth_transactions"`);
  await client.query(`DELETE FROM "public"."session"`);
  await client.query(
    `INSERT INTO "public"."session" (id, "expiresAt", token, "createdAt", "updatedAt", "userId")
     VALUES ('s-1', now() + interval '1 hour', 'tok-s-1', now(), now(), 'user-1')`,
  );
});

d("the frame's token renewal on a real database (cinatra#4217)", () => {
  it("one statement writes the successor and the grace row under the same key, jti and sign-in time", async () => {
    const first = await signIn();
    const jti = await jtiOf(first);
    const [minted] = await rowsOfJti(jti);

    const renewed = renew(first);
    expect(renewed.ok).toBe(true);
    if (!renewed.ok) return;

    const rows = await rowsOfJti(jti);
    expect(rows.map((r) => r.token_hash).sort()).toEqual([hashOf(first), hashOf(renewed.token)].sort());
    const [graceRow, successor] = rows;
    expect(graceRow.token_hash, "the spent bearer is the shorter-lived row").toBe(hashOf(first));
    for (const r of rows) {
      expect(r.created_at.getTime(), "the sign-in time is copied, never moved").toBe(minted.created_at.getTime());
      expect(r.live).toBe(true);
    }
    const grace = Number(testing.USER_TOKEN_RENEW_GRACE_SECONDS);
    const spans = await client.query(
      `SELECT EXTRACT(EPOCH FROM (expires_at - now()))::float AS left_s, token_hash FROM ${TABLE} WHERE jti = $1`,
      [jti],
    );
    for (const s of spans.rows as Array<{ left_s: number; token_hash: string }>) {
      if (s.token_hash === hashOf(first)) expect(s.left_s).toBeLessThanOrEqual(grace);
      else expect(s.left_s).toBeGreaterThan(__testing.USER_TOKEN_TTL_SECONDS - 60);
    }
    expect(successor.expires_at.getTime()).toBeGreaterThan(graceRow.expires_at.getTime());

    // The spent bearer verifies for its grace window and is never renewed again.
    expect(use(first).ok).toBe(true);
    expect(renew(first)).toEqual({ ok: false, reason: "not_renewable" });
    expect(use(renewed.token).ok).toBe(true);
  });

  it("two connections renewing the same bearer at once leave exactly one successor", async () => {
    const first = await signIn();
    const jti = await jtiOf(first);
    const text = statement();
    const values = (successorHash: string) => [
      hashOf(first),
      successorHash,
      Number(testing.USER_TOKEN_MAX_SESSION_SECONDS),
      __testing.USER_TOKEN_TTL_SECONDS,
      Number(testing.USER_TOKEN_RENEW_GRACE_SECONDS),
    ];
    const otherPid = Number((await other.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);

    await client.query("BEGIN");
    const a = await client.query(text, values("successor-a"));
    expect(a.rowCount, "the first renewal claims the row").toBe(1);

    await other.query("BEGIN");
    const pending = other.query(text, values("successor-b"));
    // Wait until the second renewal is really blocked on the row the first holds.
    for (let i = 0; i < 200; i += 1) {
      const w = await client.query(
        "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
        [otherPid],
      );
      if (w.rows[0]?.wait_event_type === "Lock") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await client.query("COMMIT");
    const b = await pending;
    await other.query("COMMIT");

    expect(b.rowCount, "the second renewal claims nothing").toBe(0);
    const rows = await rowsOfJti(jti);
    expect(rows.map((r) => r.token_hash).sort()).toEqual([hashOf(first), "successor-a"].sort());
  });

  // A real-database check that the capture reader returns the live successor.
  // It is NOT the mutation proof of the reader's ORDER BY: without it, which of
  // the two rows Postgres returns first is unspecified, so this case may pass by
  // chance. The deterministic proofs for BOTH jti readers are unit cases in
  // review-island-serving.test.ts and widget-capture-principal.test.ts (r5).
  it("a spent row that lingers past its grace never hides the live successor from the jti readers", async () => {
    const first = await signIn();
    const jti = await jtiOf(first);
    const renewed = renew(first);
    expect(renewed.ok).toBe(true);
    if (!renewed.ok) return;
    // The grace window ends; nothing has swept the spent row yet.
    await client.query(`UPDATE ${TABLE} SET expires_at = now() - interval '1 second' WHERE token_hash = $1`, [
      hashOf(first),
    ]);
    expect((await rowsOfJti(jti)).filter((r) => !r.live)).toHaveLength(1);

    const principal = readLiveWidgetCapturePrincipal(jti);
    expect(principal, "the capture principal reads the live successor").not.toBeNull();
    expect(principal?.userId).toBe("user-1");

    expect(use(first)).toEqual({ ok: false, reason: "expired" });
    expect(renew(first)).toEqual({ ok: false, reason: "not_found" });
    expect(use(renewed.token).ok).toBe(true);
  });

  // cinatra#4217 r4. RED BEFORE r4: the claim's life guard compared with now(),
  // which is the time a transaction BEGAN. `other` begins first; the shipped
  // renewal then commits and writes the grace row a grace window past its clock;
  // `other`'s statement, under READ COMMITTED, sees that row, and against its
  // earlier now() the row still had "more than the grace window" left, so it
  // claimed it and wrote a second successor for the same jti. The guard now
  // reads clock_timestamp(), so the grace row is never claimable.
  it("a renewal whose transaction began before another renewal committed cannot claim the grace row", async () => {
    const first = await signIn();
    const jti = await jtiOf(first);
    const text = statement();

    await other.query("BEGIN");
    await other.query("SELECT now()");
    await new Promise((resolve) => setTimeout(resolve, 50)); // the first renewal's now() is later
    const renewed = renew(first);
    expect(renewed.ok, "the shipped renewal wins and commits").toBe(true);
    if (!renewed.ok) {
      await other.query("ROLLBACK");
      return;
    }

    const late = await other.query(text, [
      hashOf(first),
      "successor-late",
      Number(testing.USER_TOKEN_MAX_SESSION_SECONDS),
      __testing.USER_TOKEN_TTL_SECONDS,
      Number(testing.USER_TOKEN_RENEW_GRACE_SECONDS),
    ]);
    await other.query("COMMIT");

    expect(late.rowCount, "the grace row is never claimed").toBe(0);
    const rows = await rowsOfJti(jti);
    expect(rows.map((r) => r.token_hash).sort()).toEqual([hashOf(first), hashOf(renewed.token)].sort());
  });

  // cinatra#4217 r5. RED ON r4: the CAP guard compared with now(), the time the
  // transaction BEGAN. `other` begins one second before the chain's cap and runs
  // the shipped statement half a second after it; against its earlier now() the
  // chain was still under its cap, so it claimed the row and wrote a successor
  // whose cap had already passed. The guard now reads clock_timestamp().
  it("a renewal whose transaction began before the cap and ran after it claims nothing", async () => {
    const first = await signIn();
    const max = Number(testing.USER_TOKEN_MAX_SESSION_SECONDS);
    await client.query(
      `UPDATE ${TABLE} SET created_at = clock_timestamp() - make_interval(secs => $2) + interval '1 second' WHERE token_hash = $1`,
      [hashOf(first), max],
    );
    const snapshot = async () =>
      (await client.query(`SELECT token_hash, expires_at FROM ${TABLE} ORDER BY token_hash`)).rows;
    const before = await snapshot();

    await other.query("BEGIN");
    try {
      const start = await other.query(
        `SELECT (created_at + make_interval(secs => $2) > now()) AS under_cap FROM ${TABLE} WHERE token_hash = $1`,
        [hashOf(first), max],
      );
      expect(start.rows[0]?.under_cap, "vacuity: the transaction began under the cap").toBe(true);
      await other.query("SELECT pg_sleep(1.5)"); // the cap passes while the transaction is open
      const late = await other.query(statement(), [
        hashOf(first),
        "successor-past-cap",
        max,
        __testing.USER_TOKEN_TTL_SECONDS,
        Number(testing.USER_TOKEN_RENEW_GRACE_SECONDS),
      ]);
      await other.query("COMMIT");
      expect(late.rowCount, "past the cap when the statement runs").toBe(0);
    } catch (err) {
      await other.query("ROLLBACK").catch(() => undefined);
      throw err;
    }
    expect(await snapshot(), "nothing is written or spent").toEqual(before);
  });

  it("a chain at its maximum lifetime is not claimed by the database's own clock", async () => {
    const first = await signIn();
    const max = Number(testing.USER_TOKEN_MAX_SESSION_SECONDS);
    await client.query(
      `UPDATE ${TABLE} SET created_at = now() - make_interval(secs => $2) WHERE token_hash = $1`,
      [hashOf(first), max],
    );
    const before = (await client.query(`SELECT count(*)::int AS n FROM ${TABLE}`)).rows[0].n;
    expect(renew(first)).toEqual({ ok: false, reason: "not_renewable" });
    expect((await client.query(`SELECT count(*)::int AS n FROM ${TABLE}`)).rows[0].n).toBe(before);
    expect(use(first).ok, "the token itself still serves out its own life").toBe(true);
  });
});
