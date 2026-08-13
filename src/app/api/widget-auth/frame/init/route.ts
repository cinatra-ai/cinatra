import { NextResponse } from "next/server";

import { resolveWidgetStreamAgentUnion } from "@/lib/widget-stream-agents.server";
import { createAuthTransaction } from "@/lib/widget-user-auth";
import { deriveFrameBinding, isSameOriginFrameRequest } from "@/lib/widget-frame-auth";
import { allowNamedRateLimit } from "@/lib/connect-rate-limit";
import { emitWidgetAuthAudit } from "@/lib/widget-auth-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// cinatra#2674 (epic #2564 S8e) — POST /api/widget-auth/frame/init
//
// THE FRAME STARTS ITS OWN SIGN-IN. This is the replacement for the retired,
// site-mediated `/api/widget-auth/init`: it is called SAME-ORIGIN by the Cinatra
// embed iframe, presents NO credential of any kind, and pins a transaction to a
// context the SERVER derived from its own rows.
//
// WHAT THE CALLER SENDS, AND WHAT IT IS WORTH. `assistant` and `instanceId` are
// the frame's own URL disambiguators; `siteId` and `origin` are optional
// cross-checks. All of them are SELECTORS — `deriveFrameBinding` re-derives the
// authoritative agent, site, org, origin and canonical instance from the closed
// host table, the connector config and `connect_sites`, and denies on any
// disagreement. Naming another tenant's instance yields a denial, not that
// tenant's transaction. THE AGENT IS NOT SENT AT ALL (codex round 0, finding 1):
// it is derived from the assistant, so no request field can select one.
//
// PKCE MOVES TO WHERE IT BELONGS. The `code_verifier` is minted and held by the
// frame — the public client that will redeem — instead of by a CMS backend. The
// challenge travels here; the verifier never leaves the frame's memory.
//
// NOTHING SECRET IS RETURNED. The response is a transaction id and the hosted
// authorize URL. Both are useless to anyone who cannot receive the authorization
// code, and the code is delivered by `postMessage` to the CINATRA ORIGIN ONLY.
//
// Path is on the middleware public-path allowlist (the visitor has no session
// yet — that is the point of the flow); authorization runs INSIDE here and is
// the server-side re-derivation, not a credential.
// ---------------------------------------------------------------------------

type InitBody = {
  assistant?: unknown;
  instanceId?: unknown;
  siteId?: unknown;
  origin?: unknown;
  codeChallenge?: unknown;
  codeChallengeMethod?: unknown;
  state?: unknown;
};

