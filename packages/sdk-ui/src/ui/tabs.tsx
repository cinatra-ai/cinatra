"use client"

// Portable, connector-agnostic Tabs primitive for extension setup pages.
//
// Bundled-react connector extensions (github, gmail, google-calendar,
// wordpress-assistant) ship their OWN React and cannot import the host app's
// `@/components/ui/tabs`. This is the shared, design-system-strict Tabs export
// they consume via `@cinatra-ai/sdk-ui/marketplace` so no `tabs.tsx` is copied
// into 5 extensions.
//
// It is PURE UI INFRA — the accessible tab semantics (roles, aria-selected,
// arrow-key roving focus, tab order) come from Radix `Tabs`; the visual language
// is the design-system underline tab (13px, indigo `--primary` active underline,
// slate inactive). NO connector-specific behaviour, layout, or Help-tab policy
// lives here (the consuming extension owns its content + composition, incl. the
// always-last Help tab). The class list is kept in lockstep with the host app's
// `src/components/ui/tabs.tsx` so both render the identical design-system Tabs.

import * as React from "react"
import { Tabs as TabsPrimitive } from "radix-ui"
import { cn } from "../lib/utils"

function Tabs({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  )
}

// Underline tabs only; no pill tabs. The list carries the bottom hairline the
// active 2px indigo underline sits on.
function TabsList({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        "inline-flex w-fit items-center justify-start gap-4 border-b border-line text-muted-foreground",
        className,
      )}
      {...props}
    />
  )
}

// Active uses a 2px indigo (--primary) underline; inactive labels are slate
// (--muted-foreground). 13px medium sans per the design-system Tabs spec.
function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex items-center gap-1.5 whitespace-nowrap px-1 py-2 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50",
        // 2px indigo underline on the active state (offset to live just below
        // the row baseline so the click target stays compact).
        "data-[state=active]:text-primary after:pointer-events-none after:absolute after:inset-x-0 after:-bottom-px after:h-[2px] after:bg-transparent data-[state=active]:after:bg-primary",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  )
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("flex-1 outline-none", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
