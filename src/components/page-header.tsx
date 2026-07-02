import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
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
   * Render an etched paired-line `<Separator major>` beneath the header
   * block as a section-rule divider. Default ON (owner directive
   * 2026-05-20 — every page chrome carries the section rule beneath its
   * PageHeader); pass `divider={false}` to opt a specific surface out.
   */
  divider?: boolean;
  className?: string;
}

export function PageHeader({
  title,
  titleContent,
  label,
  description,
  actions,
  size = "lg",
  tone = "ink",
  divider = true,
  className,
}: PageHeaderProps) {
  return (
    <header
      className={cn(
        "mx-auto mb-6 w-full max-w-7xl px-5 sm:px-8 lg:px-0",
        className
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          {label && (
            <p className="font-mono text-xs uppercase tracking-[0.3em] text-muted-foreground">
              {label}
            </p>
          )}
          <h1
            className={cn(
              "font-display italic font-extrabold leading-[1.05] tracking-[-0.018em] text-balance",
              size === "sm" && "text-[20px]",
              size === "md" && "text-[24px]",
              size === "lg" && "text-[28px]",
              size === "lg" && !label && "-mt-2",
              tone === "mustard" && "text-brand-mustard",
              tone === "ink" && "text-foreground",
              label && "mt-2"
            )}
          >
            {titleContent ?? title}
          </h1>
          {description && (
            <p className="mt-1 max-w-[64ch] text-sm text-pretty leading-[1.55] text-muted-foreground">{description}</p>
          )}
        </div>
        {actions && (
          <div className="flex shrink-0 items-center gap-3 pt-1">{actions}</div>
        )}
      </div>
      {divider && <PageHeaderRule />}
      <PageHeaderTitleSync title={title} />
    </header>
  );
}
