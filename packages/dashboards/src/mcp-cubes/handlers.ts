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
  listAccessibleOrgIdsForUser,
  readUserIsPlatformAdmin,
} from "@/lib/better-auth-db";
import { resolveAndValidateCubeId, type CubeJsWireQuery } from "@cinatra-ai/sdk-dashboard";
import {
  assertMcpRuntimeCubeServeable,
  filterMcpCubeIdsForActor,
  type McpCubeActor,
} from "@/lib/dashboards/runtime-cube-serve-host";
import { isRuntimeCube } from "@cinatra-ai/dashboards/runtime-cube-registry";
import { getMcpCubeTools } from "./cubes-singleton";
import { buildDashboardCubeMcpSecurityContext } from "./security-context";

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

// ─── discover-catalog filtering helpers ───────────────────────────────────
/** The candidate cube-id keys a drizzle-cube discover entry may carry. Across
 *  drizzle-cube versions a catalog entry has named its cube via `cube`, `name`,
 *  `cubeName`, `id`, or `title` — accept any string-valued one so the filter is
 *  robust to the version-specific payload shape. */
const CUBE_ID_KEYS = ["cube", "name", "cubeName", "id", "title"] as const;

/** The cube id of a catalog entry, trying every known id key in order. */
function cubeIdOf(entry: unknown): string | null {
  if (typeof entry !== "object" || entry === null) return null;
  const e = entry as Record<string, unknown>;
  for (const k of CUBE_ID_KEYS) {
    if (typeof e[k] === "string" && (e[k] as string).length > 0) return e[k] as string;
  }
  return null;
}

/** Recursively find arrays-of-cube-entries (objects with a string cube id) in a
 *  drizzle-cube discover payload, so the catalog filter can splice denied
 *  runtime cubes regardless of the exact wrapper shape (defensive). */
function findCubeArrays(node: unknown, into: unknown[][] = [], depth = 0): unknown[][] {
  if (depth > 6 || node === null || typeof node !== "object") return into;
  if (Array.isArray(node)) {
    if (node.some((el) => cubeIdOf(el) !== null)) into.push(node);
    for (const el of node) findCubeArrays(el, into, depth + 1);
    return into;
  }
  for (const v of Object.values(node as Record<string, unknown>)) {
    findCubeArrays(v, into, depth + 1);
  }
  return into;
}

/** Recursively find object-MAPS keyed BY cube id (e.g. `{ ext_x: {...} }`) — an
 *  alternate discover shape — so denied runtime cubes can be deleted by key.
 *  An object qualifies when at least one of its keys is a registered runtime
 *  cube id (so we never touch ordinary config objects). */
