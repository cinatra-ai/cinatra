import type { ReactNode } from "react";
import { cva } from "class-variance-authority";
// cn: intentionally the EXTENDED tailwind-merge from sdk-ui, not "@/lib/utils".
// The default app cn strips the custom design-token size utilities
// (`text-page-title-*` / `text-listing-title` / `text-badge-*`) whenever a
// text-COLOR class follows in the same merge (tailwind-merge classifies
// unknown `text-*` classes as colors). The app-wide cn fix requires the
// vendored-primitive refresh cascade (src/lib/utils.ts is a registry source
// vendored into extension repos), tracked with the arbitrary-value lint gate.
import { cn } from "@cinatra-ai/sdk-ui/lib/utils";
import { PageHeaderRule } from "@/components/page-header-rule";
import { PageHeaderTitleSync } from "@/components/page-header-title-sync";

export type PageHeaderSize = "sm" | "md" | "lg";
export type PageHeaderTone = "ink" | "mustard";

interface PageHeaderProps {
  title: string;
  /**
   * Optional rich content rendered inside the spec h1 in place of the plain
   * `title` text. Lets a page mount an inline-edit
   * affordance (e.g. `<WorkflowEditableTitle>`) without changing the breadcrumb
   * / `document.title` sync contract — `title` stays a plain string, the h1
   * renders `titleContent ?? title`. Never widen `title` to `ReactNode`; the
   * sync contract requires the string.
   */
  titleContent?: ReactNode;
  /** Small contextual label rendered above the h1. */
  label?: string;
  description?: string;
  /**
   * A MONO META LINE beneath the title — the ratified drawing's own header
   * shape for a surface that names a record rather than a section: the type,
   * the revision, and the row facts the host authorized. Rendered as one line
   * of mono, cells divided by the drawing's middle dot. A page with no record
   * to name passes none, and its header is exactly what it was.
   */
  meta?: ReactNode;
  /** Right-side action buttons / controls. */
  actions?: ReactNode;
  /**
   * Page-title display scale.
   *  - "lg" (default) — 28px. Brand-y top-level pages.
   *  - "md" — 24px. Action-heavy admin / settings / detail subpages with
   *    long titles, where the lg size crowds the actions slot.
   *  - "sm" — 20px. Nested sub-screens.
   */
  size?: PageHeaderSize;
  /**
   * Page-title color tone.
   *  - "ink" (default) — `text-foreground` navy.
   *  - "mustard" — `text-brand-mustard`. Per-route opt-in for brand-y
   *    top-level pages; never used on settings / admin chrome.
   */
  tone?: PageHeaderTone;
  /**
   * Cross-axis alignment of the title block against the `actions` slot.
   *
   *  - "start" (default) — top-aligned, the layout every action-bearing page
   *    uses: a button row lines up with the first line of a title that may
   *    wrap, above a description.
   *  - "center" — level, for a header whose actions slot holds a single
   *    fixed-height MARK rather than controls (the setup wizard's BrandMark).
   *    Top-aligning a 30px mark against the display-face title left the mark
   *    visibly lower than the title text (cinatra#2528).
   *
   * "center" also drops the two nudges that only make sense top-aligned: the
   * actions' `pt-1`, and the title's `-mt-2` optical lift (which pulls the h1
   * out of its own box and would re-introduce the offset it is meant to fix).
   */
  align?: "start" | "center";
  /**
   * Render an etched paired-line `<Separator major>` beneath the header
   * block as a section-rule divider. Default ON (owner directive
   * 2026-05-20 — every page chrome carries the section rule beneath its
   * PageHeader); pass `divider={false}` to opt a specific surface out.
   */
  divider?: boolean;
  className?: string;
}

/**
 * Page-title typography — the spec h1 ramp as named design tokens.
 *
 * `text-page-title-{sm,md,lg}` carry their paired line-height (1.05) and
 * tight display tracking (-0.018em) via the design package's @theme mapping,
 * so no bracket literals are needed here. A future scale change is a
 * one-line token edit in `@cinatra-ai/design/tokens.css`.
 */
export const pageTitleVariants = cva(
  "font-display italic font-extrabold text-balance",
  {
    variants: {
      size: {
        sm: "text-page-title-sm",
        md: "text-page-title-md",
        lg: "text-page-title-lg",
      },
    },
    defaultVariants: {
      size: "lg",
    },
  },
);

export function PageHeader({
  title,
  titleContent,
  label,
  description,
  meta,
  actions,
  size = "lg",
  tone = "ink",
  align = "start",
  divider = true,
  className,
}: PageHeaderProps) {
  const centered = align === "center";
  return (
    <header
      className={cn(
        "mx-auto mb-6 w-full max-w-7xl px-5 sm:px-8 lg:px-0",
        className
      )}
    >
      <div
        className={cn(
          "flex justify-between gap-4",
          centered ? "items-center" : "items-start"
        )}
      >
        <div>
          {label && (
            <p className="font-mono text-xs uppercase tracking-page-label text-muted-foreground">
              {label}
            </p>
          )}
          <h1
            className={cn(
              pageTitleVariants({ size }),
              size === "lg" && !label && !centered && "-mt-2",
              tone === "mustard" && "text-brand-mustard",
              tone === "ink" && "text-foreground",
              label && "mt-2"
            )}
          >
            {titleContent ?? title}
          </h1>
          {meta && (
            <p className="mt-1.5 font-mono text-xs leading-[1.6] text-muted-foreground">
              {meta}
            </p>
          )}
          {description && (
            <p className="mt-1 max-w-[64ch] text-sm text-pretty leading-[1.55] text-muted-foreground">{description}</p>
          )}
        </div>
        {actions && (
          <div
            className={cn(
              "flex shrink-0 items-center gap-3",
              !centered && "pt-1"
            )}
          >
            {actions}
          </div>
        )}
      </div>
      {divider && <PageHeaderRule />}
      <PageHeaderTitleSync title={title} />
    </header>
  );
}
