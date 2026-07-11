/**
 * Enumerator of APPROVED runtime widget-stream slugs (widget-stream runtime
 * trust — the seam the guard-snapshot refresher reads from).
 *
 * WHAT THIS FEEDS. The per-replica guard snapshot needs the SET of currently-
 * approved runtime widget-stream slugs across the WHOLE fleet's org scopes, to
 * redirect-skip their `/api/agents/<slug>/{stream,token,capabilities}` paths so
 * those routes reach their self-authenticating handlers. It is pure liveness.
 *
 * SWAP DONE (slice 5). This used to carry a local
 * `SELECT DISTINCT agent_slug WHERE status='approved'` with a documented swap
 * point. The slice-2 read surface exposed only `listApprovedWidgetStreamMetadata
 * Grants`, which is EXACT-scope (one org / the global rows) — swapping onto it
 * would have NARROWED this all-orgs liveness read to a single scope and dropped
 * cross-org runtime widgets from the redirect-skip set. So slice 5 added the
 * cross-org `listAllApprovedWidgetStreamMetadataGrants` (all org scopes, read-
 * only, same NOT-GRANT-VALIDATION caveats) and this enumerator now delegates to
 * it and maps to the DISTINCT approved slugs. The local SELECT is gone; the
 * grant module is the single place the SQL lives.
 *
 * NOT GRANT VALIDATION. This is a PLAIN cross-org ENUMERATION of `approved`
 * slugs — it deliberately does NOT re-derive approval, the canon hash, trust
 * classification, or the credential-store-owner conjunction. Those are the
 * authority checks, and they are re-asserted at the in-handler runtime resolver,
 * which is the real wall. The snapshot this feeds is pure liveness (redirect-skip
 * only), so an over-inclusive read is safe: a slug that should no longer serve
 * still 404s at the handler. Because it is pure liveness, org-scope precedence is
 * intentionally NOT applied here (any approved row's slug is a redirect-skip
 * candidate; the handler re-resolves with precedence).
 */
import type { ApprovedWidgetStreamSlugEnumerator } from "@/lib/widget-stream-runtime-slug-snapshot";
import {
  listAllApprovedWidgetStreamMetadataGrants,
  type WidgetStreamMetadataGrantQuery,
} from "@/lib/extension-capability-ownership-grants";

export type CreateApprovedWidgetStreamSlugEnumeratorDeps = {
  query: WidgetStreamMetadataGrantQuery;
  /** The host schema the grants live in (default `cinatra` / SUPABASE_SCHEMA). */
  schema?: string;
};

/**
 * Build the enumerator over an injected query — unit-testable without a DB.
 * Delegates to the grant module's cross-org `listAllApprovedWidgetStreamMetadata
 * Grants` (one narrow all-orgs read of `status='approved'` rows) and returns the
 * DISTINCT approved slugs (a slug approved in more than one org scope is a single
 * redirect-skip candidate).
 */
export function createApprovedWidgetStreamSlugEnumerator(
  deps: CreateApprovedWidgetStreamSlugEnumeratorDeps,
): ApprovedWidgetStreamSlugEnumerator {
  return async () => {
    const grants = await listAllApprovedWidgetStreamMetadataGrants({
      query: deps.query,
      schema: deps.schema,
    });
    return [...new Set(grants.map((g) => g.agentSlug))];
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
