/**
 * `teams` cube.
 *
 * Lists every team the caller can see. The visibility set is computed
 * before query execution by the host's `buildSecurityContextWithVisibility`
 * (using `readTeamsForUser` and any role-resolution helpers that widen the
 * set for org admins) and rides on `SecurityContext.visibleTeamIds`. The
 * cube reads it back, fails closed when missing/empty, and JOINs against
 * `public."organization"` so the Name + Organization columns can render.
 *
 * Lives in the sdk-dashboard adapter package per ADR 0044. The host
 * (packages/dashboards) injects live Drizzle table refs at registration.
 */
import { eq, inArray, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { BaseQueryDefinition, QueryContext } from "drizzle-cube/server";

import type { CubeDescriptor } from "../../../types/cube";
import type { RegisteredCube } from "../types";
import { defineCinatraCube } from "../define-cube";

export type TeamsTable = {
  readonly id: AnyColumn;
  readonly name: AnyColumn;
  readonly organizationId: AnyColumn;
  readonly createdAt: AnyColumn;
};

export type OrganizationsTable = {
  readonly id: AnyColumn;
  readonly name: AnyColumn;
};

export type CreateTeamsCubeOptions = {
  readonly tableRef: unknown;
  readonly columns: TeamsTable;
  readonly organizationsTableRef: unknown;
  readonly organizationColumns: OrganizationsTable;
};

export const TEAMS_CUBE_DESCRIPTOR: CubeDescriptor = {
  id: "teams",
  version: "1.0.0",
  displayName: "Teams",
  description:
    "Teams the caller belongs to or can otherwise see via SecurityContext" +
    ".visibleTeamIds (pre-computed by readTeamsForUser + admin-org widening). " +
    "Filtering is enforced at the SQL predicate layer.",
  dimensions: [
    { id: "id", displayName: "Team ID", type: "string" },
    { id: "name", displayName: "Name", type: "string" },
    { id: "organization_id", displayName: "Organization ID", type: "string" },
    { id: "organization_name", displayName: "Organization", type: "string" },
    { id: "created_at", displayName: "Created at", type: "date" },
  ],
  measures: [
    { id: "count", displayName: "Team count", type: "count" },
    // Per-row member count via a correlated subquery over public."teamMember"
    // (Better Auth team-membership table). `max` so a single-team detail query
    // surfaces that team's member count; mirrors the organizations cube's
    // `member_count` measure shape.
    { id: "member_count", displayName: "Members", type: "max" },
  ],
};

function readVisibleTeamIds(ctx: QueryContext): readonly string[] | null {
  const raw = ctx.securityContext?.visibleTeamIds;
  if (
    Array.isArray(raw) &&
    raw.length > 0 &&
    raw.every((v) => typeof v === "string" && v.length > 0)
  ) {
    return raw as readonly string[];
  }
  return null;
}

export function createTeamsCube(opts: CreateTeamsCubeOptions): RegisteredCube {
  const { tableRef, columns, organizationsTableRef, organizationColumns } = opts;
  return defineCinatraCube(TEAMS_CUBE_DESCRIPTOR, {
    buildSql: (ctx): BaseQueryDefinition => {
      const visible = readVisibleTeamIds(ctx);
      const visibilityPredicate: SQL<unknown> =
        visible === null
          ? sql`false`
          : (inArray(columns.id, visible as string[]) as SQL<unknown>);
      return {
        from: tableRef as unknown as BaseQueryDefinition["from"],
        where: visibilityPredicate,
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
      organization_id: columns.organizationId,
      organization_name: sql<string>`coalesce(${organizationColumns.name}, '')`,
      created_at: columns.createdAt,
    },
    measureSql: {
      count: columns.id,
      member_count: sql<number>`(
        SELECT count(*) FROM public."teamMember" tm
        WHERE tm."teamId" = ${columns.id}
      )`,
    },
  });
}
