import { NextResponse } from "next/server";

import { emitWidgetAuthAudit } from "@/lib/widget-auth-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// RETIRED — POST /api/widget-auth/init (cinatra#2674, epic #2564 S8e).
//
// WHAT THIS ROUTE USED TO DO. A CMS backend presented its `cnx_` credential and
// started the hosted PKCE transaction on the user's behalf, holding the PKCE
// verifier so that IT — not the person's browser — would be the party able to
// redeem. The frame now starts and owns that ceremony itself:
// `/api/widget-auth/frame/init`, same-origin, no credential, with the server
// re-deriving every authoritative binding from its own rows.
//
// WHY THIS ONE IS RETIRED TOO, THOUGH IT RETURNED NO BEARER. Leaving it open
// would leave the site-mediated ceremony HALF alive: a backend could still mint
// transactions and open its own popup, and the only thing standing between that
// and a delivered credential would be the postMessage target origin. That is a
// real wall — but a flow whose safety rests on one browser check, with the whole
// rest of the machinery still present and inviting, is a flow waiting for
// somebody to "fix" the last step. The ceremony is withdrawn as a whole.
//
// 410 GONE with the same generic body shape a failure of the old contract had.
// Nothing from the request is read, so this cannot be used to probe agents,
// sites or credentials.
// ---------------------------------------------------------------------------

const RETIRED = {
  error: "invalid_request",
  reason: "widget_auth_site_init_retired",
} as const;

export async function POST(request: Request): Promise<Response> {
  emitWidgetAuthAudit("init_failure", {
    ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    ua: request.headers.get("user-agent"),
    reason: "legacy_site_init_retired",
  });
  return NextResponse.json(RETIRED, { status: 410 });
}
