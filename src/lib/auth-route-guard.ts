import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import {
  GENERATED_WIDGET_STREAM_PUBLIC_PATHS,
  GENERATED_WIDGET_STREAM_TOKEN_PATHS,
  GENERATED_WIDGET_STREAM_CAPABILITY_PATHS,
} from "@/lib/generated/widget-stream-public-paths";
import { isRuntimeApprovedWidgetStreamPublicPath } from "@/lib/widget-stream-runtime-slug-snapshot";
import {
  frameAncestorsDirectiveFor,
  resolveVerifiedWidgetFrameOrigin,
} from "@/lib/embed/frame-ancestors.server";
import { CURRENT_PATH_HEADER, buildSignInPath } from "@/lib/auth-redirect-target";

const PUBLIC_PATH_PREFIXES = [
  "/permissions",
  "/api/auth",
  "/api/nango/webhook", // Nango auth-event webhook receiver — auth enforced inside the nango-connector route handler (HMAC-SHA256 over the raw body keyed by the Nango environment API secret key NANGO_SECRET_KEY, matching how self-hosted nango-server signs the X-Nango-Hmac-Sha256 header); an unsigned/invalid/unconfigured signature fails closed. The sender is an unauthenticated third party (Nango), so there is no session.
  "/api/mcp",      // MCP transport — auth is enforced by the transport handler itself
  "/api/cli",      // cinatra CLI control-plane — auth enforced inside each route handler via authorizeCliRequest (src/lib/cli-api/route-guard.ts): a Better-Auth session, a JWKS-verified OAuth Bearer on the DEDICATED /api/cli audience (reciprocal isolation from /api/mcp above) with per-endpoint scope + LIVE role resolution, or the loopback dev-admin bypass. The published `cinatra` bin drives a remote instance as a COOKIELESS OAuth API client, so without this exemption guardAppRoute 307s every /api/cli/* request (reconcile / status / agent export|import) to /sign-in before authorizeCliRequest runs — the CLI then receives the /sign-in HTML and crashes parsing it as JSON. Reachability only; the route still self-authorizes (a caller with no valid Bearer/session/bypass gets the route's own 401, never data).
  "/api/a2a",      // A2A transport — auth enforced inside route handlers (Bearer JWT)
  "/api/llm-bridge", // WayFlow ApiNode bridge — bridge-token auth enforced inside via isAuthorizedBridgeRequest
  "/api/context-resolve",  // Context-selection-agent resolve ApiNode — bridge/JWT auth + run-bound actor enforced inside (deriveContextRouteContext)
  "/api/context-finalize", // Context-selection-agent finalize ApiNode — bridge/JWT auth + run-bound actor enforced inside (deriveContextRouteContext)
  "/api/agents/passthrough", // Deterministic-dispatch passthrough — bridge-token auth enforced inside via isAuthorizedBridgeRequest
  "/api/oas-lint",   // Agent-lint-policy scan-all endpoint — bridge-token auth enforced inside via isAuthorizedBridgeRequest
  "/api/review",     // Review-merge endpoint — bridge-token auth enforced inside via isAuthorizedBridgeRequest. The route is kept for external callers that want the trust boundary without writing TypeScript. Host-app callers SHOULD use mergeReviewLanes from @cinatra-ai/agents directly.
  "/api/auditor",    // run-skills WayFlow ApiNode callback — bridge-token auth enforced inside via isAuthorizedBridgeRequest (direct UI/MCP callers still require a session in-handler). cinatra#1796 / #2047 row 8: the /apply + /exclude callbacks under this prefix were DELETED with the auditor retirement; run-skills was outside the authorized scope and is kept, so the prefix stays. Codex flagged the breadth of this exemption as a bounded latent risk — narrowing it (or removing run-skills outright) is an owner-gated follow-up, NOT this PR.
  "/.well-known",  // OAuth / OIDC discovery metadata (RFC 8414, RFC 8707)
  "/api/connect/token", // cinatra#221 Connect provisioning code/install-code exchange — server-to-server (CMS backend); auth enforced inside via the authorization-code/PKCE/install-code itself (no session, no cookies). NOTE: /connect/authorize is NOT exempted — it stays session-gated (org-admin consent screen).
  "/api/connect/site-inventory", // cinatra#2018 (S3) PR-D, absorbed by cinatra#2021 (S6): the authenticated WordPress site-inventory intake — server-to-server (the site plugin, never a browser); auth enforced inside via the per-site `cnx_` credential + paired Origin binding (no session, no cookies), mirrors /api/connect/token.
  "/api/widget-auth", // cinatra#2674 (epic #2564 S8e) — the hosted-PKCE login's API surface. `/frame/init` + `/frame/token` are the FRAME-OWNED flow: called SAME-ORIGIN by cinatra's own embed iframe, which holds no session (that is what the flow is for), and authorized INSIDE each handler by the same-origin gate plus the server-side re-derivation of site/org/origin/agent/instance from cinatra's own rows — never by a caller-presented credential. `/init` + `/token` are the RETIRED site-mediated pair: exempted so a legacy CMS backend receives their honest 410 instead of a /sign-in redirect that would read as a network fault. NOTE: the /widget-auth PAGE is exempted separately below (it must render the login form for a SESSIONLESS visitor instead of 307→/sign-in).
  "/api/health",   // Unauthenticated host-native Next.js health probe for local startup polling; no session is available
  "/api/extensions/purge", // Human-origin `cinatra extensions purge` CLI loopback POST — auth enforced inside the route handler (NODE_ENV!=production + CINATRA_RUNTIME_MODE=development + loopback-only, mirrors /api/skills/reset-repo). Without this exemption guardAppRoute 307s the unauthenticated loopback CLI to /sign-in before the handler's triple-guard runs.
  "/webhook", // cinatra#340 generic inbound-webhook namespace — a webhook arrives from an unauthenticated connected site; auth is the Standard-Webhooks signature enforced INSIDE the route (verified via the per-binding secret resolved from the server-issued opaque bindingId, never the payload). One static namespace prefix (the route owns the declared→dispatch / undeclared→404 verdict, so an undeclared hook 404s rather than 307s); do NOT import GENERATED_WEBHOOK_PUBLIC_PREFIXES here.
];

// Only the CMS content-editor agent stream slugs are widget-public.
// These are hit by unauthenticated browser widgets (CMS admin pages) and the
// route handler enforces auth via CORS Origin allowlist + Bearer API key
// (see src/app/api/agents/[agentSlug]/stream/route.ts — generic widget-stream
// origin/token validation). The list is GENERATED from each extension's
// cinatra.widgetStream declaration (slug-only, proxy-bundle-safe file) — adding
// a widget-stream extension requires no edit here. Do NOT generalize to a
// /api/agents prefix — other agent routes must continue to require a session.
const PUBLIC_AGENT_STREAM_PATHS = GENERATED_WIDGET_STREAM_PUBLIC_PATHS;

// Token-exchange + capabilities siblings of each widget-stream slug (cinatra#220),
// GENERATED from the same cinatra.widgetStream declarations as the stream paths.
// "Public path" here means "skip the Better-Auth session redirect so the route
// enforces its OWN auth" — a self-authenticating route NOT on this list gets
// 307'd to /sign-in before its handler runs. Each route still enforces auth:
//   - .../token: server-to-server long-lived-key Bearer auth INSIDE the handler;
//   - .../capabilities: AUTH-FREE static contract metadata (leaks no instance data).
// Exact slug paths only — do NOT broaden to an /api/agents prefix (that would
// make every agent route public).
const PUBLIC_AGENT_TOKEN_PATHS = GENERATED_WIDGET_STREAM_TOKEN_PATHS;
const PUBLIC_AGENT_CAPABILITY_PATHS = GENERATED_WIDGET_STREAM_CAPABILITY_PATHS;

// cinatra#1221 S5 Lane B (§2/§7). The provisional embed-page path (OQ2): if it
// is renamed, ONLY this constant + the CMS iframe `src` change; the bridge and
// schemas are stable.
const EMBED_ASSISTANT_PATH = "/embed/assistant";

