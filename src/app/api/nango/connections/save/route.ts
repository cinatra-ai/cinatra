import { NextResponse } from "next/server";
import { getNangoSystem } from "@/lib/nango-system";
import type { NangoConnectionSavedHook } from "@cinatra-ai/sdk-extensions";
import { NANGO_CONNECTION_SAVED_CAPABILITY } from "@cinatra-ai/sdk-extensions/internal";
import { resolveCapabilityProviders } from "@/lib/extension-capabilities-registry";
import { getAuthSession } from "@/lib/auth-session";

export const dynamic = "force-dynamic";

// Structural guard: a capability impl is `unknown` by contract.
function isConnectionSavedHook(impl: unknown): impl is NangoConnectionSavedHook {
  if (typeof impl !== "object" || impl === null) return false;
  const candidate = impl as { connectorKey?: unknown; run?: unknown };
  return typeof candidate.connectorKey === "string" && typeof candidate.run === "function";
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
  const session = await getAuthSession();
  const body = (await request.clone().json().catch(() => null)) as
    | { connectorKey?: string; scope?: string }
    | null;
  const result = await nango.handleNangoConnectionSaveRequest(request, {
    userId: session?.user.id,
  });

  // Registration-driven post-save hooks: a connector that needs to react to a
  // saved connection (e.g. a mailbox provider refreshing its send-as aliases)
  // registers a `nango-connection-saved` capability provider from its
  // serverEntry. Hooks run best-effort — the connection save itself already
  // succeeded; a failed hook can be retried from the connector's tools UI.
  if (result.body.success === true && body?.connectorKey && session?.user.id) {
    const hooks = resolveCapabilityProviders(NANGO_CONNECTION_SAVED_CAPABILITY)
      .map((p) => p.impl)
      .filter(isConnectionSavedHook)
      .filter(
        (hook) =>
          hook.connectorKey === body.connectorKey &&
          (hook.scope === undefined || hook.scope === body.scope),
      );
    for (const hook of hooks) {
      try {
        await hook.run({ userId: session.user.id });
      } catch {
        // Best-effort by contract — never fail the save response.
      }
    }
  }

  return NextResponse.json(result.body, result.status ? { status: result.status } : undefined);
}
