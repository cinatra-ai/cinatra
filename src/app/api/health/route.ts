// Unauthenticated host-native Next.js health probe.
//
// `cinatra clone start` polls `http://localhost:31NN/api/health` to know
// when the spawned `pnpm dev` is ready to serve. Must NOT require auth —
// the polling CLI has no session.
//
// Boot-phase readiness (engineering #302): the probe also surfaces the
// process-local boot-state snapshot so a phase failure is VISIBLE to operators.
// The top-level `status` stays "ok" whenever the process is serving (a `degraded`
// boot still serves — only reduced functionality), so the CLI ready-poll contract
// is unchanged; the `boot` field carries the readiness + the degraded-phase list.

import { NextResponse } from "next/server";

import { getBootStateSnapshot } from "@/lib/boot/boot-state";

export const dynamic = "force-dynamic";

export async function GET() {
  const boot = getBootStateSnapshot();
  return NextResponse.json({
    status: "ok",
    port: process.env.PORT ?? "3000",
    cloneSlug: process.env.CINATRA_CLONE_SLUG ?? null,
    boot: {
      scope: boot.scope,
      readiness: boot.readiness,
      startedAt: boot.startedAt,
      readyAt: boot.readyAt,
      degradedPhases: boot.degradedPhases,
      ...(boot.fatalPhase ? { fatalPhase: boot.fatalPhase } : {}),
    },
  });
}
