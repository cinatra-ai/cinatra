"use client";

import * as React from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

// design-system.html §Toolbar — horizontal control surface that sits
// directly under <PageHeader> and REPLACES the section rule for that
// view (pair with `<PageHeader divider={false}>`; spec §Dividers bans
// stacking the etched rule on top of a toolbar).
//
// Composition primitives (no per-control borders — the toolbar ground is
// the container):
//   <Toolbar>
//     <ToolbarGroup>…tab buttons…</ToolbarGroup>
//     <ToolbarSeparator />
//     <ToolbarSearchGroup>
//       <ToolbarSearchInput placeholder="…" defaultValue={…} onChange={…} />
//     </ToolbarSearchGroup>
//     <ToolbarSeparator />
//     <ToolbarGroup>
//       <ToolbarButton asChild><Link href="…">Upload</Link></ToolbarButton>
//     </ToolbarGroup>
//   </Toolbar>

function Toolbar({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="toolbar"
      role="toolbar"
      className={cn(
        // min-h (not fixed h) + horizontal scroll so a crowded toolbar
        // (many filters + separators + search + actions) scrolls on narrow
        // viewports instead of clipping its controls.
        "flex min-h-12 w-full items-center overflow-x-auto rounded-chip bg-toolbar p-[7px]",
        className
      )}
      {...props}
    />
  );
}

function ToolbarGroup({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="toolbar-group"
      className={cn("flex shrink-0 items-center gap-1", className)}
      {...props}
    />
  );
}

function ToolbarSeparator({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        // 7px horizontal margin matches the per-cell padding in the
        // design-system.html §Toolbar example: each cell pads its
        // contents 7px, so the visible gap between any button or
        // search pill and the separator is 7px on each side.
        "mx-[7px] h-6 w-px shrink-0 self-center bg-line-strong/20",
        className
      )}
    />
  );
}

type ToolbarButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Selected state — background tint only; text color/weight do not change. */
  active?: boolean;
  /** Render as a Slot so it can wrap a Link or other element. */
  asChild?: boolean;
};

// Standalone button styling for tab-as-toolbar-item and action-as-toolbar-item.
// Per spec: hover and selected are background tints only (7px radius). Font
// weight and color stay constant across states.
const TOOLBAR_BUTTON_CLASSES =
  "inline-flex h-[34px] items-center gap-1.5 whitespace-nowrap rounded-[7px] px-3 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.06] data-[active=true]:bg-primary/[0.14] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50";

function ToolbarButton({
  className,
  active,
  asChild,
  ...props
}: ToolbarButtonProps) {
  if (asChild) {
    // Minimal asChild — clone the single child and merge className.
    const child = React.Children.only(props.children as React.ReactElement);
    type ChildProps = { className?: string; [k: string]: unknown };
    const cp = child.props as ChildProps;
    return React.cloneElement(child as React.ReactElement<ChildProps>, {
      ...cp,
      "data-active": active ? "true" : undefined,
      className: cn(TOOLBAR_BUTTON_CLASSES, cp.className, className),
    });
  }
  return (
    <button
      data-slot="toolbar-button"
      data-active={active ? "true" : undefined}
      aria-pressed={active}
      className={cn(TOOLBAR_BUTTON_CLASSES, className)}
      {...props}
    />
  );
}

// Search slot — the only white interactive surface inside the toolbar.
function ToolbarSearchGroup({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="toolbar-search-group"
      // min-w-56 floor so the search slot stays usable on narrow viewports —
      // when total content exceeds the container, the toolbar's overflow-x-auto
      // scrolls instead of collapsing search to zero.
      className={cn("flex min-w-56 shrink-0 flex-1 items-center", className)}
      {...props}
    />
  );
}

function ToolbarSearchInput({
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="flex h-[34px] w-full min-w-0 items-center gap-2 rounded-[7px] bg-surface-strong px-3">
      <Search
        aria-hidden
        className="size-[15px] shrink-0 text-muted-foreground"
      />
      <input
        type="search"
        data-slot="toolbar-search-input"
        className={cn(
          "min-w-0 flex-1 bg-transparent text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground",
          className
        )}
        {...props}
      />
    </label>
  );
}

// Numeric badge used after a tab label inside the toolbar (optional per spec).
function ToolbarCount({
  className,
  active,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { active?: boolean }) {
  return (
    <span
      data-slot="toolbar-count"
      className={cn(
        "rounded-[4px] px-1.5 py-[1px] font-mono text-[10px] font-medium",
        active
          ? "bg-primary/[0.15] text-primary"
          : "bg-foreground/[0.06] text-muted-foreground",
        className
      )}
      {...props}
    />
  );
}

export {
  Toolbar,
  ToolbarGroup,
  ToolbarSeparator,
  ToolbarButton,
  ToolbarSearchGroup,
  ToolbarSearchInput,
  ToolbarCount,
};
