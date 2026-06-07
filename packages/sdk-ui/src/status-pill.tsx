import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./lib/utils";

/**
 * StatusPill — canonical status indicator from the Cinatra design system.
 *
 * One component, ten states. For run / connection / approval lifecycle
 * states that surface in lists, table rows, run-detail headers, and inline
 * within prose.
 *
 * Spec rules enforced here:
 *   - Icon (play, check, pause, etc.) on the left — never a bare dot
 *   - Tinted background + same-colour text + matching border (status colour)
 *   - "running" is indigo; "failed" / destructive is red. Red never means run.
 *   - "needs-review" reads as the brand mustard so it picks up the same
 *     visual weight as a "needs you" badge elsewhere in the app.
 */

const pillVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11.5px] font-semibold whitespace-nowrap",
  {
    variants: {
      status: {
        running:        "border-primary/30 bg-primary/10 text-primary",
        approved:       "border-success/30 bg-success/10 text-success",
        hold:           "border-warning/30 bg-warning/15 text-warning",
        "needs-review": "border-warning/40 bg-warning/15 text-warning",
        scheduled:      "border-primary/30 bg-primary/8 text-primary",
        queued:         "border-muted/30 bg-muted/10 text-muted-foreground",
        idle:           "border-line bg-transparent text-muted-foreground",
        archived:       "border-line bg-transparent text-muted-foreground opacity-70",
        failed:         "border-destructive bg-destructive text-destructive-foreground",
        declined:       "border-destructive bg-destructive text-destructive-foreground",
      },
    },
    defaultVariants: { status: "idle" },
  },
);

export type StatusPillStatus =
  | "running" | "approved" | "hold" | "needs-review"
  | "scheduled" | "queued"
  | "idle" | "archived"
  | "failed" | "declined";

export type StatusPillProps = {
  status: StatusPillStatus;
  className?: string;
  children?: React.ReactNode;
} & Omit<React.ComponentProps<"span">, "children" | "className">;

// Icon glyphs — Lucide-style stroke icons sized to fit the pill height.
function StatusIcon({ status }: { status: StatusPillStatus }) {
  const common = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className: "h-2.5 w-2.5",
  };
  switch (status) {
    case "running":
      return (
        <svg {...common} fill="currentColor" stroke="none">
          <polygon points="6 3 20 12 6 21 6 3" />
        </svg>
      );
    case "approved":
      return (
        <svg {...common} strokeWidth="3.2">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      );
    case "hold":
      return (
        <svg {...common} fill="currentColor" stroke="none">
          <rect x="6"  y="4" width="4" height="16" rx="0.5" />
          <rect x="14" y="4" width="4" height="16" rx="0.5" />
        </svg>
      );
    case "needs-review":
      return (
        <svg {...common} strokeWidth="2.4">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v4" />
          <path d="M12 16h.01" />
        </svg>
      );
    case "scheduled":
      return (
        <svg {...common} strokeWidth="2.2">
          <rect x="3" y="6" width="18" height="15" rx="2" />
          <path d="M16 2v4" />
          <path d="M8 2v4" />
          <path d="M3 10h18" />
        </svg>
      );
    case "queued":
      return (
        <svg {...common} strokeWidth="2.4">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      );
    case "archived":
      return (
        <svg {...common} strokeWidth="2.2">
          <path d="M21 8v13H3V8" />
          <path d="M1 3h22v5H1z" />
        </svg>
      );
    case "failed":
    case "declined":
      return (
        <svg {...common} strokeWidth="3">
          <path d="M18 6 6 18" />
          <path d="m6 6 12 12" />
        </svg>
      );
    case "idle":
    default:
      return (
        <svg {...common} strokeWidth="2.4">
          <circle cx="12" cy="12" r="9" />
        </svg>
      );
  }
}

// Default human-readable label per status — overridable via children.
const DEFAULT_LABEL: Record<StatusPillStatus, string> = {
  running:        "Running",
  approved:       "Approved",
  hold:           "On hold",
  "needs-review": "Needs review",
  scheduled:      "Scheduled",
  queued:         "Queued",
  idle:           "Idle",
  archived:       "Archived",
  failed:         "Failed",
  declined:       "Declined",
};

export function StatusPill({
  status,
  className,
  children,
  ...props
}: StatusPillProps & VariantProps<typeof pillVariants>) {
  return (
    <span
      data-slot="status-pill"
      data-status={status}
      className={cn(pillVariants({ status }), className)}
      {...props}
    >
      <StatusIcon status={status} />
      {children ?? DEFAULT_LABEL[status]}
    </span>
  );
}
