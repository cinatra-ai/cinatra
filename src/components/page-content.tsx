import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

interface PageContentProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  /** Extra classes — e.g. "pb-16" for pages with a floating footer action bar */
  className?: string;
}

/**
 * Standard page content wrapper. Matches the max-width and horizontal padding
 * of PageHeader so columns stay aligned. Use inside any route's page.tsx.
 *
 * Every other property is FORWARDED onto the region's root element, the way the
 * sibling layout wrapper `components/layout/main.tsx` forwards its own: a
 * surface addresses this region by writing a host attribute on it (the artifact
 * page writes `data-render-dispatch` there), and a wrapper that dropped them
 * would make that reading unavailable to the document.
 *
 * @example
 * <PageContent>
 *   <Card>...</Card>
 * </PageContent>
 */
export function PageContent({
  children,
  className,
  ...props
}: PageContentProps) {
  return (
    <div
      className={cn(
        "mx-auto w-full max-w-7xl px-5 sm:px-8 lg:px-0",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}
