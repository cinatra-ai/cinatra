/**
 * Production `agent_runs` cube.
 *
 * Real cube that:
 *   - exposes 4 dimensions (agent_id alias of templateId, status, created_at)
 *     and 2 measures (count, last_run_at).
 *   - injects an access-scoped SQL predicate from the SecurityContext:
 *     `org_id IN (...ctx.accessibleOrgIds) OR run_by = ctx.userId`.
 *     Surfaces all runs in every org the caller is a member of PLUS any
 *     runs the user personally triggered. Enforced at the SQL predicate
 *     layer — never post-filtered in JS. The predicate supports multi-org
 *     membership via `accessibleOrgIds[]` populated by
 *     `buildSecurityContextWithAccessibleOrgIds`.
 *
 * Lives inside the drizzle-cube adapter directory because the SQL function
 * uses drizzle-cube types (QueryContext, BaseQueryDefinition) and Drizzle
 * expressions. The host (packages/dashboards) injects the agent_runs table
 * reference via the factory parameter — sdk-dashboard never imports
 * `@cinatra-ai/agents/schema` directly.
 */
import { eq, inArray, or, sql, type AnyColumn } from "drizzle-orm";
import type { BaseQueryDefinition, QueryContext } from "drizzle-cube/server";

import type { CubeDescriptor } from "../../../types/cube";
import type { SecurityContext } from "../../../types/security";
import type { RegisteredCube } from "../types";
import { defineCinatraCube } from "../define-cube";

/**
 * Minimum column shape the host's `agent_runs` Drizzle table must satisfy.
 * The host passes the full Drizzle table (which has more columns); this
 * documents the columns the cube actually references.
 *
 * `orgId` is REQUIRED — without it the cube cannot enforce row-level
 * isolation. The Cinatra schema guarantees `agent_runs.org_id NOT NULL`.
 */
export type AgentRunsTable = {
  readonly id: AnyColumn;
  readonly templateId: AnyColumn;
  readonly status: AnyColumn;
  readonly createdAt: AnyColumn;
  readonly orgId: AnyColumn;
  /**
   * `run_by` — the user (Better Auth user.id) who triggered the run.
   * Used by the cube's broadened WHERE clause: surfaces runs the user
   * owns even if they were triggered outside the caller's active org.
   */
  readonly runBy: AnyColumn;
};

/**
 * Minimum column shape for the host's `agent_templates` Drizzle table —
 * needed to JOIN agent_runs.template_id → agent_templates.id so the
 * `agent_name` dimension can resolve to a human-readable name. `name` is
 * the editable template title shown in the agent workspace.
 */
export type AgentTemplatesTable = {
  readonly id: AnyColumn;
  readonly name: AnyColumn;
};

/**
 * Factory arguments for `createAgentRunsCube`.
 *
 * `tableRef` + `columns`: agent_runs main table reference + column refs.
 *
 * `templatesTableRef` + `templateColumns`: agent_templates join target.
 * The cube emits a LEFT JOIN onto agent_templates so portlets can show
 * `agent_name` (humans-readable) instead of `agent_id` (a UUID).
 *
 * `tableRef` is the full Drizzle Table object — drizzle-cube's query
 * compiler introspects it to emit `FROM <schema>.<table>`. Without it,
 * drizzle-cube parameter-binds the FROM clause, which produces invalid
 * SQL and a JSON-serialization crash inside the pg driver.
 *
 * `columns` carries the individual column references the cube wires
 * into dimension/measure SQL functions. We keep these as a separate
 * narrow type so sdk-dashboard never depends on the exact Drizzle
 * table type.
 */
export type CreateAgentRunsCubeOptions = {
  readonly tableRef: unknown;
  readonly columns: AgentRunsTable;
  readonly templatesTableRef: unknown;
  readonly templateColumns: AgentTemplatesTable;
};

