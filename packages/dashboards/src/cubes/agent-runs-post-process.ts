/**
 * Shared row post-processor for the `agent_runs` cube.
 *
 * The cube emits `last_run_at` as Postgres `EXTRACT(EPOCH FROM ...)` so the
 * MAX() aggregation works and rows stay sortable / cacheable at the SQL
 * layer. drizzle-cube/client's table renderer has no per-column date
 * formatter, so we humanize the value into a relative-time string
 * ("30 mins ago", "1 day 4 hours ago") before responses leave the server.
 *
 * Used by the HTTP cubejs route at
 * `src/app/api/dashboards/cubejs-api/v1/[...endpoint]/route.ts`. The MCP
 * cube-tools path is intentionally vanilla — it ships raw epoch seconds
 * so LLM clients can format the value themselves.
 *
 * Keeping this in a host-side package (not sdk-dashboard) preserves the
 * adapter-package boundary — sdk-dashboard never talks about Cinatra-app
 * field names like `agent_runs.last_run_at`.
 */
import "server-only";

export function relativeAge(epochSeconds: unknown): string {
  if (typeof epochSeconds !== "number" || !Number.isFinite(epochSeconds)) return "—";
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - epochSeconds));
  if (seconds < 60) return "just now";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.max(1, Math.floor((seconds % 3600) / 60));
  if (days > 0) {
    return hours > 0
      ? `${days} day${days === 1 ? "" : "s"} ${hours} hours ago`
      : `${days} day${days === 1 ? "" : "s"} ago`;
  }
  if (hours > 0) {
    return mins > 0 ? `${hours} hours ${mins} mins ago` : `${hours} hours ago`;
  }
  return `${mins} mins ago`;
}

/**
 * Replace the epoch-seconds value at `agent_runs.last_run_at` in each row
 * with a humanized relative-time string. Rows without the key are passed
 * through untouched. Pure function — no mutation of the input rows.
 */
export function humanizeAgentRunsRows(
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
): ReadonlyArray<Readonly<Record<string, unknown>>> {
  return rows.map((row) =>
    "agent_runs.last_run_at" in row
      ? { ...row, "agent_runs.last_run_at": relativeAge(row["agent_runs.last_run_at"]) }
      : row,
  );
}
