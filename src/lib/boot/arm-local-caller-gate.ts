// ---------------------------------------------------------------------------
// ARMING THE LOCAL-CALLER GATE, at import time.
// ---------------------------------------------------------------------------
//
// Two things have to happen before this instance answers its first request, and
// both are side effects with no caller, which is why they live in a module the
// instrumentation entry point simply IMPORTS rather than in a function it has
// to remember to call:
//
//   1. THE STAMP. Subscribe to Node's `http.server.request.start` channel so
//      every incoming request carries the connecting socket's peer address and
//      the forwarded headers the CLIENT sent — recorded BEFORE the framework
//      writes its own `x-forwarded-*` headers onto the request. A request that
//      reaches a handler unstamped is REFUSED by @/lib/local-caller-gate, so
//      arming late does not fail open, it fails the operator's own CLI.
//      See @/lib/request-peer for why the second stamp exists at all.
//   2. THE CREDENTIAL. Mint this boot's 0600 local secret — the fact a caller
//      can only hold by being able to read a file as the user this instance
//      runs as. Development runtimes only: the surfaces it opens do not exist
//      in production, and @/lib/boot-credential refuses to write one there.
//
// WHY IMPORT TIME RATHER THAN INSIDE `register()`. Both are cheap and local: a
// synchronous channel subscription, and one small file write behind two
// environment fences. Neither touches the database, the scheduler or the
// network, so neither is subject to the `next build` page-data guard that
// `register()` applies to real boot work — and being ahead of it is the point,
// because the gate's callers refuse anything this module did not observe.
//
// A MINT FAILURE MUST NOT TAKE THE BOOT DOWN. An instance with no credential
// refuses every caller of those surfaces, which is the correct fail-closed
// answer, and mintBootCredential() retires the previous boot's file before it
// writes — so a failure here leaves NOTHING behind rather than silently
// re-arming a token this boot never issued.
// ---------------------------------------------------------------------------

import { mintBootCredential } from "@/lib/boot-credential";
import { installSocketPeerStamp } from "@/lib/request-peer";

installSocketPeerStamp();

if (
  process.env.NODE_ENV !== "production" &&
  process.env.CINATRA_RUNTIME_MODE === "development"
) {
  try {
    mintBootCredential();
  } catch {
    // Fail closed and stay up: the local-only surfaces refuse everyone.
  }
}
