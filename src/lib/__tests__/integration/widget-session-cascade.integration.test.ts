/**
 * SIGN-OUT REVOKES THE WIDGET SESSION — against a REAL Postgres (cinatra#2684).
 *
 * The unit suite drives an in-memory interpreter of the statements this flow
 * emits. That proves the LOGIC and nothing about the STATEMENTS: whether
 * `"expiresAt"` is really the column Better Auth writes, whether a timestamptz
 * comparison against `now()` means what the code assumes, whether the ALTERs
 * land on a database that already has the tables, and whether a keyed delete
 * really leaves a sibling session's rows alone. Those are database facts, so
 * they are proved here, on the database, through the SHIPPED functions —
 * `issueUserAuthCode`, `redeemUserAuthCode`, `consumeUserWidgetToken`,
 * `readLiveWidgetCapturePrincipal` and `widgetAuthSessionIsLive` — with no mocks
 * anywhere in the store path.
 *
 * Only `connect_sites` is stubbed, and only because it is a different module's
 * live-state read; every widget row, every session row and every statement in
 * between is real.
 *
 * Runs under CINATRA_DB_INTEGRATION_TESTS=1 with SUPABASE_DB_URL pointing at a
 * disposable database. Self-skips when the URL is absent, so the flag can never
 * make it fail-vacuous.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";

const HAVE_DB = Boolean(process.env.SUPABASE_DB_URL);
const d = HAVE_DB ? describe : describe.skip;

// The one live-state read that belongs to another module. Everything else runs
// against the real database.
const site = {
  siteId: "",
  client: "wordpress",
  orgId: "org-1",
  widgetOrigin: "https://wp.integration.test",
  credentialVersion: 1,
};
let siteIsActive = true;
vi.mock("@/lib/connect-sites-store", () => ({
  getActiveConnectSiteById: (id: string) =>
    siteIsActive && id === site.siteId ? { ...site } : null,
}));
vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: (key: string, fallback: unknown) =>
    key === "wordpress"
      ? { instances: [{ id: "inst-1", siteUrl: "https://wp.integration.test" }] }
      : fallback,
  readMetadataValueFromDatabase: () => null,
}));

import {
  consumeUserWidgetToken,
  createAuthTransaction,
  issueUserAuthCode,
  redeemUserAuthCode,
} from "@/lib/widget-user-auth";
import { readLiveWidgetCapturePrincipal } from "@/lib/lifecycle/widget-capture-principal";
import { widgetAuthSessionIsLive } from "@/lib/widget-session-binding";
import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";

const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra";
const CHAT_PATH = "/api/assistants/chat";
const AGENT = "wordpress-content-editor";
const VERIFIER = "v".repeat(64);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

let client: Client;

async function seedSession(id: string, ttlSeconds = 3600) {
  await client.query(
    `INSERT INTO "public"."session" (id, "expiresAt", token, "createdAt", "updatedAt", "userId")
     VALUES ($1, now() + make_interval(secs => $2), $3, now(), now(), 'user-1')`,
    [id, String(ttlSeconds), `tok-${id}`],
  );
}

/** What Better Auth does on sign-out / revoke: the row goes. */
async function deleteSession(id: string) {
  await client.query(`DELETE FROM "public"."session" WHERE id = $1`, [id]);
}