const PUBLIC_EXACT_PATHS = [
  "/favicon.ico",
  "/sign-in",
  "/sign-up",
  "/widget-auth", // cinatra#407 hosted widget login — a SESSIONLESS visitor must render the login form here (NOT be 307'd to /sign-in). The page itself reads a present session normally and gates issuing a code on org membership + explicit consent. Exact path only (the ?txn=... query carries the transaction id).
  "/api/assistants/chat", // cinatra#1221 S5 — the UNIFIED assistant chat route also serves the public-site (WordPress/Drupal) widget via its broker-auth branch (Bearer cit_ + X-Cinatra-Widget-User-Token cwu_). A cross-origin browser widget holds no cookie, so the middleware must NOT 307 it to /sign-in — the route's OWN dual-token fail-closed sequence is the authoritative gate (a non-widget, session-less request still 401s inside the handler; the cookie-session @cinatra path is byte-unchanged). Exact path only (no widget subpaths are public).
  "/api/assistants/chat/capabilities", // cinatra#1998 Lane A (epic #1216 S6) — the capability-negotiation surface the cross-origin embed GETs client-side with `credentials:"omit"` + the SAME broker-auth headers (Bearer cit_ + X-Cinatra-Widget-User-Token cwu_ + the forwarded parent origin/handle). A sessionless broker embed holds no cookie, so the middleware must NOT 307 it to /sign-in before the handler's OWN dual-token fail-closed sequence can authenticate it and serve the static advertisement (a sessionless, non-broker request still 401s inside the handler; the cookie-session /chat negotiation is byte-unchanged). Exact path only.
  EMBED_ASSISTANT_PATH, // cinatra#1221 S5 Lane B — the Cinatra-served embed page GET /embed/assistant (§2). A SESSIONLESS cross-origin CMS end user must RENDER the iframe shell here, not be 307'd to /sign-in (exactly like /widget-auth). The page renders NO user data before a bootstrap; tokens are NEVER in the URL — they arrive only via the postMessage bootstrap (§4). The per-request `frame-ancestors` CSP is applied below (§7). Exact path only (the ?instanceId=…&assistant=… query carries the non-secret disambiguators).
  "/lifecycle/review-island", // cinatra#2674 scope addition (2026-08-12) — the review-target island. Its audience includes a COOKIELESS `<iframe>` load inside cinatra's own embed iframe on a genuinely third-party CMS page, where a SameSite-bound session cookie is simply not sent; without this exemption guardAppRoute 307s that frame to /sign-in and the island can never paint on the deployments the parity criterion is about. Reachability only — the PAGE still authorizes: with `?ic=` it requires a sealed, unexpired, REF-BOUND island credential whose live `cwu_` principal, site binding and org standing all still hold (src/lib/lifecycle/review-island-serving.ts), and without one it requires a session exactly as before, redirecting when there is none. Every refusal draws the same empty island. Exact path only — never a prefix.
  "/api/lifecycle-views/capture", // cinatra#2576 (epic #2564 S8c) widget capture egress — auth enforced inside the route handler by the SEALED CAPABILITY IN THE URL ITSELF (decideCaptureCapabilityServe's six-rung ladder in src/lib/lifecycle/capture-capability-serving.ts: transport shape → sealed+unexpired capability → live `cwu_` principal/revocation edge → live run-read access → gate binding → capture-PNG bytes); every capture request the ladder denies gets the ONE refusal, an empty 404 with identical headers. The route's ENTIRE audience is a COOKIELESS `<img>` subresource load inside cinatra's own embed iframe — a broker `cwu_` reader holds no Better-Auth cookie and an `<img>` carries no bearer header — so without this exemption guardAppRoute 307s every capture request to /sign-in (echoing the capability into `next=`) and the handler never runs; the browser then tries to decode the /sign-in HTML as a PNG and the card shows a broken picture. Reachability only; the route still self-authorizes (a caller with no valid capability gets the route's own empty 404, never bytes). EXACT path, never a prefix — the path must stay byte-equal to CAPTURE_CAPABILITY_ROUTE, and a prefix entry would also exempt any DESCENDANT that a later parent catch-all or rewrite made routable. The siblings /api/lifecycle-views/resolve and /api/lifecycle-views/decide serve a widget branch too and carry their own entries below.
  "/api/lifecycle-views/resolve", // cinatra#2577 (epic #2564 S8d) the lifecycle card's authoritative refetch — now serving TWO auth branches, and the second one holds no cookie. The widget branch presents the broker `cwu_` proof header with `credentials:"omit"` from cinatra's own embed iframe, so without this exemption guardAppRoute 307s it to /sign-in and the card silently never resolves (it renders no DOM on a failed resolve, so the failure is INVISIBLE — the reason this needs to be stated rather than discovered). Reachability only: the handler still authenticates both branches itself (session → resolveReviewActorContext; widget → the S8a actor door, which consumes the token at THIS route's audience with `lifecycle.read` required), and it refuses a caller it cannot place with a 401 — never a session fallback behind a failed widget consume. EXACT path, never a prefix, for the same reason the capture entry above is exact.
  "/api/lifecycle-views/decide", // cinatra#2577 + #2575 (epic #2564 S8d/S8b) the ONE gate-scoped decision entry — now serving TWO auth branches, and the second holds no cookie. The widget review card POSTs it from cinatra's own embed iframe with `credentials:"omit"` and the broker `cwu_` proof header, so without this exemption guardAppRoute 307s the decision to /sign-in and the card reports a transport failure for a decision that never reached the core. Reachability only, and the ONLY entry in this list that admits a MUTATING route — so state the self-authorization exactly: the handler places the caller before it reads anything (session -> resolveReviewActorContext; widget -> the S8a actor door, consumed at THIS route's audience with `lifecycle.decide` required and NO session fallback behind a failed widget consume), 401s a caller it cannot place, then runs run READ, then hands the decision to the one core decision module, which re-checks the decision op, the pinned target set, the provenance and the gate CAS. A cookieless caller with no valid widget token therefore reaches a 401, never a decision. EXACT path, never a prefix.
  "/api/lifecycle-views/recommendation-hold", // cinatra#2790 (epic #2784 S9f) the run-start skills question's BROKER READ — the ONE lifecycle kind with no view ref to post at /api/lifecycle-views/resolve above, because its carriage is a typed INTERRUPT rather than a DATA_PART, so it is addressed by the run the transcript already names and needs a path of its own. Its ENTIRE audience is cookieless by construction: the first-party hosts keep their cookie-bound server action and never call this route at all, and the only caller is the site widget's embed frame, which POSTs with `credentials:"omit"` and the broker `cwu_` proof header. Without this exemption guardAppRoute 307s that POST to /sign-in; `fetch` follows the redirect with the METHOD AND BODY INTACT (a 307 preserves both), /sign-in is a page route that serves GET only and refuses it, the transport bails on the non-OK response, and the card renders NOTHING — the same INVISIBLE failure class the resolve entry above exists for, and the one MEASURED on this route before this entry existed (the run is genuinely blocked on an answer the person is never shown, which reads as a hung assistant rather than as a failure). Reachability only, and this route takes NO session at all: it resolves the caller from the presented `cwu_` ALONE, consumed at THIS route's audience with `lifecycle.read` required, and 401s every request without one — there is no session fallback to fall back TO, which is the point of the slice, because the frame is same-origin to the app and an ambient cookie would otherwise answer as whoever else is signed in on that browser. Behind the credential a SECOND gate runs before any state is read: the named run must be this person's OWN run in the org the TOKEN is bound to (`widgetSessionOwnsRun`), so an unrelated run id cannot be projected into a widget thread even by a reader whose standing could read that run elsewhere in the app; a failure answers with the same `{ state: "none" }` a run that was never held produces, so a caller holding a run id learns nothing about which runs exist. EXACT path, never a prefix — and here that is not a formality: `/decide` below is a DESCENDANT of this path and carries its own entry, its own audience and its own grant precisely because this entry does not admit it.
  "/api/lifecycle-views/recommendation-hold/decide", // cinatra#2790 (epic #2784 S9f) the run-start DECISION — confirm / adjust / skip on the skills question above — and a MUTATING route, so state the self-authorization exactly. Same cookieless audience as its parent and for the same reason, but a 307 costs more here than an unanswered read: `fetch` follows the redirect with the method and body intact (a 307 preserves both, which is exactly why the request is not simply lost), /sign-in serves GET only and refuses the POST, and the transport turns that non-OK answer into the row's OWN fixed refusal — so the person is told nothing was decided, the run stays blocked, and no decision ever reached the core, with nothing anywhere naming the proxy that ate it. Reachability only. The route takes NO session: the caller is resolved from the presented `cwu_` alone, consumed at THIS route's OWN audience — a SEPARATE audience from the read above — under `lifecycle.decide`, a SEPARATE grant, so a widget session holding only the read can be shown the question and cannot answer it. A caller it cannot place gets a 401, with NO session fallback behind a failed consume. Then, BEFORE any write: the run READ through the same access door the core runs, and the run ↔ widget-session binding (`widgetSessionOwnsRun`), so a decision aimed at a run this conversation does not own leaves no trace on it. Only then is the decision handed to `confirmRecommendationForActor` / `skipRecommendationForActor` — the SAME two functions the cookie-bound server action calls, which run the same hold-instance CAS, the same execute-tier selection write, the same verified release, the same resume announcement and the same dispatch, in the same order, taking the actor the door built; what differs is where the identity came from, and nothing else. Every refusal is the same one: "you may not decide this run", "that hold is stale" and "there is no such run" answer identically at 200. A cookieless caller with no valid widget token therefore reaches a 401, never a decision. EXACT path, never a prefix — it is listed SEPARATELY from its parent above because the exact list does not admit descendants, which is the property that keeps a later parent catch-all or rewrite under this subtree from inheriting either exemption.
  "/api/lifecycle-views/hitl-screen", // cinatra#2930 (lifecycle-b W3) the BROKER READ of the question an agent paused to ask — the SECOND lifecycle kind whose carriage is a typed INTERRUPT rather than a DATA_PART, so like the recommendation hold above it mints no view ref to post at /api/lifecycle-views/resolve and is addressed by the run the transcript already names. Its ENTIRE audience is cookieless by construction: the first-party hosts keep their cookie-bound server action and never call this route at all, and the only caller is the site widget's embed frame, which POSTs with `credentials:"omit"` and the broker `cwu_` proof header. Without this exemption guardAppRoute 307s that POST to /sign-in; `fetch` follows the redirect with the METHOD AND BODY INTACT (a 307 preserves both), /sign-in serves GET only and refuses it, the transport bails on the non-OK answer, and the card renders NOTHING — the INVISIBLE failure class the resolve and recommendation-hold entries above exist for, and one that reads as a hung assistant because the run really is blocked on an answer the person is never shown. Reachability only, and this route takes NO session at all: the caller is resolved from the presented `cwu_` ALONE, consumed at THIS route's audience with `lifecycle.read` required, and every request without one gets a 401 — there is no session fallback to fall back TO, which is the point, because the frame is same-origin to the app and an ambient cookie would otherwise answer as whoever else is signed in on that browser. Behind the credential a SECOND gate runs before any state is read: the named run must be this person's OWN run in the org the TOKEN is bound to (`widgetSessionOwnsRun`), and a failure answers with the same `{ state: "none" }` a run that was never paused produces, so a caller holding a run id learns nothing about which runs exist. EXACT path, never a prefix — `/submit` below is a DESCENDANT and carries its own entry, its own audience and its own grant precisely because this entry does not admit it.
  "/api/lifecycle-views/hitl-screen/submit", // cinatra#2930 (lifecycle-b W3) the BROKER ANSWER to that question — the run's own HITL gate, submitted from the widget — and a MUTATING route, so state the self-authorization exactly. Same cookieless audience as its parent and for the same reason, but a 307 costs more here than an unanswered read: `fetch` follows it with the method and body intact, /sign-in serves GET only and refuses the POST, the transport turns that non-OK answer into "the answer did not land", and the person is told nothing was continued while the run stays blocked and no answer ever reached the approval core — with nothing anywhere naming the proxy that ate it. Reachability only. The route takes NO session: the caller is resolved from the presented `cwu_` alone, consumed at THIS route's OWN audience — a SEPARATE audience from the read above — under `lifecycle.decide`, a SEPARATE grant, so a widget session holding only the read can be shown the question and cannot answer it. A caller it cannot place gets a 401, with NO session fallback behind a failed consume. Then, BEFORE any write: the run READ through the same access door the core runs; the run <-> widget-session binding (`widgetSessionOwnsRun`); and the gate binding — the run's OWN parked gate is re-derived and the submitted review task AND field must be that gate, so a caller cannot borrow another run's gate id or answer an input the run was not asking. Only then is the answer handed to `approveReviewTaskInternal` — the SAME auth-neutral core the cookie-bound server action calls, which enforces `run.execute` then `run.approveHitl` against the run it resolves and then runs the same merge, the same CAS and the same re-enqueue; what differs is where the identity came from, and nothing else. Every refusal is the same one, at 200. A cookieless caller with no valid widget token therefore reaches a 401, never a resume. EXACT path, never a prefix — it is listed SEPARATELY from its parent above because the exact list does not admit descendants, which is what keeps a later parent catch-all or rewrite under this subtree from inheriting either exemption.
  "/api/assistants/list", // cinatra#2683 (epic #2564 S8f) the participant directory the composer's @-mention flyout draws from — a READ that now serves TWO auth branches, and the second one holds no cookie. S8f gave this route its widget branch (`isWidgetBranchRequest` → the conversation door at this route's audience, `conversation.read` required) but not its reachability, so the embed frame's `credentials:"omit"` GET was 307'd to /sign-in, `fetch` FOLLOWED the redirect, and the client parsed the sign-in HTML as the directory — a 200 that yields an empty list. The flyout then cannot open at all (`recomputeMentionState` returns early on an empty list), which reads as "the widget has no @-mentions" rather than as a failure: the same INVISIBLE class the resolve entry above exists for. Reachability only — the handler still places the caller itself (session → better-auth; widget → the door, with no session fallback behind a failed consume), 401s one it cannot place, and tenant-scopes the directory to a PROVEN current membership either way, so a widget session enumerates exactly the co-members its holder enumerates in the app. EXACT path, never a prefix. The five sibling routes S8f also gave widget branches carried the same defect and are NOW FIXED, each under its own entry and its own reasoning rather than a batch exemption written by the lane that needed the directory: /api/assistants/autosave, /api/chat/pending-tool-calls, /api/chat/undo-candidate and /api/artifacts/upload below, and /api/assistants/threads/<threadId> in the PATTERN form (ASSISTANT_THREAD_BY_ID_PATH) — the path carries the thread id, so it is the one that cannot be exact.
  "/api/assistants/autosave", // cinatra#2683 (epic #2564 S8f) the Skill-autosave account setting the composer's prompt-options flyout shows and flips — ONE route carrying TWO operations, now serving TWO auth branches, and the second holds no cookie. WITHOUT THIS the flyout is WRONG IN BOTH DIRECTIONS and never says so: the GET is 307'd, `fetch` follows it, the client parses the sign-in HTML, `fetchChatCaptureConfig` returns null and the row is simply ABSENT (a reader who may configure autosave sees no control at all); a PATCH is 307'd to a GET of /sign-in — a redirect a browser follows with the METHOD DROPPED — so the request 200s, the switch appears to take, and nothing was written. A silently-discarded write is the reason this route gets its own entry rather than riding the read's. Reachability only, and the SCOPE SPLIT is what makes admitting a mutating route here safe: the handler branches on the presented credential (`isWidgetBranchRequest` → the ONE conversation door), consumes GET under `conversation.read` and PATCH under `conversation.write` at THIS route's audience, and 401s a caller it cannot place with NO session fallback behind a failed consume — so a widget session holding only the read cannot reach the write at all. PATCH THEN HAS TWO ARMS, and stating only one of them would misdescribe what this entry admits (codex round 1, finding 3): `enabled` is the APP-WIDE switch and is refused for anyone who is not a platform admin — `can(actor, "settings.update", {administration,*})` against an ORG-LESS resource, which only platform_admin resolves — with a strict pre-write audit that aborts the mutation if the audit write fails; `userChatCaptureEnabled` is the caller's OWN preference row, written for `actor.principalId` and no other, and refused for a non-admin while the admin `userCanConfigure` flag is off. Both arms take the SAME actor the read took, so a widget caller that got past `conversation.write` may change exactly what they may change in the app — and no more, since the read grant alone never reaches PATCH — and both run `rejectCrossOrigin` first — which the embed frame satisfies because it IS same-origin, and which a broker caller additionally backs with a token that guard never sees. EXACT path, never a prefix.
  "/api/chat/pending-tool-calls", // cinatra#2683 (epic #2564 S8f) the parked destructive tool calls — GET lists the caller's own, POST decides one. The widget frame asks with `credentials:"omit"` and the `cwu_` proof header; without this entry BOTH halves fail invisibly: the list 307s, `fetch` follows, the card component parses sign-in HTML, `rows` is undefined and the panel draws NO confirmation card — an action parked waiting on this person looks like an action that was never requested; and the decision POST is 307'd to a GET of /sign-in, which a browser follows WITHOUT the body or the method, so the card reports success for a confirmation that never reached the executor. Reachability only, and this is the SECOND mutating entry in this list (after /api/lifecycle-views/decide, whose pattern it copies exactly) — so state the self-authorization precisely: the handler places the caller BEFORE it reads anything (cookie → `requireAuthSession` + `requireActorContext`, and a session with no org or no session id resolves to NO caller rather than a partial one; widget → the conversation door at THIS route's audience), and the two operations require DIFFERENT grants — the list `conversation.read`, the decision `tools.confirm`, a separate consent because confirming a parked destructive call is a separate thing to agree to. `canDecide` is read off the SAME consume's claims, so a session holding only the read is served cards with NO decision tokens. The decision itself then travels the unchanged stage-4 executor, which re-verifies the decision token, the row ownership, the exactly-once consume CAS and the governed re-invoke. A cookieless caller with no valid widget token reaches a 401, never an execution. EXACT path, never a prefix.
  "/api/chat/undo-candidate", // cinatra#2683 (epic #2564 S8f) the undo chip's read — "did this run leave a change set I may still reverse?". A READ, and the answer is a change-set ID, which is an identifier for data the asker must prove they may see. The widget chip asks with `credentials:"omit"` + the `cwu_` header; without this entry the 307 is followed, the JSON parse yields no `changeSetId`, and the chip renders nothing — indistinguishable from "this run changed nothing", which is exactly the state a reader would believe. Reachability only: the handler branches on the presented credential, consumes the widget branch at THIS route's audience under `conversation.read` with NO session fallback behind a failed consume (this route is same-origin to the embed frame, which is precisely where an ambient cookie would answer as somebody else and hand the frame a stranger's change-set id), 401s a caller it cannot place, and then runs the ONE §VI per-object eligibility gate with the org the TOKEN is bound to — no administrator bypass, on either surface. An ineligible reader and a run that changed nothing get the SAME `{ changeSetId: null }`, so the route is not an existence oracle. IT CANNOT UNDO ANYTHING: the restore lives on the first-party surface the chip deep-links to and runs its own per-event authorization there, under the reader's own session. EXACT path, never a prefix.
  "/api/artifacts/upload", // cinatra#2683 (epic #2564 S8f) the composer's attachment upload — the ONLY entry in this list that admits a route which CREATES an object, so its reasoning is the longest by right. Without it a file picked inside somebody's website 307s to /sign-in, the browser follows the redirect as a GET, the bytes are dropped, and `uploadChatAttachments` surfaces the sign-in page's 200 as a refusal with no reason — the attachment silently never exists. Reachability only, and the self-authorization runs BEFORE a single byte is read: `resolveUploader` branches on the presented credential (`isWidgetBranchRequest` → the conversation door at THIS route's audience under `conversation.write`, with no session fallback behind a failed consume), returns null for every failure, and the route 401s on it. The owner is then the WIDGET PRINCIPAL and the org is the one the TOKEN is bound to — never a session's active org — and `createUploadedArtifact` files the result exactly as an in-app upload: `ownerLevel:"user"`, `visibility:"private"`, no client-supplied project frame, the 50 MiB cap enforced mid-stream, the fail-closed type refusal unchanged. There is no widget-shaped artifact and no widget-shaped upload path. The route's own SAME-ORIGIN check (`isAllowedOrigin`) is untouched and still applies to both branches — this entry removes the redirect, not a wall. EXACT path, never a prefix: `/api/artifacts/<id>/…` and the versioned byte routes underneath it stay session-gated, which is what keeps a cookieless caller from reading artifact bytes through a sibling of the door that lets them write one.
  "/api/assistants/threads", // cinatra#2683 (epic #2564 S8f item 1, WRITE HALF) the thread upsert — the COLLECTION path, admitted for its POST. The sibling `[threadId]` READ (ASSISTANT_THREAD_BY_ID_PATH below) restores a widget's transcript after a reload; until this entry there was nothing to restore, because a widget could never WRITE one. A turn's own durable rows carry a `run_id`, and the payload reconstruction reads only the legacy-mirror rows (`id LIKE 'legacy:%' AND run_id IS NULL`) that this upsert writes — `/chat` writes them on every turn through its cookie-bound writer, and the widget's `credentials:"omit"` POST was 307'd to /sign-in, which a browser follows AS A GET WITH THE BODY DROPPED: the request 200s, the client believes the conversation was kept, and the next reload opens on a blank panel. A silently-discarded write, exactly the class the autosave entry above exists for, with a whole conversation as the payload. Reachability only, and this is a MUTATING entry so state the self-authorization exactly: POST branches on the presented credential (`isWidgetBranchRequest` → the ONE conversation door at THIS route's audience under `conversation.write` — the read half consumes the same audience under `conversation.read`, so a session granted only the read can restore a transcript and cannot append to one), 401s a caller it cannot place, and NEVER falls back to a session behind a failed consume — which matters most here, because this route is same-origin to the embed frame and an ambient cookie would write the widget's turns into somebody else's conversation. The widget handler then derives ownership from the EXISTING row and never the body, floors platform standing, walls the write to the org the TOKEN is bound to, and refuses anything that is not this caller's own personal thread with the SAME 404 the read gives, so the endpoint is not an oracle for other people's thread ids. GET (the thread LIST) has NO widget branch and stays cookie-only in the handler — an enumeration of every conversation this person has ever had is not what a widget needs, and not opening it is the narrowing direction. EXACT path, never a prefix.
  "/api/development/lifecycle-seed", // cinatra#2683 (epic #2564 S8f) the in-process lifecycle SEED path — a DEVELOPMENT-ONLY, CAPABILITY-GATED, LOOPBACK test-support POST, exempted for exactly the reason /api/extensions/purge and /api/skills/reset-repo are: the caller is a local shell with no cookie, so guardAppRoute would 307 it to /sign-in before the handler's own fences could run, and the seeder would then read the sign-in HTML as its answer. Reachability only, and this one admits a WRITING route, so state its fences exactly — FOUR, independent, ALL required: (1) an explicit development runtime, allow-listed (CINATRA_RUNTIME_MODE === "development") under a non-production build (NODE_ENV !== "production"), checked separately so a mis-set runtime mode is still walled by the build; (2) the deterministic LLM provider's OWN gate, `assertScriptedProviderNotProduction`, plus the requirement that CINATRA_TEST_LLM_PROVIDER=scripted actually be set — the seed stages a scripted UAT stack or nobody, and reusing the provider's gate means the two test-only surfaces can never disagree about what "development" means; (3) a HIGH-ENTROPY PER-LAUNCH CAPABILITY (CINATRA_LIFECYCLE_SEED_TOKEN, >= 32 chars) presented as a bearer and compared in constant time, where UNSET MEANS THE ROUTE IS OFF — the default on every stack that did not deliberately arm it; (4) `application/json` only, no cross-site Origin/Sec-Fetch-Site, every advertised forwarding hop being on this machine, and a loopback authority. (That last one is a LOCAL-CHAIN check, not an absence check — MEASURED: Next's own dev server synthesises `x-forwarded-*` on the way into a route handler, so disqualifying on presence, as /api/skills/reset-repo does, refuses every request there is.) FENCE 3 IS THE LOAD-BEARING ONE AND FENCE 4 IS DEFENCE IN DEPTH, which is the opposite of the natural reading, so it is written down: `new URL(request.url).hostname` reflects the HOST HEADER, not the socket peer, so a dev server on a LAN or container interface answers `Host: localhost` from anywhere with no forwarded chain to give it away; and this very exemption means a hostile page in the operator's browser could otherwise drive the route cross-origin with a CORS-simple POST. The capability closes both. What it can write is narrow by construction: it holds NO SQL and drives only shipped writers (createSemanticArtifact → emitArtifactReviewGate → recordChangesRequested → createSemanticArtifact → submitRepairResponse; openChangeSet → historyAwareUpsert → closeChangeSet); the artifact type, the payload, the findings and the verdict are all PINNED in the driver, so there is no arm that writes caller-shaped row content; and before the first write it resolves the subject's LIVE membership, refuses a run belonging to another org, and derives the repair's `reauthorized` verdict from a real run-read check rather than a literal. EXACT path, never a prefix.
  "/api/openai/connection-status",
  "/api/app/setup-status",
  "/api/app/route-guard-status",
  "/setup/account", // cinatra#2386 — the first-account bootstrap step now lives INSIDE the setup wizard. A sessionless visitor must render the create-first-account form here (like /sign-up did before), not be 307'd to /sign-in. Exact path only — every other /setup/* route stays session-protected; the page itself re-checks hasAnyBetterAuthUsers()/the session before rendering (never trusts reachability alone), and its layout renders STATIC sign-up progress for the sessionless branch (no readiness-reader call, no setup-status disclosure to an unauthenticated visitor).
];

