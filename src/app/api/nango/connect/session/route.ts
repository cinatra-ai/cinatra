import { NextResponse } from "next/server";
import { getNangoSystem } from "@/lib/nango-system";
import { getAuthSession, isPlatformAdmin, resolveOrgRoleForSession } from "@/lib/auth-session";

export const dynamic = "force-dynamic";

// Node's fetch surfaces a network failure as a `TypeError: fetch failed` whose
// `cause.code` carries the underlying socket/DNS error. These codes mean the
// Nango SERVER itself was unreachable (down / wrong URL / DNS / timeout) — an
// INFRA failure, distinct from a bad request the connector legitimately rejects.
const NANGO_UNREACHABLE_CAUSE_CODES = new Set([
  "ECONNREFUSED", // server not listening
  "ENOTFOUND", // DNS: host does not resolve
  "EAI_AGAIN", // DNS: temporary resolution failure
  "ETIMEDOUT", // connect timed out
  "ECONNRESET", // connection dropped mid-flight
  "UND_ERR_CONNECT_TIMEOUT", // undici connect timeout
  "UND_ERR_SOCKET", // undici socket error
]);

/**
 * Pure classifier: does this thrown error mean the Nango server was UNREACHABLE
 * (an infra/upstream outage) rather than a request the connector rejected?
 *
 * Distinguishes "Nango server down" from bad input so the route can surface an
 * actionable diagnostic instead of an opaque 400. Recognizes Node fetch network
 * failures (`fetch failed` + `cause.code`) and abort/timeout errors.
 */
export function isNangoServerUnreachable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Abort/timeout (e.g. an AbortController watchdog around the upstream call).
  if (err.name === "AbortError" || err.name === "TimeoutError") return true;
  const causeCode =
    "cause" in err ? (err as { cause?: { code?: unknown } }).cause?.code : undefined;
  if (typeof causeCode === "string" && NANGO_UNREACHABLE_CAUSE_CODES.has(causeCode)) {
    return true;
  }
  // A bare `fetch failed` TypeError with no classifiable cause is still a
  // transport failure to reach the server, not a 4xx the connector chose.
  return err instanceof TypeError && /fetch failed/i.test(err.message);
}

export async function POST(request: Request) {
  // Resolution miss => a DEFINED 503 with a marker (never a silent success).
  // Unreachable in prod: nango is a systemExtension whose REQUIRED activation
  // is boot-armed; this guards degraded/build contexts only (test-pinned).
  const nango = getNangoSystem();
  if (!nango) {
    return NextResponse.json(
      { error: "The connection service is not available.", code: "nango-system-unavailable" },
      { status: 503 },
    );
  }

  // Normalize scope BEFORE authz: the app-scope UI omits `scope`, and the
  // connector treats a missing scope as the privileged *app* default — so a
  // missing scope must be gated as the most-privileged path, not the least.
  const body = (await request.clone().json().catch(() => null)) as
    | { scope?: string }
    | null;
  const scope = body?.scope ?? "app";

  // Require a VALIDATED session for ALL scopes. getAuthSession() already
  // validates (not mere cookie presence); a null session must NOT fall through
  // to the connector via optional chaining.
  const session = await getAuthSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  if (scope === "user") {
    // User scope: require & pass a validated userId; never fall through.
    if (!session.user.id) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
  } else {
    // app / missing scope mutates shared, instance-global connector state —
    // require org-admin/org-owner OR platform-admin manage authority.
    const orgRole = await resolveOrgRoleForSession(session);
    const isManager =
      isPlatformAdmin(session) || orgRole === "org_owner" || orgRole === "org_admin";
    if (!isManager) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
  }

  // Pass `request` (the original, unconsumed body) to the connector; we only
  // ever cloned it above for the pre-authz scope read.
  //
  // The delegate reaches out to the Nango server. When that server is DOWN the
  // underlying fetch throws — previously bubbling up as an opaque 400 with no
  // diagnostic in the UI or the server log, leaving connectors silently
  // un-connectable (cinatra#533). Classify the infra/upstream-unreachable case,
  // log it with context, and surface an actionable message instead.
  let result;
  try {
    result = await nango.handleNangoConnectSessionRequest(request, {
      userId: session.user.id,
      userEmail: session.user.email,
      userDisplayName: session.user.name,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (isNangoServerUnreachable(err)) {
      console.error(
        `[nango/connect/session] connect-session failed — Nango server unreachable (scope=${scope}): ${detail}`,
      );
      return NextResponse.json(
        {
          error: "Connection service is unreachable — check the Nango server.",
          code: "nango-server-unreachable",
        },
        { status: 502 },
      );
    }
    // Not an infra outage: still avoid an opaque crash, but don't mislabel a
    // genuine bug as a server-down. Log with context and return a defined 500.
    console.error(
      `[nango/connect/session] connect-session failed unexpectedly (scope=${scope}): ${detail}`,
    );
    return NextResponse.json(
      { error: "Failed to start the connection session.", code: "nango-connect-session-failed" },
      { status: 500 },
    );
  }
  return NextResponse.json(result.body, result.status ? { status: result.status } : undefined);
}
