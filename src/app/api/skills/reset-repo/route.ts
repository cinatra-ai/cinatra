import { NextResponse } from "next/server";
import { pushSkillStoreToGitHub } from "@cinatra-ai/skills";

import { requireAdminSession } from "@/lib/auth-session";

// Defense in depth on this destructive endpoint.
//
// The in-app caller was removed; the only caller left is the published
// @cinatra-ai/cinatra CLI's `cinatra skills reset-repo --yes`, which POSTs
// here from the operator's local shell.
//
// State plainly what that caller does TODAY, because the gate below is
// written for it: that CLI sends NO session cookie, so the app-wide route
// guard already answers it with a sign-in redirect before this handler runs
// (this path is not on that guard's public list, and unlike the sibling
// purge route it is deliberately not being added to it). So requiring a
// session here takes no working capability away — there is none to lose.
// Driving this operation from a shell again requires that published CLI to
// be taught to present a platform-administrator session, which is a change
// to a separately released package rather than to this one.
//
// Four independent guards, in this order:
//   1. The caller must hold a platform-administrator session. This is the
//      handler's FIRST statement, before any other input is read, so a caller
//      without that standing receives the guard's own redirect and nothing
//      else — the same answer in every runtime mode and for every request
//      origin, so the response reveals nothing about how this instance is
//      configured. The app-wide route guard (src/lib/auth-route-guard.ts) does
//      not list this path as public, but it only checks that a session cookie
//      is PRESENT: it neither validates the cookie nor reads a role, so every
//      signed-in caller reaches this handler and the standing check has to
//      live here.
//   2. NODE_ENV must NOT be production — even if CINATRA_RUNTIME_MODE
//      is mis-set, production deployments never expose this surface.
//   3. CINATRA_RUNTIME_MODE === 'development'.
//   4. The request must originate from a loopback hostname AND must not
//      carry any x-forwarded-* chain — refuses a request proxied through
//      a stale tunnel that may still trust a dev box.
//
// A caller without administrator standing is redirected. An administrator in
// production gets a 403. In dev, only an administrator's loopback POST
// (`cinatra skills reset-repo --app-url http://127.0.0.1:3000`) succeeds.
function isLoopback(req: Request): boolean {
  if (process.env.NODE_ENV === "production") return false;
  if (req.headers.get("x-forwarded-for")) return false;
  if (req.headers.get("x-forwarded-host")) return false;
  try {
    const url = new URL(req.url);
    const h = url.hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "host.docker.internal";
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  // FIRST — see guard 1 above. Deliberately outside the try/catch below:
  // requireAdminSession refuses by throwing Next's redirect signal, and a
  // catch around it would turn that redirect into a 500 JSON body.
  await requireAdminSession();

  if (process.env.CINATRA_RUNTIME_MODE !== "development") {
    return NextResponse.json({ error: "Only available in development mode." }, { status: 403 });
  }
  if (!isLoopback(req)) {
    return NextResponse.json(
      {
        error:
          "/api/skills/reset-repo refuses non-loopback origins. " +
          "Use the Library tab → Recreate library admin action for in-app destructive resets.",
      },
      { status: 403 },
    );
  }

  try {
    const result = await pushSkillStoreToGitHub({ force: true });
    return NextResponse.json({ success: true, commitSha: result.commitSha });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error." },
      { status: 500 },
    );
  }
}
