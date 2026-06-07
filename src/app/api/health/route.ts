// Unauthenticated host-native Next.js health probe.
//
// `cinatra clone start` polls `http://localhost:31NN/api/health` to know
// when the spawned `pnpm dev` is ready to serve. Must NOT require auth —
// the polling CLI has no session.

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    port: process.env.PORT ?? "3000",
    cloneSlug: process.env.CINATRA_CLONE_SLUG ?? null,
  });
}