// Internal design-system verification route. Static React server component;
// renders only the shadcn primitive catalog, token swatches, and design
// fixtures. No DB queries, no user data. Public access is gated to
// non-production environments so the Playwright pixel-diff + axe-core harness
// (`tests/e2e/design/design-fixtures.spec.ts`) can capture baselines from a CI
// runner without an authenticated session, and so a production deployment still
// requires auth. Public auth bypasses should not become production precedent.
//
// Exception for the CI harness: the design-visual-verify workflow now runs
// against a PRODUCTION standalone build (NODE_ENV=production) — the legacy
// `pnpm dev` cold-compile of the app + 79 extensions exceeded any practical
// timeout. Under a production build the route would be auth-gated, so the
// unauthenticated readiness probe + Playwright would be 307'd to /sign-in. So
// the route is ALSO public when the explicit e2e switch
// `CINATRA_E2E_SETUP_BYPASS === "true"` is set — the SAME env the setup-wizard
// honors (src/lib/setup-wizard.ts), which is never set in a real production
// deployment. The route is dataless, so this exposes no user data even if the
// env were ever mis-set.
// "/design-fixtures/marketplace-detail-modal" (cinatra#989/#739): the §V
// detail-modal seeded-fixture route — same static, dataless, seeded-render
// contract as the index page (its Playwright guard runs in the same
// production-standalone design-visual-verify harness).
// "/design-fixtures/conformance" (cinatra#985): the design-conformance
// functional-acceptance harness — same static, dataless, seeded-render
// contract (real components mounted with deterministic fixtures; no DB, no
// user data); its Playwright suite runs in the same production-standalone
// design-visual-verify harness.
// "/design-fixtures/conformance/seeded" (cinatra#986): the SEEDED
// data-contract harness — real components rendered from the run-namespaced
// seeded fixture kit (deterministic fixture rows only; no user data). Its
// Playwright suite runs in the same production-standalone harness. Unlike its
// siblings it READS the canonical installed_extension store (fixture rows the
// seed endpoint provisioned); it exposes no user data.
// "/design-fixtures/conformance/seed" (cinatra#986): the seeded-fixture
// provisioning endpoint. The handler additionally SELF-GUARDS with the same
// non-production/CINATRA_E2E_SETUP_BYPASS contract and only ever writes
// deterministic fixture rows inside the @cinatra-e2e/<runId>-- namespace
// through the real extension lifecycle primitive.
// "/design-fixtures/agents-card" (cinatra#1121): the /agents All-Agents card
// accent-panel-as-detail-hotspot fixture — same static, dataless, seeded-render
// contract as its siblings (the real AgentAllCard mounted with an injected
// detail loader; no DB, no user data). Its Playwright guard runs in the same
// production-standalone design-visual-verify harness.
// "/design-fixtures/header-rule" (cinatra#1101): the page-header SECTION-RULE
// conformance harness — the REAL shared chrome (PageHeader divider + TabsListRow,
// both → <Separator major> → .divider-etched) mounted beside the app.html
// reference rule so the header-rule gate can pixel-classify the etched
// paired-line divider. Same static, dataless, seeded-render contract as its
// siblings (no DB, no user data); its Playwright suite runs in the same
// production-standalone design-visual-verify harness. Without this exemption
// guardAppRoute 307s the unauthenticated harness to /sign-in before the fixture
// renders, so the gate's own specs time out locating the fixture testids.
// "/design-fixtures/extension-settings" (cinatra#2349): the §V extension
// settings fixture — the REAL ExtensionSettingsView mounted against seeded
// props, including the per-agent Skills section's real client editor over
// driven server actions. Same static, dataless, seeded-render contract as its
// siblings (no DB, no user data; the driven actions read nothing and write
// nothing). The route predates this entry and was therefore only reachable on
// a dev server; adding it here is what lets the §V surface — and the Skills
// section's in-flight / refusal / degraded states — be driven on the
// production-standalone harness the rest of the family already uses.
// "/design-fixtures/run-step-rail" (cinatra#2840): the run detail's STEP RAIL
// row-geometry fixture — the REAL RunStepRailPanel mounted against a
// deterministic entry set so a wrapped lifecycle policy reason's row box is
// measurable in a browser. Same static, dataless, seeded-render contract as its
// siblings (no DB, no session, no user data). It is listed here for the SAME
// reason the header-rule entry above is: without it guardAppRoute 307s the
// unauthenticated harness to /sign-in under the production-standalone build,
// and the suite's assertions then fail on a fixture that never rendered — which
// is exactly what design-visual-verify reported at 7ba5e7fc (all 8 cases:
// "element(s) not found" waiting for the rail's rows).
// "/design-fixtures/overlay-header-band" (cinatra#3105): the overlay-vs-header
// GEOMETRY harness — the REAL shared select mounted under the app shell's own
// sticky header geometry, so the gate can assert an open panel never occupies
// the header band. Same static, dataless, seeded-render contract as its
// siblings (no DB, no session, no user data). It is listed here for the SAME
// reason the header-rule entry above is: without it guardAppRoute 307s the
// unauthenticated harness to /sign-in before the fixture renders, and every
// assertion then fails on a fixture that never rendered.
const DEV_ONLY_PUBLIC_EXACT_PATHS = [
  "/design-fixtures",
  "/design-fixtures/marketplace-detail-modal",
  "/design-fixtures/conformance",
  "/design-fixtures/conformance/seeded",
  "/design-fixtures/conformance/seed",
  "/design-fixtures/agents-card",
  "/design-fixtures/header-rule",
  "/design-fixtures/extension-settings",
  "/design-fixtures/run-step-rail",
  "/design-fixtures/overlay-header-band",
];
function isDevOnlyPublicPath(pathname: string) {
  if (!DEV_ONLY_PUBLIC_EXACT_PATHS.includes(pathname)) return false;
  if (process.env.NODE_ENV !== "production") return true;
  return process.env.CINATRA_E2E_SETUP_BYPASS === "true";
}

