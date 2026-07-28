import { z } from "zod";

import { DASHBOARD_STATUSES, OWNER_LEVELS } from "../store/schema";
import { DashboardConfigV1_1Schema } from "../store/dashboard-config";
import { DASHBOARD_CONFIG_V12_VERSION } from "../extension/dashboard-config-v12";
import { ANALYTICS_PORTLET_KIND, ANALYTICS_PORTLET_KIND_ALIAS, isAnalyticsPortletKind } from "../portlets/kinds";

const ownerLevelSchema = z.enum(OWNER_LEVELS);
const statusSchema = z.enum(DASHBOARD_STATUSES);

// ─────────────────────────────────────────────────────────────────────────
// The `config` payload shape (cinatra#1736). Previously `z.unknown()`, which
// let an object-shaped legacy portlet `query` through — it validated, saved,
// and died in the browser (drizzle-cube expects a JSON string). The schema now
// models both accepted forms so the TOOL SCHEMA ITSELF teaches the model the
// contract, and the legacy `query` normalizer (dashboard-config.ts) runs right
// here at the MCP boundary.
// ─────────────────────────────────────────────────────────────────────────

/** apiVersion 1.2 envelope input: analytics portlets are modeled down to their
 *  embedded `config.dashboard` (so a bad embedded query can NOT slip through a
 *  loose envelope branch); other portlet kinds stay loose — the registry
 *  validator deep-checks them downstream. */
const analyticsEnvelopePortletInput = z
  .object({
    kind: z.enum([ANALYTICS_PORTLET_KIND, ANALYTICS_PORTLET_KIND_ALIAS]),
    config: z.object({ dashboard: DashboardConfigV1_1Schema }).passthrough(),
  })
  .passthrough();

const nonAnalyticsEnvelopePortletInput = z
  .object({
    kind: z.string().refine((k) => !isAnalyticsPortletKind(k), {
      message: "analytics portlets must match the analytics portlet schema",
    }),
  })
  .passthrough();

const v12EnvelopeInput = z
  .object({
    apiVersion: z.literal(DASHBOARD_CONFIG_V12_VERSION),
    portlets: z.array(z.union([analyticsEnvelopePortletInput, nonAnalyticsEnvelopePortletInput])),
  })
  .passthrough();

const dashboardConfigInputSchema = z
  .union([v12EnvelopeInput, DashboardConfigV1_1Schema])
  .describe(
    "Either a bare drizzle-cube DashboardConfig ({ portlets: [{ id, title, x, y, w, h, " +
      "analysisConfig | query, ... }], grid?, layouts?, ... }) or a full apiVersion 1.2 " +
      "envelope. Portlet content: use the canonical `analysisConfig` object. The legacy " +
      "`query` field is DEPRECATED and, when used, MUST be a JSON string of a " +
      "CubeQuery/MultiQuery (JSON.stringify the query object) — never a raw object. " +
      "Queries must use only executable features (cinatra#1911): flat same-cube filters " +
      "with `equals` | `in` | `inDateRange` (a date window is one relative period like " +
      "\"last 30 days\" or a [from, to] pair, on a date field) and at most one " +
      "timeDimensions entry with granularity day|week|month. Grouped and/or filters and " +
      "other operators are rejected at write time; field names/types resolve at render time.",
  );

// Read schemas
export const dashboardsListSchema = z.object({
  ownerLevel: ownerLevelSchema.optional(),
  ownerId: z.string().min(1).optional(),
  // NO `visibility` filter (cinatra#1898 Phase-3): the dashboard-local
  // visibility vocabulary retired with its column — a dashboard is always
  // visible to everyone in its scope, so `ownerLevel`/`ownerId` ARE the
  // share axis. An incoming `visibility` key is ignored (non-strict object).
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
  /** DashboardConfig payload — bare drizzle-cube config or apiVersion 1.2
   *  envelope (cinatra#1736: the shape is enforced HERE so an object-shaped
   *  legacy `query` is normalized/rejected instead of dying at render); the
   *  mutation service wraps + deep-validates downstream. */
  config: dashboardConfigInputSchema,
  configVersion: z.string().min(1).optional(),
  ownerLevel: ownerLevelSchema.describe(
    "The dashboard's SINGLE scope (cinatra#1738): every dashboard belongs to " +
      "exactly one scope, recorded at creation. team/organization dashboards " +
      "are anchored to that entity and live at canonical nested URLs " +
      "(/teams/{ownerId}/dashboards/{id}, /organizations/{ownerId}/dashboards/{id}).",
  ),
  ownerId: z
    .string()
    .min(1)
    .describe(
      "The scope entity's id — the team or organization the dashboard is " +
        "about (or the user id for a personal dashboard).",
    ),
});

export const dashboardsUpdateSchema = z.object({
  dashboardId: z.string().min(1),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  config: dashboardConfigInputSchema.optional(),
  configVersion: z.string().min(1).optional(),
});

export const dashboardsPublishSchema = z.object({
  dashboardId: z.string().min(1),
});

export const dashboardsArchiveSchema = z.object({
  dashboardId: z.string().min(1),
});
