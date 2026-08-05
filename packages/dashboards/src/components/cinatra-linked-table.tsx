"use client";
/**
 * `cinatraLinkedTable` — drizzle-cube custom chart plugin.
 *
 * Renders cube rows as a shadcn `<Table>` where the Name cell is wrapped
 * in a real Next `<Link>` whose href is computed from the row's own values
 * via a per-cube row plan (most cubes: the `<cube>.id` value into a route
 * template; `agent_runs`: vendor + package_name + run_id — cinatra#2448).
 * Preserves middle-click + right-click affordances per design-spec
 * guardrails.
 *
 * Registered globally inside `DashboardsClientShell` via
 * `chartPluginRegistry.register({ type: "cinatraLinkedTable", ... })`.
 * The seed configs request `chartType: "cinatraLinkedTable"` for
 * /projects, /teams, /organizations, /artifacts and the /agents/executions
 * "5 latest agent runs" per-run portlet. No host-side config; the cube id
 * is inferred from the first column key (which is always `<cubeId>.<dim>`
 * in drizzle-cube responses). The href is built from row DATA only — this
 * component never names a specific extension package.
 *
 * Why a custom chart instead of post-rendering / row-click:
 *   - DC's built-in table renders scalar cell values directly; there is
 *     no per-column React cell renderer.
 *   - Row-click navigation breaks middle-click + right-click, which is
 *     explicitly disallowed.
 *   - HTML-string `<a href>` via `dangerouslySetInnerHTML` is an XSS path.
 *   - A real `<Link>` inside a custom chart keeps the spec's affordances
 *     intact and uses the cube data + query path unchanged.
 */
import Link from "next/link";
import type { ComponentType } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const CINATRA_LINKED_TABLE_TYPE = "cinatraLinkedTable";

/**
 * Per-cube row plan: which columns are hidden link material, which column
 * carries the linked Name cell, how the href is assembled from the row's
 * own values, and (optionally) per-column display formatting. Only cubes
 * whose Name column should be a real `<Link>` need an entry here — others
 * render as plain text.
 */
type CubeRowPlan = {
  /**
   * Column suffix rendered as the linked Name cell. Absent → heuristic
   * (`<cube>.name`, else the first visible column).
   */
  readonly nameSuffix?: string;
  /** Column suffixes hidden from display (link/key material, not data). */
  readonly hiddenSuffixes: readonly string[];
  /** Column suffix providing the stable React row key. */
  readonly rowKeySuffix: string;
  /**
   * Build the row's href from its own values. `undefined` → the Name cell
   * degrades to plain text (never a broken link).
   */
  readonly buildHref: (
    row: Record<string, unknown>,
    cubeId: string,
  ) => string | undefined;
  /**
   * Optional per-column display formatter, keyed by column suffix.
   * Returning `undefined` falls through to the default `cellToString`.
   */
  readonly formatCell?: (columnSuffix: string, value: unknown) => string | undefined;
};

/** Narrow an unknown row value to a non-empty string. */
function readString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Standard plan for cubes whose href is `<template>(<cube>.id)` — the id
 * column is the hidden link target and the row key.
 */
function idLinkedPlan(template: (id: string) => string): CubeRowPlan {
  return {
    hiddenSuffixes: ["id"],
    rowKeySuffix: "id",
    buildHref: (row, cubeId) => {
      const id = readString(row[`${cubeId}.id`]);
      return id ? template(id) : undefined;
    },
  };
}

/**
 * Format a timestamp-ish cell (Date locally, ISO string over the wire,
 * or epoch seconds) as a relative-time string. Mirrors the buckets of the
 * server-side `relativeAge` in `cubes/agent-runs-post-process.ts` (that
 * helper is `server-only`, so the client renderer carries its own copy).
 * Returns `undefined` for unparseable values (falls back to raw display).
 */
