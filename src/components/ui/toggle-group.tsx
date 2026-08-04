"use client"

import * as React from "react"
import { type VariantProps } from "class-variance-authority"
import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { toggleVariants } from "@/components/ui/toggle"

const ToggleGroupContext = React.createContext<
  VariantProps<typeof toggleVariants> & {
    spacing?: number
    orientation?: "horizontal" | "vertical"
  }
>({
  size: "default",
  variant: "default",
  spacing: 0,
  orientation: "horizontal",
})

function ToggleGroup({
  className,
  variant,
  size,
  spacing = 0,
  orientation = "horizontal",
  children,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Root> &
  VariantProps<typeof toggleVariants> & {
    spacing?: number
    orientation?: "horizontal" | "vertical"
  }) {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      data-variant={variant}
      data-size={size}
      data-spacing={spacing}
      data-orientation={orientation}
      style={{ "--gap": spacing } as React.CSSProperties}
      className={cn(
        "group/toggle-group flex w-fit flex-row items-center gap-[--spacing(var(--gap))] data-vertical:flex-col data-vertical:items-stretch",
        // The size-dependent corner radius is resolved in JS, NOT as a
        // `data-[size=sm]:rounded-…` variant (cinatra#2407).
        //
        // As a variant it could not be overridden by a plain `rounded-*`
        // utility — the only form a consumer actually writes — in two
        // compounding ways: `tailwind-merge` does not treat
        // `data-[size=sm]:rounded-*` and a bare `rounded-*` as one conflict
        // group (different modifier), so both survived the merge; and in the
        // cascade the variant's `.…[data-size="sm"]` selector outranks a plain
        // `.rounded-[7px]`. A consumer that asked for a 7px radius rendered
        // `min(var(--radius-md),10px)` — 6px in the app scope — while its own
        // source said 7px, so a source-level class assertion could not see it.
        //
        // Emitting the same value as a PLAIN utility puts it in the consumer's
        // conflict group: `cn()` drops it whenever `className` carries its own
        // `rounded-*`, and keeps it verbatim when it does not. Nothing that
        // does not override the radius changes.
        size === "sm" ? "rounded-[min(var(--radius-md),10px)]" : "rounded-lg",
        className
      )}
      {...props}
    >
      <ToggleGroupContext.Provider
        value={{ variant, size, spacing, orientation }}
      >
        {children}
      </ToggleGroupContext.Provider>
    </ToggleGroupPrimitive.Root>
  )
}

function ToggleGroupItem({
  className,
  children,
  variant = "default",
  size = "default",
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item> &
  VariantProps<typeof toggleVariants>) {
  const context = React.useContext(ToggleGroupContext)
  const resolvedVariant = context.variant || variant
  const resolvedSize = context.size || size

  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      data-variant={resolvedVariant}
      data-size={resolvedSize}
      data-spacing={context.spacing}
      className={cn(
        "shrink-0 group-data-[spacing=0]/toggle-group:rounded-none group-data-[spacing=0]/toggle-group:px-2 focus:z-10 focus-visible:z-10 group-data-[spacing=0]/toggle-group:has-data-[icon=inline-end]:pr-1.5 group-data-[spacing=0]/toggle-group:has-data-[icon=inline-start]:pl-1.5 group-data-horizontal/toggle-group:data-[spacing=0]:first:rounded-l-lg group-data-vertical/toggle-group:data-[spacing=0]:first:rounded-t-lg group-data-horizontal/toggle-group:data-[spacing=0]:last:rounded-r-lg group-data-vertical/toggle-group:data-[spacing=0]:last:rounded-b-lg group-data-horizontal/toggle-group:data-[spacing=0]:data-[variant=outline]:border-l-0 group-data-vertical/toggle-group:data-[spacing=0]:data-[variant=outline]:border-t-0 group-data-horizontal/toggle-group:data-[spacing=0]:data-[variant=outline]:first:border-l group-data-vertical/toggle-group:data-[spacing=0]:data-[variant=outline]:first:border-t",
        toggleVariants({
          variant: resolvedVariant,
          size: resolvedSize,
        }),
        // The SEGMENTED control's small step is 32px tall, not the shared
        // toggle scale's 28px (cinatra#2432).
        //
        // Both specs that draw this control — app-connectors §I and
        // app-notifications §III — draw the group at a 34px outer height, with
        // `box-sizing: border-box`, a 1px hairline on the group and each
        // segment at `height:100%`. That is a 32px item inside a 1px border:
        // 32 + 1 + 1 = 34. The item is what has to carry it — the group takes
        // its height FROM the items, and pinning the group instead would leave
        // 28px segments floating inside a taller box, each with its own status
        // fill, which is not what either spec draws.
        //
        // Placed HERE, after `toggleVariants(...)` and before `className`, it
        // is a plain utility in the same `tailwind-merge` conflict group as the
        // variant's `h-7`: it replaces that h-7 at merge time (not by cascade
        // order), and a consumer that states its own `h-*` still wins over it.
        //
        // Scoped to ToggleGroupItem rather than to `toggleVariants` itself so
        // the standalone `Toggle`'s small step keeps its own 28px contract —
        // this is a fact about the segmented control, not about every toggle.
        // Promoting the segments to `size="default"` would reach 32px too, but
        // would move the label from 0.8rem to 14px and the icons from 14px to
        // 16px, away from the 12.5px/13px both specs draw.
        resolvedSize === "sm" && "h-8",
        className
      )}
      {...props}
    >
      {children}
    </ToggleGroupPrimitive.Item>
  )
}

export { ToggleGroup, ToggleGroupItem }
