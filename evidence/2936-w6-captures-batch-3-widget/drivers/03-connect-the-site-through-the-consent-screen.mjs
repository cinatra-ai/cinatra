// THE CONNECT-SITE, MINTED THROUGH THE PRODUCT'S OWN CONSENT CEREMONY.
//
// Nothing here writes a site or a credential by hand. The round drives the
// shipped screen `/connect/authorize` in a real browser as the signed-in
// organization admin, presses the screen's own **Approve**, and lets the app
// redirect the authorization code to the site's OWN backend callback — the path
// the shipped contract names for this client. The code is then redeemed
// server-to-server at the shipped `POST /api/connect/token`, exactly as a CMS
// backend redeems it, and the site is read back from the app's own tables.
//
// The PKCE verifier is minted in this process and never leaves it except as its
// S256 challenge on the authorize URL and as the verifier on the token POST,
// which is the whole point of the ceremony. The `cnx_` credential the exchange
// returns is NEVER printed, logged or written down: only its shape is reported.
import { chromium } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Client } from "pg";

const APP = process.env.APP_ORIGIN;
const EMAIL = process.env.LANE_ACCOUNT;
const PASSWORD = process.env.LANE_SECRET;
const WIDGET_ORIGIN = process.env.WIDGET_ORIGIN;
const CALLBACK_FILE = process.env.HOST_CALLBACK_OUT;
const OUT = process.env.OUT_JSON;
const DB = process.env.SUPABASE_DB_URL;
for (const [n, v] of Object.entries({ APP_ORIGIN: APP, LANE_ACCOUNT: EMAIL, LANE_SECRET: PASSWORD, WIDGET_ORIGIN, HOST_CALLBACK_OUT: CALLBACK_FILE, OUT_JSON: OUT, SUPABASE_DB_URL: DB }))
  if (!v) throw new Error(`the connect driver needs ${n}`);

const b64url = (buf) => buf.toString("base64url");
const verifier = b64url(randomBytes(48));
const challenge = b64url(createHash("sha256").update(verifier).digest());
const state = b64url(randomBytes(16));
const redirectUri = `${WIDGET_ORIGIN}/wp-admin/admin-post.php?action=cinatra_connect_callback`;
const authorizeUrl =
  `${APP}/connect/authorize?client=wordpress` +
  `&redirect_uri=${encodeURIComponent(redirectUri)}` +
  `&widget_origin=${encodeURIComponent(WIDGET_ORIGIN)}` +
  `&state=${encodeURIComponent(state)}` +
  `&scope=${encodeURIComponent("connector:provision")}` +
  `&code_challenge=${encodeURIComponent(challenge)}` +
  `&code_challenge_method=S256`;

const out = { steps: [] };
const say = (m, extra) => { console.log(m); out.steps.push({ at: new Date().toISOString(), m, ...(extra ?? {}) }); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.setDefaultTimeout(240_000);
page.setDefaultNavigationTimeout(240_000);
try {
  const si = await page.request.post(`${APP}/api/auth/sign-in/email`, { headers: { Origin: APP }, data: { email: EMAIL, password: PASSWORD } });
  say(`signed in: ${si.status()}`);

  await page.goto(authorizeUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  const heading = await page.locator("h1, [data-slot='card-title']").first().innerText().catch(() => "");
  const shown = await page.evaluate(() => (document.body.innerText ?? "").replace(/\s+/g, " ").slice(0, 600));
  say(`the consent screen rendered: ${JSON.stringify(heading)}`, { screenText: shown });

  const approve = page.getByRole("button", { name: /^Approve$/ }).first();
  const approveCount = await approve.count();
  say(`the screen's own Approve control: ${approveCount}`);
  if (approveCount === 0) throw new Error("the consent screen drew no Approve control");
  await approve.click();
  await page.waitForTimeout(6000);
  say(`after Approve the browser is on ${new URL(page.url()).origin}${new URL(page.url()).pathname}`);

  const received = JSON.parse(readFileSync(CALLBACK_FILE, "utf8"));
  const code = received?.query?.code ?? "";
  const stateBack = received?.query?.state ?? "";
  say(`the site's own backend received the redirect`, {
    callbackKeys: Object.keys(received?.query ?? {}),
    stateEchoed: stateBack === state,
    codePresent: code.length > 0,
  });
  if (!code) throw new Error("no authorization code reached the site's callback");

  const tokenRes = await fetch(`${APP}/api/connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "authorization_code", code, client: "wordpress", redirect_uri: redirectUri, code_verifier: verifier }),
  });
  const tokenBody = await tokenRes.json().catch(() => null);
  const credential = typeof tokenBody?.credential === "string" ? tokenBody.credential : "";
  say(`the shipped token endpoint answered ${tokenRes.status}`, {
    tokenStatus: tokenRes.status,
    bodyKeys: tokenBody ? Object.keys(tokenBody) : [],
    credentialShape: credential ? `${credential.slice(0, 4)}… (${credential.length} chars)` : "absent",
    siteId: tokenBody?.site_id ?? tokenBody?.siteId ?? null,
  });

  const c = new Client({ connectionString: DB });
  await c.connect();
  const sites = (await c.query(`select site_id, client, widget_origin, org_id, credential_version, revoked_at from cinatra.connect_sites`)).rows;
  await c.end();
  say(`connect_sites rows: ${sites.length}`, { sites });
  out.ok = sites.length === 1 && !sites[0].revoked_at;
} catch (e) {
  out.error = String(e?.message ?? e).slice(0, 400);
  say(`ERROR ${out.error}`);
} finally {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
  await browser.close();
}