function relativeTimeCell(v: unknown): string | undefined {
  let ms: number | undefined;
  if (v instanceof Date) ms = v.getTime();
  else if (typeof v === "number" && Number.isFinite(v)) {
    // Heuristic: epoch seconds vs. epoch milliseconds.
    ms = v > 1e12 ? v : v * 1000;
  } else if (typeof v === "string" && v.length > 0) {
    const parsed = Date.parse(v);
    if (!Number.isNaN(parsed)) ms = parsed;
  }
  if (ms === undefined) return undefined;
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
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
 * Row-plan lookup.
 *
 * Mappings:
 *   - `projects` → `/projects/[id]` (link target).
 *   - `teams` → `/teams/[teamId]` (per-team detail dashboard route).
 *   - `organizations` → `/organizations/[id]` (per-org detail dashboard
 *     route).
 *   - `artifacts` → `/artifacts/[id]` (the detail route).
 *   - `agent_runs` → per-RUN rows (cinatra#2448): the Run cell links to
 *     `/agents/<vendor>/<packageName>/<runId>` assembled from the row's
 *     `vendor` + `package_name` + `run_id` dimension values (pure row
 *     data — no package is named in code). Any missing coordinate (e.g.
 *     an unscoped package yields an empty vendor) degrades to plain text.
 */
const CUBE_ROW_PLANS: Readonly<Record<string, CubeRowPlan>> = {
  projects: idLinkedPlan((id) => `/projects/${encodeURIComponent(id)}`),
  teams: idLinkedPlan((id) => `/teams/${encodeURIComponent(id)}`),
  organizations: idLinkedPlan((id) => `/organizations/${encodeURIComponent(id)}`),
  // artifacts: links to the artifact detail page at
  // `src/app/artifacts/[id]/page.tsx`.
  artifacts: idLinkedPlan((id) => `/artifacts/${encodeURIComponent(id)}`),
  agent_runs: {
    nameSuffix: "run_name",
    hiddenSuffixes: ["run_id", "vendor", "package_name"],
    rowKeySuffix: "run_id",
    buildHref: (row, cubeId) => {
      const vendor = readString(row[`${cubeId}.vendor`]);
      const pkg = readString(row[`${cubeId}.package_name`]);
      const runId = readString(row[`${cubeId}.run_id`]);
      if (!vendor || !pkg || !runId) return undefined;
      return `/agents/${encodeURIComponent(vendor)}/${encodeURIComponent(pkg)}/${encodeURIComponent(runId)}`;
    },
    formatCell: (columnSuffix, value) =>
      columnSuffix === "created_at" ? relativeTimeCell(value) : undefined,
  },
};

/** Fallback plan for unmapped cubes: hide `<cube>.id`, never link. */
const UNMAPPED_PLAN: CubeRowPlan = {
  hiddenSuffixes: ["id"],
  rowKeySuffix: "id",
  buildHref: () => undefined,
};

/**
 * Derive the cube id from drizzle-cube's row keys. DC emits column names
 * as `<cubeId>.<dim>` (the dotted form is universal across the agents
 * cube and the four new ones), so the first non-id key prefix is the
 * cube identifier. Falls back to an empty string when the row shape is
 * unexpected (the renderer then degrades to plain text rather than
 * mounting a broken link).
 */
function deriveCubeId(rows: ReadonlyArray<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const sample = rows[0];
  const firstKey = Object.keys(sample)[0];
  if (!firstKey || !firstKey.includes(".")) return "";
  return firstKey.split(".", 1)[0] ?? "";
}

/**
 * The row's stable key per the cube's plan (`<cube>.id` for id-linked
 * cubes, `<cube>.run_id` for agent_runs). Undefined when the cube doesn't
 * expose the key column — the renderer then falls back to the row index.
 */
function readRowKey(
  row: Record<string, unknown>,
  cubeId: string,
  plan: CubeRowPlan,
): string | undefined {
  return readString(row[`${cubeId}.${plan.rowKeySuffix}`]);
}

/**
 * Humanize a `<cubeId>.<dim>` column key for the header row.
 * Falls back to the raw key when the dotted shape doesn't apply.
 */
function humanizeColumnKey(key: string): string {
  const parts = key.split(".");
  const dim = parts.length > 1 ? parts[1] : parts[0];
  if (!dim) return key;
  return dim
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Decide which columns to display + which one carries the name link.
 * Strategy: show every dimension the cube returned except the plan's
 * hidden link-material columns; the plan's `nameSuffix` column (else the
 * `<cube>.name` column, else the first visible column) is the linkable
 * Name column.
 */
function planColumns(
  rows: ReadonlyArray<Record<string, unknown>>,
  cubeId: string,
  plan: CubeRowPlan,
): { keys: readonly string[]; nameKey: string | null } {
  if (rows.length === 0) return { keys: [], nameKey: null };
  const all = Object.keys(rows[0]);
  const hidden = new Set(plan.hiddenSuffixes.map((s) => `${cubeId}.${s}`));
  const visible = all.filter((k) => !hidden.has(k));
  // Prefer the plan's explicit Name column, then a `<cubeId>.name`
  // column, then the first visible column.
  const nameKey =
    (plan.nameSuffix ? visible.find((k) => k === `${cubeId}.${plan.nameSuffix}`) : undefined) ??
    visible.find((k) => k === `${cubeId}.name`) ??
    visible[0] ??
    null;
  return { keys: visible, nameKey };
}

/**
 * Coerce an unknown cell value to a displayable string. Null/undefined →
 * "—" so empty cells read distinguishable from genuine empty strings.
 */
function cellToString(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString();
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

type ChartProps = {
  readonly data: ReadonlyArray<Record<string, unknown>>;
  readonly height?: string | number;
};

function CinatraLinkedTable({ data }: ChartProps) {
  const rows = data ?? [];
  const cubeId = deriveCubeId(rows);
  const plan = CUBE_ROW_PLANS[cubeId] ?? UNMAPPED_PLAN;
  const { keys, nameKey } = planColumns(rows, cubeId, plan);

  if (rows.length === 0) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
        No data
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      <Table>
        <TableHeader>
          <TableRow>
            {keys.map((k) => (
              <TableHead key={k}>{humanizeColumnKey(k)}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, idx) => {
            const rowKey = readRowKey(row, cubeId, plan);
            const href = plan.buildHref(row, cubeId);
            return (
              <TableRow key={rowKey ?? `row-${idx}`}>
                {keys.map((k) => {
                  const suffix = k.startsWith(`${cubeId}.`)
                    ? k.slice(cubeId.length + 1)
                    : k;
                  const raw =
                    plan.formatCell?.(suffix, row[k]) ?? cellToString(row[k]);
                  if (k === nameKey && href) {
                    return (
                      <TableCell key={k}>
                        <Link
                          href={href}
                          className="text-foreground hover:underline"
                        >
                          {raw}
                        </Link>
                      </TableCell>
                    );
                  }
                  return <TableCell key={k}>{raw}</TableCell>;
                })}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * ChartDefinition shape consumed by drizzle-cube's chart plugin
 * registry. Loose-typed via `unknown` so the dashboards package does
 * NOT import drizzle-cube's type surface from outside the adapter
 * boundary (only the sdk-dashboard adapter directory is
 * allowed to import drizzle-cube types). The actual registration in
 * `dashboards-client-shell.tsx` calls
 * `chartPluginRegistry.register(...)` and casts the definition.
 */
export type CinatraLinkedTableDefinition = {
  readonly type: typeof CINATRA_LINKED_TABLE_TYPE;
  readonly label: string;
  readonly config: {
    readonly dropZones: ReadonlyArray<{
      key: string;
      label: string;
      mandatory?: boolean;
      acceptTypes?: ReadonlyArray<"dimension" | "timeDimension" | "measure">;
    }>;
    readonly description?: string;
  };
  readonly component: ComponentType<ChartProps>;
};

export const cinatraLinkedTableDefinition: CinatraLinkedTableDefinition = {
  type: CINATRA_LINKED_TABLE_TYPE,
  label: "Linked table",
  config: {
    dropZones: [
      {
        key: "dimensions",
        label: "Dimensions",
        acceptTypes: ["dimension", "timeDimension"],
      },
      {
        key: "measures",
        label: "Measures",
        acceptTypes: ["measure"],
      },
    ],
    description:
      "Cinatra linked table — first column is rendered as a real Next " +
      "`<Link>` based on the row's cube id, preserving middle-click and " +
      "right-click affordances.",
  },
  component: CinatraLinkedTable,
};

export { CINATRA_LINKED_TABLE_TYPE, CinatraLinkedTable };
