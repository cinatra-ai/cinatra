import { NextResponse } from "next/server";
import { pushSkillStoreToGitHub } from "@cinatra-ai/skills";

import { getAuthSession, isPlatformAdmin } from "@/lib/auth-session";
import {
  localCallerRefusalMessage,
  localCallerVerdict,
} from "@/lib/local-caller-gate";

// Defense in depth on this destructive endpoint — it FORCE-PUSHES the
// operator's connected skills repository, so a caller that reaches it destroys
// history that lives outside this instance.
//
// The route remains accessible because the published @cinatra-ai/cinatra CLI's
// `cinatra skills reset-repo --yes` POSTs here from the operator's local
// shell. The in-app caller was removed; the only remaining caller is the
// CLI's loopback fetch.
//
// Three independent guards, asked in this order:
//
//   1. A PLATFORM ADMINISTRATOR. The route sits behind the cookie-session
//      middleware, which asks only for A session — so before this check, every
//      authenticated member of the instance could force-push the repository.
//      Asked FIRST, so an unprivileged caller is never told which connection
//      shapes the route would otherwise have accepted.
//   2. + 3. THE LOCAL-CALLER GATE (@/lib/local-caller-gate): a non-production
//      development runtime, the connecting socket's peer address being loopback
//      with no forwarded header from the caller, and this boot's 0600 local
//      credential. It replaces a `Host`-header check that admitted any caller
//      willing to write `Host: localhost` — see that module and
//      @/lib/request-peer for what the header could not tell apart.
//
// The administrator refusal answers with JSON rather than `requireAdminSession()`
// (which redirects): a 307 from a POST route is followed with the method and
// body intact, /sign-in serves GET only, and the CLI would parse the sign-in
// HTML as its answer — the failure class src/lib/auth-route-guard.ts documents
// for every self-authorizing route.
//
// WHAT THIS HANDLER DOES NOT DECIDE, said plainly so the JSON above is not read
// as more than it is: this path is NOT in PUBLIC_PATH_PREFIXES, so a caller
// with no session cookie is redirected to /sign-in by the middleware before the
// handler runs at all. That was already true before this change and is
// unchanged by it. The JSON refusal is therefore what an AUTHENTICATED
// non-administrator is told; the CLI must carry the operator's session cookie
// to reach the handler in the first place, and then this boot's credential to
// pass the local-caller gate.
export async function POST(req: Request) {
  const session = await getAuthSession();
  if (!isPlatformAdmin(session)) {
    return NextResponse.json(
      {
        error:
          "/api/skills/reset-repo requires a platform administrator. " +
          "Use the Library tab → Recreate library admin action for in-app destructive resets.",
      },
      { status: 403 },
    );
  }

  const local = localCallerVerdict(req);
  if (!local.ok) {
    return NextResponse.json(
      { error: localCallerRefusalMessage("/api/skills/reset-repo") },
      { status: local.status },
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