// cinatra#1881 — the assistant AG-UI resume/tail route
// (GET /api/assistants/runs/<runId>/stream). A cookieless caller resuming a
// dropped run (the S5 public-site CMS widget, #1221, under its run-bound resume
// token) holds no Better-Auth cookie, so the middleware must NOT 307 it to
// /sign-in before the handler's own fail-closed auth can run — matching the
// posture /api/assistants/chat already has. The handler
// (src/app/api/assistants/runs/[runId]/stream/route.ts) is the authoritative
// gate: MODE 1 a Better-Auth SESSION, else MODE 2 a DISTINCT, short-lived,
// RUN-BOUND resume token (`cinatra.widget.chat-resume`, #1855) verified against
// THIS exact runId + its own audience; any missing/invalid/expired/cross-run/
// cross-type token — and a sessionless caller with no token — is an EXPLICIT
// 401. NARROW dynamic matcher: the runId segment is a UUID (minted via
// randomUUID(), see src/lib/assistant-runtime/ag-ui-stream-route.ts) and the
// path must TERMINATE at /stream, so a sibling /api/assistants/runs/<id>/<other>
// or a non-UUID segment stays session-guarded. A too-narrow match only 307s a
// legit resume (self-healing → client degrades to a fresh mount); it can never
// open a protected route. Structural match ONLY — never an /api/assistants
// prefix (that would expose every sibling assistant API route).
//
// SCOPE (#1881, DEFERRED): this opens the SAME-ORIGIN cookieless resume path
// only. The cross-origin half stays deferred — the shared CORS builder still
// permits only POST/OPTIONS and does not expose/reflect the resume-token header,
// Authorization, or Last-Event-ID on a GET, so a real cross-origin resume
// additionally needs that header exposure + OPTIONS/GET origin reflection, which
// rides the embed wave. The CORS builder is intentionally UNTOUCHED here.
const ASSISTANT_RUN_STREAM_PATH =
  /^\/api\/assistants\/runs\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/stream$/;
