import * as React from "react";
import {
  ConnectionStatusBadge,
  type ConnectionStatus,
} from "./connection-status-badge";
import { cn } from "./lib/utils";

// ---------------------------------------------------------------------------
// Connection status card — the narrow right-column card on a connector setup
// page (design/specs/app-connectors.html §II).
//
// Two variants, ONE chrome (reused from the extension-detail info card — a
// `--surface` panel with a hairline border and a heading over a divider):
//
//   ConnectionStatusCard  (single connection) — heading "Connection status", a
//     status badge with icon + label, and a full-width Check action beneath it.
//     The status badge that once sat top-right of the page header now lives
//     HERE (spec §II intro).
//
//   ConnectionsStatusCard (many connections)  — heading "Connections status"
//     (plural), ONE count badge per status IN PLAY (e.g. "2 Connected",
//     "1 Disconnected"), NO Check, and in its place a link-style "All
//     connections" that opens the Connections tab.
//
// Both are PRESENTATIONAL: the interactive control (Check button / All-
// connections link) is passed as `action`, so the card stays server-safe and
// the parent owns the probe + navigation. A single-card `action` is rendered
// full-width (the spec's centered, 100%-wide Check button); the consumer
// typically passes `<Button variant="outline">…Check</Button>`.
// ---------------------------------------------------------------------------

const CARD_FRAME =
  "rounded-lg border border-line bg-surface px-4 pb-[17px] pt-[15px]";
const CARD_HEADING =
  "border-b border-line pb-[11px] text-[13px] font-bold text-foreground";

export interface ConnectionStatusCardProps
  extends Omit<React.ComponentProps<"div">, "children"> {
  /** Live connection status — drives the badge (incl. the transient "checking"). */
  status: ConnectionStatus;
  /** Override the badge label. */
  label?: string;
  /**
   * The Check control, rendered full-width beneath the badge. Presentational by
   * design — pass the interactive button (e.g. `<Button variant="outline">`).
   */
  action?: React.ReactNode;
  /** Heading text; defaults to the spec's "Connection status". */
  heading?: string;
}

/** Single-connection status card (spec §II "One connection", right column). */
export function ConnectionStatusCard({
  status,
  label,
  action,
  heading = "Connection status",
  className,
  ...props
}: ConnectionStatusCardProps) {
  return (
    <div
      data-slot="connection-status-card"
      data-variant="single"
      className={cn(CARD_FRAME, className)}
      {...props}
    >
      <div className={CARD_HEADING}>{heading}</div>
      <div className="mt-[14px]">
        <ConnectionStatusBadge status={status} label={label} />
      </div>
      {action ? (
        <div className="mt-[15px] [&>*]:w-full [&_[data-slot=button]]:w-full [&_[data-slot=button]]:justify-center">
          {action}
        </div>
      ) : null}
    </div>
  );
}

export interface ConnectionsStatusCardProps
  extends Omit<React.ComponentProps<"div">, "children"> {
  /**
   * Count per status. Only statuses with a count > 0 render a badge, in the
   * canonical order Connected → Disconnected → Checking ("only the statuses in
   * play", spec §II "Multiple connections").
   */
  counts: Partial<Record<ConnectionStatus, number>>;
  /**
   * The "All connections" control that opens the Connections tab — a link-style
   * button. NO Check on the multi-connection card (spec §II).
   */
  action?: React.ReactNode;
  /** Heading text; defaults to the spec's plural "Connections status". */
  heading?: string;
}

const STATUS_ORDER: ConnectionStatus[] = [
  "connected",
  "disconnected",
  "checking",
];

/** Multi-connection roll-up status card (spec §II "Multiple connections"). */
export function ConnectionsStatusCard({
  counts,
  action,
  heading = "Connections status",
  className,
  ...props
}: ConnectionsStatusCardProps) {
  const inPlay = STATUS_ORDER.filter((s) => (counts[s] ?? 0) > 0);
  return (
    <div
      data-slot="connection-status-card"
      data-variant="multi"
      className={cn(CARD_FRAME, className)}
      {...props}
    >
      <div className={CARD_HEADING}>{heading}</div>
      <div className="mt-[14px] flex flex-wrap gap-2">
        {inPlay.map((s) => (
          <ConnectionStatusBadge key={s} status={s} count={counts[s]} />
        ))}
      </div>
      {action ? <div className="mt-[14px]">{action}</div> : null}
    </div>
  );
}
