import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * StatusPill — canonical status indicator from the design system.
 *
 * One component, ten states. Sibling of `<LifecycleBadge />`, but for run /
 * connection / approval lifecycle states that surface in lists, table rows,
 * run-detail headers, and inline within prose.
 *
 * Spec rules enforced here:
 *   - Icon (play, check, pause, etc.) on the left BY DEFAULT — the design
 *     system's own rule for the pill family is "Use icon-led pills; never just
 *     dots" (specs/app-components.html, the note under the pill gallery), and
 *     every caller that does not ask otherwise gets that form.
 *   - `glyph="dot"` is the ONE opt-in exception, and it exists because the
 *     ratified drawing draws it: the run detail's own header pill is
 *     `<span class="pill approved"><span class="dot"></span>completed</span>`
 *     (specs/app-artifact-review.html, example `run-schedule-step-fired`), and
 *     the "What this run made" header of the run's last step draws the same
 *     dot form. The dot is 7px and takes the pill's own status colour —
 *     `.pill .dot { width: 7px; height: 7px; border-radius: 50% }` with
 *     `.pill.approved .dot { background: var(--green) }`, the same green as
 *     `.pill.approved`'s own text. Reach for it ONLY where the drawing draws
 *     a dot; everywhere else the icon-led form is the rule.
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
        running:      "border-primary/30 bg-primary/10 text-primary",
        approved:     "border-success/30 bg-success/10 text-success",
        hold:         "border-warning/30 bg-warning/15 text-warning",
        "needs-review":"border-warning/40 bg-warning/15 text-warning",
        scheduled:    "border-primary/30 bg-primary/8 text-primary",
        queued:       "border-muted/30 bg-muted/10 text-muted-foreground",
        idle:         "border-line bg-transparent text-muted-foreground",
        archived:     "border-line bg-transparent text-muted-foreground opacity-70",
        failed:       "border-destructive bg-destructive text-destructive-foreground",
        declined:     "border-destructive bg-destructive text-destructive-foreground",
      },
    },
    defaultVariants: { status: "idle" },
  }
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
  /**
   * Which leading mark the pill carries. `"icon"` (the default) is the design
   * system's rule. `"dot"` is the run-detail reading the ratified drawing
   * draws — see the note at the top of this file. There is no third form.
   */
  glyph?: "icon" | "dot";
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
      // Cross (✕) per design system §VI — archived reads as "crossed out",
      // muted grey (colour comes from the pill variant, not the glyph).
      return (
        <svg {...common} strokeWidth="2.4">
          <path d="M18 6 6 18" />
          <path d="m6 6 12 12" />
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
  glyph = "icon",
  ...props
}: StatusPillProps & VariantProps<typeof pillVariants>) {
  return (
    <span
      data-slot="status-pill"
      data-status={status}
      data-glyph={glyph}
      className={cn(pillVariants({ status }), className)}
      {...props}
    >
      {glyph === "dot" ? (
        // 7px, round, in the pill's own status colour. `bg-current` IS the
        // drawing's rule: the dot carries the same colour as the label beside
        // it, so one variant string keeps both halves in one family.
        <span
          data-slot="status-pill-dot"
          aria-hidden="true"
          className="h-[7px] w-[7px] shrink-0 rounded-full bg-current"
        />
      ) : (
        <StatusIcon status={status} />
      )}
      {children ?? DEFAULT_LABEL[status]}
    </span>
  );
}
