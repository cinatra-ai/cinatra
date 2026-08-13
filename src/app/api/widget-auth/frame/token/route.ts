import { NextResponse } from "next/server";

import { resolveWidgetStreamAgentUnion } from "@/lib/widget-stream-agents.server";
import { redeemUserAuthCode } from "@/lib/widget-user-auth";
import { deriveFrameBinding, isSameOriginFrameRequest } from "@/lib/widget-frame-auth";
import { mintWidgetStreamToken } from "@/lib/widget-token-broker";
import { allowConnectTokenRequest } from "@/lib/connect-rate-limit";
import { emitWidgetAuthAudit } from "@/lib/widget-auth-audit";
import { sha256Base64Url } from "@/lib/connect-provisioning";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// cinatra#2674 (epic #2564 S8e) — POST /api/widget-auth/frame/token
//
// THE FRAME REDEEMS ITS OWN CODE, AND THE CREDENTIAL STOPS HERE. This replaces
// the retired `/api/widget-auth/token`, whose entire purpose was to hand the
// user's bearer to a CMS backend. The caller is the Cinatra embed iframe, calling
// SAME-ORIGIN with the authorization code its own popup returned and the PKCE
// verifier it has held in frame memory since init. The response goes to a
// Cinatra-origin document and to nothing else: there are NO CORS headers on this
// route, so a cross-site page could not read the answer even if it managed to
// send the request.
//
// THE PAIR IS MINTED HERE, NOT COMPOSED BY A PARENT. Protocol 1 had the site's
// backend obtain a `cwu_` and a `cit_` and had the parent page compose them into
// a postMessage. Both now originate on this response: the `cwu_` from the
// authorization code (PKCE-verified, single-use), and the `cit_` site transport
// token minted for the SAME server-derived site — bound to its id and credential
// generation, so a reconnect or revoke kills it exactly as before. Neither one
// ever exists in a parent-origin document.
//
// NO CREDENTIAL AUTHENTICATES THIS CALL, AND NONE SHOULD. The authority is the
// authorization code: it is single-use, PKCE-bound, minted only for a person who
// signed in to Cinatra, and delivered only to a Cinatra-origin opener. The
// server-side re-derivation then proves the site the code is bound to is the site
// this frame is actually embedded on — a code cannot be redeemed through a
// binding it was not minted for.
// ---------------------------------------------------------------------------

type TokenBody = {
  grantType?: unknown;
  assistant?: unknown;
  instanceId?: unknown;
  siteId?: unknown;
  origin?: unknown;
  code?: unknown;
  codeVerifier?: unknown;
};

const INVALID_GRANT = { error: "invalid_grant" } as const;

function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]?.trim() || "unknown";
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export async function POST(request: Request): Promise<Response> {
  const ip = clientIp(request);
  const ua = request.headers.get("user-agent");

  if (!isSameOriginFrameRequest(request)) {
    emitWidgetAuthAudit("redeem_failure", { ip, ua, reason: "not_same_origin" });
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

  const grantType = str(body.grantType);
  const assistant = str(body.assistant);
  const instanceId = str(body.instanceId);
  const code = str(body.code);
  const codeVerifier = str(body.codeVerifier);

  if (grantType !== "authorization_code") {
    return NextResponse.json(INVALID_GRANT, { status: 400 });
  }

  // Rate limit per IP and per code-hash (never the plaintext code).
  const codeKey = code ? sha256Base64Url(code) : "no-code";
  if (!allowConnectTokenRequest({ ip, codeKey })) {
    emitWidgetAuthAudit("redeem_failure", { ip, ua, client: assistant, reason: "rate_limited" });
    return NextResponse.json(INVALID_GRANT, { status: 429 });
  }

  // RE-DERIVE the binding — agent included (codex round 0, finding 1: the agent is
  // never a request field) — from the same public selectors init used. The redeem
  // below then cross-checks the code's own bound {siteId, orgId, origin, client}
  // against it, which is the "a code minted for site A cannot be redeemed under
  // site B's binding" gate — carried over verbatim from the `cnx_` path, with the
  // server's own derivation standing where the site credential used to.
  const derived = deriveFrameBinding({
    assistant,
    instanceId,
    claimedSiteId: str(body.siteId) || null,
    claimedOrigin: str(body.origin) || null,
  });
  if (!derived.ok) {
    emitWidgetAuthAudit("redeem_failure", {
      ip,
      ua,
      client: assistant,
      reason: derived.reason,
    });
    return NextResponse.json(INVALID_GRANT, { status: 400 });
  }
  const { site, agentSlug } = derived.binding;

  const resolved = await resolveWidgetStreamAgentUnion(agentSlug);
  const entry = resolved?.entry ?? null;
  if (!entry || entry.auth.instancesConfigKey !== derived.binding.instancesConfigKey) {
    emitWidgetAuthAudit("redeem_failure", { ip, ua, client: assistant, agentSlug, reason: "unknown_agent" });
    return NextResponse.json(INVALID_GRANT, { status: 400 });
  }

  const issuerBaseUrl = new URL(request.url).origin;
  const redeemed = redeemUserAuthCode({ code, codeVerifier, site, issuerBaseUrl });
  if (!redeemed.ok) {
    emitWidgetAuthAudit("redeem_failure", {
      ip,
      ua,
      client: assistant,
      agentSlug,
      siteId: site.siteId,
      orgId: site.orgId,
      reason: redeemed.reason,
    });
    return NextResponse.json(INVALID_GRANT, { status: 400 });
  }

  // The SITE TRANSPORT token, minted for the same derived site. It is bound to
  // {siteId, credentialVersion}, so revoking or reconnecting the site kills it
  // immediately — the same binding the `cnx_` broker path produced.
  const transport = mintWidgetStreamToken({
    agentSlug,
    auth: entry.auth,
    origin: site.siteOrigin,
    issuerBaseUrl,
    connectSite: { siteId: site.siteId, credentialVersion: site.credentialVersion },
  });
  if (!transport) {
    // A user token without its transport pair is useless to the frame and must
    // not be handed out on its own — an unusable half-credential in a browser is
    // still a credential. Fail the whole redeem; the code is already consumed, so
    // the frame starts a fresh sign-in, which is the honest outcome.
    emitWidgetAuthAudit("redeem_failure", {
      ip,
      ua,
      client: assistant,
      agentSlug,
      siteId: site.siteId,
      orgId: site.orgId,
      reason: "transport_mint_failed",
    });
    return NextResponse.json(INVALID_GRANT, { status: 400 });
  }

  emitWidgetAuthAudit("redeem_success", {
    ip,
    ua,
    client: assistant,
    agentSlug,
    siteId: site.siteId,
    orgId: site.orgId,
    siteOrigin: site.siteOrigin,
    reason: "frame_owned",
  });

  return NextResponse.json(
    {
      // Held in FRAME-PRIVATE MEMORY by the caller. Never written to storage, a
      // URL, a log or any parent-visible state — see `useFrameWidgetSession`.
      userToken: redeemed.token,
      transportToken: transport.token,
      tokenType: "Bearer",
      expiresIn: Math.min(redeemed.expiresIn, transport.expiresIn),
      scope: redeemed.scope,
    },
    { status: 200 },
  );
}