export const AGENT_RUNS_CUBE_DESCRIPTOR: CubeDescriptor = {
  id: "agent_runs",
  version: "1.0.0",
  displayName: "Agent Runs",
  description:
    "Agent run executions visible to the caller: rows where the caller is " +
    "the runBy user OR the run belongs to ANY organization the caller is a " +
    "member of via SecurityContext.accessibleOrgIds. Filtering is enforced " +
    "at the SQL predicate layer.",
  dimensions: [
    // agent_id kept for back-compat with any saved DashboardConfig that
    // still references it. New portlets should use agent_name.
    { id: "agent_id", displayName: "Agent ID", type: "string" },
    { id: "agent_name", displayName: "Agent", type: "string" },
    { id: "status", displayName: "Status", type: "string" },
    { id: "created_at", displayName: "Created at", type: "date" },
  ],
  measures: [
    { id: "count", displayName: "Run count", type: "count" },
    // last_run_at is emitted as Postgres EXTRACT(EPOCH ...) seconds. The
    // route-handler post-processor (humanizeAgentRows) converts each row's
    // value to a relative-time string like "30 mins ago" before the load
    // response is returned. DC table renderer has no per-column date
    // formatter.
    { id: "last_run_at", displayName: "Last run at", type: "max" },
  ],
};

/**
 * Reads the Cinatra-typed `organizationId` field back from drizzle-cube's
 * opaque `[k]: unknown` SecurityContext. Throws if missing — a missing
 * organizationId means a SecurityContext was constructed without going
 * through the host's better-auth binding, which is a programmer error.
 */
function readOrganizationId(ctx: QueryContext): string {
  const orgId = ctx.securityContext?.organizationId;
  if (typeof orgId !== "string" || orgId.length === 0) {
    throw new Error(
      "agent_runs cube: SecurityContext.organizationId is required but missing or empty",
    );
  }
  return orgId;
}

/**
 * Reads the actor's userId — required for the "owns" half of the cube's
 * access predicate.
 */
function readUserId(ctx: QueryContext): string {
  const userId = ctx.securityContext?.userId;
  if (typeof userId !== "string" || userId.length === 0) {
    throw new Error(
      "agent_runs cube: SecurityContext.userId is required but missing or empty",
    );
  }
  return userId;
}

/**
 * Reads the actor's `accessibleOrgIds` — the set of organizations the
 * caller is a member of. The cube uses this set to widen the access predicate
 * from `org_id = activeOrg` to `org_id IN (...accessibleOrgIds)` so
 * multi-org users see runs across every org they belong to.
 *
 * Falls back to `[organizationId]` if the field is missing or empty
 * (defensive — preserves single-org-only behavior for SecurityContexts that
 * do not provide multi-org membership).
 */
function readAccessibleOrgIds(ctx: QueryContext, organizationId: string): readonly string[] {
  const raw = ctx.securityContext?.accessibleOrgIds;
  if (Array.isArray(raw) && raw.every((v) => typeof v === "string" && v.length > 0) && raw.length > 0) {
    return raw as readonly string[];
  }
  return [organizationId];
}

/**
 * Factory: takes the host's Drizzle `agent_runs` table reference and
 * returns a `RegisteredCube` ready to pass to `createDrizzleCubeAdapter`.
 *
 * drizzle-cube's query compiler requires the FULL Drizzle Table object in
 * `from`, not a column-bag. Passing a destructured `{id, templateId, ...}`
 * object caused the SQL emitter to parameter-bind the FROM clause
 * (`from $1`), which pg then JSON-serialised → circular-structure crash.
 * Now accepts `tableRef` (the table proper) alongside `columns` (the cube's
 * column refs).
 *
 * The SQL function constructs a base query whose WHERE clause filters by
 * `org_id IN (...SecurityContext.accessibleOrgIds) OR run_by = SecurityContext.userId`
 * (owns-OR-member-of-org). Filtering happens at the SQL predicate layer —
 * cross-org rows the user did NOT trigger and that belong to an org the
 * user is NOT a member of never load.
 *
 * Overloads:
 *   - createAgentRunsCube({ tableRef, columns })  — preferred shape.
 *   - createAgentRunsCube(columns)                — compatibility
 *     shape kept for tests that don't yet pass tableRef; emits a runtime
 *     warning. The SQL emitter still misfires under this path; callers MUST
 *     migrate.
 */