function findCubeKeyedMaps(
  node: unknown,
  isRuntime: (id: string) => boolean,
  into: Record<string, unknown>[] = [],
  depth = 0,
): Record<string, unknown>[] {
  if (depth > 6 || node === null || typeof node !== "object" || Array.isArray(node)) return into;
  const obj = node as Record<string, unknown>;
  if (Object.keys(obj).some((k) => isRuntime(k))) into.push(obj);
  for (const v of Object.values(obj)) findCubeKeyedMaps(v, isRuntime, into, depth + 1);
  return into;
}

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
      // Shared resolver: widens accessibleOrgIds AND decorates
      // isPlatformAdmin (DB role lookup) for the llm_usage cube gate.
      // registry.ts uses the SAME helper so the two MCP sites never drift.
      const sc = await buildDashboardCubeMcpSecurityContext(
        identity,
        listAccessibleOrgIdsForUser,
        readUserIsPlatformAdmin,
      );
      if (!sc) {
        throw new Error(
          "dashboards_cube_*: failed to build SecurityContext from identity",
        );
      }
      return sc;
    },
  });

  // Build an error envelope (mirrors drizzle-cube's MCPToolResult shape) for a
  // serve-gate refusal so a runtime-cube denial surfaces as a tool error, not a
  // silent pass-through.
  function serveGateErrorEnvelope(code: string, reason: string): DashboardCubeToolResult {
    const payload = { error: reason, code };
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: true,
    };
  }

  // CG-5 (cinatra#660): for a query-bearing cube tool (load/chart/validate),
  // resolve the cube id and assert the runtime-cube serve-gate BEFORE dispatching
  // to drizzle-cube. The drizzle-cube tenant predicate still applies inside
  // `tools.handle` for both bundled and runtime cubes — this gate is ADDITIVE.
  // `discover` carries no query (it returns the catalog) and is filtered
  // separately by the catalog filter.
  async function serveGateForQuery(input: unknown): Promise<DashboardCubeToolResult | null> {
    const identity = resolveDashboardCubeIdentity();
    // drizzle-cube's MCP tool input is `{ query: <CubeQuery> }` (load/validate/
    // chart) — the cube id lives in `input.query.measures[0]` etc., NOT on the
    // top-level input. Extract `input.query` (falling back to the input itself
    // for any non-wrapped caller) before resolving the cube id, or the gate
    // would never find a cube id and silently pass-through (a CG-5 bypass).
    const inObj = (input ?? {}) as Record<string, unknown>;
    const wire = (
      inObj.query && typeof inObj.query === "object" ? inObj.query : inObj
    ) as CubeJsWireQuery;
    const resolved = resolveAndValidateCubeId(wire);
    if (!resolved.ok) return null; // let drizzle-cube surface the malformed-query error
    const mcpActor: McpCubeActor | null = identity
      ? { userId: identity.userId, organizationId: identity.organizationId }
      : null;
    const verdict = await assertMcpRuntimeCubeServeable(resolved.cubeId, mcpActor);
    if (!verdict.ok) return serveGateErrorEnvelope(verdict.code, verdict.reason);
    return null;
  }

  async function dispatchGated(name: string, input: unknown): Promise<DashboardCubeToolResult> {
    const refusal = await serveGateForQuery(input);
    if (refusal) return refusal;
    return tools.handle(name, input);
  }

  // CG-5 catalog filter for `discover`: after drizzle-cube returns the cube
  // catalog, strip any RUNTIME cube the actor cannot serve so `discover` never
  // lists another org's runtime cube. Mirrors the HTTP `/meta` filter. Defensive:
  // the structured-content shape is drizzle-cube-owned; if no recognizable cube
  // array is found the payload is returned untouched (bundled cubes always pass,
  // so a parse miss can only OVER-include a runtime cube, never tenant DATA —
  // load/validate/chart still enforce CG-5 on the actual query).
  async function dispatchDiscoverFiltered(input: unknown): Promise<DashboardCubeToolResult> {
    const result = await tools.handle("dashboards_cube_discover", input);
    const identity = resolveDashboardCubeIdentity();
    const mcpActor: McpCubeActor | null = identity
      ? { userId: identity.userId, organizationId: identity.organizationId }
      : null;

    // The catalog may live in `structuredContent` AND/OR the JSON text block
    // (drizzle-cube emits the catalog as a text block which the cinatra wrapper
    // parses into structuredContent). Filter a parsed catalog object in place,
    // covering BOTH array-of-entries and object-keyed-by-cube-id shapes. Returns
    // true when anything was redacted.
    async function filterCatalog(root: unknown): Promise<boolean> {
      if (root === null || typeof root !== "object") return false;
      const arrays = findCubeArrays(root);
      const maps = findCubeKeyedMaps(root, isRuntimeCube);
      const runtimeIds = new Set<string>();
      for (const arr of arrays) for (const c of arr) {
        const id = cubeIdOf(c);
        if (id && isRuntimeCube(id)) runtimeIds.add(id);
      }
      for (const m of maps) for (const k of Object.keys(m)) {
        if (isRuntimeCube(k)) runtimeIds.add(k);
      }
      if (runtimeIds.size === 0) return false;
      const allowed = new Set(await filterMcpCubeIdsForActor([...runtimeIds], mcpActor));
      let changed = false;
      for (const arr of arrays) {
        for (let i = arr.length - 1; i >= 0; i--) {
          const id = cubeIdOf(arr[i]);
          if (id && isRuntimeCube(id) && !allowed.has(id)) {
            arr.splice(i, 1);
            changed = true;
          }
        }
      }
      for (const m of maps) {
        for (const k of Object.keys(m)) {
          if (isRuntimeCube(k) && !allowed.has(k)) {
            delete m[k];
            changed = true;
          }
        }
      }
      return changed;
    }

    const sc = result.structuredContent as Record<string, unknown> | undefined;
    const scChanged = await filterCatalog(sc);

    // Also filter the text block (independently parsed; rebuilt only if it both
    // parses AND changes — a non-JSON text block is left untouched).
    let textContent = result.content;
    const textBlock = result.content?.[0];
    if (textBlock && typeof textBlock.text === "string") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(textBlock.text);
      } catch {
        parsed = undefined;
      }
      if (parsed !== undefined) {
        const textChanged = await filterCatalog(parsed);
        if (textChanged) {
          textContent = [{ type: "text", text: JSON.stringify(parsed) }];
        }
      }
    }

    if (!scChanged && textContent === result.content) return result;
    return {
      content: textContent,
      structuredContent: (sc ?? {}) as Readonly<Record<string, unknown>>,
      isError: result.isError,
    };
  }

  return {
    // discover returns the catalog (no query) — filter out runtime cubes the
    // actor cannot serve (CG-5 catalog parity with HTTP /meta).
    dashboards_cube_discover: async (input: unknown) => dispatchDiscoverFiltered(input),
    // validate/load/chart carry a query → CG-5 serve-gate on the resolved cube.
    dashboards_cube_validate: async (input: unknown) => dispatchGated("dashboards_cube_validate", input),
    dashboards_cube_load: async (input: unknown) => dispatchGated("dashboards_cube_load", input),
    // drizzle-cube's `chart` tool executes the same query as `load` but
    // emits a result paired with the MCP App resource — clients that
    // implement the MCP Apps protocol (Claude Desktop, Claude.ai) render an
    // interactive visualization; text-only clients see the JSON payload like
    // `load`.
    dashboards_cube_chart: async (input: unknown) => dispatchGated("dashboards_cube_chart", input),
  };
}
