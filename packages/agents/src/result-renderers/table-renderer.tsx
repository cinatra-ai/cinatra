"use client";

import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PaginatedTable } from "@/components/ui/paginated-table";
import { Button } from "@/components/ui/button";
import { ExternalLink } from "lucide-react";
import type { RendererMode } from "../field-renderer-registry";

export type TableRowAction = {
  id: string;
  label: string;
  variant?: "default" | "destructive" | "outline" | "ghost";
};

type TableHint = {
  type: "contacts_table";
  title?: string;
  columns: string[];
  rows: Record<string, unknown>[];
  /**
   * Per-column link mapping: maps a display column name to the row field that
   * holds its URL. URL fields are hidden from display automatically.
   *
   * Example: { "Doc": "docUrl", "Run": "runUrl" }
   * Each row would then have e.g. { "Doc": "Spec.md", "docUrl": "/data/abc-123", ... }
   */
  columnLinks?: Record<string, string>;
  /**
   * Row-level actions rendered as a trailing Actions column.
   * Callers handle the action via the onAction callback.
   */
  actions?: TableRowAction[];
};

function stringifyCell(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function CellLink({ href, children }: { href: string; children: React.ReactNode }) {
  const isExternal = !href.startsWith("/");
  return (
    <a
      href={href}
      target={isExternal ? "_blank" : undefined}
      rel={isExternal ? "noopener noreferrer" : undefined}
      className="text-primary underline-offset-4 hover:underline inline-flex items-center gap-1"
    >
      {children}
      {isExternal ? <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" /> : null}
    </a>
  );
}

export function TableRenderer({
  hint,
  onAction,
  mode = "view",
}: {
  hint: TableHint;
  onAction?: (actionId: string, row: Record<string, unknown>) => void;
  mode?: RendererMode;
}) {
  void mode; // accepted but unused — edit-mode row actions are not wired yet
  const title = hint.title ?? "Contacts";
  const columns = hint.columns ?? [];
  const rows = hint.rows ?? [];
  const columnLinks = hint.columnLinks ?? {};
  const actions = hint.actions ?? [];

  // Hidden URL columns: legacy viewUrl + all values from columnLinks mapping.
  const urlFieldNames = new Set([
    "viewUrl",
    ...Object.values(columnLinks),
  ]);
  const displayColumns = columns.filter((c) => !urlFieldNames.has(c));
  const hasLegacyViewUrl = columns.includes("viewUrl");
  const hasActions = actions.length > 0 && onAction;

  if (rows.length === 0) {
    return (
      <section className="soft-panel rounded-card p-6 flex flex-col gap-4">
        <h3 className="text-base font-semibold text-foreground">{title}</h3>
        <p className="text-sm text-muted-foreground">No rows to display.</p>
      </section>
    );
  }

  return (
    <section className="soft-panel rounded-card p-6 flex flex-col gap-4">
      <h3 className="text-base font-semibold text-foreground">{title}</h3>
      <PaginatedTable>
        <TableHeader>
          <TableRow>
            {displayColumns.map((col) => (
              <TableHead key={col} className="text-xs font-semibold text-muted-foreground">
                {col}
              </TableHead>
            ))}
            {hasActions && (
              <TableHead className="text-xs font-semibold text-muted-foreground w-px" />
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
            {rows.map((row, rowIdx) => {
              // Legacy single viewUrl — wraps the first column.
              const legacyViewUrl =
                hasLegacyViewUrl && typeof row["viewUrl"] === "string" && row["viewUrl"].length > 0
                  ? (row["viewUrl"] as string)
                  : undefined;

              return (
                <TableRow key={rowIdx} className="hover:bg-surface-muted">
                  {displayColumns.map((col, colIdx) => {
                    const text = stringifyCell(row[col]);

                    // Per-column link from columnLinks mapping.
                    const colUrlField = columnLinks[col];
                    const colUrl =
                      colUrlField && typeof row[colUrlField] === "string" && (row[colUrlField] as string).length > 0
                        ? (row[colUrlField] as string)
                        : undefined;

                    // Fall back to legacy viewUrl on first column only.
                    const url = colUrl ?? (colIdx === 0 && !colUrl ? legacyViewUrl : undefined);

                    return (
                      <TableCell key={col} className="text-sm text-foreground">
                        {url ? <CellLink href={url}>{text}</CellLink> : text}
                      </TableCell>
                    );
                  })}
                  {hasActions && (
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {actions.map((action) => (
                          <Button
                            key={action.id}
                            variant={action.variant ?? "ghost"}
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => onAction(action.id, row)}
                          >
                            {action.label}
                          </Button>
                        ))}
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </PaginatedTable>
    </section>
  );
}
