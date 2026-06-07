/**
 * MCP handlers for the dashboard-cube semantic-query primitives.
 *
 * Vanilla integration of drizzle-cube's native `getCubeTools` (`discover`,
 * `validate`, `load`) into Cinatra's MCP transport. The three handlers
 * just dispatch to drizzle-cube — no Cinatra-side query rewriting,
 * limit clamping, or row post-processing. drizzle-cube owns the query
 * lifecycle end-to-end; this module owns identity resolution and
 * registration shape.
 *
 * Why so thin: the integration is intentionally vanilla: "you are not
 * reinventing what it offers, you just make sure you integrate it as is
 * into Cinatra". Any HTTP-route-style policy (semantic-query limits,
 * unsupported-analysis rejection, `last_run_at` humanisation) is out of
 * scope for this transport contract; transport-parity work can add a small
 * wrapper without changing this contract.
 *
 * Auth: read from `mcpRequestContextStorage` populated by the MCP
 * transport. Strict A2A precedence — if `a2aActorContext` is present, BOTH
 * userId AND orgId must come from it. Identity flows into drizzle-cube's
 * `getSecurityContext`; the cube's SQL `where` clause enforces tenant
 * isolation at the predicate layer (`org_id IN (...ctx.accessibleOrgIds) OR
 * run_by = ctx.userId`) with multi-org membership coverage.
 *
 * The handler-shape mirrors `packages/lists/src/mcp/handlers.ts` so the
 * static tool-count scanner in
 * `src/__tests__/mcp-server-tool-count.test.ts` discovers all three tool
 * names via its snake-case regex.
 */
import "server-only";

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";

import {
  buildSecurityContextWithAccessibleOrgIds,
} from "../auth/security-context";
import { listAccessibleOrgIdsForUser } from "@/lib/better-auth-db";
import { getMcpCubeTools } from "./cubes-singleton";

// ─── Identity resolution ─────────────────────────────────────────────────
/**
 * Resolve `{ userId, organizationId }` for the active MCP request.
 *
 * Strict A2A precedence: if `a2aActorContext` is present, BOTH `userId`
 * AND `orgId` MUST come from it — never mix half-A2A / half-top-level
 * identities. Falls back to the top-level ALS context only when no A2A
 * context is set. Returns `null` (which surfaces as `isError: true`)
 * when identity is incomplete.
 */
// Dev-mode diag sink. The dev server's stdout isn't reliably captured by
// the user's terminal across HMR cycles, so a sustained `missing identity`
// would have no visible breadcrumb. Writing to a known file lets either the
// operator OR a follow-up Claude session read the actual ALS state when the
// next chat call hits this path. PRODUCTION never touches the disk here.
function appendCubeIdentityDiag(payload: Record<string, unknown>): void {
  if (process.env.NODE_ENV === "production") return;
  try {
    const dir = join(process.cwd(), "data", "logs");
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // dir may already exist — ignore.
    }
    const entry = `${new Date().toISOString()} ${JSON.stringify(payload)}\n`;
    appendFileSync(join(dir, "cube-identity-diag.log"), entry);
  } catch {
    // Diagnostic must never break the request.
  }
}

export function resolveDashboardCubeIdentity():
  | { userId: string; organizationId: string }
  | null {
  const ctx = mcpRequestContextStorage.getStore();
  if (!ctx) {
    appendCubeIdentityDiag({
      reason: "als_getstore_returned_null",
      note: "drizzle-cube dispatch is running outside the MCP request frame",
    });
    return null;
  }
  if (ctx.a2aActorContext) {
    const a2aUser = ctx.a2aActorContext.userId;
    const a2aOrg = ctx.a2aActorContext.orgId;
    if (!a2aUser || !a2aOrg) {
      appendCubeIdentityDiag({
        reason: "a2a_path_missing_identity",
        hasA2aUser: !!a2aUser,
        hasA2aOrg: !!a2aOrg,
      });
      return null;
    }
    return { userId: a2aUser, organizationId: a2aOrg };
  }
  if (!ctx.userId || !ctx.orgId) {
    appendCubeIdentityDiag({
      reason: "top_level_ctx_missing_identity",
      hasUserId: !!ctx.userId,
      hasOrgId: !!ctx.orgId,
      delegatedRestricted: ctx.delegatedRestricted,
      hasDelegatedActor: !!ctx.delegatedActor,
      delegatedActorOrgPresent: !!ctx.delegatedActor?.orgId,
      delegatedActorUserPresent: !!ctx.delegatedActor?.userId,
    });
    return null;
  }
  return { userId: ctx.userId, organizationId: ctx.orgId };
}

// ─── Tool result envelope ────────────────────────────────────────────────
export type DashboardCubeToolResult = {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  readonly structuredContent: Readonly<Record<string, unknown>>;
  readonly isError: boolean;
};

// ─── Handler factory ─────────────────────────────────────────────────────
/**
 * Build the dashboard-cube MCP handlers. The exported map keys MUST be the
 * snake_case tool names the static tool-count scanner expects.
 *
 * Vanilla-strict dispatch: `dispatch` is a pure pass-through to drizzle-cube.
 * There is NO Cinatra-side pre-flight auth check, because drizzle-cube already
 * handles auth the way it wants:
 *
 *   - `discover` — never invokes `getSecurityContext`; returns the cube
 *     catalog regardless of identity (catalog is not tenant-scoped).
 *   - `validate` — invokes `getSecurityContext` but silently catches
 *     thrown errors; still returns the parsed query.
 *   - `load` / `chart` — awaits `getSecurityContext` and surfaces a
 *     thrown identity error as `MCPToolResult.isError = true`.
 *
 * A Cinatra-side pre-flight (`if (!identity) return errorEnvelope(...)`)
 * would pre-empt all four paths uniformly with `unauthorized`. That is
 * stricter than vanilla drizzle-cube, so `discover` and `validate` remain
 * aligned with the upstream library.
 */
export function createDashboardCubeMcpHandlers() {
  // Construct the bridge ONCE per process. `getSecurityContext` is a
  // closure that reads ALS on every call — no static identity capture.
  // accessibleOrgIds includes all Better Auth memberships.
  const tools = getMcpCubeTools({
    getSecurityContext: async () => {
      const identity = resolveDashboardCubeIdentity();
      if (!identity) {
        throw new Error(
          "dashboards_cube_*: missing user/organization identity in MCP request context",
        );
      }
      const sc = await buildSecurityContextWithAccessibleOrgIds(
        identity,
        listAccessibleOrgIdsForUser,
      );
      if (!sc) {
        throw new Error(
          "dashboards_cube_*: failed to build SecurityContext from identity",
        );
      }
      return sc;
    },
  });

  async function dispatch(name: string, input: unknown): Promise<DashboardCubeToolResult> {
    return tools.handle(name, input);
  }

  return {
    dashboards_cube_discover: async (input: unknown) => dispatch("dashboards_cube_discover", input),
    dashboards_cube_validate: async (input: unknown) => dispatch("dashboards_cube_validate", input),
    dashboards_cube_load: async (input: unknown) => dispatch("dashboards_cube_load", input),
    // drizzle-cube's `chart` tool executes the same query as `load` but
    // emits a result paired with the MCP App resource — clients that
    // implement the MCP Apps protocol (Claude Desktop, Claude.ai) render an
    // interactive visualization; text-only clients see the JSON payload like
    // `load`.
    dashboards_cube_chart: async (input: unknown) => dispatch("dashboards_cube_chart", input),
  };
}