const GENERIC_400 = { error: "invalid_request" } as const;

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

  // 1. SAME-ORIGIN GATE FIRST, before any body work. Defense in depth (headers
  //    are forgeable off-browser); the real wall is that the authorization code
  //    is postMessage'd to the Cinatra origin alone.
  if (!isSameOriginFrameRequest(request)) {
    emitWidgetAuthAudit("init_failure", { ip, ua, reason: "not_same_origin" });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Rate limit per IP. There is no credential to key on here, which is why
  //    this endpoint mints nothing bearer-shaped: a transaction id buys an
  //    attacker only the ability to be refused at the sign-in screen.
  //
  //    ONE bucket, named per IP (codex confirming round). The pair helper charges
  //    a per-IP bucket AND a per-"code" bucket, and a CONSTANT in the second slot
  //    would have made the 5/min code bucket a GLOBAL cap on frame sign-ins that
  //    a single caller could exhaust for every site on the instance. A
  //    denial-of-sign-in is not an acceptable price for a speed bump.
  if (!allowNamedRateLimit({ key: `frame-init-ip:${ip}`, max: 30 })) {
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

  const assistant = str(body.assistant);
  const instanceId = str(body.instanceId);
  const codeChallenge = str(body.codeChallenge);
  const codeChallengeMethod = str(body.codeChallengeMethod) || "S256";
  const state = str(body.state);

  // Only S256 (no plain), exactly as the retired route required.
  if (codeChallengeMethod !== "S256") {
    emitWidgetAuthAudit("init_failure", { ip, ua, client: assistant, reason: "bad_challenge_method" });
    return NextResponse.json(GENERIC_400, { status: 400 });
  }

  // 3. RE-DERIVE the authoritative binding — agent included. No credential is
  //    consulted; every caller value is a selector and every axis is checked.
  const derived = deriveFrameBinding({
    assistant,
    instanceId,
    claimedSiteId: str(body.siteId) || null,
    claimedOrigin: str(body.origin) || null,
  });
  if (!derived.ok) {
    emitWidgetAuthAudit("init_failure", { ip, ua, client: assistant, reason: derived.reason });
    // ONE generic shape for every derivation failure — a caller must not learn
    // which axis disagreed (that would be a map of the tenant's configuration).
    return NextResponse.json(GENERIC_400, { status: 400 });
  }
  const { site, instanceId: canonicalInstanceId, agentSlug } = derived.binding;

  // 4. Resolve the agent entry for the DERIVED slug (build-time map ∪
  //    admin-approved runtime entries, fail closed) and require its connector key
  //    to be the one the closed table named — two independent statements about
  //    the same agent that must agree.
  const resolved = await resolveWidgetStreamAgentUnion(agentSlug);
  const entry = resolved?.entry ?? null;
  if (!entry || entry.auth.instancesConfigKey !== derived.binding.instancesConfigKey) {
    emitWidgetAuthAudit("init_failure", { ip, ua, client: assistant, agentSlug, reason: "unknown_agent" });
    return NextResponse.json(GENERIC_400, { status: 400 });
  }

  // 4b. A SECOND, INDEPENDENT bucket on the DERIVED site (codex round 0,
  //     finding 4). The per-IP key above is keyed on a caller-influenced header,
  //     so a non-browser caller that forges the same-origin headers could rotate
  //     it and mint transaction rows without bound. This key is not
  //     caller-influenced: it is the site the SERVER derived, so the cost of
  //     forging headers is capped at one site's ordinary sign-in rate. It charges
  //     its own bucket only — charging the pair again would bill this request's
  //     IP twice for one call.
  if (!allowNamedRateLimit({ key: `frame-init-site:${site.siteId}`, max: 30 })) {
    emitWidgetAuthAudit("init_failure", {
      ip,
      ua,
      client: assistant,
      agentSlug,
      siteId: site.siteId,
      reason: "rate_limited",
    });
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  // 5. Pin the transaction to the SERVER-DERIVED context. `createAuthTransaction`
  //    re-derives the canonical instance a second time from the same verified
  //    origin, so nothing about the pinned instance depends on this route.
  const created = createAuthTransaction({
    site,
    agentSlug,
    instancesConfigKey: derived.binding.instancesConfigKey,
    codeChallenge,
    state,
    claimedInstanceId: canonicalInstanceId,
  });
  if (!created.ok) {
    emitWidgetAuthAudit("init_failure", {
      ip,
      ua,
      client: assistant,
      agentSlug,
      siteId: site.siteId,
      orgId: site.orgId,
      siteOrigin: site.siteOrigin,
      reason: created.reason,
    });
    const status = created.reason === "instance_unresolved" ? 409 : 400;
    return NextResponse.json({ error: created.reason }, { status });
  }

  const issuerOrigin = new URL(request.url).origin;
  const authorizeUrl = `${issuerOrigin}/widget-auth?txn=${encodeURIComponent(created.txnId)}`;

  emitWidgetAuthAudit("init_success", {
    ip,
    ua,
    client: assistant,
    agentSlug,
    siteId: site.siteId,
    orgId: site.orgId,
    siteOrigin: site.siteOrigin,
    instanceId: created.instanceId,
    reason: "frame_owned",
  });

  return NextResponse.json(
    { txnId: created.txnId, authorizeUrl, instanceId: created.instanceId },
    { status: 200 },
  );
}
