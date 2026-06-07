/**
 * `projects` cube.
 *
 * Real cube that lists the projects visible to the caller. Visibility
 * comes from `SecurityContext.visibleProjectIds` (pre-computed by the
 * host's `buildSecurityContextWithVisibility` from the canonical
 * `actor.projectGrants` source) so the cube reuses the sealed-room +
 * project_access + ownership-tier helpers WITHOUT re-implementing them
 * in SQL. Fail-closed: when `visibleProjectIds` is absent or empty, the
 * predicate evaluates `id IN ('-')` so zero rows leak.
 *
 * Default tile in `projects-default.ts` requests dimensions
 * `name` + `organization_name` (joined from `public."organization"`).
 * Archived projects stay hidden by default.
 *
 * Lives in the sdk-dashboard adapter package — the only directory in the
 * repo allowed to import `drizzle-cube/*` (ADR 0044). The host
 * (packages/dashboards) injects the live Drizzle table refs at
 * registration time.
 */
import { and, eq, inArray, isNull, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { BaseQueryDefinition, QueryContext } from "drizzle-cube/server";

import type { CubeDescriptor } from "../../../types/cube";
import type { RegisteredCube } from "../types";
import { defineCinatraCube } from "../define-cube";

export type ProjectsTable = {
  readonly id: AnyColumn;
  readonly name: AnyColumn;
  readonly organizationId: AnyColumn;
  readonly slug: AnyColumn;
  readonly archivedAt: AnyColumn;
  readonly createdAt: AnyColumn;
};

export type OrganizationsTable = {
  readonly id: AnyColumn;
  readonly name: AnyColumn;
};

export type CreateProjectsCubeOptions = {
  readonly tableRef: unknown;
  readonly columns: ProjectsTable;
  readonly organizationsTableRef: unknown;
  readonly organizationColumns: OrganizationsTable;
};

export const PROJECTS_CUBE_DESCRIPTOR: CubeDescriptor = {
  id: "projects",
  version: "1.0.0",
  displayName: "Projects",
  description:
    "Projects visible to the caller via SecurityContext.visibleProjectIds " +
    "(pre-computed from actor.projectGrants — the owned-∪-accessed " +
    "union). Archived projects hidden by default. Filtering is enforced " +
    "at the SQL predicate layer; no per-actor JS post-filter.",
  dimensions: [
    { id: "id", displayName: "Project ID", type: "string" },
    { id: "name", displayName: "Name", type: "string" },
    { id: "slug", displayName: "Slug", type: "string" },
    { id: "organization_id", displayName: "Organization ID", type: "string" },
    { id: "organization_name", displayName: "Organization", type: "string" },
    { id: "created_at", displayName: "Created at", type: "date" },
  ],
  measures: [{ id: "count", displayName: "Project count", type: "count" }],
};

/**
 * Read `visibleProjectIds` from the opaque DC security context. Returns
 * `null` when missing/empty so `buildSql` emits a `WHERE false` predicate
 * — strictly fail-closed regardless of whether any specific row in the
 * `projects` table happens to have a sentinel id. The text-PK shape of
 * `cinatra.projects` makes a sentinel-id approach defensible in practice
 * but not strictly invariant, so we use an explicit false predicate.
 */
function readVisibleProjectIds(ctx: QueryContext): readonly string[] | null {
  const raw = ctx.securityContext?.visibleProjectIds;
  if (
    Array.isArray(raw) &&
    raw.length > 0 &&
    raw.every((v) => typeof v === "string" && v.length > 0)
  ) {
    return raw as readonly string[];
  }
  return null;
}

export function createProjectsCube(opts: CreateProjectsCubeOptions): RegisteredCube {
  const { tableRef, columns, organizationsTableRef, organizationColumns } = opts;
  return defineCinatraCube(PROJECTS_CUBE_DESCRIPTOR, {
    buildSql: (ctx): BaseQueryDefinition => {
      const visible = readVisibleProjectIds(ctx);
      // Strictly fail-closed when visibility is missing/empty: emit
      // `WHERE false` instead of relying on a sentinel id that any row
      // could in theory match.
      const visibilityPredicate: SQL<unknown> =
        visible === null
          ? sql`false`
          : (inArray(columns.id, visible as string[]) as SQL<unknown>);
      return {
        from: tableRef as unknown as BaseQueryDefinition["from"],
        where: and(visibilityPredicate, isNull(columns.archivedAt)),
        joins: [
          {
            table:
              organizationsTableRef as unknown as BaseQueryDefinition["from"],
            on: eq(columns.organizationId, organizationColumns.id),
            type: "left",
          },
        ],
      };
    },
    dimensionSql: {
      id: columns.id,
      name: columns.name,
      slug: columns.slug,
      organization_id: columns.organizationId,
      // `coalesce(<org.name>, '')` keeps the column shape stable when a
      // project's `organization_id` is NULL (workspace-tier projects).
      organization_name: sql<string>`coalesce(${organizationColumns.name}, '')`,
      created_at: columns.createdAt,
    },
    measureSql: { count: columns.id },
  });
}
