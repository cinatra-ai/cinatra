import * as React from "react";
import { LoaderCircle, PlugZap, Unplug } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./lib/utils";

// ---------------------------------------------------------------------------
// ConnectionStatusBadge — the connector connection-status chip.
//
// design/specs/app-connectors.html §II ("Connector setup page"): the setup
// page's Connection status card, the multi-connection Connections-status
// roll-up, and each Connections-tab row all speak ONE badge language — the
// SAME solid green / red status language as the §I connector cards + filter.
//
// This is the sdk-ui-local, dependency-light counterpart of the host-package
// `@cinatra-ai/connectors` `ConnectorBadge` (the /connectors card + top-of-page
// badge). sdk-ui sits BELOW `@cinatra-ai/connectors` in the dependency graph,
// so it cannot import that component; instead the two are kept in visual
// lockstep by using the IDENTICAL design tokens:
//   connected    → SOLID green chip, white plug (`bg-success` +
//                  `text-success-foreground`, PlugZap) — matches ConnectorBadge.
//   disconnected → SOLID red chip, white unplug (`bg-destructive` +
//                  `text-destructive-foreground`, Unplug) — matches ConnectorBadge.
//   checking     → TRANSIENT indigo-tint chip with a spinning loader
//                  (`border-primary/30 bg-primary/10 text-primary`), the state
//                  the setup card's Check action swaps in until the probe
//                  resolves (spec §II "connection status · Check flow").
//
// Presentational only: the parent owns the probe/state transitions; this chip
// just renders whichever status it is handed. An optional `count` prefixes the
// label ("2 Connected") for the multi-connection roll-up card.
// ---------------------------------------------------------------------------

export type ConnectionStatus = "connected" | "disconnected" | "checking";

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12.5px] font-semibold whitespace-nowrap [&_svg]:size-3.5 [&_svg]:shrink-0",
  {
    variants: {
      status: {
        connected:
          "border-transparent bg-success text-success-foreground dark:bg-success",
        disconnected:
          "border-transparent bg-destructive text-destructive-foreground dark:bg-destructive",
        checking: "border-primary/30 bg-primary/10 text-primary",
      },
    },
    defaultVariants: { status: "disconnected" },
  },
);

const DEFAULT_LABEL: Record<ConnectionStatus, string> = {
  connected: "Connected",
  disconnected: "Disconnected",
  checking: "Checking…",
};

function StatusGlyph({ status }: { status: ConnectionStatus }) {
  switch (status) {
    case "connected":
      return <PlugZap aria-hidden="true" />;
    case "checking":
      // Spinner — the transient probe state (spec: icon spinning until resolved).
      return <LoaderCircle aria-hidden="true" className="animate-spin" />;
    case "disconnected":
    default:
      return <Unplug aria-hidden="true" />;
  }
}

export interface ConnectionStatusBadgeProps
  extends Omit<React.ComponentProps<"span">, "children">,
    VariantProps<typeof badgeVariants> {
  status: ConnectionStatus;
  /** Override the default label ("Connected" / "Disconnected" / "Checking…"). */
  label?: string;
  /** Optional leading count for the multi-connection roll-up ("2 Connected"). */
  count?: number;
}

export function ConnectionStatusBadge({
  status,
  label,
  count,
  className,
  ...props
}: ConnectionStatusBadgeProps) {
  const text = label ?? DEFAULT_LABEL[status];
  const rendered = typeof count === "number" ? `${count} ${text}` : text;
  return (
    <span
      data-slot="connection-status-badge"
      data-status={status}
      className={cn(badgeVariants({ status }), className)}
      {...props}
    >
      {/* The glyph is decorative (aria-hidden in StatusGlyph); the visible
          label is the badge's accessible name — no fragile aria-label on a
          plain span, and the text is never hidden from assistive tech. */}
      <StatusGlyph status={status} />
      <span>{rendered}</span>
    </span>
  );
}
