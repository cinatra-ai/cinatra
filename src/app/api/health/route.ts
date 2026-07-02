// Unauthenticated host-native Next.js health probe.
//
// `cinatra clone start` polls `http://localhost:31NN/api/health` to know
// when the spawned `pnpm dev` is ready to serve. Must NOT require auth —
// the polling CLI has no session.
//
// Boot-phase readiness (engineering #302 + cinatra#789 item 1): the probe surfaces
// the process-local boot-state snapshot AND reflects readiness in the TOP-LEVEL
// `status` so a deploy health gate that polls top-level status REJECTS a not-ready or
// DURABLY-degraded boot (previously top-level `status` was hard-coded "ok" whenever
// the process served, so a degraded boot passed the gate — the cinatra#789 gap).
//
// HEALTH CONTRACT (what a deploy gate must poll — top-level `status` + HTTP code):
//   readiness "ready"                                   -> status "ok"       HTTP 200
//   readiness "degraded" but ONLY retryable failures     -> status "ok"       HTTP 200 (+ degraded:true)
//     (retryable phases self-heal on the next boot / a lazy path — NOT deploy-blocking)
//   readiness "degraded" with a durable degraded failure -> status "degraded" HTTP 503 (DEPLOY-BLOCKING)
//   readiness "booting"                                  -> status "starting" HTTP 503
//   readiness "failed"                                   -> status "error"    HTTP 503
// A deploy gate requires top-level status == "ok" (equivalently HTTP 200). The nested
// `boot` field still carries the full readiness detail (unchanged shape; `blockingPhases`
// added). The endpoint ALWAYS answers (never throws), so a reachability-based ready-poll
// still works; only the status/HTTP code now reflects readiness.

import { NextResponse } from "next/server";

import { getBootStateSnapshot } from "@/lib/boot/boot-state";
import type { BootStateSnapshot } from "@/lib/boot/boot-state";
import { deriveHealthStatus } from "@/lib/boot/health-status";

export const dynamic = "force-dynamic";

export async function GET() {
  const boot: BootStateSnapshot = getBootStateSnapshot();
  const { status, httpStatus, degraded } = deriveHealthStatus(boot);

  return NextResponse.json(
    {
      status,
      degraded,
      port: process.env.PORT ?? "3000",
      cloneSlug: process.env.CINATRA_CLONE_SLUG ?? null,
      boot: {
        scope: boot.scope,
        readiness: boot.readiness,
        startedAt: boot.startedAt,
        readyAt: boot.readyAt,
        degradedPhases: boot.degradedPhases,
        blockingPhases: boot.blockingPhases,
        ...(boot.fatalPhase ? { fatalPhase: boot.fatalPhase } : {}),
      },
    },
    { status: httpStatus },
  );
}
