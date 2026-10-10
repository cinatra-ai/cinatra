"use client"

import * as React from "react"
import { Separator as SeparatorPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  major = false,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root> & {
  /** Use the etched paired-line section divider. */
  major?: boolean;
}) {
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      data-major={major || undefined}
      decorative={decorative}
      orientation={orientation}
      className={cn(
        "shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:w-px data-[orientation=vertical]:self-stretch",
        major && "divider-etched bg-transparent",
        className
      )}
      {...props}
    />
  )
}

export { Separator }
