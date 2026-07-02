import { NextResponse } from "next/server";

import { resolveWidgetStreamAgent } from "@/lib/widget-stream-agents.server";
import {
  createAuthTransaction,
  resolveVerifiedSiteFromCredential,
} from "@/lib/widget-user-auth";
import { allowConnectTokenRequest } from "@/lib/connect-rate-limit";
import { emitWidgetAuthAudit } from "@/lib/widget-auth-audit";
import { sha256Base64Url } from "@/lib/connect-provisioning";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// cinatra#407 — POST /api/widget-auth/init
//
// SITE-TOKEN-AUTHENTICATED transaction init for the hosted /widget-auth PKCE
// login. The CMS BACKEND (broker), holding the per-site `cnx_` credential,
// calls this server-to-server to START an auth transaction. It PINS the
// server-verified context {siteId, orgId, siteOrigin, client, agentSlug,
// canonical instanceId} + the widget's PKCE code_challenge + single-use state,
// so the hosted page can never be driven by a query string alone (the
// transaction is the verified context, NOT the URL).
//
// Returns { txnId, authorizeUrl } — the broker hands the authorizeUrl to its
// own browser widget, which opens it as a popup. The `cnx_` NEVER reaches the
// browser (server-to-server only, exactly like /api/connect/token). No CORS
// headers: the browser never calls this directly.
//
// Path is on the middleware public-path allowlist so the session redirect is
// suppressed; self-authentication (the `cnx_` credential) runs INSIDE here.
// ---------------------------------------------------------------------------

type InitBody = {
  client?: unknown;
  agentSlug?: unknown;
  codeChallenge?: unknown;
  codeChallengeMethod?: unknown;
  state?: unknown;
  instanceId?: unknown;
};

function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]?.trim() || "unknown";
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

const GENERIC_400 = { error: "invalid_request" } as const;

export async function POST(request: Request): Promise<Response> {
  const ip = clientIp(request);
  const ua = request.headers.get("user-agent");
  const requestOrigin = request.headers.get("Origin");

  // 1. Auth FIRST (before body parse): the `cnx_` site credential. A missing /
  // malformed bearer never reaches the JSON parser.
  const authHeader = request.headers.get("Authorization");
  const credential = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!credential) {
    emitWidgetAuthAudit("init_failure", { ip, ua, reason: "missing_credential" });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Rate limit per IP and per credential-hash (never the plaintext credential).
  if (!allowConnectTokenRequest({ ip, codeKey: sha256Base64Url(credential) })) {
    emitWidgetAuthAudit("init_failure", { ip, ua, reason: "rate_limited" });
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  let body: InitBody;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object") {
      return NextResponse.json(GENERIC_400, { status: 400 });
    }
    body = parsed as InitBody;
  } catch {
    return NextResponse.json(GENERIC_400, { status: 400 });
  }

  const client = typeof body.client === "string" ? body.client : "";
  const agentSlug = typeof body.agentSlug === "string" ? body.agentSlug : "";
  const codeChallenge = typeof body.codeChallenge === "string" ? body.codeChallenge : "";
  const codeChallengeMethod =
    typeof body.codeChallengeMethod === "string" ? body.codeChallengeMethod : "S256";
  const state = typeof body.state === "string" ? body.state : "";
  const claimedInstanceId = typeof body.instanceId === "string" ? body.instanceId : null;

  // Only S256 (no plain). Reject anything else up front.
  if (codeChallengeMethod !== "S256") {
    emitWidgetAuthAudit("init_failure", { ip, ua, client, reason: "bad_challenge_method" });
    return NextResponse.json(GENERIC_400, { status: 400 });
  }

  // 2. Resolve the agent entry (404 if unknown) and verify the requested client
  // matches the agent's instancesConfigKey (a WordPress agent slug must carry
  // client "wordpress", etc.).
  const entry = resolveWidgetStreamAgent(agentSlug);
  if (!entry) {
    emitWidgetAuthAudit("init_failure", { ip, ua, client, agentSlug, reason: "unknown_agent" });
    return NextResponse.json({ error: "Unknown agent" }, { status: 404 });
  }
  const expectedClient = entry.auth.instancesConfigKey;
  if (!client || client !== expectedClient) {
    emitWidgetAuthAudit("init_failure", { ip, ua, client, agentSlug, reason: "client_mismatch" });
    return NextResponse.json(GENERIC_400, { status: 400 });
  }

  // 3. Validate the `cnx_` credential (paired Origin, expected client) and
  // resolve the fully-bound, verified site context. Generic 401 on any failure
  // (no oracle).
  const site = resolveVerifiedSiteFromCredential({
    credential,
    requestOrigin,
    expectedClient,
  });
  if (!site) {
    emitWidgetAuthAudit("init_failure", { ip, ua, client, agentSlug, reason: "invalid_credential" });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 4. Create the transaction: validate PKCE challenge + state, SERVER-DERIVE
  // the canonical instanceId from the verified origin (strict — zero/multiple
  // origin-matched rows → deny).
  const created = createAuthTransaction({
    site,
    agentSlug,
    instancesConfigKey: entry.auth.instancesConfigKey,
    codeChallenge,
    state,
    claimedInstanceId,
  });
  if (!created.ok) {
    emitWidgetAuthAudit("init_failure", {
      ip,
      ua,
      client,
      agentSlug,
      siteId: site.siteId,
      orgId: site.orgId,
      siteOrigin: site.siteOrigin,
      reason: created.reason,
    });
    // instance_unresolved is a 409 (the site is connected but has no single
    // canonical instance bound to this origin); the others are 400.
    const status = created.reason === "instance_unresolved" ? 409 : 400;
    return NextResponse.json({ error: created.reason }, { status });
  }

  // 5. Build the hosted authorize URL on THIS instance's origin.
  const issuerOrigin = new URL(request.url).origin;
  const authorizeUrl = `${issuerOrigin}/widget-auth?txn=${encodeURIComponent(created.txnId)}`;

  emitWidgetAuthAudit("init_success", {
    ip,
    ua,
    client,
    agentSlug,
    siteId: site.siteId,
    orgId: site.orgId,
    siteOrigin: site.siteOrigin,
    instanceId: created.instanceId,
  });

  return NextResponse.json(
    {
      txnId: created.txnId,
      authorizeUrl,
      // Echo the server-derived canonical instance so the broker can sanity-check
      // (it is NOT authoritative client-side — the transaction holds the truth).
      instanceId: created.instanceId,
    },
    { status: 200 },
  );
}