async function mintTokenUnder(authSessionId: string): Promise<{ token: string; jti: string }> {
  const txn = createAuthTransaction({
    site: {
      siteId: site.siteId,
      client: site.client,
      orgId: site.orgId,
      siteOrigin: site.widgetOrigin,
      credentialVersion: site.credentialVersion,
    },
    agentSlug: AGENT,
    instancesConfigKey: "wordpress",
    codeChallenge: CHALLENGE,
    state: "state-" + randomUUID().slice(0, 12),
  });
  if (!txn.ok) throw new Error(`txn: ${txn.reason}`);
  const issued = issueUserAuthCode({ txnId: txn.txnId, userId: "user-1", authSessionId });
  if (!issued.ok) throw new Error(`issue: ${issued.reason}`);
  const redeemed = redeemUserAuthCode({
    code: issued.code,
    codeVerifier: VERIFIER,
    site: {
      siteId: site.siteId,
      client: site.client,
      orgId: site.orgId,
      siteOrigin: site.widgetOrigin,
      credentialVersion: site.credentialVersion,
    },
    issuerBaseUrl: "https://cinatra.integration.test",
  });
  if (!redeemed.ok) throw new Error(`redeem: ${redeemed.reason}`);
  const jtiRow = await client.query(
    `SELECT jti FROM "${SCHEMA}"."widget_user_tokens" WHERE token_hash = $1`,
    [createHash("sha256").update(redeemed.token).digest("hex")],
  );
  return { token: redeemed.token, jti: String(jtiRow.rows[0]?.jti ?? "") };
}

function turn(token: string) {
  return consumeUserWidgetToken({
    token,
    agentSlug: AGENT,
    routePath: CHAT_PATH,
    requestOrigin: site.widgetOrigin,
  });
}

beforeAll(async () => {
  if (!HAVE_DB) return;
  client = new Client({ connectionString: process.env.SUPABASE_DB_URL });
  await client.connect();
  await client.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
  // Better Auth's OWN tables, in the shape it actually ships — this database is
  // provisioned from a migrated instance's `public` schema, foreign keys and
  // all, so the liveness read below runs against the real `session` table and
  // the real `"expiresAt" timestamptz` rather than a hand-written stand-in.
  // Anything less would let a wrong column name or a timezone-naive comparison
  // pass here and fail in production, which is the whole point of this tier.
  await client.query(
    `INSERT INTO "public"."user" (id, name, email, "emailVerified")
     VALUES ('user-1', 'Widget Person', 'widget-person@integration.test', true)
     ON CONFLICT (id) DO NOTHING`,
  );
  // The core store, through the SSOT — including the #2684 ALTERs, so this run
  // also proves they apply to a database that already has the tables.
  for (const q of buildCreateStoreSchemaQueries(SCHEMA)) {
    const head = q.text.trim().slice(0, 6).toUpperCase();
    if (head !== "CREATE" && head !== "ALTER ") continue;
    try {
      await client.query(q.text, q.values ?? []);
    } catch (err) {
      // The SSOT is idempotent for tables and columns but not for triggers, and
      // a few statements reference seed dependencies a bare schema lacks. Both
      // are re-run noise; a genuine schema problem still throws.
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("does not exist") && !msg.includes("already exists")) throw err;
    }
  }
  site.siteId = randomUUID();
});

afterAll(async () => {
  if (!HAVE_DB) return;
  await client?.end();
});

beforeEach(async () => {
  if (!HAVE_DB) return;
  siteIsActive = true;
  await client.query(`DELETE FROM "${SCHEMA}"."widget_user_tokens"`);
  await client.query(`DELETE FROM "${SCHEMA}"."widget_auth_codes"`);
  await client.query(`DELETE FROM "${SCHEMA}"."widget_auth_transactions"`);
  await client.query(`DELETE FROM "public"."session"`);
});

