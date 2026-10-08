"use client"

import * as React from "react"
import { ScrollArea as ScrollAreaPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function ScrollArea({
  className,
  children,
  // "fades when idle" (the components drawing's Scroll area section). Radix
  // implements exactly this clause on the root: `type="scroll"` shows the bar
  // while the user scrolls and hides it again `scrollHideDelay` after they
  // stop. The primitive used to pass no `type` at all, so it took Radix's
  // `"hover"` default, which reveals the bar on POINTER ENTRY and never hides
  // it on idle: the clause's own "fades" half could not happen at all
  // (cinatra#3189, leg 2).
  //
  // The idle half was only the first of two faults here, and it hid the
  // second. The bar's width and height were stated with the BARE variants
  // `data-vertical:` / `data-horizontal:`, which match an attribute literally
  // NAMED `data-vertical`; Radix writes `data-orientation="vertical"`. Neither
  // utility was ever generated, so the track measured 0px wide on this boot in
  // both palettes and the overlay bar was invisible everywhere in the product,
  // not merely mis-sized. Both halves are stated properly below.
  //
  // Stated as a defaulted prop rather than a hardcoded one so a consumer that
  // genuinely needs an always-visible bar can still say so; the conformance
  // checklist's own render passes `type="always"` for exactly that reason.
  type = "scroll",
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root>) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      type={type}
      className={cn("relative", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        className="size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        // "6px overlay track" — read as the track the eye sees. The bar used to
        // be `w-2.5` / `h-2.5` (10px) and, inside that, a `p-px` gutter and a
        // 1px transparent placeholder border left the thumb at 8px. Taking the
        // box to 6px while keeping both would have left a 3px thumb, which is
        // half of what the section's own example draws (its thumb is 6px), so
        // the padding and the placeholder border come off with the width and
        // the 6px track carries a 6px thumb (cinatra#3189, leg 2).
        "flex touch-none select-none data-[orientation=horizontal]:h-1.5 data-[orientation=horizontal]:flex-col data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1.5",
        // "fades when idle", the visible half. With `type="scroll"` Radix does
        // not restyle the bar on idle, it UNMOUNTS it behind a `Presence` — and
        // `Presence` waits on an `animationend`, never on a transitionend. A
        // bar carrying only a transition would therefore still vanish in one
        // frame. The enter/exit animation is what makes the clause's "fades"
        // true; the transition covers the states the bar changes in while it is
        // mounted, and names opacity and colour together because the two are
        // one tailwind-merge conflict group and cannot be written side by side.
        "transition-[opacity,color] data-[state=visible]:animate-in data-[state=visible]:fade-in-0 data-[state=hidden]:animate-out data-[state=hidden]:fade-out-0",
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-border"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  )
}

export { ScrollArea, ScrollBar }
