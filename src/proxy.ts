import type { NextRequest } from "next/server";
import { guardAppRoute } from "@/lib/auth-route-guard";

// NODE-RUNTIME INVARIANT. In Next.js 16 the proxy (this file, the renamed
// middleware) ALWAYS runs on the Node.js runtime — declaring a `runtime` in the
// config below is a build error (E1031, "Proxy always runs on Node.js runtime").
// Do NOT add one. This guarantee is load-bearing for widget-stream runtime
// trust (slice 4): `guardAppRoute` reads a per-replica in-memory approved-slug
// snapshot that a boot-time background refresher (instrumentation.node) keeps
// warm; both run in the same Node process (the snapshot is anchored on
// globalThis), so the guard sees the refresher's writes. Forcing the edge
// runtime would sandbox this away and silently break that liveness layer (see
// src/lib/widget-stream-runtime-slug-snapshot.ts). The snapshot is pure
// liveness, never the authz boundary — each widget route self-authenticates.
export async function proxy(request: NextRequest) {
  return guardAppRoute(request);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|txt|xml)$).*)"],
};