function isAssistantRunStreamPath(pathname: string) {
  return ASSISTANT_RUN_STREAM_PATH.test(pathname);
}

// cinatra#2683 (epic #2564 S8f) — GET /api/assistants/threads/<threadId>, the
// widget's own transcript after the frame reloads. The ONLY one of S8f's six
// widget-branch routes that could not take an exact entry, because the path
// carries the thread id, so it takes the guard's PATTERN form instead — the
// same shape (and the same discipline) the run-stream matcher above uses.
//
// WHAT BREAKS WITHOUT IT. The embed reads its history BEFORE it mounts a
// column, with `credentials:"omit"` and the `cwu_` proof header. A 307 is
// followed by `fetch`, `payload.messages` is not an array, `fetchThreadMessages`
// returns null, and the restore SETTLES EMPTY — the panel opens on a blank
// conversation. Every earlier message the person sent through this widget is
// simply gone from the screen, and nothing anywhere says why. It is the same
// invisible class as the directory, one surface up.
//
// WHY THE SEGMENT IS NOT SHAPE-MATCHED. A thread id is whatever the embedding
// CMS minted (`session.threadId`, a 1..200-char opaque string in the bridge
// bootstrap) — not a UUID like a runId — so there is no narrower shape to
// require, and requiring one would 307 exactly the real ids this exists for. The
// matcher is therefore structural in the only dimension that IS available:
// EXACTLY ONE non-empty segment, terminating there. `/threads/` and any DEEPER
// path stay guarded. `/threads` itself is admitted by its OWN exact entry above
// and not by this matcher — the write half (cinatra#2683 item 1) gave the
// collection route a POST widget branch, so it is admitted deliberately, under
// its own reasoning and its own scope, rather than by a matcher widening.
//
// THE RESIDUAL, STATED. Any future STATIC child of `/api/assistants/threads/`
// would be admitted by this matcher without anyone deciding it should be. That
// is not hypothetical enough to ignore, so it is pinned rather than hoped about:
// a source test asserts the route directory holds exactly the one dynamic child,
// and adding a sibling breaks it and lands the decision on the author.
//
// Reachability only. The handler branches on the presented credential and never
// falls back (this route is same-origin to the embed frame, so a failed widget
// consume must 401 rather than drop to whatever Cinatra cookie that browser
// holds — which would hand the frame somebody else's conversation), consumes the
// widget branch at THIS route's audience under `conversation.read`, and then runs
// the SAME per-row ownership matrix the first-party read runs, with the widget
// principal and the org the TOKEN is bound to. A thread this caller may not read
// 404s exactly as it does in the app: existence is not disclosed across tenants.
const ASSISTANT_THREAD_BY_ID_PATH = /^\/api\/assistants\/threads\/[^/]+$/;
function isAssistantThreadByIdPath(pathname: string) {
  return ASSISTANT_THREAD_BY_ID_PATH.test(pathname);
}

