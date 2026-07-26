import "server-only";

import { z } from "zod";
import { getAuthSession, requireActorContext, isPlatformAdmin, resolveOrgRoleForUser } from "@/lib/auth-session";
import { hasConfiguredLlmRuntime, runChatTurn, type ChatRequestMessage } from "@/app/api/chat/runner";
import {
  authorizeThreadForTurn,
  streamAgUiChatTurn,
} from "@/lib/assistant-runtime/ag-ui-stream-route";
import { runAssistantTurn } from "@/lib/assistant-runtime/runtime";
import { resolveAssistantRuntimeConfigByPrincipal } from "@/lib/assistant-runtime/resolve-runtime-config";
import { resolveAssistantHandles } from "@/lib/better-auth-db";
import { isBuiltinAssistantByPackage } from "@/lib/assistant-registry-reader";
import { POLICY_VERSION, type ActorContext } from "@/lib/authz/actor-context";
import type { WidgetPrincipal } from "@/lib/assistant-runtime/widget-principal";
import { WIDGET_BROKER_ROUTE_PATH } from "@/lib/widget-broker-route";
import { resolveAssistantWidgetBinding, listAssistantWidgetBindings } from "@/lib/assistant-widget-handles";
import {
  isSelectedAssistantVisible,
  sessionSelectorCaller,
  widgetSelectorCaller,
} from "@/lib/assistant-selector-audience";
import {
  resolveWidgetStreamAgentUnion,
  widgetStreamRequestSource,
  reassertWidgetStreamGrantBeforeOboRun,
} from "@/lib/widget-stream-agents.server";
import {
  resolveWidgetStreamOrigin,
  buildWidgetStreamCorsHeaders,
} from "@/lib/widget-stream-auth";
import { consumeWidgetStreamToken, normalizeOriginStrict } from "@/lib/widget-token-broker";
import { consumeUserWidgetToken, resolveCanonicalInstanceForOrigin } from "@/lib/widget-user-auth";
import { emitWidgetAuthAudit } from "@/lib/widget-auth-audit";
import { issueWidgetChatResumeToken } from "@/lib/widget-chat-resume-token";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// POST /api/assistants/chat — the Cinatra assistant AG-UI endpoint
// (cinatra#1218, epic #1216 S2; realizes #1037 P3's wire half).
//
// One /chat turn on the ONE wire: the caller's messages drive the assistant
// runtime (`runChatTurn` — the #1037 P2 producer) through the shared AG-UI
// streaming harness (`streamAgUiChatTurn`) — the durable Redis-Streams log
// substrate, turn linkage, TOCTOU-safe thread binding, abort lifecycle, and
// resume window all live in the harness so any additional AG-UI producer reuses
// them verbatim (cinatra#1218 predecessor 3). This route owns exactly the
// producer choice + the validation/auth posture; behavior is byte-identical to
// before the extraction (the harness is the same code).
//
// AUTH + THREAD BINDING — TWO branches sharing ONE runtime:
//
//   1. COOKIE SESSION (default, byte-identical to before): same posture as
//      POST /api/chat; the caller-supplied threadId is authorized against the
//      PERSISTED ownership axes — never against request-body claims (the exact
//      POST /api/chat/save matrix): personal → owner-or-admin; team →
//      member-of-owning-org-or-admin; legacy unowned → allowed; absent →
//      claimed for the caller.
//
//   2. BROKER-AUTH WIDGET (S5, cinatra#1221): a cross-origin public-site
//      (WordPress/Drupal) browser widget presents a site `cit_` token on
//      `Authorization` PLUS a per-user `cwu_` token on
//      `X-Cinatra-Widget-User-Token`. This branch ports the `/api/agents/
//      {slug}/stream` route's dual-token FAIL-CLOSED sequence VERBATIM (cit_
//      origin consume → cwu_ user consume → two-token origin agreement →
//      canonical origin re-pin → live org membership → handle↔agent_slug
//      binding (G9)), then builds a SERVER-VERIFIED `WidgetPrincipal` and drives
//      the SAME `runAssistantTurn` — which mints a `cinatra.widget.mcp-obo` OBO
//      token so the CMS write authorizes AS THE END USER against the pinned
//      canonical instance, platform-admin floored to `member` (no privilege
//      widening vs. the OLD relay). `authorizeThreadForTurn` is UNCHANGED.
// ---------------------------------------------------------------------------

