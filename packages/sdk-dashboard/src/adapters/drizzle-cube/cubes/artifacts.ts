/**
 * `artifacts` cube.
 *
 * Lists the artifacts visible to the caller. Visibility comes from
 * `SecurityContext.visibleArtifactIds` (pre-computed by the host via
 * `listArtifacts({orgId, actor}).map(r => r.artifactId)` — reuses the
 * existing sealed-room + project_access + ownership-tier scope helpers
 * from `listObjectsByFilter` so authz logic is NOT duplicated in cube
 * SQL). Fail-closed when missing/empty.
 *
 * Two defense-in-depth filters layered on top:
 *   - `org_id = activeOrganizationId` — tenant boundary.
 *   - `objects.deleted_at IS NULL` — never surface tombstoned artifacts.
 *
 * The host supplies the canonical `cinatra.objects` table reference at
 * registration time. The canonical schema does NOT carry a Drizzle
 * binding (`packages/objects/src/schema.ts` documents the prohibition);
 * the host wires a narrow projection alongside the cube registration so
 * the cube layer never touches the cinatra-app `objects-store.ts` raw
 * SQL surface.
 */
import { and, eq, inArray, isNull, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { BaseQueryDefinition, QueryContext } from "drizzle-cube/server";

import type { CubeDescriptor } from "../../../types/cube";
import type { RegisteredCube } from "../types";
import { defineCinatraCube } from "../define-cube";

export type ObjectsTable = {
  readonly id: AnyColumn;
  readonly type: AnyColumn;
  readonly orgId: AnyColumn;
  readonly data: AnyColumn;
  readonly createdAt: AnyColumn;
  readonly deletedAt: AnyColumn;
};

export type CreateArtifactsCubeOptions = {
  readonly tableRef: unknown;
  readonly columns: ObjectsTable;
};

export const ARTIFACTS_CUBE_DESCRIPTOR: CubeDescriptor = {
  id: "artifacts",
  version: "1.0.0",
  displayName: "Artifacts",
  description:
    "Artifacts visible to the caller via SecurityContext" +
    ".visibleArtifactIds (pre-computed by listArtifacts to honour " +
    "sealed-room / project_access / ownership-tier authz). Tombstoned " +
    "rows hidden. Filtering enforced at the SQL predicate layer.",
  dimensions: [
    { id: "id", displayName: "Artifact ID", type: "string" },
    { id: "name", displayName: "Name", type: "string" },
    { id: "type", displayName: "Type", type: "string" },
    { id: "context", displayName: "Context", type: "string" },
    { id: "mime", displayName: "MIME type", type: "string" },
    { id: "created_at", displayName: "Created at", type: "date" },
  ],
  measures: [{ id: "count", displayName: "Artifact count", type: "count" }],
};

function readVisibleArtifactIds(ctx: QueryContext): readonly string[] | null {
  const raw = ctx.securityContext?.visibleArtifactIds;
  if (
    Array.isArray(raw) &&
    raw.length > 0 &&
    raw.every((v) => typeof v === "string" && v.length > 0)
  ) {
    return raw as readonly string[];
  }
  return null;
}

function readOrganizationId(ctx: QueryContext): string {
  const orgId = ctx.securityContext?.organizationId;
  if (typeof orgId !== "string" || orgId.length === 0) {
    throw new Error(
      "artifacts cube: SecurityContext.organizationId is required but missing or empty",
    );
  }
  return orgId;
}

export function createArtifactsCube(opts: CreateArtifactsCubeOptions): RegisteredCube {
  const { tableRef, columns } = opts;
  return defineCinatraCube(ARTIFACTS_CUBE_DESCRIPTOR, {
    buildSql: (ctx): BaseQueryDefinition => {
      const visible = readVisibleArtifactIds(ctx);
      const orgId = readOrganizationId(ctx);
      const visibilityPredicate: SQL<unknown> =
        visible === null
          ? sql`false`
          : (inArray(columns.id, visible as string[]) as SQL<unknown>);
      return {
        from: tableRef as unknown as BaseQueryDefinition["from"],
        where: and(
          visibilityPredicate,
          eq(columns.orgId, orgId),
          isNull(columns.deletedAt),
        ),
      };
    },
    dimensionSql: {
      id: columns.id,
      // Artifact display name comes from `objects.data->>'title'` (the
      // canonical name field for artifact-typed objects) with a fallback
      // to the object id when title is missing/empty.
      name: sql<string>`coalesce(nullif(${columns.data} ->> 'title', ''), ${columns.id})`,
      type: columns.type,
      // `context` surfaces the artifact's registered type slug
      // (e.g. "blog-idea", "marketing-icp"). Pulled from
      // `objects.data->>'artifactType'` — the canonical field on
      // `ArtifactObjectData`. Falls back to the row's `objects.type`
      // (which is `SEMANTIC_ARTIFACT_OBJECT_TYPE` for artifact-typed
      // rows but is at least always-present) before rendering '—' so
      // legacy rows without `artifactType` still show something.
      context: sql<string>`coalesce(nullif(${columns.data} ->> 'artifactType', ''), nullif(${columns.type}, ''), '—')`,
      mime: sql<string>`coalesce(${columns.data} ->> 'mime', '')`,
      created_at: columns.createdAt,
    },
    measureSql: { count: columns.id },
  });
}
