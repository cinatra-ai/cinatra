import { NextResponse } from "next/server";

import { emitWidgetAuthAudit } from "@/lib/widget-auth-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// RETIRED — POST /api/widget-auth/token (cinatra#2674, epic #2564 S8e).
//
// WHAT THIS ROUTE USED TO DO. It was the site-mediated redemption: a CMS backend
// presented its `cnx_` credential and an authorization code, and the response
// carried the user's `cwu_` bearer back to that backend. The parent page then
// composed the bearer pair into the iframe. That is precisely the possession
// S8e ends — a person's widget credential is between them and Cinatra, and a
// website that hosts the chat is not a party to it.
//
// SO IT IS GONE, AND IT FAILS CLOSED RATHER THAN DEGRADING. There is no
// compatibility mode, no env flag and no bounded window on THIS route, because
// every one of those is a way for a site to keep receiving a bearer. The
// migration rule of #2674 is satisfied by the other branch it allows: an
// unmigrated widget's sign-in FAILS and the person signs in again, inside the
// frame, through the flow that keeps the credential on the Cinatra origin. There
// is no path from here back to parent credential delivery.
//
// 410 GONE, not 404: the route exists and is deliberately withdrawn, which is
// what an integrator debugging an old plugin needs to learn. The body carries
// the same generic `invalid_grant` every failure of the old contract carried, so
// a legacy client's error handling still works, and it carries NOTHING about the
// code presented — a retired endpoint must not become an oracle for whether a
// code was real.
//
// The path stays on the middleware public-path allowlist so a legacy caller gets
// this answer instead of a session redirect that would look like a network
// problem.
// ---------------------------------------------------------------------------

/** What a retired credential-bearing contract answers, always, to everyone. */
const RETIRED = {
  error: "invalid_grant",
  reason: "widget_auth_site_redemption_retired",
} as const;

export async function POST(request: Request): Promise<Response> {
  // Audited as a redeem FAILURE so the existing series shows the migration
  // happening — a site still calling this is a plugin that needs its update.
  // Nothing from the request body is read: refusing before parsing means a
  // retired route cannot be used to probe anything.
  emitWidgetAuthAudit("redeem_failure", {
    ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    ua: request.headers.get("user-agent"),
    reason: "legacy_site_redemption_retired",
  });
  return NextResponse.json(RETIRED, { status: 410 });
}
