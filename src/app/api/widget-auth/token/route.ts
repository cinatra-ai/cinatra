import { NextResponse } from "next/server";

import { resolveWidgetStreamAgent } from "@/lib/widget-stream-agents.server";
import {
  redeemUserAuthCode,
  resolveVerifiedSiteFromCredential,
} from "@/lib/widget-user-auth";
import { allowConnectTokenRequest } from "@/lib/connect-rate-limit";
import { emitWidgetAuthAudit } from "@/lib/widget-auth-audit";
import { sha256Base64Url } from "@/lib/connect-provisioning";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// cinatra#407 — POST /api/widget-auth/token
//
// SITE-TOKEN-AUTHENTICATED redeem of a user authorization code for a SHORT-LIVED
// OPAQUE user widget token (`cwu_`). The CMS BACKEND (broker) calls this
// server-to-server: it presents the per-site `cnx_` credential (Authorization),
// the auth code (postMessage'd from the hosted page to the widget, relayed to
// its backend), and the PKCE code_verifier.
//
// The opaque token is delivered through the TRUSTED backend, never minted by a
// browser holding the `cnx_`. The redeem CROSS-CHECKS that the code was minted
// for the SAME site as the presenting credential (a code minted for site A
// cannot be redeemed through site B's `cnx_`). Generic `invalid_grant` on any
// failure — no oracle. No CORS headers (server-to-server only). Mirrors the
// /api/connect/token redeem posture.
//
// Path is on the middleware public-path allowlist so the session redirect is
// suppressed; self-authentication (the `cnx_` credential) runs INSIDE here.
// ---------------------------------------------------------------------------

type TokenBody = {
  grantType?: unknown;
  client?: unknown;
  agentSlug?: unknown;
  code?: unknown;
  codeVerifier?: unknown;
};

const INVALID_GRANT = { error: "invalid_grant" } as const;

function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]?.trim() || "unknown";
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

export async function POST(request: Request): Promise<Response> {
  const ip = clientIp(request);
  const ua = request.headers.get("user-agent");
  const requestOrigin = request.headers.get("Origin");

  // 1. Auth FIRST: the `cnx_` site credential.
  const authHeader = request.headers.get("Authorization");
  const credential = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!credential) {
    emitWidgetAuthAudit("redeem_failure", { ip, ua, reason: "missing_credential" });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: TokenBody;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object") {
      return NextResponse.json(INVALID_GRANT, { status: 400 });
    }
    body = parsed as TokenBody;
  } catch {
    return NextResponse.json(INVALID_GRANT, { status: 400 });
  }

  const grantType = typeof body.grantType === "string" ? body.grantType : "";
  const client = typeof body.client === "string" ? body.client : "";
  const agentSlug = typeof body.agentSlug === "string" ? body.agentSlug : "";
  const code = typeof body.code === "string" ? body.code : "";
  const codeVerifier = typeof body.codeVerifier === "string" ? body.codeVerifier : "";

  if (grantType !== "authorization_code") {
    return NextResponse.json(INVALID_GRANT, { status: 400 });
  }

  // Rate limit per IP and per code-hash (never the plaintext code).
  const codeKey = code ? sha256Base64Url(code) : "no-code";
  if (!allowConnectTokenRequest({ ip, codeKey })) {
    emitWidgetAuthAudit("redeem_failure", { ip, ua, client, reason: "rate_limited" });
    return NextResponse.json(INVALID_GRANT, { status: 429 });
  }

  // 2. Resolve agent + verify the client matches the agent's client.
  const entry = resolveWidgetStreamAgent(agentSlug);
  if (!entry) {
    emitWidgetAuthAudit("redeem_failure", { ip, ua, client, agentSlug, reason: "unknown_agent" });
    return NextResponse.json({ error: "Unknown agent" }, { status: 404 });
  }
  const expectedClient = entry.auth.instancesConfigKey;
  if (!client || client !== expectedClient) {
    emitWidgetAuthAudit("redeem_failure", { ip, ua, client, agentSlug, reason: "client_mismatch" });
    return NextResponse.json(INVALID_GRANT, { status: 400 });
  }

  // 3. Validate the `cnx_` credential and resolve the verified site context.
  const site = resolveVerifiedSiteFromCredential({
    credential,
    requestOrigin,
    expectedClient,
  });
  if (!site) {
    emitWidgetAuthAudit("redeem_failure", { ip, ua, client, agentSlug, reason: "invalid_credential" });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 4. Redeem: atomic single-use consume + PKCE verify + cross-site binding
  // check + mint the opaque user token. Generic invalid_grant on any failure.
  const issuerBaseUrl = new URL(request.url).origin;
  const redeemed = redeemUserAuthCode({ code, codeVerifier, site, issuerBaseUrl });
  if (!redeemed.ok) {
    emitWidgetAuthAudit("redeem_failure", {
      ip,
      ua,
      client,
      agentSlug,
      siteId: site.siteId,
      orgId: site.orgId,
      reason: redeemed.reason,
    });
    return NextResponse.json(INVALID_GRANT, { status: 400 });
  }

  emitWidgetAuthAudit("redeem_success", {
    ip,
    ua,
    client,
    agentSlug,
    siteId: site.siteId,
    orgId: site.orgId,
    siteOrigin: site.siteOrigin,
  });

  return NextResponse.json(
    {
      token: redeemed.token,
      tokenType: redeemed.tokenType,
      expiresIn: redeemed.expiresIn,
      scope: redeemed.scope,
    },
    { status: 200 },
  );
}
