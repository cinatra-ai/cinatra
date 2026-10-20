import { NextResponse } from "next/server";

import { resolveWidgetStreamAgentUnion } from "@/lib/widget-stream-agents.server";
import { renewUserWidgetToken } from "@/lib/widget-user-auth";
import { deriveFrameBinding, resolveFrameRequestOrigin } from "@/lib/widget-frame-auth";
import { mintWidgetStreamToken } from "@/lib/widget-token-broker";
import { allowConnectTokenRequest } from "@/lib/connect-rate-limit";
import { emitWidgetAuthAudit } from "@/lib/widget-auth-audit";
import { sha256Base64Url } from "@/lib/connect-provisioning";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// cinatra#4217 — POST /api/widget-auth/frame/renew
//
// THE FRAME RENEWS THE PAIR IT HOLDS, BEFORE IT RUNS OUT. The caller is the same
// Cinatra embed iframe that ran the sign-in through ../token, calling SAME-ORIGIN
// through the same gate. It presents its CURRENT `cwu_` in the header it already
// sends on every broker call and receives a new pair: a renewed `cwu_` (same
// person, grant and jti, a fresh life capped at the maximum session lifetime —
// see renewUserWidgetToken) and a fresh `cit_` for the same server-derived site.
// No CORS headers, exactly like ../token: the answer is for a Cinatra-origin
// document only.
//
// THE CURRENT TOKEN IS THE AUTHORITY, AND THE VERIFIER DECIDES IT. No token, no
// renewal: a request without the header is refused before anything is read, and
// a token in the body is not a token. The binding is RE-DERIVED from the public
// selectors as at ../token, and the token must belong to that derived site.
//
// THE USER TOKEN IS RENEWED FIRST, THE TRANSPORT TOKEN SECOND, so no `cit_` is
// ever minted for a request whose `cwu_` was refused. When the transport mint
// fails after a successful renewal, the whole renewal fails, as at ../token: the
// presented bearer is already spent, the new one is never handed out, and the
// frame signs in again — the honest outcome.
// ---------------------------------------------------------------------------

type RenewBody = {
  assistant?: unknown;
  instanceId?: unknown;
  siteId?: unknown;
  origin?: unknown;
};

const INVALID_GRANT = { error: "invalid_grant" } as const;
const USER_TOKEN_HEADER = "x-cinatra-widget-user-token";

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

  const frameOrigin = resolveFrameRequestOrigin(request);
  if (!frameOrigin.ok) {
    emitWidgetAuthAudit("renew_failure", { ip, ua, reason: "not_same_origin" });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const token = (request.headers.get(USER_TOKEN_HEADER) ?? "").trim();
  if (!token) {
    emitWidgetAuthAudit("renew_failure", { ip, ua, reason: "no_user_token" });
    return NextResponse.json(INVALID_GRANT, { status: 400 });
  }

  let body: RenewBody;
  try {
    const parsed: unknown = await request.json();
    // A plain JSON object only. An array is an object to `typeof` and would
    // otherwise pass here and spend the shared limiter's quota below before the
    // binding refused it; every malformed body is refused BEFORE the limiter.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      emitWidgetAuthAudit("renew_failure", { ip, ua, reason: "invalid_body" });
      return NextResponse.json(INVALID_GRANT, { status: 400 });
    }
    body = parsed as RenewBody;
  } catch {
    emitWidgetAuthAudit("renew_failure", { ip, ua, reason: "invalid_body" });
    return NextResponse.json(INVALID_GRANT, { status: 400 });
  }

  const assistant = str(body.assistant);
  const instanceId = str(body.instanceId);

  // Rate limit on the SAME buckets as the sign-in (../token): per IP, and per
  // presented token keyed on its hash, never the plaintext. An exhausted bucket
  // answers 429 and renews nothing; the frame retries while its pair still has
  // life and signs in again only when it cannot renew in time. The IP bucket is
  // shared with sign-ins (30 a minute, connect-rate-limit.ts): at one renewal
  // per frame every 210 s it is full at about 105 open frames behind one
  // address. KNOWN LIMIT: the address is the first X-Forwarded-For hop, and
  // a caller can set that header, so anyone can fill a victim address's bucket
  // with about 30 junk requests a minute and refuse that address's renewals
  // and sign-ins for as long as the flood lasts. Keying the bucket on a trusted
  // proxy hop or the socket address, and a separate renewal bucket, are
  // follow-ups.
  if (!allowConnectTokenRequest({ ip, codeKey: sha256Base64Url(token) })) {
    emitWidgetAuthAudit("renew_failure", { ip, ua, client: assistant, reason: "rate_limited" });
    return NextResponse.json(INVALID_GRANT, { status: 429 });
  }

  const derived = deriveFrameBinding({
    assistant,
    instanceId,
    claimedSiteId: str(body.siteId) || null,
    claimedOrigin: str(body.origin) || null,
  });
  if (!derived.ok) {
    emitWidgetAuthAudit("renew_failure", { ip, ua, client: assistant, reason: derived.reason });
    return NextResponse.json(INVALID_GRANT, { status: 400 });
  }
  const { site, agentSlug } = derived.binding;

  const resolved = await resolveWidgetStreamAgentUnion(agentSlug);
  const entry = resolved?.entry ?? null;
  if (!entry || entry.auth.instancesConfigKey !== derived.binding.instancesConfigKey) {
    emitWidgetAuthAudit("renew_failure", { ip, ua, client: assistant, agentSlug, reason: "unknown_agent" });
    return NextResponse.json(INVALID_GRANT, { status: 400 });
  }

  const renewed = renewUserWidgetToken({ token, agentSlug, site });
  if (!renewed.ok) {
    emitWidgetAuthAudit("renew_failure", {
      ip,
      ua,
      client: assistant,
      agentSlug,
      siteId: site.siteId,
      orgId: site.orgId,
      reason: renewed.reason,
    });
    return NextResponse.json(INVALID_GRANT, { status: 400 });
  }

  const issuerBaseUrl = frameOrigin.canonicalOrigin;
  const transport = mintWidgetStreamToken({
    agentSlug,
    auth: entry.auth,
    origin: site.siteOrigin,
    issuerBaseUrl,
    connectSite: { siteId: site.siteId, credentialVersion: site.credentialVersion },
  });
  if (!transport) {
    emitWidgetAuthAudit("renew_failure", {
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

  // The audit names the person whose chain was renewed (cinatra#4217), so an
  // investigation can follow one sign-in's renewals. Never the token, its hash
  // or its jti: the audit's field set has no slot for any of them.
  emitWidgetAuthAudit("renew_success", {
    actor: renewed.userId,
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
      // Held in FRAME-PRIVATE MEMORY by the caller, replacing the pair it
      // presented. Never written to storage, a URL, a log or parent-visible state.
      userToken: renewed.token,
      transportToken: transport.token,
      tokenType: "Bearer",
      expiresIn: Math.min(renewed.expiresIn, transport.expiresIn),
      scope: renewed.scope,
    },
    { status: 200 },
  );
}
