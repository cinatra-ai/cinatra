/**
 * MCP handlers for the dashboards platform.
 *
 * Read handlers expose dashboards_list + dashboards_get. Write handlers expose
 * dashboards_create / dashboards_update / dashboards_publish /
 * dashboards_archive. All write handlers funnel through the mutation service
 * to preserve the single-writer invariant.
 *
 * Both read AND write handlers apply the SAME permission resolver as the
 * mutation service. Inactive dashboards (archived / generation_failed) are
 * filtered out unless the caller explicitly requests them via `status`.
 */
import "server-only";
import type {
  PrimitiveActorContext,
  PrimitiveInvocationRequest,
} from "@cinatra-ai/mcp-client";
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";

import { buildListPage, decodeCursor } from "@/lib/mcp-pagination";

import {
  archiveDashboard,
  createDashboard,
  DashboardConfigInvalidError,
  DashboardForbiddenError,
  DashboardNotFoundError,
  publishDashboard,
  updateDashboard,
} from "../mutation-service";
import type { DashboardActor } from "../permissions";
import { resolveDashboardAccess } from "../permissions";
import {
  dashboardRevisions,
  dashboards,
  getDashboardsDb,
} from "../store/db";
import type { DashboardRow, DashboardStatus } from "../store/schema";
import {
  dashboardsArchiveSchema,
  dashboardsCreateSchema,
  dashboardsGetSchema,
  dashboardsListSchema,
  dashboardsPublishSchema,
  dashboardsUpdateSchema,
} from "./schemas";

// ─────────────────────────────────────────────────────────────────────────
// Actor envelope extraction. Mirrors the lists handler pattern.
// ─────────────────────────────────────────────────────────────────────────

// The dashboards owner resolver only recognizes owner/admin/member, while the
// MCP registry stamps the transport-resolved KERNEL vocabulary
// (`org_owner`/`org_admin`/`member`, see PrimitiveActorContext.orgRole).
// Normalize both vocabularies — mirroring normalizeOrgRole in
// src/lib/dashboards/authz.ts — so a carried org_admin/org_owner role is not
// silently demoted to member here. Unknown / absent values stay "member"
// (existing default; never widens). Exported for unit tests only.
export function normalizeOrgRole(role: unknown): "owner" | "admin" | "member" {
  if (role === "owner" || role === "org_owner") return "owner";
  if (role === "admin" || role === "org_admin") return "admin";
  return "member";
}

function getActor(actor: PrimitiveActorContext): DashboardActor | null {
  const ext = actor as unknown as Record<string, unknown>;
  const orgId = (ext["orgId"] as string | null | undefined) ?? null;
  const userId = actor.userId;
  if (!orgId || !userId) return null;
  // teamIds / roles are populated by the route layer. The resolver tolerates
  // empty teamIds + member role when only basic actor context is available.
  const teamIds = ((ext["teamIds"] as string[] | undefined) ?? []) as readonly string[];
  const orgRole = normalizeOrgRole(ext["orgRole"]);
  const teamRoles =
    (ext["teamRoles"] as Record<string, "admin" | "member"> | undefined) ?? {};
  return { userId, organizationId: orgId, teamIds, orgRole, teamRoles };
}

// ─────────────────────────────────────────────────────────────────────────
// Wire-shape for MCP responses. Plain DTOs — no Drizzle types leak.
// ─────────────────────────────────────────────────────────────────────────
export type DashboardDto = {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly ownerLevel: string;
  readonly ownerId: string;
  readonly organizationId: string;
  readonly visibility: string;
  readonly status: string;
  readonly configVersion: string;
  readonly dashboardVersion: number;
  readonly publishedRevisionNumber: number | null;
  readonly createdBy: string;
  readonly updatedBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly publishedAt: string | null;
  readonly archivedAt: string | null;
};

export type DashboardRevisionDto = {
  readonly revisionNumber: number;
  readonly createdBy: string;
  readonly createdAt: string;
};

function toDto(row: DashboardRow): DashboardDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    ownerLevel: row.ownerLevel,
    ownerId: row.ownerId,
    organizationId: row.organizationId,
    visibility: row.visibility,
    status: row.status,
    configVersion: row.configVersion,
    dashboardVersion: row.dashboardVersion,
    publishedRevisionNumber: row.publishedRevisionNumber,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    publishedAt: row.publishedAt?.toISOString() ?? null,
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}

