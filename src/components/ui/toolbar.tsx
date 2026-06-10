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
//
// §Nested toolbar — when a selected toolbar item carries sub-controls they
// open in a CHILD toolbar rendered as a SIBLING directly beneath the parent
// (never a menu). `<ToolbarChild level={2|3}>` is the spec's
// `<Toolbar.Child />` in this file's named-export convention (same mapping
// as ToolbarGroup / ToolbarSeparator):
//   <Toolbar>…</Toolbar>
//   <ToolbarChild level={2} aria-label="…">…</ToolbarChild>
//   <ToolbarChild level={3} aria-label="…">…</ToolbarChild>
// Each child is inset 20px from the level above, stacked 6px beneath it,
// and its ground lightens toward the page (--toolbar-l2 / --toolbar-l3) —
// the inset + lightening carry the lineage; no connector lines. The level
// prop is typed `2 | 3`, so the spec's three-level cap is enforced at
// compile time. Single-select per level is app-state-driven: callers
// render only the selected item's child, and selecting a different item
// replaces every level below it. Give every child toolbar an `aria-label`.

type ToolbarLevel = 1 | 2 | 3;

// Depth context lets the embedded primitives (button / separator / search)
// scale to the child-toolbar geometry without prop drilling. Per-level
// sizing follows the spec examples: bars 48 → 42 → 40px, cell padding
// 7 → 6 → 5px, controls 34 → 30px, separators 24 → 22 → 20px.
const ToolbarLevelContext = React.createContext<ToolbarLevel>(1);

const TOOLBAR_CONTROL_HEIGHT: Record<ToolbarLevel, string> = {
  1: "h-[34px]",
  2: "h-[30px]",
  3: "h-[30px]",
};

const TOOLBAR_SEPARATOR_HEIGHT: Record<ToolbarLevel, string> = {
  1: "h-6",
  2: "h-[22px]",
  3: "h-5",
};

function Toolbar({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <ToolbarLevelContext.Provider value={1}>
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
    </ToolbarLevelContext.Provider>
  );
}

type ToolbarChildProps = React.HTMLAttributes<HTMLDivElement> & {
  /** Nesting depth beneath the primary toolbar. `2 | 3` only — the spec
   *  caps nesting at three levels (a fourth belongs in the page body or a
   *  sidebar, and is unrepresentable here by construction). */
  level: 2 | 3;
};

function ToolbarChild({ className, level, ...props }: ToolbarChildProps) {
  return (
    <ToolbarLevelContext.Provider value={level}>
      <div
        data-slot="toolbar-child"
        data-level={level}
        role="toolbar"
        className={cn(
          // 6px stack gap beneath the level above; 20px inset per level
          // (L2 = 20px, L3 = 40px from the parent's left edge). Ground
          // lightens toward the page per level; geometry shrinks one step.
          "mt-1.5 flex items-center overflow-x-auto rounded-chip",
          level === 2
            ? "ml-5 min-h-[42px] bg-toolbar-l2 p-[6px]"
            : "ml-10 min-h-10 bg-toolbar-l3 p-[5px]",
          className
        )}
        {...props}
      />
    </ToolbarLevelContext.Provider>
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
  const level = React.useContext(ToolbarLevelContext);
  return (
    <div
      aria-hidden
      className={cn(
        // 7px horizontal margin matches the per-cell padding in the
        // design-system.html §Toolbar example: each cell pads its
        // contents 7px, so the visible gap between any button or
        // search pill and the separator is 7px on each side.
        "mx-[7px] w-px shrink-0 self-center bg-line-strong/20",
        TOOLBAR_SEPARATOR_HEIGHT[level],
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
// weight and color stay constant across states. Height comes from the level
// context (34px in the primary bar, 30px inside a child toolbar).
const TOOLBAR_BUTTON_CLASSES =
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-[7px] px-3 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.06] data-[active=true]:bg-primary/[0.14] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50";

function ToolbarButton({
  className,
  active,
  asChild,
  ...props
}: ToolbarButtonProps) {
  const level = React.useContext(ToolbarLevelContext);
  const buttonClasses = cn(TOOLBAR_BUTTON_CLASSES, TOOLBAR_CONTROL_HEIGHT[level]);
  if (asChild) {
    // Minimal asChild — clone the single child and merge className.
    const child = React.Children.only(props.children as React.ReactElement);
    type ChildProps = { className?: string; [k: string]: unknown };
    const cp = child.props as ChildProps;
    return React.cloneElement(child as React.ReactElement<ChildProps>, {
      ...cp,
      "data-active": active ? "true" : undefined,
      className: cn(buttonClasses, cp.className, className),
    });
  }
  return (
    <button
      data-slot="toolbar-button"
      data-active={active ? "true" : undefined}
      aria-pressed={active}
      className={cn(buttonClasses, className)}
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
  const level = React.useContext(ToolbarLevelContext);
  return (
    <label
      className={cn(
        "flex w-full min-w-0 items-center gap-2 rounded-[7px] bg-surface-strong px-3",
        TOOLBAR_CONTROL_HEIGHT[level]
      )}
    >
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
  ToolbarChild,
  ToolbarGroup,
  ToolbarSeparator,
  ToolbarButton,
  ToolbarSearchGroup,
  ToolbarSearchInput,
  ToolbarCount,
};
