import * as React from "react";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";

// scope-color tokens should move to CSS variables.
// Palette maps the skills package level badge colors to the canonical 5-level model.
// This is the ONLY file in the codebase allowed to use these raw Tailwind palette classes
// for ownership-level encoding — all call sites MUST consume <ScopeBadge> rather than re-applying.
export const scopeBadgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.15em]",
  {
    variants: {
      level: {
        user:         "border-sky-200 bg-sky-50 text-sky-700",
        team:         "border-emerald-200 bg-emerald-50 text-emerald-700",
        organization: "border-violet-200 bg-violet-50 text-violet-700",
        workspace:    "border-amber-200 bg-amber-50 text-amber-700",
        project:      "border-line bg-surface-strong text-foreground",
      },
    },
    defaultVariants: { level: "user" },
  }
);

export type ScopeLevel = "user" | "team" | "organization" | "workspace" | "project";

export type ScopeBadgeProps = {
  level: ScopeLevel;
  className?: string;
  children?: React.ReactNode;
} & Omit<React.ComponentProps<"span">, "children" | "className">;

export function ScopeBadge({ level, className, children, ...props }: ScopeBadgeProps) {
  return (
    <span
      data-slot="scope-badge"
      data-level={level}
      className={cn(scopeBadgeVariants({ level }), className)}
      {...props}
    >
      {children ?? level}
    </span>
  );
}
