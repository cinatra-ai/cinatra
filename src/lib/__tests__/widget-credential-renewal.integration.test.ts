/**
 * THE CREDENTIAL RENEWS ITSELF, MEASURED AGAINST A REAL STORE (cinatra#3051).
 *
 * The bearer a widget column holds has a fifteen-minute life. A column that
 * outlives it is not degraded — it is dead: every read it makes is refused, so a
 * run released after that point reaches nothing however long the page stays
 * open. `renewUserWidgetToken` is the second act that was missing, and the whole
 * question about it is whether it re-issues THE SAME AUTHORIZATION or quietly
 * makes a new one.
 *
 * That question cannot be answered by a double. What a renewal copies, what it
 * refuses, and what it leaves behind are all facts about ROWS — so every arm
 * here runs against Postgres through the shipped writers only: the sign-in is
 * performed by `createAuthTransaction` / `issueUserAuthCode` / `redeemUserAuthCode`,
 * the renewal by the shipped renewal, and every verdict by the shipped consume.
 * Nothing is hand-inserted into the token table, because a hand-written row is
 * an assertion about a mint rather than a measurement of one.
 *
 * DB-gated like its sibling in this tier: it self-skips without a real
 * SUPABASE_DB_URL, and refuses to skip inside the dedicated lane.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { writeConnectorConfigToDatabase } from "@/lib/database";
import { upsertConnectSiteCredential } from "@/lib/connect-sites-store";
import {
  consumeUserWidgetToken,
  createAuthTransaction,
  issueUserAuthCode,
  redeemUserAuthCode,
  renewUserWidgetToken,
  resolveVerifiedSiteFromCredential,
  type VerifiedSiteContext,
} from "@/lib/widget-user-auth";
import { WIDGET_SIGNIN_GRANTED_SCOPES } from "@/lib/widget-lifecycle-scope";
import { WIDGET_BROKER_ROUTE_PATH } from "@/lib/widget-broker-route";
import { postgresSchema } from "@/lib/postgres-config";
import { X3052_SCHEMA } from "@/lib/lifecycle/__tests__/widget-schedule-grant.setup";

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@");
const describeDb = HAS_DB ? describe : describe.skip;

const IN_DEDICATED_LANE = process.env.CINATRA_WIDGET_SCHEDULE_GRANT_REALDB === "1";
const ALLOW_SKIP = process.env.X3052_ALLOW_SKIP === "1";

if (IN_DEDICATED_LANE && !ALLOW_SKIP && !HAS_DB) {
  throw new Error(
    "the widget credential-renewal tier needs a live Postgres: set SUPABASE_DB_URL " +
      "to a real connection string. Refusing to skip — a skipped proof that a " +
      "credential renews proves nothing. Pass X3052_ALLOW_SKIP=1 to skip anyway.",
  );
}

const TEST_SCHEMA = X3052_SCHEMA;
const q = (s: string) => s.replaceAll('"', '""');

const ORG_ID = "org-x3051r";
const PERSON_ID = "usr-x3051r";
const SESSION_ID = "sess-x3051r";
const SITE_ORIGIN = "https://widget-x3051r.example.test";
const INSTANCE_ID = "inst-x3051r";
const AGENT_SLUG = "wordpress";
const BASE_URL = (process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");

let admin: Client;
let verifiedSite: VerifiedSiteContext | null = null;

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** ONE FRESH SIGN-IN, through the shipped writers only — the same three hops a
 *  person's own sign-in takes. */
function signIn(): { token: string; scope: string } {
  const site = verifiedSite;
  if (!site) throw new Error("the connect site did not verify — nothing to authorise against");
  const { verifier, challenge } = pkce();
  const txn = createAuthTransaction({
    site,
    agentSlug: AGENT_SLUG,
    instancesConfigKey: "wordpress",
    codeChallenge: challenge,
    state: randomBytes(16).toString("base64url"),
  });
  if (!txn.ok) throw new Error(`the auth transaction was refused: ${txn.reason}`);
  const issued = issueUserAuthCode({
    txnId: txn.txnId,
    userId: PERSON_ID,
    authSessionId: SESSION_ID,
    grantedScopes: WIDGET_SIGNIN_GRANTED_SCOPES,
  });
  if (!issued.ok) throw new Error(`the authorisation code was refused: ${issued.reason}`);
  const redeemed = redeemUserAuthCode({
    code: issued.code,
    codeVerifier: verifier,
    site,
    issuerBaseUrl: BASE_URL,
  });
  if (!redeemed.ok) throw new Error(`the widget user token mint was refused: ${redeemed.reason}`);
  return { token: redeemed.token, scope: redeemed.scope };
}

