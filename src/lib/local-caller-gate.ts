// ---------------------------------------------------------------------------
// THE ONE "is this the operator, on this machine?" decision.
// ---------------------------------------------------------------------------
//
// Three development-only surfaces asked this question and each answered it
// slightly differently, all three from the `Host` header:
//
//   • /api/skills/reset-repo   force-pushes the connected skills repository
//   • /api/extensions/purge    irreversibly purges an extension
//   • the A2A_DEV_BYPASS branch of src/lib/a2a-auth.ts
//
// They now share this function, so a hardening applied once applies to all
// three, and a divergence between them is not expressible.
//
// FOUR fences, in this order, each independent:
//
//   1. THE BUILD.   `NODE_ENV !== "production"`, checked separately from the
//      runtime mode so a deployment that mis-sets the mode is still walled.
//   2. THE RUNTIME. `CINATRA_RUNTIME_MODE === "development"`, an allow-list:
//      unset, misspelled and production all refuse.
//   3. THE CONNECTION. The socket's peer address must be loopback, and the
//      caller must have sent NO forwarded header of its own
//      (`@/lib/request-peer`, which explains why the framework's own
//      `x-forwarded-*` synthesis does not count against a caller).
//   4. THE CREDENTIAL. This boot's 0600 local secret (`@/lib/boot-credential`).
//
// WHICH FENCE IS LOAD-BEARING. Fence 4. Say it plainly, because the natural
// reading is the other way round: fence 3 is a genuine socket-level fact, not a
// header, so it is far stronger than the `Host` check it replaces — but a
// hostile page in the operator's own browser connects over loopback too, and
// these routes are reachable without a session. What that page cannot do is read
// a 0600 file to fill in a custom header, and a custom header is not a
// CORS-simple one, so it cannot be sent at all without a preflight none of these
// routes answers. Fence 3 keeps the surface off the network; fence 4 keeps it
// off the browser.
//
// The environment is asked before the request is inspected, so a production host
// never reveals which caller shapes it would otherwise have accepted.
// ---------------------------------------------------------------------------

import {
  bootCredentialPresented,
  type CredentialEnv,
} from "@/lib/boot-credential";
import { socketPeerVerdict, type HeaderBag } from "@/lib/request-peer";

export type LocalCallerVerdict =
  | { ok: true }
  | { ok: false; status: 403; reason: string };

function refuse(reason: string): LocalCallerVerdict {
  return { ok: false, status: 403, reason };
}

export function localCallerVerdict(
  request: { headers: HeaderBag },
  env: CredentialEnv = process.env,
): LocalCallerVerdict {
  // FENCE 1 — the build.
  if (env.NODE_ENV === "production") return refuse("production-build");
  // FENCE 2 — the runtime mode, as an explicit allow-list.
  if (env.CINATRA_RUNTIME_MODE !== "development") {
    return refuse("not-development-runtime");
  }
  // FENCE 3 — the connection this request actually arrived on.
  const peer = socketPeerVerdict(request.headers);
  if (!peer.ok) return refuse(peer.reason);
  // FENCE 4 — the credential, the one a remote caller and a browser both lack.
  if (!bootCredentialPresented(request.headers, env)) {
    return refuse("boot-credential-not-presented");
  }
  return { ok: true };
}

/**
 * The refusal a caller is told, which is deliberately not the reason.
 *
 * The reason names which fence answered and is useful in a local log; handing it
 * to the caller would let a prober map the fences one at a time. Every refusal
 * reads the same from outside.
 */
export function localCallerRefusalMessage(surface: string): string {
  return (
    `${surface} answers only a local caller on this machine presenting the ` +
    `instance's boot credential. Run the cinatra CLI from the host shell.`
  );
}
