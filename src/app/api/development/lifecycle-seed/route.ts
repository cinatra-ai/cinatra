import { NextResponse } from "next/server";

import {
  SEED_MAX_BODY_BYTES,
  lifecycleSeedEnvVerdict,
  lifecycleSeedRequestVerdict,
} from "@/lib/test-support/lifecycle-seed-fence";

// ---------------------------------------------------------------------------
// POST /api/development/lifecycle-seed — the IN-PROCESS lifecycle seed path
// (cinatra#2683, epic #2564 S8f).
//
// A TEST-ONLY ROUTE, and it is treated as the security surface it is. Read the
// fence's own contract in `@/lib/test-support/lifecycle-seed-fence`; in short,
// FOUR independent gates must all pass — an explicit development runtime under a
// non-production build, the scripted LLM provider's OWN
// `assertScriptedProviderNotProduction` gate with the flag actually set, a
// high-entropy per-launch capability presented as a bearer (UNSET = the route is
// off, which is every stack's default), and a JSON, same-site, unforwarded,
// loopback-authority request.
//
// WHAT IT IS FOR. Two S8f parity views need rows that only the shipped writers
// can produce, and those writers are `server-only` behind a top-level `await`
// that no out-of-process runner can load. This route is the smallest thing that
// puts a caller INSIDE the Next process: it names a SUBJECT and calls the
// writers. It contains no SQL and adds no persistence of its own.
//
// WHAT IT CANNOT DO. It cannot write a row around a writer. It cannot choose a
// type, a payload, a finding or a verdict — all of those are pinned in the driver
// and the verdict is computed by the pipeline. It cannot write for a subject who
// is not a live member of the named org, nor against a run that belongs to
// another org, nor for a reader who may not read that run. The body it will read
// is bounded, and there is no arm that takes caller-shaped row content.
//
// The drivers are imported LAZILY, after the fence answers `ok`, so a build that
// never seeds never evaluates the seeding module graph.
// ---------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * THE ONE REFUSAL. Same body, same headers, for every fence — a probing caller
 * learns nothing about which gate it tripped, and the status is the only signal
 * (404 "there is no such surface here", 403 "there is, and you are not it"). The
 * reason is written to the server log, where the operator who armed the route can
 * read it and a remote caller cannot.
 */
function refuse(verdict: { status: 403 | 404; reason: string }): NextResponse {
  console.warn(`[lifecycle-seed] refused: ${verdict.reason}`);
  return NextResponse.json(
    { error: "Not available." },
    { status: verdict.status, headers: { "Cache-Control": "no-store" } },
  );
}

type Body = {
  fixture?: unknown;
  orgId?: unknown;
  actorId?: unknown;
  runId?: unknown;
};

/** An ID-SHAPED string. Bounded, printable, no whitespace — every parameter this
 *  route accepts is an identifier, so nothing longer or stranger is a parameter
 *  it has. */
function id(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return null;
  return /^[A-Za-z0-9._:@/-]+$/.test(trimmed) ? trimmed : null;
}

export async function POST(request: Request): Promise<Response> {
  const envVerdict = lifecycleSeedEnvVerdict(process.env);
  if (!envVerdict.ok) return refuse(envVerdict);
  const requestVerdict = lifecycleSeedRequestVerdict(request, process.env);
  if (!requestVerdict.ok) return refuse(requestVerdict);

  // BOUND THE BODY BEFORE PARSING IT. Every parameter is an id; a caller sending
  // more than a few kilobytes is not calling this route, and `request.json()`
  // would buffer whatever it sent.
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > SEED_MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Body too large." }, { status: 413 });
  }
  const raw = await request.text();
  // BYTES, not UTF-16 code units — a multibyte body would otherwise pass a limit
  // it exceeds (codex round 1).
  if (Buffer.byteLength(raw, "utf8") > SEED_MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Body too large." }, { status: 413 });
  }

  let body: Body;
  try {
    const parsed: unknown = JSON.parse(raw);
    // `null` and `[1,2]` are both valid JSON and neither is a body; reading a
    // field off them is a 500 for what is plainly a 400 (codex round 1).
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return NextResponse.json({ error: "expected a JSON object body" }, { status: 400 });
    }
    body = parsed as Body;
  } catch {
    return NextResponse.json({ error: "expected a JSON body" }, { status: 400 });
  }

  const fixture = id(body.fixture);
  const orgId = id(body.orgId);
  const actorId = id(body.actorId);
  const runId = id(body.runId);
  if (!orgId || !actorId || !runId) {
    return NextResponse.json(
      { error: "orgId, actorId and runId are required — the fixture names its subject" },
      { status: 400 },
    );
  }
  if (fixture !== "repairVerification" && fixture !== "restorableChangeSet") {
    return NextResponse.json(
      {
        error:
          'fixture must be "repairVerification" or "restorableChangeSet" — the seed drives ' +
          "shipped writers only, so there is no generic row-writing arm",
      },
      { status: 400 },
    );
  }

  const subject = { orgId, actorId, runId };
  try {
    const drivers = await import("@/lib/test-support/lifecycle-seed-drivers");
    const result =
      fixture === "repairVerification"
        ? await drivers.seedRepairVerification(subject)
        : await drivers.seedRestorableChangeSet(subject);
    return NextResponse.json(
      { fixture, ...result },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    // A writer's refusal is the honest answer here, and it is safe to return: by
    // this point the caller has already presented the capability, so they are the
    // operator who armed the route, not a prober. The fence's own refusals above
    // stay opaque for exactly the opposite reason.
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[lifecycle-seed] ${fixture} failed: ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
