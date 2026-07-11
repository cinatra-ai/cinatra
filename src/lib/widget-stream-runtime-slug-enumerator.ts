/**
 * Narrow local enumerator of APPROVED runtime widget-stream slugs (widget-stream
 * runtime trust, slice 4 — the seam the guard-snapshot refresher reads from).
 *
 * WHY THIS EXISTS (and its swap point). The snapshot refresher needs the SET of
 * currently-approved runtime widget-stream slugs. Slice 1's read surface exposes
 * only a per-slug resolve (`resolveApprovedWidgetStreamMetadataGrant`) and a
 * per-store claim read (`readWidgetStreamMetadataClaimsFromStore`) — there is no
 * list-of-approved surface on main. Slice 2 adds a read-only
 * `listApprovedWidgetStreamMetadataGrants`; when it merges, replace the body of
 * `createApprovedWidgetStreamSlugEnumerator` with a call to it (and drop the
 * local SELECT). This file is the single swap point.
 *
 * NOT GRANT VALIDATION. This is a PLAIN ENUMERATION read of `status='approved'`
 * slugs — it deliberately does NOT re-derive approval, the canon hash, trust
 * classification, or the credential-store-owner conjunction. Those are the
 * authority checks, and they are re-asserted at the in-handler runtime resolver
 * (slice 2), which is the real wall. The snapshot this feeds is pure liveness
 * (redirect-skip only), so an over-inclusive read is safe: a slug that should no
 * longer serve still 404s at the handler. Because it is pure liveness, org-scope
 * precedence is intentionally NOT applied here (any approved row's slug is a
 * redirect-skip candidate; the handler re-resolves with precedence).
 */
import type {
  ApprovedWidgetStreamSlugEnumerator,
} from "@/lib/widget-stream-runtime-slug-snapshot";
import type { WidgetStreamMetadataGrantQuery } from "@/lib/extension-capability-ownership-grants";

// Kept in sync with the grant module's own default (extension-capability-
// ownership-grants.ts): `process.env.SUPABASE_SCHEMA?.trim() || "cinatra"`.
function resolveSchema(schema?: string): string {
  if (schema !== undefined) return schema;
  return process.env.SUPABASE_SCHEMA?.trim() || "cinatra";
}

// Mirror the grant module's identifier-quoting so a schema with a stray quote
// cannot break out of the identifier (defense in depth; the value is env-fixed).
function qualifiedGrantsTable(schema: string): string {
  return `"${schema.replaceAll('"', '""')}"."extension_widget_stream_metadata_grant"`;
}

type ApprovedSlugRow = { agent_slug: string };

export type CreateApprovedWidgetStreamSlugEnumeratorDeps = {
  query: WidgetStreamMetadataGrantQuery;
  /** The host schema the grants live in (default `cinatra` / SUPABASE_SCHEMA). */
  schema?: string;
};

/**
 * Build the enumerator over an injected query — unit-testable without a DB.
 * Issues ONE narrow read: the distinct `agent_slug`s of all `approved` grant
 * rows. When slice 2 merges, this body becomes
 * `return () => listApprovedWidgetStreamMetadataGrants(deps).then(gs => gs.map(g => g.agentSlug))`.
 */
export function createApprovedWidgetStreamSlugEnumerator(
  deps: CreateApprovedWidgetStreamSlugEnumeratorDeps,
): ApprovedWidgetStreamSlugEnumerator {
  const table = qualifiedGrantsTable(resolveSchema(deps.schema));
  return async () => {
    const rows = await deps.query<ApprovedSlugRow>(
      `SELECT DISTINCT agent_slug FROM ${table} WHERE status = 'approved'`,
    );
    return rows.map((r) => r.agent_slug);
  };
}

let cached: ApprovedWidgetStreamSlugEnumerator | undefined;

/**
 * The production enumerator — a lazily-built query over the shared pooled DB.
 * The pool import is deferred so this module carries no `server-only` top-level
 * import (its factory above stays unit-testable). Memoized per process.
 */
export function defaultApprovedWidgetStreamSlugEnumerator(): ApprovedWidgetStreamSlugEnumerator {
  if (cached) return cached;
  cached = async () => {
    const { getPooledDb } = await import("@/lib/db/pooled");
    const pool = getPooledDb({ name: "widget-stream-runtime-slug-snapshot" });
    const query: WidgetStreamMetadataGrantQuery = async <T = unknown>(
      text: string,
      values?: readonly unknown[],
    ) => {
      const result = await pool.query(text, values ? [...values] : undefined);
      return result.rows as T[];
    };
    return createApprovedWidgetStreamSlugEnumerator({ query })();
  };
  return cached;
}
