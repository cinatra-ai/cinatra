import { NextResponse } from "next/server";

import {
  CONNECT_SCOPE,
  exchangeAuthorizationCode,
  exchangeInstallCode,
  sha256Base64Url,
} from "@/lib/connect-provisioning";
import { generateWidgetAuthConfig, readWidgetAuthConfig } from "@/lib/wordpress-widget-auth";
import { allowConnectTokenRequest } from "@/lib/connect-rate-limit";
import { emitConnectAudit } from "@/lib/connect-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// cinatra#221 — POST /api/connect/token
//
// Server-to-server token/exchange endpoint. The CMS BACKEND (never the browser)
// redeems either an authorization_code (redirect path, with PKCE) or an
// install_code (fallback path) and receives the per-site `cnx_` credential
// exactly once. No session, no cookies — auth IS the code/PKCE/install-code
// itself, enforced inside this handler (the route is PUBLIC_PATH_PREFIXES-
// exempted in auth-route-guard, mirroring /api/webhooks/wordpress).
//
// SECURITY POSTURE:
//   - All failures return a GENERIC `400 {"error":"invalid_grant"}` — no oracle
//     leaks which check failed (codex).
//   - Single-use is enforced by the atomic UPDATE...RETURNING consume inside
//     exchange*Code; a replayed code returns invalid_grant.
//   - Rate-limited per IP and per code-hash (install-code brute-force defense).
//   - Secrets (code, code_verifier, credential, install_code, webhookSecret)
//     are NEVER logged.
// ---------------------------------------------------------------------------

const INVALID_GRANT = { error: "invalid_grant" } as const;

function genericInvalidGrant(): NextResponse {
  return NextResponse.json(INVALID_GRANT, { status: 400 });
}

function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]?.trim() || "unknown";
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

// The webhook secret returned to the CMS. For v1 we reuse the existing
// per-connector SHARED webhookSecret (the /api/webhooks/wordpress receiver
// still validates the shared secret); generateWidgetAuthConfig lazily ensures
// it exists. KNOWN v1 TRADEOFF (codex adversarial Medium, accepted per spec
// §2.4): every connected site receives the same webhookSecret, so the webhook
// receiver authenticates "a connected site" but not WHICH site. The
// security-critical value — the long-lived per-site CREDENTIAL — IS per-site,
// hashed, and individually revocable. Per-site webhook secrets + per-site
// receiver verification are tracked as follow-up; the connect-site row already
// carries a webhook_secret_hash column so the migration is non-breaking. The WP
// publish webhook receiver currently only logs events (no state mutation).
function resolveWebhookSecret(): string {
  const existing = readWidgetAuthConfig();
  if (existing?.webhookSecret) return existing.webhookSecret;
  return generateWidgetAuthConfig().webhookSecret;
}

// #220 token-broker availability. The broker is not part of this issue; until
// it lands the capability is reported false so the CMS falls back to the legacy
// direct-stream path. A future #220 change flips this via a real capability
// probe — wired here without touching the rest of the handler.
function tokenBrokerAvailable(): boolean {
  return process.env.CINATRA_TOKEN_BROKER_ENABLED === "true";
}

export async function POST(request: Request): Promise<Response> {
  const ip = clientIp(request);
  const ua = request.headers.get("user-agent");

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object") return genericInvalidGrant();
    body = parsed as Record<string, unknown>;
  } catch {
    return genericInvalidGrant();
  }

  const grantType = typeof body.grant_type === "string" ? body.grant_type : "";

  if (grantType === "authorization_code") {
    const code = typeof body.code === "string" ? body.code : "";
    const client = typeof body.client === "string" ? body.client : "";
    const redirectUri = typeof body.redirect_uri === "string" ? body.redirect_uri : "";
    const codeVerifier = typeof body.code_verifier === "string" ? body.code_verifier : "";

    // Rate limit BEFORE the DB consume. Key the code bucket on the hash so the
    // limiter never holds a plaintext code.
    const codeKey = code ? sha256Base64Url(code) : "no-code";
    if (!allowConnectTokenRequest({ ip, codeKey })) {
      emitConnectAudit("exchange_failure", { ip, ua, client, reason: "rate_limited" });
      return NextResponse.json(INVALID_GRANT, { status: 429 });
    }

    let result;
    try {
      result = await exchangeAuthorizationCode({
        code,
        client,
        redirectUri,
        codeVerifier,
        webhookSecret: resolveWebhookSecret(),
        tokenBrokerAvailable: tokenBrokerAvailable(),
      });
    } catch (err) {
      console.error("[connect/token] authorization_code exchange threw:", err instanceof Error ? err.message : err);
      emitConnectAudit("exchange_failure", { ip, ua, client, reason: "internal_error" });
      // Generic — never reveal internal detail.
      return genericInvalidGrant();
    }
    if (!result.ok) {
      emitConnectAudit("exchange_failure", { ip, ua, client, codeHash: codeKey, reason: "invalid_grant" });
      return genericInvalidGrant();
    }
    emitConnectAudit("exchange_success", {
      ip,
      ua,
      client,
      siteId: result.response.siteId,
      credentialVersion: result.response.credentialVersion,
    });
    emitConnectAudit(result.response.credentialVersion > 1 ? "site_rotated" : "site_created", {
      ip,
      ua,
      client,
      siteId: result.response.siteId,
      credentialVersion: result.response.credentialVersion,
    });
    return NextResponse.json(result.response, { status: 200 });
  }

  if (grantType === "install_code") {
    const installCode = typeof body.install_code === "string" ? body.install_code : "";
    const client = typeof body.client === "string" ? body.client : "";

    const codeKey = installCode ? sha256Base64Url(installCode) : "no-code";
    if (!allowConnectTokenRequest({ ip, codeKey })) {
      emitConnectAudit("exchange_failure", { ip, ua, client, reason: "rate_limited" });
      return NextResponse.json(INVALID_GRANT, { status: 429 });
    }

    let result;
    try {
      result = await exchangeInstallCode({
        installCode,
        client,
        webhookSecret: resolveWebhookSecret(),
        tokenBrokerAvailable: tokenBrokerAvailable(),
      });
    } catch (err) {
      console.error("[connect/token] install_code exchange threw:", err instanceof Error ? err.message : err);
      emitConnectAudit("exchange_failure", { ip, ua, client, reason: "internal_error" });
      return genericInvalidGrant();
    }
    if (!result.ok) {
      emitConnectAudit("exchange_failure", { ip, ua, client, codeHash: codeKey, reason: "invalid_grant" });
      return genericInvalidGrant();
    }
    emitConnectAudit("exchange_success", {
      ip,
      ua,
      client,
      siteId: result.response.siteId,
      credentialVersion: result.response.credentialVersion,
    });
    emitConnectAudit(result.response.credentialVersion > 1 ? "site_rotated" : "site_created", {
      ip,
      ua,
      client,
      siteId: result.response.siteId,
      credentialVersion: result.response.credentialVersion,
    });
    return NextResponse.json(result.response, { status: 200 });
  }

  // Unknown / missing grant_type — generic.
  void CONNECT_SCOPE; // scope is enforced at issuance time; referenced for parity.
  return genericInvalidGrant();
}
