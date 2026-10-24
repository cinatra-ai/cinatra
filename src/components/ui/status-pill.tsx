import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * StatusPill — canonical status indicator from the design system.
 *
 * One component, twelve states. Sibling of `<LifecycleBadge />`, but for run /
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
 *     a dot; everywhere else the icon-led form is the rule. The marketplace
 *     approval states draw it too: their two pending pills, Awaiting you
 *     (`pill hold`) and Awaiting others (`pill idle`), carry the dot
 *     (specs/app.html, marketplace approval states block, cinatra#4296).
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
        // `pill hold` as the roster draws it (specs/app.html, the pill
        // recipes): the mustard tint at 16%, its border at 42%, and the
        // drawing's MUSTARD INK for the label, the readable shade of the same
        // mustard on that tint (cinatra#4296).
        hold:         "border-warning/42 bg-warning/16 text-mustard-ink",
        "needs-review":"border-warning/40 bg-warning/15 text-warning",
        scheduled:    "border-primary/30 bg-primary/8 text-primary",
        queued:       "border-muted/30 bg-muted/10 text-muted-foreground",
        // `pill idle` as the roster draws it: no ground, the muted ink, and
        // the strong line for its border (specs/app.html, the pill recipes).
        // Archived, Withdrawn and Reset are drawn as `pill idle` too, so they
        // share this recipe and differ only by their glyph (Archived also by
        // its 0.7 opacity).
        idle:         "border-line-strong bg-transparent text-muted-foreground",
        archived:     "border-line-strong bg-transparent text-muted-foreground opacity-70",
        withdrawn:    "border-line-strong bg-transparent text-muted-foreground",
        reset:        "border-line-strong bg-transparent text-muted-foreground",
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
  | "withdrawn" | "reset"
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
      // Archive box, as the roster draws Archived (specs/app.html, the pill
      // roster and block V.1: "retired and kept for the record"). The
      // Extensions lifecycle chip keeps its own grey cross; that chip is the
      // marked text of installed-status-indicator.tsx, not this pill.
      return (
        <svg {...common} strokeWidth="2.4">
          <path d="M21 8v13H3V8" />
          <path d="M1 3h22v5H1z" />
        </svg>
      );
    case "withdrawn":
      // Undo arrow: the requester took the request back (specs/app.html V.1).
      return (
        <svg {...common} strokeWidth="2.4">
          <path d="M9 14 4 9l5-5" />
          <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" />
        </svg>
      );
    case "reset":
      // Back-to-start arrow: an administrator cleared the approval (V.1).
      return (
        <svg {...common} strokeWidth="2.4">
          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
          <path d="M3 3v5h5" />
        </svg>
      );
    case "declined":
      // Trash can, as the roster draws Declined (specs/app.html, the pill
      // roster and block V.1).
      return (
        <svg {...common} strokeWidth="2.8">
          <path d="M3 6h18" />
          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
        </svg>
      );
    case "failed":
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

// The dot's fill. It takes the label's colour (`bg-current`) except where the
// roster draws it otherwise: `.pill.hold .dot` is the mustard (`--logo`, the
// app's `--warning`), while the hold label is the darker mustard ink.
const DOT_FILL: Partial<Record<StatusPillStatus, string>> = {
  hold: "bg-warning",
};

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
  withdrawn:      "Withdrawn",
  reset:          "Reset",
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
        // 7px, round, in the pill's own status colour: the label's colour
        // (`bg-current`) for every status but hold (DOT_FILL above).
        <span
          data-slot="status-pill-dot"
          aria-hidden="true"
          className={cn("h-[7px] w-[7px] shrink-0 rounded-full", DOT_FILL[status] ?? "bg-current")}
        />
      ) : (
        <StatusIcon status={status} />
      )}
      {children ?? DEFAULT_LABEL[status]}
    </span>
  );
}
