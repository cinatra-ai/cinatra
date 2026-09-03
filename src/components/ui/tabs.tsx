"use client"

import * as React from 'react'
import { Tabs as TabsPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'
import { Separator } from '@/components/ui/separator'

function Tabs({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot='tabs'
      className={cn('flex flex-col gap-2', className)}
      {...props}
    />
  )
}

// Underline tabs only; no pill tabs. Active uses a 2px indigo
// (--primary) underline; inactive labels are slate (--muted-foreground).
function TabsList({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot='tabs-list'
      className={cn(
        'inline-flex w-fit items-center justify-start gap-4 border-b border-line text-muted-foreground',
        className
      )}
      {...props}
    />
  )
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot='tabs-trigger'
      className={cn(
        'relative inline-flex items-center gap-1.5 whitespace-nowrap px-1 py-2 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50',
        // 2px indigo underline on the active state (offset to live just below
        // the row baseline so the click target stays compact).
        'data-[state=active]:text-primary after:pointer-events-none after:absolute after:inset-x-0 after:-bottom-px after:h-[2px] after:bg-transparent data-[state=active]:after:bg-primary',
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
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
      data-slot='tabs-content'
      className={cn('flex-1 outline-none', className)}
      {...props}
    />
  )
}

// design-system.html §Tabs — when tabs sit directly under a PageHeader,
// the etched paired-line rule begins to the right of the last tab and
// stretches to the page edge. Use TabsListRow in place of TabsList for
// that row; pair with `<PageHeader divider={false}>` so the rule does
// not stack with the header rule above (spec §Dividers).
//
// cinatra#3216 — "IMMEDIATELY to the right of the last tab" (spec
// §Dividers), so the grid carries NO column gap. It used to carry
// `gap-7` (28px), which punched a visible hole between the last tab and
// the start of the rule, so the row read as two separate marks instead
// of one continuous line. Neither §Dividers nor §Tabs allows a gap.
function TabsListRow({
  className,
  children,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <div className='grid grid-cols-[auto_1fr] items-end'>
      <TabsList className={cn('border-b-0', className)} {...props}>
        {children}
      </TabsList>
      {/* cinatra#3106 — the rule this row carries REPLACES the plain list's
          own `border-b`, which paints on the list's bottom edge, so it has to
          sit on that same edge: end-aligned in the grid with NO bottom offset.
          The former `mb-[11px]` lifted it eleven pixels clear of the row
          baseline, so it read as a second horizontal mark floating above the
          active tab's underline instead of continuing it. Position only — the
          etched paired-line paint is unchanged. */}
      <Separator major decorative className='self-end' />
    </div>
  )
}

export { Tabs, TabsList, TabsListRow, TabsTrigger, TabsContent }
