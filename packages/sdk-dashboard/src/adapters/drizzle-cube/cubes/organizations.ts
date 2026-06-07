/**
 * `organizations` cube.
 *
 * Lists every organization the caller is a member of. Visibility comes
 * directly from `SecurityContext.accessibleOrgIds` (populated by the
 * existing `buildSecurityContextWithAccessibleOrgIds` helper that reads
 * Better Auth's `member` table). The cube fails closed when
 * `accessibleOrgIds` is empty.
 *
 * Per-row computed columns:
 *   - `role` — the caller's role inside that org. Implemented via a
 *     LEFT JOIN to `public."member"` filtered to the caller's userId in
 *     the ON clause. Coalesced to '' when absent (defensive — every
 *     `accessibleOrgIds` row is membership-derived, so a missing row
 *     would mean upstream drift).
 *   - `team_names` — comma-separated list of team names in the org.
 *     Inline `string_agg` subquery over `public."team"`.
 *   - `member_count` — total members of the org. Inline `count(*)`
 *     subquery over `public."member"`.
 *
 * ADR 0044: this file (inside the sdk-dashboard adapter directory) is
 * the only place the cube wiring is allowed to talk about Better Auth
 * tables. The host injects live Drizzle table refs at registration time
 * so the canonical bindings stay in `src/lib/better-auth-db.ts`.
 */
import { and, eq, inArray, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { BaseQueryDefinition, QueryContext } from "drizzle-cube/server";

import type { CubeDescriptor } from "../../../types/cube";
import type { RegisteredCube } from "../types";
import { defineCinatraCube } from "../define-cube";

export type OrganizationsTable = {
  readonly id: AnyColumn;
  readonly name: AnyColumn;
  readonly slug: AnyColumn;
  readonly createdAt: AnyColumn;
};

export type MembersTable = {
  readonly organizationId: AnyColumn;
  readonly userId: AnyColumn;
  readonly role: AnyColumn;
};

export type CreateOrganizationsCubeOptions = {
  readonly tableRef: unknown;
  readonly columns: OrganizationsTable;
  readonly membersTableRef: unknown;
  readonly memberColumns: MembersTable;
};

export const ORGANIZATIONS_CUBE_DESCRIPTOR: CubeDescriptor = {
  id: "organizations",
  version: "1.0.0",
  displayName: "Organizations",
  description:
    "Organizations the caller is a member of via SecurityContext" +
    ".accessibleOrgIds. The Role / Teams / Members columns are derived per " +
    "row against public.\"member\" and public.\"team\".",
  dimensions: [
    { id: "id", displayName: "Organization ID", type: "string" },
    { id: "name", displayName: "Name", type: "string" },
    { id: "slug", displayName: "Slug", type: "string" },
    { id: "role", displayName: "Role", type: "string" },
    { id: "team_names", displayName: "Teams", type: "string" },
    { id: "created_at", displayName: "Created at", type: "date" },
  ],
  measures: [
    { id: "count", displayName: "Organization count", type: "count" },
    // `max` over a correlated single-value subquery is a valid drizzle-cube
    // measure shape (same pattern as `last_run_at: type: "max"` in the
    // agent_runs cube). The subquery already returns one row per org so
    // the aggregate is a passthrough; we keep the type for the cube's
    // sortability and renderer affordances.
    { id: "member_count", displayName: "Members", type: "max" },
  ],
};

function readAccessibleOrgIds(ctx: QueryContext): readonly string[] | null {
  const raw = ctx.securityContext?.accessibleOrgIds;
  if (
    Array.isArray(raw) &&
    raw.length > 0 &&
    raw.every((v) => typeof v === "string" && v.length > 0)
  ) {
    return raw as readonly string[];
  }
  return null;
}

function readUserId(ctx: QueryContext): string {
  const id = ctx.securityContext?.userId;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(
      "organizations cube: SecurityContext.userId is required but missing or empty",
    );
  }
  return id;
}

export function createOrganizationsCube(
  opts: CreateOrganizationsCubeOptions,
): RegisteredCube {
  const { tableRef, columns, membersTableRef, memberColumns } = opts;
  return defineCinatraCube(ORGANIZATIONS_CUBE_DESCRIPTOR, {
    buildSql: (ctx): BaseQueryDefinition => {
      const visible = readAccessibleOrgIds(ctx);
      const userId = readUserId(ctx);
      const visibilityPredicate: SQL<unknown> =
        visible === null
          ? sql`false`
          : (inArray(columns.id, visible as string[]) as SQL<unknown>);
      return {
        from: tableRef as unknown as BaseQueryDefinition["from"],
        where: visibilityPredicate,
        // LEFT JOIN the caller's own membership row for each visible org
        // so the `role` dimension can read `m.role` directly. The userId
        // ride in the ON clause via a literal parameter binding — captures
        // the actor's userId at query time even though `dimensionSql` is
        // static at definition time.
        joins: [
          {
            table: membersTableRef as unknown as BaseQueryDefinition["from"],
            // `and(a, b)` may type as `SQL | undefined` (per drizzle's
            // overloads); both args are always present here so the cast
            // is safe and avoids a `!` non-null assertion on the union.
            on: and(
              eq(memberColumns.organizationId, columns.id),
              eq(memberColumns.userId, userId),
            ) as SQL<unknown>,
            type: "left",
          },
        ],
      };
    },
    dimensionSql: {
      id: columns.id,
      name: columns.name,
      slug: columns.slug,
      role: sql<string>`coalesce(${memberColumns.role}, '')`,
      // Aggregated comma-separated team names in THIS organization. Inline
      // subquery — doesn't need actor context.
      team_names: sql<string>`coalesce((
        SELECT string_agg(t.name, ', ' ORDER BY t.name)
        FROM public."team" t
        WHERE t."organizationId" = ${columns.id}
      ), '')`,
      created_at: columns.createdAt,
    },
    measureSql: {
      count: columns.id,
      member_count: sql<number>`(
        SELECT count(*) FROM public."member" m
        WHERE m."organizationId" = ${columns.id}
      )`,
    },
  });
}
