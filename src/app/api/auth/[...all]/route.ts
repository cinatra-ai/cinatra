import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";
import {
  classifyDcrRegistration,
  dcrOutcomeForStatus,
  recordDcrRegistrationUsage,
  REQUIRED_MCP_SCOPE,
  type DcrRegistrationClassification,
} from "@/lib/mcp-dcr-telemetry";

const authHandlers = toNextJsHandler(auth);

// The Cinatra MCP resource requires the `mcp:connect` scope to authorize
// (see `requiredScopes` in packages/mcp-server/src/index.tsx). Some MCP
// clients — notably the MCP CLI proxy — perform Dynamic Client Registration
// with a narrow scope set (e.g. `openid email profile`) and only request
// `mcp:connect` at authorize time, discovered from the protected-resource
// metadata. Better Auth's `clientRegistrationDefaultScopes` only fills scopes
// when `scope` is FALSY (`if (!body.scope)`) — absent, `undefined` or `""` — so
// an explicit narrow scope bypasses the default and the subsequent authorize
// fails with `invalid_scope` → "No authorization code received".
//
// To make those clients connect out of the box, union `mcp:connect` into any
// DCR request that already carries a usable explicit scope. Requests with a
// falsy `scope` are left untouched so Better Auth still applies its full default
// scope set (which already includes `mcp:connect`).
//
// DCR is DEPRECATED by MCP revision `2026-07-28` with a twelve-month minimum
// removal window, and the recorded maintainer decision on cinatra#2218 is
// RETAIN + instrument. This handler is the single seam both registration paths
// pass through, so it is where the usage telemetry is emitted: one structured
// event per attempt, recording whether the shim below was needed
// (`cinatra-scope-shim`) or the request went to the plugin untouched
// (`plugin-default`). The payload is dimensions and counts only — never a
// client id, client secret, token, redirect URI or client-authored string. See
// `src/lib/mcp-dcr-telemetry.ts` and the "Deprecated features" section of
// docs/internals/contracts/mcp-supported-revisions.md.

// The Better Auth mount, i.e. the directory this route file lives in
// (src/app/api/auth/[...all]). Matches the `AUTH_BASE_PATH` constant the rest of
// the app already hardcodes (src/lib/a2a-auth.ts, src/lib/cli-api/verified-bearer.ts,
// packages/llm/src/mcp-access.ts, …), and next.config.ts sets no `basePath`.
const AUTH_BASE_PATH = "/api/auth";
const DCR_REGISTRATION_PATH = `${AUTH_BASE_PATH}/oauth2/register`;

/**
 * EXACT-path predicate, deliberately matching what Better Auth's router will
 * actually dispatch to the registration endpoint — no more and no less.
 *
 * Not a suffix test: `endsWith("/oauth2/register")` also matches
 * `POST /api/auth/anything/oauth2/register`, which the catch-all segment happily
 * routes here, so the shim would rewrite a body Better Auth is about to 404 and —
 * now that this seam is the deprecation-evidence channel — the telemetry would
 * count a non-registration as DCR usage.
 *
 * And deliberately NOT trailing-slash-normalised, for the same reason in the
 * other direction: `better-call`'s router 404s a path whose trailing slash does
 * not match the declared route (`skipTrailingSlashes` is left `false` by Better
 * Auth) and 404s any path containing consecutive slashes. Normalising
 * `/oauth2/register/` or `/oauth2//register` into a match here would instrument —
 * and rewrite — requests that never reach the endpoint.
 */
function isDynamicClientRegistration(request: Request): boolean {
  if (request.method !== "POST") return false;
  try {
    return new URL(request.url).pathname === DCR_REGISTRATION_PATH;
  } catch {
    return false;
  }
}

/**
 * Read the registration body once and derive BOTH the request to forward and
 * the telemetry dimensions from a single classification, so the event can never
 * claim a path the request did not take.
 */
async function prepareDynamicClientRegistration(
  request: Request,
): Promise<{ request: Request; classification: DcrRegistrationClassification }> {
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    body = undefined; // not JSON — classified `unreadable-body`, passed through
  }

  const classification = classifyDcrRegistration(body, REQUIRED_MCP_SCOPE);
  if (classification.rewrittenScope === null) {
    return { request, classification };
  }

  const nextBody = JSON.stringify({
    ...(body as Record<string, unknown>),
    scope: classification.rewrittenScope,
  });

  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return {
    request: new Request(request.url, {
      method: request.method,
      headers,
      body: nextBody,
    }),
    classification,
  };
}

export async function GET(
  ...args: Parameters<typeof authHandlers.GET>
): ReturnType<typeof authHandlers.GET> {
  return authHandlers.GET(...args);
}

export async function POST(
  ...args: Parameters<typeof authHandlers.POST>
): ReturnType<typeof authHandlers.POST> {
  const [request] = args;
  if (!(request instanceof Request) || !isDynamicClientRegistration(request)) {
    return authHandlers.POST(...args);
  }

  const { request: forwarded, classification } =
    await prepareDynamicClientRegistration(request);

  let response: Awaited<ReturnType<typeof authHandlers.POST>>;
  try {
    response = await authHandlers.POST(forwarded);
  } catch (error) {
    // A thrown handler is still an observed registration attempt; recording it
    // as `handler-error` keeps the observation window honest instead of making
    // failures look like non-use. The error still propagates unchanged.
    recordDcrRegistrationUsage({
      path: classification.path,
      scopeDisposition: classification.scopeDisposition,
      clientRequestedScopeCount: classification.clientRequestedScopeCount,
      outcome: "handler-error",
      status: null,
    });
    throw error;
  }

  recordDcrRegistrationUsage({
    path: classification.path,
    scopeDisposition: classification.scopeDisposition,
    clientRequestedScopeCount: classification.clientRequestedScopeCount,
    outcome: dcrOutcomeForStatus(response.status),
    status: response.status,
  });
  return response;
}
