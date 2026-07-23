import "server-only";

import { z } from "zod";
import { getAuthSession } from "@/lib/auth-session";
import {
  ASSISTANT_STREAM_AUTH_MODES,
  buildAssistantStreamCapabilities,
  negotiateStreamContract,
} from "@cinatra-ai/agent-ui-protocol/stream";
import { WIDGET_BROKER_ROUTE_PATH } from "@/lib/widget-broker-route";
import { resolveAssistantWidgetBinding } from "@/lib/assistant-widget-handles";
import {
  resolveWidgetStreamAgentUnion,
  widgetStreamRequestSource,
} from "@/lib/widget-stream-agents.server";
import { consumeWidgetStreamToken, normalizeOriginStrict } from "@/lib/widget-token-broker";
import { consumeUserWidgetToken } from "@/lib/widget-user-auth";
import { emitWidgetAuthAudit } from "@/lib/widget-auth-audit";

// ---------------------------------------------------------------------------
// /api/assistants/chat/capabilities — the S1 capability surface for the Cinatra
// assistant chat surfaces (cinatra#1218, epic #1216 S2; CONTRACT.md §5). Lane A
// (cinatra#1998, epic #1216 S6) makes the SAME advertisement reachable to the
// cross-origin broker-auth embed, resolving the §8 Lane-A interlock the merged
// embed negotiator (`embed-chat-negotiate.ts`) documented.
//
//   GET  — the server's `AssistantStreamCapabilities` advertisement. Served to
//          (1) a first-party cookie SESSION, OR (2) a sessionless broker-auth
//          embed presenting the SAME `cit_`/`cwu_` dual-token pair the turn
//          endpoint already brokers (S5 #1221). Every other caller 401s.
//   POST — the first-party `/chat` handshake: the client posts its
//          `StreamClientHello` and receives the `StreamNegotiation`. The PURE
//          negotiation runs here rather than in the browser bundle (the /chat
//          route graph is a locked dev-perf budget, and both handshake legs are
//          served by the same deployment). Session-gated: the cross-origin
//          embed negotiates CLIENT-SIDE via GET, never this POST (its graph is
//          not /chat's — see `embed-chat-negotiate.ts`).
//
// The advertisement is STATIC contract metadata only (nothing instance-specific
// — no auth config, no package names, no extension internals), so admitting a
// verified broker caller is NOT a capability oracle beyond what the endpoint it
// replaces already exposed; it is the same static shape either auth mode sees.
// `renderableViews` is empty: the Cinatra assistant runtime emits no registered
// renderable view yet (its DATA_PARTs are the structural `agent_run` /
// `citations` payloads the reducer consumes) — the entry is ADVISORY by
// contract and never gates rendering.
//
// AUTH advertised = ["session", "token-broker"]: the surface genuinely accepts
// BOTH (the turn endpoint `route.ts` landed the broker branch in S5). Adding
// `token-broker` never weakens the session negotiation (the pure negotiator
// only asserts the server ACCEPTS the mode the client presents), and it is what
// lets `negotiateEmbedChatContract` reach `ok:true`.
// ---------------------------------------------------------------------------

// The site transport-token prefix — the discriminant for the broker-auth GET.
// A cookie-session caller carries NO Authorization bearer and falls to the
// session path (byte-identical to before Lane A).
const SHORT_LIVED_TOKEN_PREFIX = "cit_";
// cinatra#408 — the per-user widget identity proof header (the "dual token").
const USER_TOKEN_HEADER = "X-Cinatra-Widget-User-Token";
// Lane A (#1998) forwarded seams. The embed's negotiate GET is SAME-ORIGIN to
// the Cinatra-served app, so the browser sends no CMS `Origin` header (and JS
// cannot set the forbidden `Origin`). The embed therefore forwards the
// server-resolved parent (CMS) origin + its bound assistant handle here; both
// are validated INTRINSICALLY against the token binding (a forged value fails
// the consume closed — the tokens, never these headers, are the authority).
const WIDGET_ORIGIN_HEADER = "X-Cinatra-Widget-Origin";
const WIDGET_ASSISTANT_HEADER = "X-Cinatra-Widget-Assistant";

function chatSurfaceCapabilities() {
  return buildAssistantStreamCapabilities({
    auth: ["session", "token-broker"],
    renderableViews: [],
  });
}

const advertisementResponse = () =>
  Response.json(chatSurfaceCapabilities(), {
    headers: { "Cache-Control": "no-store" },
  });