const tokenHash = (token: string) =>
  createHash("sha256").update(token, "utf8").digest("hex");

/** THE ROW ITSELF, read straight out of the table. Every claim is a column, so
 *  "the same authorization" is a comparison of columns and not of a summary. */
async function readRow(token: string): Promise<Record<string, unknown> | null> {
  const { rows } = await admin.query(
    `SELECT * FROM "${q(TEST_SCHEMA)}"."widget_user_tokens" WHERE token_hash = $1`,
    [tokenHash(token)],
  );
  return (rows[0] as Record<string, unknown>) ?? null;
}

/** The shipped verdict on a bearer — the same one a turn goes through. */
function consume(token: string, over: { agentSlug?: string; requestOrigin?: string } = {}) {
  return consumeUserWidgetToken({
    token,
    agentSlug: over.agentSlug ?? AGENT_SLUG,
    routePath: WIDGET_BROKER_ROUTE_PATH,
    requestOrigin: over.requestOrigin ?? SITE_ORIGIN,
  });
}

describeDb("the widget credential renews itself while the sign-in lives", () => {
  beforeAll(async () => {
    expect(
      postgresSchema,
      "this suite writes through the shipped stores — it must be pointed at its own throwaway schema",
    ).toBe(TEST_SCHEMA);
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query(
      `INSERT INTO public."user" (id, username, name, email, "emailVerified")
       VALUES ($1, $2, $3, $4, false) ON CONFLICT (id) DO NOTHING`,
      [PERSON_ID, "x3051r", "x3051r", "x3051r@example.test"],
    );
    await admin.query(
      `INSERT INTO public."organization" (id, slug, name, "createdAt")
       VALUES ($1, $2, $3, now()) ON CONFLICT (id) DO NOTHING`,
      [ORG_ID, "x3051r", "x3051r"],
    );
    await admin.query(
      `INSERT INTO public."member" (id, "organizationId", "userId", "createdAt", role)
       VALUES ($1, $2, $3, now(), $4) ON CONFLICT (id) DO NOTHING`,
      ["mem-x3051r", ORG_ID, PERSON_ID, "member"],
    );
    // THE SIGN-IN ROW. Every renewal below asks whether it is still there.
    await admin.query(
      `INSERT INTO public."session" (id, "userId", token, "expiresAt", "createdAt", "updatedAt", "activeOrganizationId")
       VALUES ($1, $2, $3, now() + interval '1 day', now(), now(), $4) ON CONFLICT (id) DO NOTHING`,
      [SESSION_ID, PERSON_ID, `tok-${SESSION_ID}`, ORG_ID],
    );
    writeConnectorConfigToDatabase("wordpress", {
      instances: [{ id: INSTANCE_ID, siteUrl: SITE_ORIGIN, name: "x3051r" }],
    });
    const secret = randomBytes(24).toString("base64url");
    const siteRow = upsertConnectSiteCredential({
      candidateSiteId: randomUUID(),
      client: "wordpress",
      widgetOrigin: SITE_ORIGIN,
      callbackOrigin: null,
      credentialSecret: secret,
      webhookSecretHash: null,
      adminUserId: PERSON_ID,
      orgId: ORG_ID,
    });
    verifiedSite = resolveVerifiedSiteFromCredential({
      credential: `cnx_${siteRow.siteId}_${secret}`,
      requestOrigin: SITE_ORIGIN,
      expectedClient: "wordpress",
    });
    expect(verifiedSite, "the shipped credential verifier refused the seeded site").not.toBeNull();
  }, 300_000);

  afterAll(async () => {
    if (!admin) return;
    await admin.query(`DELETE FROM public."session" WHERE id = $1`, [SESSION_ID]);
    await admin.query(`DELETE FROM public."member" WHERE id = $1`, ["mem-x3051r"]);
    await admin.query(`DELETE FROM public."user" WHERE id = $1`, [PERSON_ID]);
    await admin.query(`DELETE FROM public."organization" WHERE id = $1`, [ORG_ID]);
    await admin.end();
  }, 120_000);

  it("renews a live bearer, and the successor is the one that works from then on", async () => {
    const { token } = signIn();
    expect(consume(token).ok).toBe(true);

    const renewed = renewUserWidgetToken({
      token,
      agentSlug: AGENT_SLUG,
      requestOrigin: SITE_ORIGIN,
    });
    expect(renewed.ok).toBe(true);
    if (!renewed.ok) return;

    // The successor turns.
    expect(consume(renewed.token).ok).toBe(true);
    // THE PREDECESSOR STOPS WORKING, immediately and not at the end of its own
    // life: one open column, exactly one live bearer, however long the page
    // stays open.
    const after = consume(token);
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.reason).toBe("not_found");
    expect(await readRow(token)).toBeNull();
  }, 120_000);

  it("carries EXACTLY the claims the sign-in wrote — column for column, the name excepted", async () => {
    const { token, scope } = signIn();
    const before = await readRow(token);
    expect(before).not.toBeNull();

    const renewed = renewUserWidgetToken({
      token,
      agentSlug: AGENT_SLUG,
      requestOrigin: SITE_ORIGIN,
    });
    expect(renewed.ok).toBe(true);
    if (!renewed.ok) return;
    const after = await readRow(renewed.token);
    expect(after).not.toBeNull();

    // Every claim column, compared as stored. A renewal that re-DERIVED any of
    // these would be making a decision the sign-in already made — which is the
    // one way a renewal could end up wider than the grant behind it.
    for (const column of [
      "user_id",
      "site_id",
      "client",
      "org_id",
      "site_origin",
      "agent_slug",
      "instance_id",
      "credential_version",
      "aud",
      "iss",
      "scope",
      "auth_session_id",
    ]) {
      expect(after?.[column], `the renewal changed ${column}`).toEqual(before?.[column]);
    }
    // The scope column is the string the SIGN-IN wrote, byte for byte.
    expect(after?.scope).toBe(scope);
    // What must differ: the credential's own name and its hash. A jti that
    // travelled would make two credentials one credential.
    expect(after?.jti).not.toEqual(before?.jti);
    expect(after?.token_hash).not.toEqual(before?.token_hash);
  }, 120_000);

  it("REFUSES when the sign-in behind it is gone — and destroys nothing on the way out", async () => {
    const { token } = signIn();
    /** How many bearers this session holds right now. Taken as a BEFORE reading
     *  rather than asserted as a number: earlier arms in this file left their
     *  own rows behind, and what has to be true here is that the refusal changed
     *  the count by nothing at all. */
    const bearersHeld = async (): Promise<number> => {
      const { rows } = await admin.query(
        `SELECT count(*)::int AS n FROM "${q(TEST_SCHEMA)}"."widget_user_tokens" WHERE auth_session_id = $1`,
        [SESSION_ID],
      );
      return (rows[0] as { n: number }).n;
    };
    const before = await bearersHeld();
    // The person signed out (or an administrator revoked the session). The
    // widget bearer is unexpired and otherwise perfect.
    await admin.query(`DELETE FROM public."session" WHERE id = $1`, [SESSION_ID]);
    try {
      const renewed = renewUserWidgetToken({
        token,
        agentSlug: AGENT_SLUG,
        requestOrigin: SITE_ORIGIN,
      });
      expect(renewed.ok).toBe(false);
      if (!renewed.ok) expect(renewed.reason).toBe("session_revoked");
      // THE ROW IS STILL THERE. Reaping belongs to the consume path; a renewal
      // that said no must not also be a thing that deletes rows, or a two-second
      // outage becomes a forced re-login for everyone.
      expect(await readRow(token)).not.toBeNull();
      // And no successor was written either: a refused renewal writes nothing,
      // deletes nothing, and leaves the column exactly where it found it.
      expect(await bearersHeld()).toBe(before);
    } finally {
      await admin.query(
        `INSERT INTO public."session" (id, "userId", token, "expiresAt", "createdAt", "updatedAt", "activeOrganizationId")
         VALUES ($1, $2, $3, now() + interval '1 day', now(), now(), $4) ON CONFLICT (id) DO NOTHING`,
        [SESSION_ID, PERSON_ID, `tok-${SESSION_ID}`, ORG_ID],
      );
      await admin.query(
        `DELETE FROM "${q(TEST_SCHEMA)}"."widget_user_tokens" WHERE token_hash = $1`,
        [tokenHash(token)],
      );
    }
  }, 120_000);

  it("one predecessor makes ONE successor — a bearer already spent renews nothing more (convergence finding 3)", async () => {
    const { token } = signIn();
    const held = async (): Promise<number> => {
      const { rows } = await admin.query(
        `SELECT count(*)::int AS n FROM "${q(TEST_SCHEMA)}"."widget_user_tokens" WHERE auth_session_id = $1`,
        [SESSION_ID],
      );
      return (rows[0] as { n: number }).n;
    };
    const before = await held();

    const first = renewUserWidgetToken({ token, agentSlug: AGENT_SLUG, requestOrigin: SITE_ORIGIN });
    expect(first.ok).toBe(true);
    // The SAME bearer presented a second time. In production the two arrive at
    // once — two frames, a retried request, a double-armed timer — and the
    // rotation is one statement whose insert is fed by its own delete precisely
    // so that only one of them can ever claim it. Presented after the fact, as
    // here, the claim is simply gone.
    const second = renewUserWidgetToken({ token, agentSlug: AGENT_SLUG, requestOrigin: SITE_ORIGIN });
    expect(second.ok).toBe(false);

    // THE COUNT DID NOT MOVE. The rotation is one for one — the successor took
    // the predecessor's place — and the presentation that lost wrote no orphan
    // successor beside it. A read-then-write rotation would have left two.
    expect(await held()).toBe(before);
    if (first.ok) {
      expect(consume(first.token).ok).toBe(true);
      await admin.query(
        `DELETE FROM "${q(TEST_SCHEMA)}"."widget_user_tokens" WHERE token_hash = $1`,
        [tokenHash(first.token)],
      );
    }
  }, 120_000);

  it("renews NOTHING from a bearer that has already expired", async () => {
    const { token } = signIn();
    await admin.query(
      `UPDATE "${q(TEST_SCHEMA)}"."widget_user_tokens" SET expires_at = now() - interval '1 minute' WHERE token_hash = $1`,
      [tokenHash(token)],
    );
    const renewed = renewUserWidgetToken({
      token,
      agentSlug: AGENT_SLUG,
      requestOrigin: SITE_ORIGIN,
    });
    expect(renewed.ok).toBe(false);
    if (!renewed.ok) expect(renewed.reason).toBe("expired");
    // A dead credential is not a renewable one: re-signing in is the only road
    // back, which is the property that keeps the chain bounded by the sign-in.
    await admin.query(
      `DELETE FROM "${q(TEST_SCHEMA)}"."widget_user_tokens" WHERE token_hash = $1`,
      [tokenHash(token)],
    );
  }, 120_000);

  it("REFUSES another agent or another origin, and the bearer is untouched by the refusal", async () => {
    const { token } = signIn();

    const wrongAgent = renewUserWidgetToken({
      token,
      agentSlug: "drupal",
      requestOrigin: SITE_ORIGIN,
    });
    expect(wrongAgent.ok).toBe(false);
    if (!wrongAgent.ok) expect(wrongAgent.reason).toBe("agent_mismatch");

    const wrongOrigin = renewUserWidgetToken({
      token,
      agentSlug: AGENT_SLUG,
      requestOrigin: "https://somebody-elses-site.example.test",
    });
    expect(wrongOrigin.ok).toBe(false);
    if (!wrongOrigin.ok) expect(wrongOrigin.reason).toBe("origin_mismatch");

    // Neither refusal consumed, rotated or reaped anything — the person's column
    // is still working after somebody else asked the wrong question about it.
    expect(await readRow(token)).not.toBeNull();
    expect(consume(token).ok).toBe(true);
  }, 120_000);
});
