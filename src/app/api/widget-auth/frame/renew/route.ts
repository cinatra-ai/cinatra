import { NextResponse } from "next/server";

import { resolveWidgetStreamAgentUnion } from "@/lib/widget-stream-agents.server";
import { renewUserWidgetToken } from "@/lib/widget-user-auth";
import { deriveFrameBinding, isSameOriginFrameRequest } from "@/lib/widget-frame-auth";
import { mintWidgetStreamToken } from "@/lib/widget-token-broker";
import { allowConnectTokenRequest } from "@/lib/connect-rate-limit";
import { emitWidgetAuthAudit } from "@/lib/widget-auth-audit";
import { sha256Base64Url } from "@/lib/connect-provisioning";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// cinatra#3051 — POST /api/widget-auth/frame/renew
//
// THE SAME ROAD AS THE MINT, WALKED A SECOND TIME. This route exists because a
// widget column that is already OPEN on somebody's page must be able to keep
// working: its bearer has a fifteen-minute life, and a run released twenty
// minutes after the panel opened could not reach it — every read the column made
// was refused by a credential that had quietly died. Re-signing-in is not an
// answer for a column nobody closed.
//
// IT IS THE FRAME'S OWN ROUTE, exactly like the token route beside it: called
// SAME-ORIGIN from the Cinatra-served embed document, with NO CORS headers, so
// a cross-site page could not read the answer even if it managed to send the
// request. The binding is RE-DERIVED here from the frame's public selectors and
// the renewal is judged against THAT — never against a site, origin or agent the
// caller named.
//
// THE BEARER TRAVELS ON A HEADER, NOT IN THE BODY. It is a credential in flight
// and the body of a POST is the one part of a request that ends up in an
// application log or an error report by accident; the same header the turn
// already presents (`X-Cinatra-Widget-User-Token`) carries it here too, so the
// widget has exactly one way of presenting its bearer rather than two.
//
// NOTHING IS BROADENED, and the module makes that structural: `renewUserWidgetToken`
// copies the presented row's claims column for column and composes no grant of
// its own. This route adds the two live re-checks a frame-side road owes —
// same-origin, and the derived binding — and mints the site TRANSPORT half for
// the same server-derived site, so the pair the frame ends up holding is bound
// exactly as the pair it started with.
//
// ONE GENERIC REFUSAL. Every reason the module can name — an unknown bearer, an
// expired one, the wrong agent, the wrong origin, a signed-out person, a revoked
// site — answers the same `invalid_grant` with the same status. The reason
// reaches the AUDIT trail and nothing else, so this route is no oracle about
// which of them applied.
// ---------------------------------------------------------------------------

type RenewBody = {
  grantType?: unknown;
  assistant?: unknown;
  instanceId?: unknown;
  siteId?: unknown;
  origin?: unknown;
};

const INVALID_GRANT = { error: "invalid_grant" } as const;

/** The one header the widget already presents its bearer on. */
export const WIDGET_USER_TOKEN_HEADER = "x-cinatra-widget-user-token";

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
    emitWidgetAuthAudit("renew_failure", { ip, ua, reason: "not_same_origin" });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: RenewBody;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object") {
      return NextResponse.json(INVALID_GRANT, { status: 400 });
    }
    body = parsed as RenewBody;
  } catch {
    return NextResponse.json(INVALID_GRANT, { status: 400 });
  }

  const grantType = str(body.grantType);
  const assistant = str(body.assistant);
  const instanceId = str(body.instanceId);
  // THE BEARER, from the header and from nowhere else. A body field named
  // anything at all is not read here, so a caller cannot get one accepted by
  // moving it — the shape of the request is the rule, not a preference.
  const presented = request.headers.get(WIDGET_USER_TOKEN_HEADER)?.trim() ?? "";

  if (grantType !== "widget_token_renewal") {
    return NextResponse.json(INVALID_GRANT, { status: 400 });
  }

  // Rate limit per IP and per bearer HASH — never the plaintext bearer, which
  // is why the hash is taken here rather than the value passed down.
  const tokenKey = presented ? sha256Base64Url(presented) : "no-token";
  if (!allowConnectTokenRequest({ ip, codeKey: tokenKey })) {
    emitWidgetAuthAudit("renew_failure", { ip, ua, client: assistant, reason: "rate_limited" });
    return NextResponse.json(INVALID_GRANT, { status: 429 });
  }

  if (!presented) {
    emitWidgetAuthAudit("renew_failure", { ip, ua, client: assistant, reason: "no_bearer" });
    return NextResponse.json(INVALID_GRANT, { status: 400 });
  }

  // RE-DERIVE the binding from the same public selectors the mint uses — the
  // agent included, which is never a request field (the frame names a handle and
  // the server maps it through its own closed table). The renewal below is then
  // asked about the SERVER's site, origin and agent, so a bearer minted for one
  // site cannot be renewed under another's binding.
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

  // THE TRANSPORT HALF IS MINTED FIRST, and that order is the whole of
  // "both or nothing" (cinatra#3051 convergence). The rotation below SPENDS the
  // bearer this frame is holding — the predecessor row is gone the moment it
  // succeeds — so a transport mint that fails AFTER it would leave the column
  // with a credential it no longer has and a pair it never received. Minting the
  // half that can fail cheaply first means the only thing that can fail after
  // the spend is the answer's journey home, and nothing this route does can
  // make that shorter.
  const issuerBaseUrl = new URL(request.url).origin;
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

  const renewed = renewUserWidgetToken({
    token: presented,
    agentSlug,
    requestOrigin: site.siteOrigin,
  });
  if (!renewed.ok) {
    // The bearer was NOT spent on this road — every refusal in the module leaves
    // the presented row exactly where it found it — so the frame keeps working
    // with the pair it already holds. The transport token minted just above is
    // simply not handed out; it expires on its own five-minute clock.
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

  emitWidgetAuthAudit("renew_success", {
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
      // Held in FRAME-PRIVATE MEMORY by the caller, exactly as the minted pair
      // is. The renewal changes how long the column lives, not where its
      // credential lives.
      userToken: renewed.token,
      transportToken: transport.token,
      tokenType: "Bearer",
      expiresIn: Math.min(renewed.expiresIn, transport.expiresIn),
      scope: renewed.scope,
    },
    { status: 200 },
  );
}
