import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * The components drawing's Card section splits the primitive by whether the
 * user touches it: "Non-interactive cards use `--surface`. Clickable cards
 * (agent tiles, run rows, popovers, anything with hover or focus) use
 * `--surface-strong` per rule #8." — the design system's "White means
 * interactive" rule, which reserves pure white for the elements that invite
 * input.
 *
 * `interactive` is that second form. Without it the primitive had no way to
 * draw the white ground at all, so every surface that wanted one hand-rolled
 * its own `div` instead of using this component, which is exactly the drift
 * this primitive exists to prevent. The 1px hover lift is the section's own
 * example behaviour ("Hover lifts it 1px") and rides the same opt-in, so no
 * existing card moves.
 */
function Card({
  className,
  size = "default",
  interactive = false,
  ...props
}: React.ComponentProps<"div"> & {
  size?: "default" | "sm"
  interactive?: boolean
}) {
  return (
    <div
      data-slot="card"
      data-size={size}
      data-interactive={interactive ? "true" : undefined}
      className={cn(
        // `border border-border` is the section's "1px line border". The card
        // drew a `ring-1` before, which paints as a box-shadow: its computed
        // border-width was 0, so a consumer that passed a `border-*` colour got
        // no stroke at all.
        //
        // The corner clause is NOT spelled in this file, and that is
        // deliberate. It is stated once, as a scope on this card's own DOM
        // seam at the end of src/app/globals.css, because this file is
        // vendored verbatim into extension repositories: a corner written
        // here drifts every one of them the moment the band moves, and the
        // provenance gate stays red until each has re-vendored and had its
        // pin raised. src/components/ui/__tests__/card-drawing-conformance.test.tsx
        // holds that boundary as a test, and the live corner is read in both
        // palettes by tests/e2e/design/conformance/primitive-chrome.spec.ts.
        "group/card flex flex-col gap-4 overflow-hidden rounded-xl border border-border bg-card py-4 text-sm text-card-foreground has-data-[slot=card-footer]:pb-0 has-[>img:first-child]:pt-0 data-[size=sm]:gap-3 data-[size=sm]:py-3 data-[size=sm]:has-data-[slot=card-footer]:pb-0 *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl",
        // The lift is a transform, so it is silenced for a reader who has asked
        // the platform for reduced motion. There is no blanket
        // prefers-reduced-motion rule in this product to inherit, so the
        // primitive carries the guard itself.
        interactive &&
          "bg-surface-strong transition-transform hover:-translate-y-px motion-reduce:transition-none motion-reduce:hover:translate-y-0",
        className
      )}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "group/card-header @container/card-header grid auto-rows-min items-start gap-1 rounded-t-xl px-4 group-data-[size=sm]/card:px-3 has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-4 group-data-[size=sm]/card:[.border-b]:pb-3",
        className
      )}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn(
        "text-base leading-snug font-medium group-data-[size=sm]/card:text-sm",
        className
      )}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className
      )}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-4 group-data-[size=sm]/card:px-3", className)}
      {...props}
    />
  )
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        "flex items-center rounded-b-xl border-t bg-muted/50 p-4 group-data-[size=sm]/card:p-3",
        className
      )}
      {...props}
    />
  )
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
}
