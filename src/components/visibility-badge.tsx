import * as React from "react";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";

// visibility-color tokens — TODO: convert to CSS variables in a future cleanup.
// Palette grandfathered from the scope-badge pattern per CLAUDE.md §Scope Model.
// This is the ONLY file in the codebase allowed to use these raw Tailwind palette
// classes for visibility encoding — all call sites MUST consume <VisibilityBadge>
// rather than re-applying palette classes inline.
// Sibling component to ScopeBadge (src/components/scope-badge.tsx).
export const visibilityBadgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold uppercase tracking-[0.15em]",
  {
    variants: {
      visibility: {
        public:  "border-emerald-200 bg-emerald-50 text-emerald-700",
        private: "border-sky-200 bg-sky-50 text-sky-700",
      },
    },
    defaultVariants: { visibility: "public" },
  }
);

export type VisibilityLevel = "public" | "private";

export type VisibilityBadgeProps = {
  visibility: VisibilityLevel;
  className?: string;
  children?: React.ReactNode;
} & Omit<React.ComponentProps<"span">, "children" | "className">;

export function VisibilityBadge({ visibility, className, children, ...props }: VisibilityBadgeProps) {
  return (
    <span
      data-slot="visibility-badge"
      data-visibility={visibility}
      aria-label={`Visibility: ${visibility}`}
      className={cn(visibilityBadgeVariants({ visibility }), className)}
      {...props}
    >
      {children ?? visibility}
    </span>
  );
}
