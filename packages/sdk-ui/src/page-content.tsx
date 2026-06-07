import type { ReactNode } from "react";
import { cn } from "./lib/utils";

interface PageContentProps {
  children: ReactNode;
  /** Extra classes — e.g. `pb-16` for pages with a floating footer action bar. */
  className?: string;
}

/**
 * PageContent — standard page-content wrapper. Matches the max-width and
 * horizontal padding of `PageHeader` so columns stay aligned. Use inside
 * any route's page component.
 *
 * @example
 * <Main>
 *   <PageHeader title="Marketplace" />
 *   <PageContent className="flex flex-col gap-6 pb-8">
 *     <Card>...</Card>
 *   </PageContent>
 * </Main>
 */
export function PageContent({ children, className }: PageContentProps) {
  return (
    <div
      className={cn(
        "mx-auto w-full max-w-7xl px-5 sm:px-8 lg:px-0",
        className,
      )}
    >
      {children}
    </div>
  );
}
