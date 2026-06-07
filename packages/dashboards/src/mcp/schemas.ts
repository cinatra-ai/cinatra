import { z } from "zod";

import { DASHBOARD_STATUSES, OWNER_LEVELS, VISIBILITIES } from "../store/schema";

const ownerLevelSchema = z.enum(OWNER_LEVELS);
const visibilitySchema = z.enum(VISIBILITIES);
const statusSchema = z.enum(DASHBOARD_STATUSES);

// Read schemas
export const dashboardsListSchema = z.object({
  ownerLevel: ownerLevelSchema.optional(),
  ownerId: z.string().min(1).optional(),
  visibility: visibilitySchema.optional(),
  /** If absent, inactive dashboards (archived/generation_failed) are EXCLUDED. */
  status: z.union([statusSchema, z.array(statusSchema)]).optional(),
  search: z.string().optional(),
  limit: z.number().int().min(1).max(500).optional().default(100),
  cursor: z.string().optional(),
});

export const dashboardsGetSchema = z.object({
  dashboardId: z.string().min(1),
});

/**
 * Reserved id prefix for dashboards materialized by Cinatra system actions
 * using the `system-agents:<orgId>:<userId>` namespace. MCP callers MUST
 * NOT create rows with these ids; doing so would let an attacker
 * pre-poison a victim's `/agents` layout. Defense-in-depth alongside the
 * screen-level read filter (id + organizationId + ownerId + ownerLevel).
 */
export const RESERVED_SYSTEM_DASHBOARD_PREFIX = "system-";

const writeDashboardIdSchema = z
  .string()
  .min(1)
  .refine((id) => !id.startsWith(RESERVED_SYSTEM_DASHBOARD_PREFIX), {
    message:
      `Dashboard ids starting with "${RESERVED_SYSTEM_DASHBOARD_PREFIX}" are reserved for Cinatra system actions`,
  });

// Write schemas
export const dashboardsCreateSchema = z.object({
  /** Optional client-provided id; server generates if absent. system-* reserved. */
  dashboardId: writeDashboardIdSchema.optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  /** DashboardConfig payload - validated by parseDashboardConfig(version, payload). */
  config: z.unknown(),
  configVersion: z.string().min(1).optional(),
  ownerLevel: ownerLevelSchema,
  ownerId: z.string().min(1),
  visibility: visibilitySchema.optional(),
});

export const dashboardsUpdateSchema = z.object({
  dashboardId: z.string().min(1),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  config: z.unknown().optional(),
  configVersion: z.string().min(1).optional(),
  visibility: visibilitySchema.optional(),
});

export const dashboardsPublishSchema = z.object({
  dashboardId: z.string().min(1),
});

export const dashboardsArchiveSchema = z.object({
  dashboardId: z.string().min(1),
});