d("the shipped DDL binds a widget token to a session (cinatra#2684)", () => {
  it("both widget tables carry auth_session_id, and the token table is indexed by it", async () => {
    const cols = await client.query(
      `SELECT table_name, column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = $1 AND column_name = 'auth_session_id'
        ORDER BY table_name`,
      [SCHEMA],
    );
    expect(cols.rows.map((r) => r.table_name).sort()).toEqual([
      "widget_auth_codes",
      "widget_user_tokens",
    ]);
    // Nullable is the mixed-version contract; a NOT NULL would have been a
    // destructive change to a deployed table.
    for (const r of cols.rows) expect(r.is_nullable).toBe("YES");

    const idx = await client.query(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = $1 AND indexname = 'widget_user_tokens_auth_session_idx'`,
      [SCHEMA],
    );
    expect(idx.rowCount).toBe(1);
    expect(String(idx.rows[0].indexdef)).toContain("auth_session_id");
    expect(String(idx.rows[0].indexdef)).not.toContain("UNIQUE");
  });
});

d("widgetAuthSessionIsLive against the real session table", () => {
  it("is true for a live row, false once it is deleted, false when it has expired", async () => {
    await seedSession("s-live");
    expect(widgetAuthSessionIsLive("s-live")).toBe(true);

    await deleteSession("s-live");
    expect(widgetAuthSessionIsLive("s-live")).toBe(false);

    // An expired row is still a row. The `"expiresAt" > now()` clause is what
    // makes it read as signed out — this is the assertion that would fail if the
    // column name or the timestamptz comparison were wrong.
    await seedSession("s-expired", -60);
    expect(widgetAuthSessionIsLive("s-expired")).toBe(false);
  });

  it("is false for a session that never existed", () => {
    expect(widgetAuthSessionIsLive("s-never")).toBe(false);
  });
});

d("AC-1 / AC-3 — a signed-out session's credentials stop working", () => {
  it("the widget turn is refused, and the control on the same token passes first", async () => {
    await seedSession("s-1");
    const { token } = await mintTokenUnder("s-1");
    expect(turn(token).ok).toBe(true); // control: live session

    await deleteSession("s-1"); // sign-out

    expect(turn(token)).toEqual({ ok: false, reason: "session_revoked" });
  });

  it("AC-3 the capture capability's live principal refuses at the dead parent row", async () => {
    await seedSession("s-1");
    const { jti } = await mintTokenUnder("s-1");
    // The capability seals the jti; this probe is what serves or refuses the
    // bytes. The control is STRICT on purpose: a probe that answered null both
    // times would pass a weaker assertion while proving nothing at all.
    const before = readLiveWidgetCapturePrincipal(jti);
    expect(before, "the control must serve before the sign-out").not.toBeNull();
    expect(before?.userId).toBe("user-1");

    await deleteSession("s-1"); // sign-out

    expect(readLiveWidgetCapturePrincipal(jti)).toBeNull();
  });

  it("the refused row is really gone from the table", async () => {
    await seedSession("s-1");
    const { token } = await mintTokenUnder("s-1");
    await deleteSession("s-1");
    turn(token);
    const left = await client.query(`SELECT count(*)::int AS n FROM "${SCHEMA}"."widget_user_tokens"`);
    expect(left.rows[0].n).toBe(0);
  });
});

d("AC-4 / AC-5 — revocation is per session, not per person", () => {
  it("AC-5 revoking ONE session leaves the OTHER live session's token working", async () => {
    await seedSession("s-1");
    await seedSession("s-2");
    const a = await mintTokenUnder("s-1");
    const b = await mintTokenUnder("s-2");
    expect(turn(a.token).ok).toBe(true);
    expect(turn(b.token).ok).toBe(true);

    // Exactly what Better Auth does for ONE revoked session: the row goes.
    await deleteSession("s-1");

    expect(turn(a.token)).toEqual({ ok: false, reason: "session_revoked" });
    expect(turn(b.token).ok).toBe(true);

    const rows = await client.query(
      `SELECT auth_session_id FROM "${SCHEMA}"."widget_user_tokens"`,
    );
    expect(rows.rows.map((r) => r.auth_session_id)).toEqual(["s-2"]);
  });

  it("AC-4 revoking every session of the user invalidates every bound row", async () => {
    await seedSession("s-1");
    await seedSession("s-2");
    const a = await mintTokenUnder("s-1");
    const b = await mintTokenUnder("s-2");

    // Revoking every session of a user is the same delete, twice — which is why
    // "all sessions" needs no wider predicate anywhere.
    for (const id of ["s-1", "s-2"]) await deleteSession(id);

    expect(turn(a.token).ok).toBe(false);
    expect(turn(b.token).ok).toBe(false);
    // Each refusal reaps its own row, keyed on that one token's hash.
    const left = await client.query(`SELECT count(*)::int AS n FROM "${SCHEMA}"."widget_user_tokens"`);
    expect(left.rows[0].n).toBe(0);
  });
});

d("AC-6 — a code revoked before redemption mints nothing", () => {
  it("refuses the exchange, and the identical exchange under a live session mints", async () => {
    await seedSession("s-1");
    const txn = createAuthTransaction({
      site: { ...site, siteOrigin: site.widgetOrigin },
      agentSlug: AGENT,
      instancesConfigKey: "wordpress",
      codeChallenge: CHALLENGE,
      state: "state-" + randomUUID().slice(0, 12),
    });
    if (!txn.ok) throw new Error("txn");
    const issued = issueUserAuthCode({
      txnId: txn.txnId,
      userId: "user-1",
      authSessionId: "s-1",
    });
    if (!issued.ok) throw new Error("issue");

    await deleteSession("s-1"); // the sign-out, between issue and redeem

    expect(
      redeemUserAuthCode({
        code: issued.code,
        codeVerifier: VERIFIER,
        site: { ...site, siteOrigin: site.widgetOrigin },
        issuerBaseUrl: "https://cinatra.integration.test",
      }),
    ).toEqual({ ok: false, reason: "invalid_grant" });
    const minted = await client.query(`SELECT count(*)::int AS n FROM "${SCHEMA}"."widget_user_tokens"`);
    expect(minted.rows[0].n).toBe(0);

    // Control: the same exchange under a session that is still there.
    await seedSession("s-2");
    const { token } = await mintTokenUnder("s-2");
    expect(turn(token).ok).toBe(true);
  });

  it("a code whose session died WITHOUT the cascade running is still refused", async () => {
    // Deleted behind Better Auth's back — the read is what catches it.
    await seedSession("s-1");
    const txn = createAuthTransaction({
      site: { ...site, siteOrigin: site.widgetOrigin },
      agentSlug: AGENT,
      instancesConfigKey: "wordpress",
      codeChallenge: CHALLENGE,
      state: "state-" + randomUUID().slice(0, 12),
    });
    if (!txn.ok) throw new Error("txn");
    const issued = issueUserAuthCode({
      txnId: txn.txnId,
      userId: "user-1",
      authSessionId: "s-1",
    });
    if (!issued.ok) throw new Error("issue");

    await deleteSession("s-1");

    expect(
      redeemUserAuthCode({
        code: issued.code,
        codeVerifier: VERIFIER,
        site: { ...site, siteOrigin: site.widgetOrigin },
        issuerBaseUrl: "https://cinatra.integration.test",
      }),
    ).toEqual({ ok: false, reason: "invalid_grant" });
  });
});

d("AC-7 — nothing about a live session's token changed", () => {
  it("the token still lives its full TTL and the site re-check still decides", async () => {
    await seedSession("s-1");
    const { token } = await mintTokenUnder("s-1");

    const ttl = await client.query(
      `SELECT round(extract(epoch from (expires_at - created_at)))::int AS secs
         FROM "${SCHEMA}"."widget_user_tokens"`,
    );
    expect(ttl.rows[0].secs).toBe(15 * 60);

    expect(turn(token).ok).toBe(true);
    siteIsActive = false;
    expect(turn(token)).toEqual({ ok: false, reason: "site_revoked" });
  });

  it("an EXPIRED session ends the token even though nobody deleted the row", async () => {
    await seedSession("s-short", 1);
    const { token } = await mintTokenUnder("s-short");
    expect(turn(token).ok).toBe(true);

    await client.query(
      `UPDATE "public"."session" SET "expiresAt" = now() - interval '1 second' WHERE id = 's-short'`,
    );
    expect(turn(token)).toEqual({ ok: false, reason: "session_revoked" });
  });
});
