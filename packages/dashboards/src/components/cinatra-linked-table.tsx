"use client";
/**
 * `cinatraLinkedTable` — drizzle-cube custom chart plugin.
 *
 * Renders cube rows as a shadcn `<Table>` where the first dimension cell
 * is wrapped in a real Next `<Link>` whose href is computed from the row's
 * `<cube>.id` value via a per-cube route template. Preserves middle-click
 * + right-click affordances per design-spec guardrails.
 *
 * Registered globally inside `DashboardsClientShell` via
 * `chartPluginRegistry.register({ type: "cinatraLinkedTable", ... })`.
 * The seed configs request `chartType: "cinatraLinkedTable"` so
 * /agents stays on DC's built-in table renderer while /projects, /teams,
 * /organizations, /artifacts mount the linked variant. No host-side
 * config; the cube id is inferred from the first column key (which is
 * always `<cubeId>.<dim>` in drizzle-cube responses).
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
 * Per-cube route template lookup. The first dimension value of the row is
 * substituted into `${id}`. Only cubes whose Name column should be a real
 * `<Link>` need an entry here — others render as plain text.
 *
 * Mappings:
 *   - `projects` → `/projects/[id]` (link target).
 *   - `teams` → `/teams/[teamId]` (per-team detail dashboard route).
 *   - `organizations` → `/organizations/[id]` (per-org detail dashboard
 *     route).
 *   - `artifacts` → `/artifacts/[id]` (the detail route).
 *   - `agent_runs` → omitted; /agents stays on the built-in table.
 */
const CUBE_NAME_LINK_TEMPLATES: Readonly<Record<string, (id: string) => string>> =
  {
    projects: (id) => `/projects/${encodeURIComponent(id)}`,
    teams: (id) => `/teams/${encodeURIComponent(id)}`,
    organizations: (id) => `/organizations/${encodeURIComponent(id)}`,
    // artifacts: links to the artifact detail page at
    // `src/app/artifacts/[id]/page.tsx`.
    artifacts: (id) => `/artifacts/${encodeURIComponent(id)}`,
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
 * `<columnId>.id` is the drizzle-cube column name for the row's primary
 * key. Resolves to undefined when the cube doesn't expose `id` as a
 * dimension — in that case the row's Name column falls back to plain text.
 */
function readRowId(
  row: Record<string, unknown>,
  cubeId: string,
): string | undefined {
  const candidate = row[`${cubeId}.id`];
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : undefined;
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
 * Strategy: show every dimension that the cube returned, treat
 * the column whose key suffix is `name` (or the first non-`id` column
 * if the cube doesn't surface a `name` dim) as the linkable Name column.
 * The `id` column itself is hidden — it's the link target, not display.
 */
function planColumns(
  rows: ReadonlyArray<Record<string, unknown>>,
  cubeId: string,
): { keys: readonly string[]; nameKey: string | null } {
  if (rows.length === 0) return { keys: [], nameKey: null };
  const all = Object.keys(rows[0]);
  const idKey = `${cubeId}.id`;
  const visible = all.filter((k) => k !== idKey);
  // Prefer a `<cubeId>.name` column for the link target; fall back to
  // the first visible column.
  const nameKey =
    visible.find((k) => k === `${cubeId}.name`) ?? visible[0] ?? null;
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
  const { keys, nameKey } = planColumns(rows, cubeId);
  const linkBuilder = CUBE_NAME_LINK_TEMPLATES[cubeId];

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
            const id = readRowId(row, cubeId);
            return (
              <TableRow key={id ?? `row-${idx}`}>
                {keys.map((k) => {
                  const raw = cellToString(row[k]);
                  if (k === nameKey && id && linkBuilder) {
                    return (
                      <TableCell key={k}>
                        <Link
                          href={linkBuilder(id)}
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
 * boundary (ADR 0044 — only the sdk-dashboard adapter directory is
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
