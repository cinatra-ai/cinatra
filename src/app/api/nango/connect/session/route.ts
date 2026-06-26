import { NextResponse } from "next/server";
import { getNangoSystem } from "@/lib/nango-system";
import { getAuthSession, isPlatformAdmin, resolveOrgRoleForSession } from "@/lib/auth-session";

export const dynamic = "force-dynamic";

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
  const result = await nango.handleNangoConnectSessionRequest(request, {
    userId: session.user.id,
    userEmail: session.user.email,
    userDisplayName: session.user.name,
  });
  return NextResponse.json(result.body, result.status ? { status: result.status } : undefined);
}