// ---------------------------------------------------------------------------
// GET — advertisement. Broker-auth branch (cit_ bearer) OR cookie session.
// ---------------------------------------------------------------------------
export async function GET(request: Request) {
  const auth = request.headers.get("Authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "";

  // A `cit_` bearer discriminates the broker-auth embed. It is validated
  // STRICTLY and FAIL-CLOSED with NO session fallback: a broker caller presents
  // `credentials: "omit"`, so ambient Cinatra cookies must never rescue a failed
  // broker validation (auth-confusion guard, mirrors the turn endpoint).
  if (bearer.startsWith(SHORT_LIVED_TOKEN_PREFIX)) {
    return serveBrokerAdvertisement(request, bearer);
  }

  const session = await getAuthSession();
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return advertisementResponse();
}

// ---------------------------------------------------------------------------
// The broker-auth advertisement path (Lane A, #1998).
//
// AUTHENTICATE the caller as a legitimate broker principal — the SAME dual-token
// FAIL-CLOSED sequence the turn endpoint runs — then serve the static
// advertisement. This is deliberately AUTHENTICATION only: it does NOT run the
// turn endpoint's RUN-gating rungs (live org-membership, audience closure, grant
// re-assert, the OBO mint) — those gate dispatching a RUN, not reading static
// contract metadata, and importing them here would turn the advertisement into
// an authorization oracle it must not be. The tokens are NOT consumed/burned
// (the consume path is an idempotent hash-lookup re-validation), so the
// subsequent turn against the already-broker-capable turn endpoint still works.
// ---------------------------------------------------------------------------
async function serveBrokerAdvertisement(request: Request, citToken: string): Promise<Response> {
  const unauthorized = () => Response.json({ error: "Unauthorized" }, { status: 401 });

  // The per-user cwu_ token is REQUIRED on the interactive broker surface (no
  // anonymous/install fallback — same posture as the turn endpoint).
  const userToken = request.headers.get(USER_TOKEN_HEADER)?.trim() ?? "";
  if (!userToken) return unauthorized();

  // The embed-forwarded parent origin (validated against the token binding
  // below). Absent → the consume's origin re-check fails closed.
  const forwardedOrigin = request.headers.get(WIDGET_ORIGIN_HEADER);

  // Resolve the CLOSED widget binding from the forwarded handle. A missing /
  // unknown / built-in "cinatra" handle presenting a cit_ token is fail-closed —
  // a cit_ token is never valid for a non-widget surface. The handle is only a
  // selector; the cit_ consume re-checks `agent_slug` so a forged handle fails.
  const handle = request.headers.get(WIDGET_ASSISTANT_HEADER)?.trim().toLowerCase() ?? "";
  const binding = resolveAssistantWidgetBinding(handle);
  if (!binding) return unauthorized();

  const resolved = await resolveWidgetStreamAgentUnion(binding.agentSlug, undefined, {
    requestSource: widgetStreamRequestSource(request),
  });
  if (!resolved) return unauthorized();
  const entry = resolved.entry;

  // cit_ site transport token — origin/aud/scope/expiry + live rotation re-check
  // against the STORED row. `aud` is the UNIFIED turn route (WIDGET_BROKER_ROUTE_
  // PATH): the capabilities check proves the caller holds valid TURN credentials
  // (exactly the population allowed to then negotiate + turn), so it verifies
  // against the turn aud, never the capabilities path.
  const consumed = consumeWidgetStreamToken({
    token: citToken,
    agentSlug: binding.agentSlug,
    auth: entry.auth,
    routePath: WIDGET_BROKER_ROUTE_PATH,
    requestOrigin: forwardedOrigin,
  });
  if (!consumed.ok) return unauthorized();
  const verifiedOrigin = consumed.origin;

  // cwu_ per-user token — the authenticated end user, re-checked live (not
  // expired, agent/aud/scope/origin, connect-site still active + same
  // org/origin/credential generation).
  const consumedUser = consumeUserWidgetToken({
    token: userToken,
    agentSlug: binding.agentSlug,
    routePath: WIDGET_BROKER_ROUTE_PATH,
    requestOrigin: forwardedOrigin,
  });
  if (!consumedUser.ok) return unauthorized();

  // TWO-TOKEN AGREEMENT — the cit_-derived verified origin MUST equal the
  // cwu_-bound site origin, so a valid user token for site A cannot ride a site
  // token for site B (agent agreement is intrinsic — both consumes gate the same
  // agent_slug + aud).
  if (
    normalizeOriginStrict(verifiedOrigin) !==
    normalizeOriginStrict(consumedUser.claims.siteOrigin)
  ) {
    return unauthorized();
  }

  emitWidgetAuthAudit("assistant_chat_capabilities_broker_advertised", {
    actor: consumedUser.claims.userId,
    orgId: consumedUser.claims.orgId,
    agentSlug: binding.agentSlug,
    siteOrigin: verifiedOrigin,
  });

  return advertisementResponse();
}

const clientHelloSchema = z.object({
  supportedContracts: z.array(z.string().min(1)).min(1).max(32),
  authMode: z.enum(ASSISTANT_STREAM_AUTH_MODES),
  requiredViews: z.array(z.string().min(1)).max(64).optional(),
  requiresResumable: z.boolean().optional(),
});

export async function POST(request: Request) {
  const session = await getAuthSession();
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const raw = (await request.json().catch(() => null)) as unknown;
  const parsed = clientHelloSchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid stream client hello", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const negotiation = negotiateStreamContract(parsed.data, chatSurfaceCapabilities());
  return Response.json(negotiation, { headers: { "Cache-Control": "no-store" } });
}