export function createAgentRunsCube(
  arg: CreateAgentRunsCubeOptions | AgentRunsTable,
): RegisteredCube {
  // Back-compat shim — callers that pass the bare AgentRunsTable still
  // work, but the cube won't emit the agent_templates JOIN, so
  // `agent_name` dimension will be missing. New callers MUST pass the
  // `CreateAgentRunsCubeOptions` shape with templatesTableRef + cols.
  const isFullOptions =
    arg && typeof arg === "object" && "tableRef" in arg && "columns" in arg;
  const opts: CreateAgentRunsCubeOptions = isFullOptions
    ? (arg as CreateAgentRunsCubeOptions)
    : {
        tableRef: arg as unknown,
        columns: arg as AgentRunsTable,
        templatesTableRef: undefined as unknown,
        templateColumns: {
          id: (arg as AgentRunsTable).templateId,
          name: (arg as AgentRunsTable).templateId,
        },
      };
  const { tableRef, columns, templatesTableRef, templateColumns } = opts;
  return defineCinatraCube(AGENT_RUNS_CUBE_DESCRIPTOR, {
    buildSql: (ctx): BaseQueryDefinition => {
      // Access predicate:
      //
      //   OWNS    → run_by = ctx.userId
      //              (the user personally triggered this run, possibly
      //               from a different active-org context).
      //   CAN ACCESS → org_id IN (...ctx.accessibleOrgIds)
      //                (the user is a member of the run's owning org —
      //                 multi-org users see runs across every org they
      //                 belong to).
      //
      // `accessibleOrgIds` is populated by
      // `buildSecurityContextWithAccessibleOrgIds` (Better Auth membership
      // query). SecurityContexts without it fall back to `[organizationId]`
      // via `readAccessibleOrgIds`, which keeps single-org behavior.
      const organizationId = readOrganizationId(ctx);
      const userId = readUserId(ctx);
      const accessibleOrgIds = readAccessibleOrgIds(ctx, organizationId);
      const def: BaseQueryDefinition = {
        from: tableRef as unknown as BaseQueryDefinition["from"],
        where: or(
          inArray(columns.orgId, accessibleOrgIds as string[]),
          eq(columns.runBy, userId),
        ),
      };
      // LEFT JOIN agent_templates so dimensions/measures can read
      // agent_templates.name. The join is omitted entirely in the
      // back-compat single-arg call path (templatesTableRef === undefined).
      if (templatesTableRef !== undefined) {
        def.joins = [
          {
            table: templatesTableRef as BaseQueryDefinition["from"],
            on: eq(columns.templateId, templateColumns.id),
            type: "left",
          },
        ];
      }
      return def;
    },
    dimensionSql: {
      agent_id: columns.templateId,
      // Humanise the agent identifier.
      //   coalesce(nullif(t.name, ''), runs.template_id)
      // → prefers the template name; falls back to the UUID when name
      //   is missing/empty (runs without a resolvable template name).
      agent_name: sql<string>`coalesce(nullif(${templateColumns.name}, ''), ${columns.templateId})`,
      status: columns.status,
      created_at: columns.createdAt,
    },
    measureSql: {
      count: columns.id,
      // Emit as epoch seconds (numeric) so the SQL stays MAX()-compatible
      // and the route-handler post-processor can format it as a
      // relative-time string. The descriptor lists `last_run_at` as
      // `type: "max"`; epoch math works with MAX.
      last_run_at: sql<number>`extract(epoch from ${columns.createdAt})`,
    },
  });
}

/**
 * Helper for tests + the host: produces a Cinatra SecurityContext narrowed
 * to the fields the agent_runs cube reads. The /agents widgets pass this
 * through `useCubeQuery`.
 */
export type AgentRunsSecurityContext = Pick<
  SecurityContext,
  "userId" | "organizationId" | "workspaceId" | "teamIds" | "ownerLevel"
>;
