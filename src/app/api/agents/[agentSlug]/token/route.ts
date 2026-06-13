import { NextResponse } from "next/server";

import { resolveWidgetStreamAgent } from "@/lib/widget-stream-agents.server";
import { isConfiguredOrigin } from "@/lib/widget-stream-auth";
import {
  isAuthorizedLongLivedKey,
  mintWidgetStreamToken,
  normalizeOriginStrict,
} from "@/lib/widget-token-broker";
import { validateTokenExchangeRequest } from "@/lib/wp-drupal-contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Token-exchange endpoint (cinatra#220 / wp#4 Option A).
//
// The plugin/module BACKEND (holding the long-lived integration key) calls this
// server-to-server to mint a SHORT-LIVED, origin/aud/scope-bound `cit_` token
// the browser then presents to .../stream. The long-lived key NEVER reaches the
// browser. Generic + manifest-resolved exactly like the stream route — adding a
// future widget agent needs no edit here. The two exact token paths are on the
// middleware public-path allowlist (GENERATED_WIDGET_STREAM_TOKEN_PATHS) so the
// session redirect is suppressed; self-authentication (the long-lived Bearer)
// runs INSIDE this handler.
//
// Authorization derives from the long-lived key + the configured-instance
// check — NOT from any CORS Origin header. This is a server-to-server endpoint;
// no CORS headers are emitted (the browser never calls it directly).
// ---------------------------------------------------------------------------

type TokenExchangeBody = {
  contractVersion?: unknown;
  origin?: unknown;
  sub?: unknown;
  scope?: unknown;
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ agentSlug: string }> },
): Promise<Response> {
  const { agentSlug } = await params;

  // 1. Unknown slug → 404 (cheap, no body read).
  const entry = resolveWidgetStreamAgent(agentSlug);
  if (!entry) {
    return NextResponse.json({ error: "Unknown agent" }, { status: 404 });
  }

  // 2. Long-lived key auth FIRST — before parsing/validating any body — so an
  // unauthenticated caller cannot drive JSON-parse / schema-validator work
  // (adversarial finding: auth-before-body-parse on a publicly reachable
  // endpoint). Constant-time compare; 401 on missing/mismatch.
  const authHeader = request.headers.get("Authorization");
  const presented = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : "";
  if (!presented || !isAuthorizedLongLivedKey(presented, entry.auth)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: TokenExchangeBody;
  try {
    body = (await request.json()) as TokenExchangeBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // 3. Contract version + request shape (structured 400, never a 500).
  const contractCheck = validateTokenExchangeRequest(body);
  if (!contractCheck.ok) {
    return NextResponse.json(
      {
        error: contractCheck.error.message,
        code: contractCheck.error.code,
        supportedVersions: contractCheck.error.supportedVersions,
      },
      { status: 400 },
    );
  }

  // 4. The requested origin must normalize-match a VALID configured instance.
  // This binding is authz — NOT a CORS Origin-header check.
  const requestedOrigin = normalizeOriginStrict(body.origin);
  if (!requestedOrigin) {
    return NextResponse.json(
      { error: "`origin` must be a valid scheme://host[:port] origin" },
      { status: 400 },
    );
  }
  if (!isConfiguredOrigin(requestedOrigin, entry.auth)) {
    return NextResponse.json(
      { error: "`origin` is not a configured site for this integration" },
      { status: 403 },
    );
  }

  // 5. Mint. The issuer base URL is this instance's request origin.
  const issuerBaseUrl = new URL(request.url).origin;
  const minted = mintWidgetStreamToken({
    agentSlug,
    auth: entry.auth,
    origin: requestedOrigin,
    sub: typeof body.sub === "string" ? body.sub : undefined,
    scope: typeof body.scope === "string" ? body.scope : undefined,
    issuerBaseUrl,
  });
  if (!minted) {
    // The configured key vanished between the auth check and mint, or the
    // origin failed strict normalization (already guarded). Treat as a server
    // configuration error rather than a half-issued token.
    return NextResponse.json(
      { error: "Token could not be minted (integration not fully configured)" },
      { status: 500 },
    );
  }

  return NextResponse.json(
    {
      token: minted.token,
      tokenType: minted.tokenType,
      expiresIn: minted.expiresIn,
      expiresAt: minted.expiresAt,
      contractVersion: "v2",
      scope: minted.scope,
    },
    { status: 200 },
  );
}