// cinatra#408 — per-user widget identity proof header (the "dual token"). The
// site `cit_` transport token stays on `Authorization`; this carries the
// short-lived `cwu_` user token minted by the hosted /widget-auth PKCE login.
const USER_TOKEN_HEADER = "X-Cinatra-Widget-User-Token";
// Lane A (#1998) forwarded seam — mirrors the capabilities route. Post-S5 the
// turn is issued by the `/embed/assistant` iframe, which is SAME-ORIGIN to the
// Cinatra app, so the browser `Origin` header is the Cinatra origin (never the
// CMS site origin) and JS cannot set the forbidden `Origin`. The embed forwards
// the server-resolved parent (CMS) origin here; it is the origin the cit_/cwu_
// tokens were minted against and is validated INTRINSICALLY by the consume (a
// forged value fails closed — the tokens, never this header, are the authority).
const WIDGET_ORIGIN_HEADER = "X-Cinatra-Widget-Origin";
// Emitted on a fail-closed per-user 401 so the cross-origin widget can tell
// "re-login required" from a generic error and swap back to the login window.
const WIDGET_AUTH_REQUIRED_HEADER = "X-Cinatra-Widget-Auth";
// The site transport token prefix — the discriminant for the broker-auth
// branch. A cookie-session caller carries NO Authorization bearer.
const SHORT_LIVED_TOKEN_PREFIX = "cit_";

const attachmentRefSchema = z
  .object({
    artifactId: z.string().min(1),
    representationRevisionId: z.string().min(1),
    digest: z.string().min(1),
    mime: z.string().min(1),
    originKind: z.enum([
      "upload",
      "email_attachment",
      "agent_generated",
      "external_link",
      "live_generator",
    ]),
    title: z.string().optional(),
    filename: z.string().optional(),
    size: z.number().int().nonnegative().optional(),
  })
  .strict();

const chatMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string(),
    attachments: z.array(attachmentRefSchema).max(20).optional(),
  })
  .strict();

const assistantChatBodySchema = z.object({
  threadId: z.string().min(1).max(200),
  messages: z.array(chatMessageSchema),
  // OPTIONAL assistant selector (cinatra#1823, epic #1037 P4.1): the mention
  // handle of the registered assistant to drive this turn (e.g. "wordpress",
  // "drupal", "cinatra"). ABSENT = the built-in @cinatra binding (backward
  // compatible — the historical single-assistant behaviour). When present, the
  // turn is driven by that assistant's OWN persisted `assistant_config` resolved
  // through its `assistant_user_id` link — never the hardcoded Cinatra fallback.
  assistant: z.string().min(1).max(200).optional(),
});

// ---------------------------------------------------------------------------
// OPTIONS — CORS preflight for the cross-origin widget branch.
//
// A widget preflight carries no body, so the target assistant handle is
// unknown here. We reflect the request Origin if it matches ANY public-site
// widget binding's configured-instance allowlist (wordpress ∪ drupal). CORS is
// RESPONSE-HEADER POLICY only — never the authorization mechanism; the POST's
// dual-token sequence is the authoritative gate. A non-matching origin gets a
// 403 preflight (no reflected header), consistent with the stream route.
// ---------------------------------------------------------------------------
export async function OPTIONS(request: Request): Promise<Response> {
  const requestOrigin = request.headers.get("Origin");
  if (!requestOrigin) return new Response(null, { status: 403 });

  for (const binding of listAssistantWidgetBindings()) {
    const resolved = await resolveWidgetStreamAgentUnion(binding.agentSlug, undefined, {
      requestSource: widgetStreamRequestSource(request),
    });
    if (!resolved) continue;
    const allowed = resolveWidgetStreamOrigin(requestOrigin, resolved.entry.auth);
    if (allowed) {
      return new Response(null, { status: 200, headers: buildWidgetStreamCorsHeaders(allowed) });
    }
  }
  return new Response(null, { status: 403 });
}

