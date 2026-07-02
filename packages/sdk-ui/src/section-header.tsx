import type { ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./lib/utils";

/**
 * Kicker — the canonical uppercase mono kicker label.
 *
 * The small contextual label that sits above a section title (and, in the
 * design spec, above sidebar groups, table headers, and card toplines):
 * JetBrains Mono, uppercase, muted, wide-tracked. Sizes and tracking come
 * from the `@cinatra-ai/design` type-scale tokens, so the treatment flexes
 * through named lanes instead of one hardcoded value — the rigidity that
 * made authors bypass the old `.section-kicker` utility class.
 *
 * Tracking lanes (design tokens):
 *  - "kicker" (default) — 0.18em; the standard section/sidebar label.
 *  - "wide" — 0.2em; roomier labels (settings groups, empty-state tags).
 *  - "label" — 0.3em; the PageHeader-style page context label.
 */
export const kickerVariants = cva(
  "block font-mono font-semibold uppercase text-muted-foreground",
  {
    variants: {
      size: {
        /** 10px — the `.section-kicker` scale (design token `text-badge-xs`). */
        xs: "text-badge-xs",
        /** 12px — the larger hand-rolled kicker scale. */
        sm: "text-xs",
      },
      tracking: {
        kicker: "tracking-kicker",
        wide: "tracking-kicker-wide",
        label: "tracking-page-label",
      },
    },
    defaultVariants: {
      size: "xs",
      tracking: "kicker",
    },
  },
);

export type KickerProps = React.ComponentProps<"p"> &
  VariantProps<typeof kickerVariants>;

export function Kicker({
  size,
  tracking,
  className,
  children,
  ...props
}: KickerProps) {
  return (
    <p
      data-slot="kicker"
      className={cn(kickerVariants({ size, tracking }), className)}
      {...props}
    >
      {children}
    </p>
  );
}

/**
 * Section-title scale — plain semibold sans (NOT the Archivo italic
 * page-title; page chrome belongs to `PageHeader`). Tracking uses the
 * `tracking-title-tight` design token so a global tightening is a one-line
 * token edit.
 */
export const sectionTitleVariants = cva(
  "font-semibold tracking-title-tight text-balance text-foreground",
  {
    variants: {
      size: {
        sm: "text-xl",
        md: "text-2xl",
        lg: "text-3xl",
      },
    },
    defaultVariants: {
      size: "md",
    },
  },
);

export interface SectionHeaderProps
  extends VariantProps<typeof sectionTitleVariants> {
  /** Uppercase mono kicker label rendered above the title. */
  kicker?: ReactNode;
  /** Kicker size lane (see {@link kickerVariants}). */
  kickerSize?: VariantProps<typeof kickerVariants>["size"];
  /** Kicker tracking lane (see {@link kickerVariants}). */
  kickerTracking?: VariantProps<typeof kickerVariants>["tracking"];
  title: ReactNode;
  /** Heading element for the title. Defaults to `h2`. */
  as?: "h1" | "h2" | "h3";
  description?: ReactNode;
  /** Right-side actions (status pills, buttons, close controls). */
  actions?: ReactNode;
  className?: string;
}

/**
 * SectionHeader — the canonical section-header + uppercase-mono-kicker
 * pattern: kicker label, semibold title, optional description and
 * right-side actions.
 *
 * Replaces the hand-rolled `h1/h2 + font-mono uppercase` clusters (and
 * supersedes the rigid `.section-kicker` utility class, which remains only
 * for back-compat). Everything is expressed in named design-token utilities
 * — no bracket literals — so the arbitrary-value lint surface stays clean.
 */
export function SectionHeader({
  kicker,
  kickerSize,
  kickerTracking,
  title,
  as: Heading = "h2",
  size,
  description,
  actions,
  className,
}: SectionHeaderProps) {
  return (
    <div
      data-slot="section-header"
      className={cn(
        "flex flex-wrap items-start justify-between gap-4",
        className,
      )}
    >
      <div className="min-w-0">
        {kicker != null && (
          <Kicker size={kickerSize} tracking={kickerTracking}>
            {kicker}
          </Kicker>
        )}
        <Heading
          className={cn(sectionTitleVariants({ size }), kicker != null && "mt-2")}
        >
          {title}
        </Heading>
        {description != null && (
          <p className="mt-2 max-w-prose text-sm leading-6 text-pretty text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {actions != null && (
        <div className="flex shrink-0 items-start gap-3">{actions}</div>
      )}
    </div>
  );
}
