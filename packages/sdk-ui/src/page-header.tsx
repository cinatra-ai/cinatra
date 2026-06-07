import type { ReactNode } from "react";
import { cn } from "./lib/utils";

export type PageHeaderSize = "sm" | "md" | "lg";
export type PageHeaderTone = "ink" | "mustard";

interface PageHeaderProps {
  title: string;
  /** Small contextual label rendered above the h1. */
  label?: string;
  description?: string;
  /** Right-side action buttons / controls. */
  actions?: ReactNode;
  /**
   * Page-title display scale.
   *  - "lg" (default) — 38px. Brand-y top-level pages.
   *  - "md" — 30px. Action-heavy admin / settings / detail subpages.
   *  - "sm" — 24px. Nested sub-screens.
   */
  size?: PageHeaderSize;
  /**
   * Page-title color tone.
   *  - "ink" (default) — `text-foreground` navy.
   *  - "mustard" — `text-brand-mustard`. Brand-y top-level pages only.
   */
  tone?: PageHeaderTone;
  /**
   * Render an etched paired-line section divider beneath the header. Default
   * ON — every page chrome carries the section rule. Pass `divider={false}`
   * to opt a specific surface out.
   */
  divider?: boolean;
  className?: string;
}

/**
 * PageHeader — canonical page chrome h1 for Cinatra-design-strict surfaces.
 *
 * Owns the spec h1 typography (Archivo italic 800, `-0.018em` tracking,
 * `text-balance`) end-to-end so consumer pages never roll their own. Use the
 * `tone` prop to opt into the brand-mustard treatment on top-level pages.
 *
 * The divider is the `.divider-etched` utility class shipped by
 * `@cinatra-ai/design/utilities.css`. Consumers must import that stylesheet
 * for the divider to render.
 */
export function PageHeader({
  title,
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
        className,
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
              size === "sm" && "text-[24px]",
              size === "md" && "text-[30px]",
              size === "lg" && "text-[38px]",
              size === "lg" && !label && "-mt-2",
              tone === "mustard" && "text-brand-mustard",
              tone === "ink" && "text-foreground",
              label && "mt-2",
            )}
          >
            {title}
          </h1>
          {description && (
            <p className="mt-1 max-w-[64ch] text-sm text-pretty leading-[1.55] text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {actions && (
          <div className="flex shrink-0 items-center gap-3 pt-1">{actions}</div>
        )}
      </div>
      {divider && (
        <div className="mt-6">
          <hr className="divider-etched" />
        </div>
      )}
    </header>
  );
}
