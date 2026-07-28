"use server";

import { revalidatePath } from "next/cache";
import { requireAdminSession } from "@/lib/auth-session";
import { setMcpPublicBaseUrl } from "@cinatra-ai/mcp-server/credentials";

/**
 * Persist the workspace's public base URL. Pass an empty/null URL to clear it.
 *
 * RESTART REQUIRED before a changed URL takes effect for external MCP clients.
 * `getPublicMcpServerUrl()` re-reads the saved value on the next request, so
 * every PER-REQUEST reader picks the change up without a restart: this tab,
 * /api/mcp-settings, and Better Auth's `trustedOrigins` (already passed as a
 * function, so it is re-evaluated per request).
 *
 * The OAuth `validAudiences` do NOT follow. `src/lib/auth.ts` builds the MCP
 * auth plugins at MODULE EVAL via `createMcpServerAuthPlugins`, and
 * `@better-auth/oauth-provider` SNAPSHOTS its options object at plugin
 * construction — it spreads the caller's options into its internal `opts`, so
 * even a lazily-derived audience list would be materialized at that single
 * read. The allowlist an RFC 8707 `resource` is checked against is therefore
 * fixed at startup, in BOTH directions:
 *
 *   - SET / REPLACE: until the app restarts, a token request naming the new
 *     public URL is REJECTED outright by the provider's resource check
 *     (`invalid_request`) — no token is issued at all. A provider-side tool
 *     listing run right after a save fails for that reason: a stale-boot
 *     symptom, not a broken tunnel.
 *   - CLEAR / REPLACE: the PREVIOUS public audience stays in the boot-time
 *     allowlist, so a client still naming the old URL keeps minting against it
 *     until the app restarts. Clearing the field is not, on its own, a
 *     revocation.
 *
 * Scope: the audiences derived from the public origin — the MCP audience and
 * the CLI control-plane audience (`<publicOrigin>/api/cli`, from
 * `extraAudienceBasePaths`). The A2A bearer path binds a DIFFERENT resource and
 * is out of scope for this note.
 *
 * Pinned by:
 *   - packages/mcp-server/src/__tests__/auth-plugins.test.ts
 *     ("public base URL audience freeze")
 *   - src/app/configuration/development/__tests__/tunnel-tab.test.tsx
 *     (this comment + the tab's restart notice + the save toast)
 */
export async function setMcpPublicBaseUrlAction(input: {
  url: string | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  await requireAdminSession();
  try {
    setMcpPublicBaseUrl(input.url);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  revalidatePath("/configuration/development");
  revalidatePath("/configuration/mcp");
  return { ok: true };
}