// cinatra#2902 — GET /api/agents/runs/<runId>, the inline run panel's SEED.
//
// WHAT BREAKS WITHOUT IT. Inside the embedded widget, a conversation that
// references an agent run mounts the inline run panel, and the panel's first act
// is to read the run it must draw. That read is a cookieless cross-site request,
// so the guard answered it with a 307 to sign-in before the handler ever ran.
// `fetch` follows the redirect, the sign-in HTML is not JSON, the seed fails, and
// the panel draws its "Could not load agent run … — please try again." line for
// ever. Retrying never helps, because nothing about the request changes.
//
// WHY A PATTERN AND NOT AN EXACT ENTRY. The path carries the run id, so there is
// no literal to list — the same reason the two matchers above take this form.
//
// WHY THIS SHAPE IS THE NARROWEST HONEST ONE. A run id is always minted from
// `randomUUID()`, at the call sites that create a run, and carried into the one
// creation perimeter (`createAgentRun` in `packages/agents/src/store.ts`). Those
// call sites mint TWO shapes, and the matcher admits exactly those two:
//
//   · the BARE uuid — `packages/agents/src/actions.ts`,
//     `packages/agents/src/a2a-actions.ts`,
//     `packages/agents/src/mcp/agent-tools-registry.ts`;
//   · `run_<uuid>` — `src/lib/project-dispatch.ts` and the two mint sites in
//     `src/lib/host-content-editor-dispatch.ts`.
//
// A matcher that admitted only the bare form would leave every project-dispatch
// and content-editor run answering the widget with the 307 this entry exists to
// remove — the defect would survive for exactly the runs a customer's site is
// most likely to reference.
//
// THE RESIDUAL, STATED. `run-<uuid>` (hyphen) is admitted alongside them because
// the run-id column is opaque `text` with no shape constraint, and the model
// layer already reads that form off a turn (`AGENT_RUN_ID_PATTERN` in
// `packages/llm/src/scripted-test-provider.ts`, whose own note records a
// deployment keyed that way). It widens nothing else: all three alternatives are
// one segment of fixed length and fixed alphabet, and the matcher terminates
// there, so a malformed id stays guarded rather than reaching a handler that
// would only refuse it anyway.
//
// WHAT STAYS GUARDED, and each has its own control in the pinned suite: the
// DESCENDANT `/stream` (the panel's live transport, deliberately out of this
// slice's scope and still session-only), the SIBLING collection `/api/agents/runs`,
// a malformed id, and every unrelated path.
//
// Reachability only. The handler branches on the presented credential and
// never falls back — this route is same-origin to the embed frame, so a failed
// widget consume must refuse rather than drop to whatever Cinatra cookie that
// browser holds — consumes the widget branch at THIS route's audience under
// `conversation.read`, and then runs the SAME per-run authorization ladder the
// first-party read runs, with the widget principal and the org the TOKEN is bound
// to. A run this caller may not read is refused with the branch's one uniform
// answer: existence is not disclosed across tenants.
const AGENT_RUN_BY_ID_PATH =
  /^\/api\/agents\/runs\/(?:run[-_])?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
function isAgentRunByIdPath(pathname: string) {
  return AGENT_RUN_BY_ID_PATH.test(pathname);
}

const SETUP_PATH_PREFIXES = [
  "/setup",
  "/configuration/llm/initial-setup",
  "/configuration/llm/openai",
  "/configuration/apps/openai",
];