export async function POST(request: Request) {
  const auth = request.headers.get("Authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "";

  // Discriminate the broker-auth WIDGET branch by the `cit_` transport-token
  // prefix. A cookie-session caller carries no Authorization bearer and falls
  // to the byte-identical cookie path below. The legacy long-lived key path is
  // NOT accepted here — it stays on `/api/agents/{slug}/stream` (W4 banked); the
  // unified route is the modern short-lived-token surface only.
  if (bearer.startsWith(SHORT_LIVED_TOKEN_PREFIX)) {
    return handleWidgetBrokerTurn(request, bearer);
  }

  return handleCookieSessionTurn(request);
}

// ---------------------------------------------------------------------------
// Branch 2 — the broker-auth widget turn (S5, cinatra#1221).
// ---------------------------------------------------------------------------
async function handleWidgetBrokerTurn(request: Request, citToken: string): Promise<Response> {
  // Browser `Origin` (the SAME-ORIGIN embed→Cinatra request) — used ONLY to
  // source the CORS response header. The AUTHORITATIVE origin for the token
  // consume is the CMS site origin the embed forwards (the browser cannot send
  // it — see WIDGET_ORIGIN_HEADER), matching the capabilities route.
  const requestOrigin = request.headers.get("Origin");
  const forwardedOrigin = request.headers.get(WIDGET_ORIGIN_HEADER);

  const raw = (await request.json().catch(() => null)) as unknown;
  const parsed = assistantChatBodySchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid assistant chat request shape", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  // The broker-auth branch is ONLY reachable for a public-site widget assistant.
  // Resolve the CLOSED host binding (handle → agentSlug/instancesConfigKey/kind)
  // from the caller's `body.assistant`. A missing/unknown handle (or the built-in
  // "cinatra") presenting a `cit_` token is a fail-closed 403 — a `cit_` token is
  // NEVER valid for the cookie-session assistant surface.
  const handle = parsed.data.assistant?.trim().toLowerCase() ?? "";
  const binding = resolveAssistantWidgetBinding(handle);
  if (!binding) {
    return new Response("Forbidden", { status: 403 });
  }

  // Resolve the widget-stream union for the bound agentSlug (build-time ∪
  // runtime-approved, serve-time re-verified) — the SAME resolution the stream
  // route uses, so the point-of-use grant re-assert + CORS origin allowlist +
  // entry.auth are consistent. Null → 404.
  const resolved = await resolveWidgetStreamAgentUnion(binding.agentSlug, undefined, {
    requestSource: widgetStreamRequestSource(request),
  });
  if (!resolved) {
    return Response.json({ error: "Unknown assistant" }, { status: 404 });
  }
  const entry = resolved.entry;

  // CORS is RESPONSE-HEADER POLICY only — never the authorization mechanism. We
  // resolve the request Origin against the configured-instance allowlist to
  // SOURCE the reflected Access-Control-Allow-Origin; the AUTHORITATIVE gate is
  // the token-bound origin checked inside consumeWidgetStreamToken below.
  const allowedOrigin = resolveWidgetStreamOrigin(requestOrigin, entry.auth);
  const corsHeaders = buildWidgetStreamCorsHeaders(allowedOrigin ?? requestOrigin ?? "");

  const hasProvider = await hasConfiguredLlmRuntime();
  if (!hasProvider) {
    return Response.json({ error: "No LLM provider configured." }, { status: 400, headers: corsHeaders });
  }

  // ----- cit_ SHORT-LIVED PATH. The token is authoritative: it binds
  // origin/aud/scope/expiry and is re-checked against the STORED row + live
  // config. The aud is the UNIFIED chat route (S5 audience re-scope), so a token
  // minted for the OLD stream aud fails aud_mismatch here — and vice versa.
  const consumed = consumeWidgetStreamToken({
    token: citToken,
    agentSlug: binding.agentSlug,
    auth: entry.auth,
    routePath: WIDGET_BROKER_ROUTE_PATH,
    requestOrigin: forwardedOrigin,
  });
  if (!consumed.ok) {
    console.warn(`[assistant-chat:${binding.handle}] cit_ token rejected:`, consumed.reason);
    return new Response("Unauthorized", { status: 401, headers: corsHeaders });
  }
  // Re-checked against the stored row AND the live configured-instance list.
  const verifiedOrigin = consumed.origin;

  // -------------------------------------------------------------------------
  // DUAL-TOKEN per-user validation (FAIL-CLOSED BY DEFAULT) — ported verbatim
  // from the stream route. Every request reaching THIS broker-auth branch is
  // the interactive `public_site_widget` surface, so the per-user `cwu_` token
  // is REQUIRED unless the entry EXPLICITLY opts out with `requireUserToken:
  // false`. Absent/true → enforce. ANY failure denies (401) with NO fallback to
  // any install/session/anonymous identity, and creates NO run.
  // -------------------------------------------------------------------------
  const userTokenHeader = request.headers.get(USER_TOKEN_HEADER)?.trim() ?? "";
  const userTokenPresent = userTokenHeader.length > 0;
  const requireUserToken =
    (entry.auth as { requireUserToken?: boolean }).requireUserToken !== false;

  // The single generic deny — never leaks WHICH check failed to the browser (a
  // scrubbed, reason-coded audit line is emitted server-side instead).
  const denyUserAuth = (reason: string): Response => {
    emitWidgetAuthAudit("assistant_chat_widget_token_rejected", {
      agentSlug: binding.agentSlug,
      siteOrigin: verifiedOrigin,
      reason,
      ip: request.headers.get("x-forwarded-for"),
      ua: request.headers.get("user-agent"),
    });
    return new Response("Unauthorized (widget login required)", {
      status: 401,
      headers: { ...corsHeaders, [WIDGET_AUTH_REQUIRED_HEADER]: "required" },
    });
  };

  if (requireUserToken && !userTokenPresent) {
    return denyUserAuth("user_token_required");
  }
  if (!userTokenPresent) {
    // An explicit opt-out (`requireUserToken: false`) is unsupported on the
    // broker-auth turn: the widget principal REQUIRES an authenticated end user
    // to run AS. Fail closed rather than dispatch without a per-user identity.
    return denyUserAuth("user_token_required");
  }

  const consumedUser = consumeUserWidgetToken({
    token: userTokenHeader,
    agentSlug: binding.agentSlug,
    routePath: WIDGET_BROKER_ROUTE_PATH,
    requestOrigin: forwardedOrigin,
  });
  if (!consumedUser.ok) {
    return denyUserAuth(consumedUser.reason);
  }
  const claims = consumedUser.claims;

  // TWO-TOKEN AGREEMENT — origin: the cit_-derived verifiedOrigin MUST equal the
  // cwu_-bound siteOrigin, so a valid user token for site A cannot ride a site
  // token for site B. Agent agreement is intrinsic (both consumes gated
  // agent_slug + aud == this route path; a wordpress cit_ under
  // assistant:"drupal" already failed agent_mismatch above — G9).
  if (normalizeOriginStrict(verifiedOrigin) !== normalizeOriginStrict(claims.siteOrigin)) {
    return denyUserAuth("origin_disagreement");
  }

  // CANONICAL RE-PIN: re-derive the canonical instance for the VERIFIED origin
  // via the strict resolver and assert it agrees with the token's server-derived
  // instanceId. Zero/multiple origin-matched rows, or a divergent id → deny.
  // This re-pins the write target to the verified origin's single canonical row
  // (the server-verified-origin authority the AUTH INVARIANT preserves EXACTLY).
  const reResolvedInstance = resolveCanonicalInstanceForOrigin({
    instancesConfigKey: entry.auth.instancesConfigKey,
    origin: verifiedOrigin ?? "",
    claimedInstanceId: claims.instanceId,
  });
  if (!reResolvedInstance || reResolvedInstance !== claims.instanceId) {
    return denyUserAuth("instance_binding_failed");
  }

  // LIVE org membership re-check BEFORE any run creation (up-front gate; the OBO
  // mint path re-checks live too, defense-in-depth). A non-member (or demoted
  // between mint and now) user is denied — no run created.
  const role = await resolveOrgRoleForUser(claims.orgId, claims.userId);
  if (!role) {
    return denyUserAuth("not_org_member");
  }

  // POINT-OF-USE grant re-assert (widget-stream runtime trust): immediately
  // before the turn runs, re-assert the pinned grant descriptor live. A
  // revocation that landed after resolution linearizes HERE — refuse with an
  // OPAQUE 404 (real reason server-side only) and create NO run.
  if (!(await reassertWidgetStreamGrantBeforeOboRun(resolved))) {
    console.warn(
      `[assistant-chat:${binding.handle}] point-of-use grant re-assert failed before OBO run — refusing (fail closed)`,
    );
    return Response.json({ error: "Unknown assistant" }, { status: 404, headers: corsHeaders });
  }

  // Build the SERVER-VERIFIED widget principal — the SINGLE source of the pinned
  // instance + connector kind + `public_site_widget` discriminator that ride the
  // widget OBO token across the MCP boundary. `instanceId` is the server-derived
  // canonical re-pin (== claims.instanceId, asserted above), never a body field.
  const widgetPrincipal: WidgetPrincipal = {
    kind: "public_site_widget",
    userId: claims.userId,
    orgId: claims.orgId,
    instanceId: reResolvedInstance,
    verifiedOrigin: verifiedOrigin ?? "",
    assistantHandle: binding.handle,
    instancesConfigKey: entry.auth.instancesConfigKey,
  };

  emitWidgetAuthAudit("assistant_chat_widget_dispatch_authorized", {
    actor: claims.userId,
    orgId: claims.orgId,
    siteId: claims.siteId,
    client: claims.client,
    agentSlug: binding.agentSlug,
    siteOrigin: claims.siteOrigin,
    instanceId: reResolvedInstance,
  });

  // Thread binding — UNCHANGED. The widget user is the caller; floored to
  // non-admin (isAdmin: false) and its own org. authorizeThreadForTurn's
  // persisted-ownership matrix is byte-identical.
  const authz = authorizeThreadForTurn({
    threadId: parsed.data.threadId,
    callerId: widgetPrincipal.userId,
    isAdmin: false,
    sessionOrgId: widgetPrincipal.orgId,
  });
  if (!authz.ok) {
    return Response.json({ error: authz.error }, { status: authz.status, headers: corsHeaders });
  }

  // Resolve the assistant's OWN persisted runtime config (the SAME generalized
  // resolution ladder the cookie-session selector branch uses). Unknown/corrupt
  // → 404, never a Cinatra fallback for a non-built-in principal.
  const resolvedHandles = await resolveAssistantHandles([binding.handle]);
  const assistantUserId = resolvedHandles.get(binding.handle);
  if (!assistantUserId) {
    return Response.json({ error: "Assistant not found" }, { status: 404, headers: corsHeaders });
  }

  // AC#3 audience closure (cinatra#1875 W2) + the FIRST-PARTY BUILT-IN exception
  // (cinatra#2031). Site auth is NOT an installed assistant's audience: the
  // dual-token sequence proved the end user is a legit member of the bound org for
  // this SITE, but for an INSTALLED assistant the verified end user must ALSO be IN
  // its audience — an out-of-audience end user 404-HIDES.
  //
  // The bound widget assistant here, however, is a boot-seeded FIRST-PARTY BUILT-IN
  // (WordPress / Drupal siblings of the @cinatra builtin, cinatra#1823): it carries
  // NO `assistant_audience` rows and has NO `installed_extension` row, so the W1
  // registry reader (installed-extension assistants + the single @cinatra builtin)
  // never lists it — the audience gate alone would 404 EVERY widget turn. The
  // CLOSED binding names the built-in's reserved package; recognizing the resolved
  // principal AS that first-party built-in admits it (it is the platform's own
  // always-available widget assistant), fail-closed and scoped to the EXACT
  // reserved package — never a global audience widen, never an installed assistant.
  // An installed (non-built-in) assistant still closes through the audience gate.
  const isBoundBuiltinAssistant = await isBuiltinAssistantByPackage(
    assistantUserId,
    binding.builtinPackageName,
  );
  if (
    !isBoundBuiltinAssistant &&
    !(await isSelectedAssistantVisible(assistantUserId, widgetSelectorCaller(widgetPrincipal)))
  ) {
    emitWidgetAuthAudit("assistant_chat_widget_out_of_audience", {
      actor: widgetPrincipal.userId,
      orgId: widgetPrincipal.orgId,
      agentSlug: binding.agentSlug,
      siteOrigin: verifiedOrigin,
    });
    return Response.json({ error: "Unknown assistant" }, { status: 404, headers: corsHeaders });
  }

  const resolvedConfig = await resolveAssistantRuntimeConfigByPrincipal({
    assistantUserId,
    handle: binding.handle,
  });
  if (!resolvedConfig.ok) {
    return Response.json({ error: "Assistant not found" }, { status: 404, headers: corsHeaders });
  }
  const runtimeConfig = resolvedConfig.runtimeConfig;

  // A MINIMAL, FLOORED ActorContext for the widget user — G5: platformRole is
  // hard-coded `member` (NEVER resolved live), so a widget user who is also a
  // platform admin gets no elevated standing on any downstream authz. The OBO
  // token independently floors the MCP boundary; this floors the runtime's own
  // actor dimension. Least-privilege: no team/project grants are carried.
  const widgetActorContext: ActorContext = {
    principalType: "HumanUser",
    principalId: widgetPrincipal.userId,
    organizationId: widgetPrincipal.orgId,
    teamIds: [],
    projectGrants: [],
    projectIds: [],
    platformRole: "member",
    orgRole: "member",
    authSource: "a2a",
    policyVersion: POLICY_VERSION,
  };

  const messages: ChatRequestMessage[] = parsed.data.messages;
  const runProducer: Parameters<typeof streamAgUiChatTurn>[0]["runProducer"] = (send, signal) =>
    runAssistantTurn(runtimeConfig, {
      messages,
      actorContext: widgetActorContext,
      userId: widgetPrincipal.userId,
      platformRole: "member",
      sessionOrgId: widgetPrincipal.orgId,
      send,
      signal,
      widgetPrincipal,
    });

  const response = await streamAgUiChatTurn({
    request,
    threadId: parsed.data.threadId,
    mirrorOrgId: authz.mirrorOrgId,
    needsStructuredRow: authz.needsStructuredRow,
    userId: widgetPrincipal.userId,
    isAdmin: false,
    runProducer,
    // Mint the DISTINCT run-bound resume token from the SAME server-verified
    // widget principal (userId/orgId/pinned instance/kind) — option A per the
    // #1221 owner ruling. The harness delivers it on the turn response so the
    // cross-origin embed can resume under broker auth; the chat-audience broker
    // token is NEVER accepted at the resume seam. A fresh per-run `jti`.
    mintResumeToken: (runId) =>
      issueWidgetChatResumeToken({
        userId: widgetPrincipal.userId,
        orgId: widgetPrincipal.orgId,
        instanceId: widgetPrincipal.instanceId,
        kind: widgetPrincipal.assistantHandle,
        runId,
        jti: randomUUID(),
      }),
  });
  // Reflect CORS onto the streamed response so the cross-origin widget can read
  // it (the harness builds a same-origin Response; the widget surface needs the
  // Access-Control-* headers the preflight advertised).
  for (const [key, value] of Object.entries(corsHeaders)) {
    response.headers.set(key, value);
  }
  return response;
}

// ---------------------------------------------------------------------------
// Branch 1 — the cookie-session turn (BYTE-IDENTICAL to before S5).
// ---------------------------------------------------------------------------
async function handleCookieSessionTurn(request: Request): Promise<Response> {
  const raw = (await request.json().catch(() => null)) as unknown;
  const parsed = assistantChatBodySchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid assistant chat request shape", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { threadId } = parsed.data;
  const messages: ChatRequestMessage[] = parsed.data.messages;

  const hasProvider = await hasConfiguredLlmRuntime();
  if (!hasProvider) {
    return Response.json({ error: "No LLM provider configured." }, { status: 400 });
  }

  const session = await getAuthSession();
  const userId = session?.user?.id;
  if (!userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const actorContext = await requireActorContext();
  const isAdmin = isPlatformAdmin(session);
  const platformRole: "platform_admin" | "member" = isAdmin ? "platform_admin" : "member";
  const sessionOrgId =
    (session?.session as { activeOrganizationId?: string | null } | undefined)
      ?.activeOrganizationId ?? null;

  const authz = authorizeThreadForTurn({
    threadId,
    callerId: userId,
    isAdmin,
    sessionOrgId,
  });
  if (!authz.ok) {
    return Response.json({ error: authz.error }, { status: authz.status });
  }

  // Producer selection (cinatra#1823, epic #1037 P4.1). ABSENT `assistant` keeps
  // the historical @cinatra binding (`runChatTurn`, byte-identical). A selector
  // resolves the target assistant's OWN runtime config from its PERSISTED sidecar
  // via the `assistant_user_id` link (the generalized resolution ladder) and
  // drives the SAME extracted runtime — so WordPress/Drupal (or any registered
  // assistant) are reachable here under the SAME authorization policy as @cinatra
  // (the thread-binding authz above is unchanged). An unknown handle or an
  // unresolvable/corrupt config fails CLOSED (404) — never a Cinatra fallback for
  // a non-built-in principal.
  let runProducer: Parameters<typeof streamAgUiChatTurn>[0]["runProducer"];
  if (parsed.data.assistant === undefined) {
    runProducer = (send, signal) =>
      runChatTurn({ messages, actorContext, userId, platformRole, sessionOrgId, send, signal });
  } else {
    const handle = parsed.data.assistant.trim().toLowerCase();
    const resolvedHandles = await resolveAssistantHandles([handle]);
    const assistantUserId = resolvedHandles.get(handle);
    if (!assistantUserId) {
      return Response.json({ error: "Assistant not found" }, { status: 404 });
    }
    // AC#3 audience closure (cinatra#1875 W2). The picker surfaces the caller's
    // audience-visible set (the W1 reader); the chosen handle is re-resolved
    // actor+audience-scoped HERE so a forged out-of-audience selection 404-hides
    // instead of dispatching. The built-in @cinatra is always visible (the reader
    // unions it); an installed assistant is gated by its audience grants.
    if (
      !(await isSelectedAssistantVisible(
        assistantUserId,
        sessionSelectorCaller(userId, sessionOrgId, platformRole),
      ))
    ) {
      return Response.json({ error: "Assistant not found" }, { status: 404 });
    }
    const resolved = await resolveAssistantRuntimeConfigByPrincipal({ assistantUserId, handle });
    if (!resolved.ok) {
      return Response.json({ error: "Assistant not found" }, { status: 404 });
    }
    const runtimeConfig = resolved.runtimeConfig;
    runProducer = (send, signal) =>
      runAssistantTurn(runtimeConfig, {
        messages,
        actorContext,
        userId,
        platformRole,
        sessionOrgId,
        send,
        signal,
      });
  }

  return streamAgUiChatTurn({
    request,
    threadId,
    mirrorOrgId: authz.mirrorOrgId,
    needsStructuredRow: authz.needsStructuredRow,
    userId,
    isAdmin,
    runProducer,
  });
}
