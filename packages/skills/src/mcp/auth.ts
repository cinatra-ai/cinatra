import "server-only";

/**
 * Gate an MCP primitive on platform_admin.
 *
 * Mirrors the admin-gating pattern used by other MCP primitive handlers
 * (e.g. the `resolveIsPlatformAdminFromSession` helper in `handlers.ts`),
 * but lifted into a shared helper so admin-gated primitives can call a
 * single line at the top of their bodies.
 *
 * Resolution order for the actor's platform role:
 *   1. The `actor.platformRole` populated by `actorContextFromMcpRequest`
 *      (which loads the Better Auth session under the hood).
 *   2. A direct `getAuthSession()` + `isPlatformAdmin()` probe as a
 *      defense-in-depth fallback for code paths where the kernel was unable
 *      to populate the actor envelope (e.g. scheduler-fired BullMQ jobs,
 *      where session-cookie context is unavailable but server-side
 *      identity may still be derivable from the actor's principalId).
 *
 * Throws `PrimitiveInvocationError({ code: "not_admin" })` on rejection.
 * Returns `void` on success.
 */

import { PrimitiveInvocationError } from "@cinatra-ai/mcp-client";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import { actorContextFromMcpRequest } from "@cinatra-ai/agents/auth-policy";
import { getAuthSession, isPlatformAdmin } from "@/lib/auth-session";

export async function requireAdminActor(
  actor: PrimitiveActorContext,
): Promise<void> {
  // Trusted-hint early-exit. When the MCP transport stamped
  // `platformRole: "platform_admin"` on the actor envelope (cookie session
  // OR the localhost dev bypass in
  // `packages/mcp-server/src/dev-admin-bypass.ts`), honor it without
  // rebuilding from session. Without this short-circuit,
  // `actorContextFromMcpRequest` below derives `platformRole` exclusively
  // from `getAuthSession()` and DROPS the upstream hint — the dev bypass
  // would never reach this gate. The transport-layer guards (NODE_ENV !=
  // production AND CINATRA_MCP_DEV_ADMIN_BYPASS=true AND localhost) make
  // this trust safe.
  const actorWithRole = actor as PrimitiveActorContext & { platformRole?: "platform_admin" | "member" };
  if (actorWithRole.platformRole === "platform_admin") return;

  // Resolve the actor's org context first so the kernel can populate
  // `platformRole` from the active Better Auth session. Failures here are
  // non-fatal — we still try the direct probe below.
  let orgId: string | undefined;
  try {
    const session = await getAuthSession();
    orgId = session?.session?.activeOrganizationId ?? undefined;
  } catch {
    // ignore — actor may already carry orgId via the upstream envelope
  }

  let ctx: Awaited<ReturnType<typeof actorContextFromMcpRequest>> | undefined;
  try {
    ctx = await actorContextFromMcpRequest(actor, orgId);
  } catch {
    // ignore — fall through to the direct session probe below
  }

  if (ctx?.platformRole === "platform_admin") return;

  // Defense-in-depth fallback: probe the live Better Auth session directly.
  // Handles the scheduler/worker actor case where
  // `actorContextFromMcpRequest` could not populate `platformRole`.
  try {
    const session = await getAuthSession();
    if (session && isPlatformAdmin(session)) return;
  } catch {
    // ignore — proceed to throw
  }

  throw new PrimitiveInvocationError({
    code: "not_admin",
    message: "Admin role required for this operation.",
    retryable: false,
  });
}