const ACTIVE_STATUSES: DashboardStatus[] = ["draft", "published"];

export function createDashboardPrimitiveHandlers() {
  return {
    // ─────────────────────────────────────────────────────────────────────
    // dashboards_list — paginated, permission-filtered, status-filtered.
    // ─────────────────────────────────────────────────────────────────────
    dashboards_list: async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = dashboardsListSchema.parse(request.input);
      const actor = getActor(request.actor);
      if (!actor) return { items: [], total: 0 };

      const db = getDashboardsDb();
      const offset = decodeCursor(input.cursor);
      const limit = input.limit;

      // Default: exclude archived / generation_failed.
      const statusFilter: DashboardStatus[] =
        input.status === undefined
          ? ACTIVE_STATUSES
          : Array.isArray(input.status)
            ? input.status
            : [input.status];

      // Build org-scoped WHERE — cross-org rows excluded at the SQL layer.
      const conditions = [eq(dashboards.organizationId, actor.organizationId)];
      conditions.push(inArray(dashboards.status, statusFilter));
      // Safe gate: the MCP actor does not yet carry projectGrants
      // (deferred amendment), so this agentic primitive excludes project-scoped
      // INSTANCE rows (project_id NOT NULL) and project-scope TEMPLATE rows
      // (template_scope='project'). Project dashboards surface only via the
      // /dashboards routes, which gate on the full resolved projectGrants.
      conditions.push(isNull(dashboards.projectId));
      conditions.push(or(isNull(dashboards.templateScope), ne(dashboards.templateScope, "project"))!);
      if (input.ownerLevel) conditions.push(eq(dashboards.ownerLevel, input.ownerLevel));
      if (input.ownerId) conditions.push(eq(dashboards.ownerId, input.ownerId));
      if (input.visibility) conditions.push(eq(dashboards.visibility, input.visibility));
      if (input.search) {
        // ILIKE on name; description is nullable so we omit it from the
        // search to keep the WHERE simple.
        conditions.push(sql`${dashboards.name} ILIKE ${`%${input.search}%`}`);
      }

      // Fetch a slice + permission-filter in JS. The org-scope condition
      // already eliminates the vast majority of irrelevant rows. The
      // remaining permission check is per-row (visibility × ownership).
      const slice = await db
        .select()
        .from(dashboards)
        .where(and(...conditions))
        .orderBy(desc(dashboards.createdAt))
        .offset(offset)
        .limit(limit);

      // The total count is approximate-ish: we count rows matching the SQL
      // conditions, not the post-permission-resolver filter. This matches
      // the lists package convention.
      const totalRows = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(dashboards)
        .where(and(...conditions));
      const total = totalRows[0]?.n ?? 0;

      const visible = slice.filter(
        (row) => resolveDashboardAccess(row, actor).canRead,
      );

      return buildListPage(visible.map(toDto), total, offset, limit);
    },

    // ─────────────────────────────────────────────────────────────────────
    // dashboards_get — single row with revision summaries.
    // ─────────────────────────────────────────────────────────────────────
    dashboards_get: async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = dashboardsGetSchema.parse(request.input);
      const actor = getActor(request.actor);
      if (!actor) {
        return { error: { code: "unauthorized", message: "Not authenticated" } };
      }

      const db = getDashboardsDb();
      const rows = await db
        .select()
        .from(dashboards)
        .where(eq(dashboards.id, input.dashboardId))
        .limit(1);
      const row = rows[0];
      if (!row) {
        return { error: { code: "not_found", message: `Dashboard not found: ${input.dashboardId}` } };
      }
      // A project-scope TEMPLATE is a template only — never opened
      // directly (its per-project instances are the operational rows).
      if (row.isTemplate && row.templateScope === "project") {
        return { error: { code: "dashboard_is_project_template", message: "Project-scope template cannot be opened directly." } };
      }
      // Safe gate (deferred amendment): the MCP actor lacks projectGrants, so this
      // agentic primitive does not serve project-scoped instances. They surface via
      // the /dashboards routes, which gate on the full resolved projectGrants.
      if (row.projectId) {
        return { error: { code: "not_found", message: `Dashboard not found: ${input.dashboardId}` } };
      }

      const access = resolveDashboardAccess(row, actor);
      if (!access.canRead) {
        return { error: { code: "forbidden", message: "Access denied" } };
      }

      const revs = await db
        .select({
          revisionNumber: dashboardRevisions.revisionNumber,
          createdBy: dashboardRevisions.createdBy,
          createdAt: dashboardRevisions.createdAt,
        })
        .from(dashboardRevisions)
        .where(eq(dashboardRevisions.dashboardId, row.id))
        .orderBy(asc(dashboardRevisions.revisionNumber));

      const revisionDtos: DashboardRevisionDto[] = revs.map((r) => ({
        revisionNumber: r.revisionNumber,
        createdBy: r.createdBy,
        createdAt: r.createdAt.toISOString(),
      }));

      return {
        dashboard: toDto(row),
        revisions: revisionDtos,
      };
    },

    // ─────────────────────────────────────────────────────────────────────
    // Write handlers — all funnel through the mutation service.
    // Permission errors → 403; not-found → 404; config validation → 400.
    // ─────────────────────────────────────────────────────────────────────
    dashboards_create: async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = dashboardsCreateSchema.parse(request.input);
      const actor = getActor(request.actor);
      if (!actor) return { error: { code: "unauthorized", message: "Not authenticated" } };
      // Resolve self-reference placeholders to the actor's actual userId. The
      // chat surface (and other LLM callers) often passes literal "me",
      // "current", or "self" instead of resolving the platform identity at
      // call site. Without this, ownerLevel:"user" + ownerId:"current" lands
      // in `resolveDashboardAccess` as a non-match against the actor, throws
      // `forbidden`, and the chat sees "dashboards.create forbidden …".
      const isSelfRef = (v: string | undefined | null): boolean =>
        !v || v === "current" || v === "me" || v === "self";
      const resolvedOwnerId =
        input.ownerLevel === "user" && isSelfRef(input.ownerId)
          ? actor.userId
          : input.ownerId;
      try {
        const row = await createDashboard(
          {
            id: input.dashboardId,
            name: input.name,
            description: input.description,
            config: input.config,
            configVersion: input.configVersion,
            ownerLevel: input.ownerLevel,
            ownerId: resolvedOwnerId,
            visibility: input.visibility,
          },
          actor,
        );
        return { dashboard: toDto(row) };
      } catch (err) {
        return mutationError(err);
      }
    },

    dashboards_update: async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = dashboardsUpdateSchema.parse(request.input);
      const actor = getActor(request.actor);
      if (!actor) return { error: { code: "unauthorized", message: "Not authenticated" } };
      try {
        const row = await updateDashboard(
          input.dashboardId,
          {
            name: input.name,
            description: input.description,
            config: input.config,
            configVersion: input.configVersion,
            visibility: input.visibility,
          },
          actor,
        );
        return { dashboard: toDto(row) };
      } catch (err) {
        return mutationError(err);
      }
    },

    dashboards_publish: async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = dashboardsPublishSchema.parse(request.input);
      const actor = getActor(request.actor);
      if (!actor) return { error: { code: "unauthorized", message: "Not authenticated" } };
      try {
        const row = await publishDashboard(input.dashboardId, actor);
        return { dashboard: toDto(row) };
      } catch (err) {
        return mutationError(err);
      }
    },

    dashboards_archive: async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = dashboardsArchiveSchema.parse(request.input);
      const actor = getActor(request.actor);
      if (!actor) return { error: { code: "unauthorized", message: "Not authenticated" } };
      try {
        const row = await archiveDashboard(input.dashboardId, actor);
        return { dashboard: toDto(row) };
      } catch (err) {
        return mutationError(err);
      }
    },
  };
}

/** Convert a thrown mutation-service error into the MCP error envelope. */
function mutationError(err: unknown): { error: { code: string; message: string } } {
  if (err instanceof DashboardForbiddenError) {
    return { error: { code: "forbidden", message: err.message } };
  }
  if (err instanceof DashboardNotFoundError) {
    return { error: { code: "not_found", message: err.message } };
  }
  if (err instanceof DashboardConfigInvalidError) {
    return { error: { code: "invalid_config", message: err.message } };
  }
  return {
    error: {
      code: "internal_error",
      message: err instanceof Error ? err.message : String(err),
    },
  };
}
