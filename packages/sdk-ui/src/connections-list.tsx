import * as React from "react";
import {
  ConnectionStatusBadge,
  type ConnectionStatus,
} from "./connection-status-badge";
import { cn } from "./lib/utils";

// ---------------------------------------------------------------------------
// Connections list — the multi-connection "Connections" tab
// (design/specs/app-connectors.html §II "Multiple connections",
// `connector-connections`). Each connection is its OWN stacked card: name,
// URL, the same solid status badge, and a per-row action that follows the
// status — Disconnect (destructive) on a connected row, Connect (primary) on a
// disconnected one; never a bare "Remove".
//
// Presentational: the parent supplies each row's `action` button (so the
// status→action mapping + the connection-level confirm dialog live in the
// consumer). The list emits the conformance id + the current data-state so the
// design functional-acceptance suite can drive its empty / loading variants.
//
// Both the badge and the action are OPTIONAL, and for the same reason
// (cinatra#2357): a consumer that lists connection IDENTITIES rather than live
// connections — the host's connection-sharing section — can name each row and
// nothing more. Both affordances are CLAIMS, so a surface that cannot back one
// omits it instead of borrowing it.
// ---------------------------------------------------------------------------

export interface ConnectionRowProps
  extends Omit<React.ComponentProps<"div">, "children"> {
  /** Connection display name (e.g. "a2a-dev-localhost-10010"). */
  name: string;
  /** Secondary mono line beneath the name (e.g. the server URL). */
  url?: string;
  /**
   * Solid status badge for this connection. OPTIONAL: a consumer that holds no
   * per-connection signal renders the row WITHOUT a badge rather than
   * borrowing one. Passing `"connected"` paints a green joined-plug chip and
   * `data-status="connected"` — a claim about the connection answering right
   * now — so a surface that only knows the identity is stored must omit it. A
   * label alone is not enough to soften that: the colour and the glyph are the
   * claim as much as the word is.
   */
  status?: ConnectionStatus;
  /**
   * The per-row action, following the status: a destructive Disconnect on a
   * connected row, a primary Connect on a disconnected one.
   */
  action?: React.ReactNode;
}

export function ConnectionRow({
  name,
  url,
  status,
  action,
  className,
  ...props
}: ConnectionRowProps) {
  return (
    <div
      data-slot="connection-row"
      data-status={status}
      className={cn(
        "flex items-center justify-between gap-4 rounded-[10px] border border-line bg-surface px-[18px] py-[15px] shadow-sm",
        className,
      )}
      {...props}
    >
      <div className="min-w-0">
        <div className="truncate text-[15px] font-bold text-foreground">
          {name}
        </div>
        {url ? (
          <div className="mt-[3px] truncate font-mono text-xs text-muted-foreground">
            {url}
          </div>
        ) : null}
      </div>
      <div className="flex flex-none items-center gap-3">
        {status ? <ConnectionStatusBadge status={status} /> : null}
        {action}
      </div>
    </div>
  );
}

export type ConnectionsListState = "ready" | "empty" | "loading";

export interface ConnectionsListProps
  extends Omit<React.ComponentProps<"div">, "children"> {
  /** The stacked `ConnectionRow`s. */
  children?: React.ReactNode;
  /** Current surface state; drives `data-state` for functional-acceptance. */
  state?: ConnectionsListState;
  /** Copy shown in the empty state (no saved connections yet). */
  emptyLabel?: string;
  /** Copy shown while connections are loading. */
  loadingLabel?: string;
}

export function ConnectionsList({
  children,
  state = "ready",
  emptyLabel = "No connections yet.",
  loadingLabel = "Loading connections…",
  className,
  ...props
}: ConnectionsListProps) {
  return (
    <div
      data-conformance-id="connector-connections"
      data-state={state}
      className={cn("mt-[22px] flex flex-col gap-3", className)}
      {...props}
    >
      {state === "empty" ? (
        <p className="text-sm text-muted-foreground">{emptyLabel}</p>
      ) : state === "loading" ? (
        // The loading state carries its own visible affordance so the surface
        // never renders blank; a consumer may still pass skeleton children.
        <p className="text-sm text-muted-foreground">{children ?? loadingLabel}</p>
      ) : (
        children
      )}
    </div>
  );
}
