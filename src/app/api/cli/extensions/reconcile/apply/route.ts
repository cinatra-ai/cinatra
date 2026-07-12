// ---------------------------------------------------------------------------
// POST /api/cli/extensions/reconcile/apply — authenticated `cinatra extensions
// reconcile --apply` over the API. Part of #1042 (the reconcile lever).
//
// The server RE-PLANS immediately before dispatch; when the body carries
// `{ planDigest }` it is verified as a lightweight CAS and a mismatch is REFUSED
// with HTTP 409 `{ code: "plan-digest-mismatch" }` (the exact shape the CLI's
// `surfaceError` recognises) before ANY execution. Application is per-candidate
// ISOLATED and dispatched under the defined auto-update SYSTEM actor — every
// per-target gate, the pre-dispatch recheck, and the expected-version CAS still
// apply (only the daily scheduler is decoupled). See
// `@/lib/cli-api/extensions-reconcile`.
//
// AUTH: PLATFORM-ADMIN ONLY via `authorizeCliRequest` — the exact mirror of the
// sibling `/api/cli/*` routes: cookie session, a verified remote Bearer carrying
// `cli:extensions:write`, or the dev-admin loopback bypass. Platform-admin
// because the dispatch mutates instance-global (platform-scoped NULL-org)
// extension rows with no org predicate.
// ---------------------------------------------------------------------------

import { NextResponse } from "next/server";

import { authorizeCliRequest } from "@/lib/cli-api/route-guard";
import {
  applyReconcile,
  PLAN_DIGEST_MISMATCH_CODE,
  PlanDigestMismatchError,
} from "@/lib/cli-api/extensions-reconcile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const guard = await authorizeCliRequest(request, {
    minTier: "platform-admin",
    requiredScope: "cli:extensions:write",
  });
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  // Body is optional: an empty body or `{}` re-plans against live state;
  // `{ planDigest: "<digest>" }` pins the exact candidate set apply may execute
  // (CAS). Parse defensively and FAIL CLOSED — a malformed body, a non-object
  // (array / string / null), or a `planDigest` key present but not a non-empty
  // string is the caller's fault (400), never a silent unpinned apply and never
  // a 500.
  let expectedDigest: string | undefined;
  try {
    const raw = await request.text();
    if (raw.trim() !== "") {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return NextResponse.json(
          { error: "Request body must be a JSON object." },
          { status: 400 },
        );
      }
      // A PRESENT `planDigest` key must be a non-empty string. An explicit
      // null / number / empty string is rejected rather than silently treated
      // as an unpinned apply (which would permit a write the caller may not
      // have intended). Only an ABSENT key means "unpinned".
      if ("planDigest" in parsed) {
        const pd = (parsed as { planDigest?: unknown }).planDigest;
        if (typeof pd !== "string" || pd.trim() === "") {
          return NextResponse.json(
            { error: "`planDigest` must be a non-empty string when supplied." },
            { status: 400 },
          );
        }
        expectedDigest = pd;
      }
    }
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body." },
      { status: 400 },
    );
  }

  // The initiating operator is the authenticated platform admin; the dev-admin
  // loopback bypass has no real user id, so record the bypass principal
  // honestly rather than an empty string.
  const initiatingOperator = guard.actor.userId ?? "system:dev-admin-bypass";

  try {
    const result = await applyReconcile({ expectedDigest, initiatingOperator });
    return NextResponse.json(result, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    // CAS lost: the pinned digest no longer matches the recomputed plan. Nothing
    // was executed. Surface the stable code the CLI keys on → 409.
    if (
      error instanceof PlanDigestMismatchError ||
      (error as { code?: unknown } | null | undefined)?.code === PLAN_DIGEST_MISMATCH_CODE
    ) {
      return NextResponse.json(
        {
          error:
            "The plan changed since the supplied --plan-digest (the candidate set drifted). Re-run --plan for a fresh digest, or --apply without --plan-digest.",
          code: PLAN_DIGEST_MISMATCH_CODE,
        },
        { status: 409 },
      );
    }
    console.error("[cli-api/extensions/reconcile/apply] failed", error);
    return NextResponse.json(
      { error: "Failed to apply the reconcile plan." },
      { status: 500 },
    );
  }
}
