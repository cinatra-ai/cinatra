"use client"

import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const alertVariants = cva(
  'relative w-full rounded-lg border px-4 py-3 text-sm grid has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] grid-cols-[0_1fr] has-[>svg]:gap-x-3 gap-y-0.5 items-start [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current',
  {
    variants: {
      variant: {
        default: 'bg-card text-card-foreground',
        destructive:
          'bg-destructive/10 text-foreground border-destructive/30 [&>svg]:text-destructive',
        warning:
          'bg-warning/10 text-foreground border-warning/30 [&>svg]:text-warning',
        success:
          'bg-success/10 text-foreground border-success/30 [&>svg]:text-success',
        info:
          'bg-info/10 text-foreground border-info/30 [&>svg]:text-info',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
)

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot='alert'
      role='alert'
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot='alert-title'
      className={cn(
        'col-start-2 line-clamp-1 min-h-4 font-medium tracking-tight',
        className
      )}
      {...props}
    />
  )
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot='alert-description'
      className={cn(
        'col-start-2 text-sm leading-[1.55] text-pretty text-muted-foreground [&>p+p]:mt-1.5',
        className
      )}
      {...props}
    />
  )
}

export { Alert, AlertTitle, AlertDescription }
