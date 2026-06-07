"use client"

import * as React from "react"
import { Avatar as AvatarPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import {
  ACCENT_PALETTE,
  type ExtensionAccent,
} from "@/lib/extension-accent"

function Avatar({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Root> & {
  size?: "default" | "sm" | "lg"
}) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      data-size={size}
      className={cn(
        "group/avatar relative flex size-8 shrink-0 rounded-full select-none after:absolute after:inset-0 after:rounded-full after:border after:border-border after:mix-blend-darken data-[size=lg]:size-10 data-[size=sm]:size-6 dark:after:mix-blend-lighten",
        className
      )}
      {...props}
    />
  )
}

function AvatarImage({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Image>) {
  return (
    <AvatarPrimitive.Image
      data-slot="avatar-image"
      className={cn(
        "aspect-square size-full rounded-full object-cover",
        className
      )}
      {...props}
    />
  )
}

// Avatar fallback: random accent ground with italic 800 initial.
// Archivo italic 800 is supplied by the `font-display` lane. The random
// accent ground is per-user-persisted, with call sites passing
// `user.accent_color` when rendering the user-menu Avatar.
// When `accent` is set, the fallback paints the spec ACCENT_PALETTE
// background and uses the matching foreground colour. When unset, it
// falls back to the muted ground so users who have not picked a color
// still see a readable initial.
function AvatarFallback({
  className,
  accent,
  style,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Fallback> & {
  accent?: ExtensionAccent | null
}) {
  const accentStyle = accent
    ? {
        background: ACCENT_PALETTE[accent].bg,
        color: ACCENT_PALETTE[accent].fg,
      }
    : undefined
  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      data-accent={accent ?? undefined}
      className={cn(
        "flex size-full items-center justify-center rounded-full text-sm font-display italic font-extrabold group-data-[size=sm]/avatar:text-xs",
        // Only apply the muted fallback when no accent is provided.
        !accent && "bg-muted text-muted-foreground",
        className
      )}
      style={{ ...accentStyle, ...style }}
      {...props}
    />
  )
}

function AvatarBadge({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="avatar-badge"
      className={cn(
        "absolute right-0 bottom-0 z-10 inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground bg-blend-color ring-2 ring-background select-none",
        "group-data-[size=sm]/avatar:size-2 group-data-[size=sm]/avatar:[&>svg]:hidden",
        "group-data-[size=default]/avatar:size-2.5 group-data-[size=default]/avatar:[&>svg]:size-2",
        "group-data-[size=lg]/avatar:size-3 group-data-[size=lg]/avatar:[&>svg]:size-2",
        className
      )}
      {...props}
    />
  )
}

function AvatarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="avatar-group"
      className={cn(
        "group/avatar-group flex -space-x-2 *:data-[slot=avatar]:ring-2 *:data-[slot=avatar]:ring-background",
        className
      )}
      {...props}
    />
  )
}

function AvatarGroupCount({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="avatar-group-count"
      className={cn(
        "relative flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-sm text-muted-foreground ring-2 ring-background group-has-data-[size=lg]/avatar-group:size-10 group-has-data-[size=sm]/avatar-group:size-6 [&>svg]:size-4 group-has-data-[size=lg]/avatar-group:[&>svg]:size-5 group-has-data-[size=sm]/avatar-group:[&>svg]:size-3",
        className
      )}
      {...props}
    />
  )
}

export {
  Avatar,
  AvatarImage,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarBadge,
}