function isPublicPath(pathname: string, method: string) {
  if (pathname.startsWith("/_next")) {
    return true;
  }

  if (pathname.startsWith("/images/")) {
    return true;
  }

  if (PUBLIC_EXACT_PATHS.includes(pathname)) {
    return true;
  }

  if (isDevOnlyPublicPath(pathname)) {
    return true;
  }

  // Only the two CMS content-editor agent stream slugs are widget-public.
  if (PUBLIC_AGENT_STREAM_PATHS.includes(pathname)) {
    return true;
  }

  // The token-exchange + capabilities siblings of those exact slugs (cinatra#220).
  // Each enforces its own auth in-handler (token: long-lived key; capabilities:
  // auth-free static metadata). Exact-match only — never an /api/agents prefix.
  if (
    PUBLIC_AGENT_TOKEN_PATHS.includes(pathname) ||
    PUBLIC_AGENT_CAPABILITY_PATHS.includes(pathname)
  ) {
    return true;
  }

  // RUNTIME-approved widget-stream slugs (widget-stream runtime trust, slice 4).
  // A widget-stream connector approved at RUNTIME (its metadata grant admin-
  // approved after build) is not in the generated build-time arrays above, so
  // its three exact /api/agents/<slug>/{stream,token,capabilities} paths would
  // 307 to /sign-in before their in-handler auth runs. A per-replica in-memory
  // snapshot (kept warm out-of-band by a background refresher over the approved
  // grants) unions those exact paths in. Checked AFTER the build-time arrays so
  // build-time wins absolutely (the runtime snapshot drops any build-time-slug
  // collision). This is PURE LIVENESS — an EXACT-match, DB-free, synchronous
  // redirect-skip; each route still self-authenticates in its handler and the
  // fail-closed in-handler runtime resolver is the real wall. A cold/stale
  // snapshot can only ever 307 a legit widget route (self-healing), never open
  // a protected one, and never an /api/agents wildcard. Valid because in Next 16
  // the proxy always runs on the Node.js runtime (see src/proxy.ts).
  if (isRuntimeApprovedWidgetStreamPublicPath(pathname)) {
    return true;
  }

  // cinatra#1881 — the assistant AG-UI resume/tail stream. NARROW UUID-shaped
  // dynamic matcher (not an /api/assistants prefix); the handler's own session-
  // OR-resume-token fail-closed auth is the gate. See ASSISTANT_RUN_STREAM_PATH.
  if (isAssistantRunStreamPath(pathname)) {
    return true;
  }

  // cinatra#2683 — GET /api/assistants/threads/<threadId>, the widget's own
  // transcript restore. ONE non-empty segment, never the collection above it and
  // never a deeper path; the handler's own credential-branched auth is the gate.
  // See ASSISTANT_THREAD_BY_ID_PATH.
  if (isAssistantThreadByIdPath(pathname)) {
    return true;
  }

  // cinatra#2902 — GET /api/agents/runs/<runId>, the inline run panel's seed.
  // A bounded UUID-shaped segment terminating there; the descendant `/stream`
  // and the bare collection stay guarded. The handler's own credential-branched
  // auth is the gate. See AGENT_RUN_BY_ID_PATH.
  //
  // METHOD-PINNED. The exemption is a READ exemption, so it is spent on GET and
  // on nothing else. The path rule alone was method-blind: any verb on a
  // matching path skipped the cookie guard. Today that is only latent — the
  // route module exports GET alone, so Next answers a POST there with 405 —
  // but the guard must not be the layer that depends on it. If a writing verb
  // is ever added to this path, it inherits the cookie guard by default instead
  // of silently inheriting a cookieless exemption written for a read. A non-GET
  // falls through to the checks below and then to the session guard.
  if (method === "GET" && isAgentRunByIdPath(pathname)) {
    return true;
  }

  return PUBLIC_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function isSetupPath(pathname: string) {
  return SETUP_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

// cinatra#1221 S5 Lane B §7 — apply the per-request `frame-ancestors` CSP to the
// embed page. An RSC cannot set a per-request response header, so the directive
// is computed by the read-only, exception-wrapped resolver and set HERE for this
// ONE exact path. FAIL-CLOSED to `'none'` on EVERY failure (unknown assistant,
// missing/duplicate/non-normalizable instance row, any thrown DB/normalize
// exception — the resolver never throws): a `'none'` page still renders the
// shell but the browser refuses to frame it anywhere (a safe, debuggable wall).
// NO `'self'` (the policy is "ONLY the registered site"; `'self'` would let the
// Cinatra origin frame it too). `X-Frame-Options` is OMITTED deliberately (XFO
// cannot express an allow-list origin and would override to SAMEORIGIN, blocking
// the legitimate CMS frame). `Cache-Control: no-store` so a per-instance CSP is
// never cached and served to a different instance. Gated on the EXACT path so no
// other route pays.
// cinatra#2577 (epic #2564 S8d) — the §III review-target ISLAND's framing wall,
// per request.
//
// WHAT WAS WRONG. S2 fixed the island at `frame-ancestors 'self'` +
// `X-Frame-Options: SAMEORIGIN` in next.config.ts, reasoning that the island is
// a first-party fragment with no legitimate cross-origin embedder. S8d made the
// widget draw the SAME review card, and there the island is nested one level
// deeper: its ancestors are the `/embed/assistant` frame (this origin) AND the
// registered site framing that (a different origin). `frame-ancestors` is
// checked against EVERY ancestor, so `'self'` alone refuses the render — the
// island returned 200 with the reader's cookie and painted nothing. Chrome says
// it outright: "Framing '<app origin>' violates the following Content Security
// Policy directive: \"frame-ancestors 'self'\". The request has been blocked."
//
// WHAT IT IS NOW. `'self'` ALWAYS, plus — only when the request names a widget
// frame AND that frame resolves to exactly one registered site — that ONE
// origin. The origin is never taken from the request: `assistant` and
// `instanceId` are opaque selectors, mapped by `frameAncestorsDirectiveFor`
// through the CLOSED host-side binding table and the stored instance row, the
// SAME derivation `/embed/assistant`'s own wall uses. An unknown assistant, an
// unknown / duplicate / non-normalizable instance, or any thrown read all
// resolve to `'none'` there and land on the `'self'`-only wall here. So the
// worst a forged pair can do is the first-party policy — never a widening, and
// never a wildcard.
//
// `X-Frame-Options` is DROPPED on the widened arm and kept on the first-party
// one, exactly as `/embed/assistant` does: XFO cannot express an allow-list
// origin, and `SAMEORIGIN` is a second wall that would contradict the first.
// (Per CSP2 a `frame-ancestors` directive obsoletes XFO, so a conformant browser
// ignores it — but shipping a header whose meaning is "block this" next to one
// whose meaning is "allow this" is a defect waiting for a non-conformant agent.)
//
// This is NOT an authorization boundary and does not soften one. The island
// still requires the reader's own session, still decodes the ref server-side,
// and still re-runs `loadReviewGateSurface`'s per-row access. The wall is
// anti-clickjacking only.
const REVIEW_ISLAND_PATH = "/lifecycle/review-island";

/** The island's own credential parameter and its ceiling — the two constants
 *  `src/lib/lifecycle/review-island-credential.ts` owns, named here rather than
 *  imported so the request guard stays free of the codec (and of its key). */
const REVIEW_ISLAND_CREDENTIAL_PARAM = "ic";
const REVIEW_ISLAND_CREDENTIAL_MAX = 1024;

/**
 * Does this island request carry its OWN credential (cinatra#2754)?
 *
 * SYNTAX ONLY, AND DELIBERATELY. This decides which authority answers the
 * request, never whether the request is authorized: a credential that is
 * forged, tampered with, expired, or bound to another gate, reader or site is
 * refused by the island page's own ladder, which is the only thing that holds
 * the key. Verifying here would put the codec — and the app secret — into the
 * request guard for no gain, and would give the guard a second opinion about a
 * question the page must own alone.
 */
function islandRequestPresentsCredential(request: NextRequest): boolean {
  const raw = request.nextUrl.searchParams.get(REVIEW_ISLAND_CREDENTIAL_PARAM);
  if (raw === null) return false;
  return (
    raw.length > 0 && raw.length <= REVIEW_ISLAND_CREDENTIAL_MAX && /^[A-Za-z0-9_-]+$/.test(raw)
  );
}

/** The island's framing headers for this request. Fail-closed to first-party. */
export function reviewIslandFramingHeaders(request: NextRequest): {
  contentSecurityPolicy: string;
  xFrameOptions: string | null;
  /** True only when the wall was actually widened for a resolved widget frame. */
  widened: boolean;
} {
  const FIRST_PARTY = {
    contentSecurityPolicy: "frame-ancestors 'self'",
    xFrameOptions: "SAMEORIGIN",
    widened: false,
  } as const;
  // ONE resolution, shared with the island page (which keys the empty-island
  // answer on the same decision) — so the header and the page can never
  // disagree about whether this is a widget frame. `null` covers every failure:
  // a half-declared frame, an unknown assistant, an unknown / duplicate /
  // non-normalizable instance, a thrown read, and a resolved value that is not
  // a policy-safe origin. All of them land on the first-party wall — never
  // `'none'`, which on the ISLAND would refuse the first-party card too.
  const origin = resolveVerifiedWidgetFrameOrigin({
    assistant: request.nextUrl.searchParams.get("assistant"),
    instanceId: request.nextUrl.searchParams.get("instanceId"),
  });
  if (!origin) return { ...FIRST_PARTY };
  return {
    contentSecurityPolicy: `frame-ancestors 'self' ${origin}`,
    xFrameOptions: null,
    widened: true,
  };
}

/**
 * The island's answer to a widget frame with no session cookie (codex round 1,
 * finding 4). It is EMPTY, not a redirect.
 *
 * A 307 to `/sign-in` was wrong twice over. It does not carry this wall — a
 * redirect's `frame-ancestors` is not inherited by the document the browser
 * fetches next, and `/sign-in` declares no framing policy of its own — so the
 * "the 307 keeps the outcome indistinguishable" reasoning was simply false.
 * And what it produces is worse than nothing: Cinatra's interactive sign-in
 * form, rendered inside chrome a third-party site controls, which is the shape
 * of a credential-phishing surface. An empty document is what every other
 * island denial draws, so this one is not distinguishable from them either.
 */
/**
 * THE EMPTY ISLAND, AS A DOCUMENT (cinatra#3051).
 *
 * This response and the island page's own `emptyIsland` are the SAME refusal,
 * and they have to be the same DOCUMENT. The review card reads the framed
 * document to tell a frame that PAINTED from one that merely LOADED — an empty
 * document fires `load` exactly like a full one, and treating that as painted is
 * what left the reader in front of a panel naming nothing. A zero-byte body
 * carried no anchor, so the card could not tell this refusal from a target that
 * had arrived, and it is the refusal a genuinely cross-site widget frame with no
 * minted address gets EVERY time.
 *
 * It carries the page's own anchor and nothing else. No reason, no content,
 * nothing that could tell one refusal from another — the generic refusal
 * contract is exactly as closed as it was.
 */
const EMPTY_ISLAND_DOCUMENT =
  '<!doctype html><html><head><meta charset="utf-8"></head>' +
  '<body><div data-conformance-id="review-target-island-empty"></div></body></html>';

function emptyIslandResponse(): NextResponse {
  return new NextResponse(EMPTY_ISLAND_DOCUMENT, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** Put the island's framing wall on whatever response the guard produced. */
function applyReviewIslandFraming(
  framing: ReturnType<typeof reviewIslandFramingHeaders>,
  response: NextResponse,
): NextResponse {
  response.headers.set("Content-Security-Policy", framing.contentSecurityPolicy);
  if (framing.xFrameOptions) response.headers.set("X-Frame-Options", framing.xFrameOptions);
  else response.headers.delete("X-Frame-Options");
  return response;
}

function applyEmbedFrameAncestors(request: NextRequest): NextResponse {
  const response = NextResponse.next();
  const directive = frameAncestorsDirectiveFor({
    assistant: request.nextUrl.searchParams.get("assistant"),
    instanceId: request.nextUrl.searchParams.get("instanceId"),
  });
  response.headers.set("Content-Security-Policy", `frame-ancestors ${directive}`);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function guardAppRoute(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // The embed page is public (below) AND carries a per-request frame-ancestors
  // CSP (§7). Handle it first so the header is set on the response.
  if (pathname === EMBED_ASSISTANT_PATH) {
    return applyEmbedFrameAncestors(request);
  }

  // The island is a PROTECTED path and keeps every gate below unchanged — it
  // only needs its framing wall computed per request (cinatra#2577), with ONE
  // substitution: a widget frame with no session cookie is answered with the
  // empty island rather than sent to an interactive sign-in inside somebody
  // else's chrome (see `emptyIslandResponse`).
  if (pathname === REVIEW_ISLAND_PATH) {
    const framing = reviewIslandFramingHeaders(request);
    // A request that PRESENTS AN ISLAND CREDENTIAL is answered by the page
    // (cinatra#2754). It is the cross-site case the credential exists for: no
    // cookie will ever ride that frame load, so both other arms here are wrong
    // for it — the empty response would swallow a valid credential before the
    // page could read it, and the protected route would send an interactive
    // sign-in into chrome a third-party site controls. The page prefers the
    // credential over any ambient cookie too, so this guard and that page
    // agree on which branch decides, for every request.
    const response = islandRequestPresentsCredential(request)
      ? NextResponse.next()
      : framing.widened && !getSessionCookie(request)
        ? emptyIslandResponse()
        : await guardProtectedRoute(request);
    return applyReviewIslandFraming(framing, response);
  }

  return guardProtectedRoute(request);
}

async function guardProtectedRoute(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // `pathname` EXCLUDES the query string (that is `nextUrl.search`), so no
  // `?...` can widen a path rule — admission is decided on the path alone, and
  // a matching GET stays admitted whatever it carries as query. That is safe
  // because admission here only means "reach the handler": the handler's own
  // credential branch, not this guard, decides who may read the run.
  // `?? "GET"` matches the framework default and keeps test doubles that stub
  // only `nextUrl.pathname` on the read path they are written for.
  if (isPublicPath(pathname, request.method ?? "GET")) {
    return NextResponse.next();
  }

  // Check for session cookie only — no HTTP fetch back to the server.
  // Full session validation and setup-complete checks happen in API routes
  // and server components via better-auth. Middleware only gates unauthenticated
  // users (no cookie) from reaching protected routes at all.
  const sessionCookie = getSessionCookie(request);
  // `?? ""` guards test doubles that stub only `nextUrl.pathname` (a real
  // NextRequest's `nextUrl.search` is always a string, "" when absent).
  const currentPath = `${pathname}${request.nextUrl.search ?? ""}`;
  if (!sessionCookie) {
    // cinatra#2359 — capture the destination the caller was actually headed
    // to so a post-auth redirect can return them there instead of always
    // landing on the default page. `buildSignInPath` validates `currentPath`
    // as a same-origin relative path before ever echoing it back (it always
    // is here — derived straight from `request.nextUrl` — but the shared
    // validator is applied uniformly regardless of call site).
    return NextResponse.redirect(new URL(buildSignInPath(currentPath), request.url));
  }

  // A session cookie is present, but better-auth's own session lookup (DB- or
  // cache-backed) hasn't run yet — that happens in the Server Component /
  // Route Handler via `getAuthSession()`. If that lookup finds the session
  // expired or otherwise invalid, `requireAuthSession()` (and the ad hoc
  // gates that mirror it) need the SAME "where was the caller headed" signal
  // this proxy has and they don't: a Server Component has no direct access to
  // the incoming request's URL. Forward it via a request header (the
  // documented Next.js pattern for surfacing the current path to Server
  // Components) so the belt-and-suspenders redirect also preserves the
  // target.
  const forwardedHeaders = new Headers(request.headers);
  forwardedHeaders.set(CURRENT_PATH_HEADER, currentPath);
  return NextResponse.next({ request: { headers: forwardedHeaders } });
}

export const authRouteGuardConfig = {
  matcher: ["/((?!_next/static|_next/image|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|txt|xml)$).*)"],
};
