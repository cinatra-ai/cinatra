import { NextResponse } from "next/server";
import { pushSkillStoreToGitHub } from "@cinatra-ai/skills";

import { requireAdminSession } from "@/lib/auth-session";
import {
  localCallerRefusalMessage,
  localCallerVerdict,
} from "@/lib/local-caller-gate";

// Defense in depth on this destructive endpoint — it FORCE-PUSHES the
// operator's connected skills repository, so a caller that reaches it destroys
// history that lives outside this instance.
//
// The in-app caller was removed; the only caller left is the published
// @cinatra-ai/cinatra CLI's `cinatra skills reset-repo --yes`, which POSTs
// here from the operator's local shell.
//
// State plainly what that caller does TODAY, because the gate below is written
// for it: that CLI sends NO session cookie, so the app-wide route guard
// already answers it with a sign-in redirect before this handler runs (this
// path is not on that guard's public list, and unlike the sibling purge route
// it is deliberately not being added to it). So requiring a session here takes
// no working capability away — there is none to lose. Driving this operation
// from a shell again requires that published CLI to be taught to present a
// platform-administrator session AND this boot's local credential, which is a
// change to a separately released package rather than to this one.
//
// TWO layers, asked in this order:
//
//   1. A PLATFORM ADMINISTRATOR. This is the handler's FIRST statement, before
//      any other input is read, so a caller without that standing receives the
//      guard's own redirect and nothing else — the same answer in every
//      runtime mode and for every connection shape, so the response reveals
//      nothing about how this instance is configured. The app-wide route guard
//      (src/lib/auth-route-guard.ts) does not list this path as public, but it
//      only checks that a session cookie is PRESENT: it neither validates the
//      cookie nor reads a role, so every signed-in caller reaches this handler
//      and the standing check has to live here.
//   2. THE LOCAL-CALLER GATE (@/lib/local-caller-gate) — the defence-in-depth
//      layer, and the one this route used to spell out for itself from the
//      request's `Host` header. Its four fences are: a non-production BUILD
//      (`NODE_ENV`), checked separately so a deployment that mis-sets the mode
//      is still walled; a `development` RUNTIME mode; the connecting SOCKET's
//      peer address being loopback with no forwarded header from the caller;
//      and this boot's 0600 local CREDENTIAL. The header check it replaces
//      admitted any caller willing to write a loopback `Host` — see that module
//      and @/lib/request-peer for what the header could not tell apart, and for
//      why the credential rather than the socket is the load-bearing fence.
//
// So: a caller without administrator standing is redirected, whatever else is
// true of the request. An administrator that is not the operator on this
// machine gets one uniform 403 that does not say which fence answered. Only an
// administrator's local call carrying this boot's credential runs the reset.
export async function POST(req: Request) {
  // FIRST — see layer 1 above. Deliberately outside the try/catch below:
  // requireAdminSession refuses by throwing Next's redirect signal, and a
  // catch around it would turn that redirect into a 500 JSON body.
  await requireAdminSession();

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
