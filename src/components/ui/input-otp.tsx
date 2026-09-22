"use client"

import * as React from 'react'
import { OTPInput, OTPInputContext } from 'input-otp'
import { cn } from '@/lib/utils'

function InputOTP({
  className,
  containerClassName,
  ...props
}: React.ComponentProps<typeof OTPInput> & {
  containerClassName?: string
}) {
  return (
    <OTPInput
      data-slot='input-otp'
      containerClassName={cn(
        'flex items-center gap-2 has-disabled:opacity-50',
        containerClassName
      )}
      className={cn('disabled:cursor-not-allowed', className)}
      {...props}
    />
  )
}

function InputOTPGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot='input-otp-group'
      className={cn('flex items-center', className)}
      {...props}
    />
  )
}

function InputOTPSlot({
  index,
  className,
  ...props
}: React.ComponentProps<'div'> & {
  index: number
}) {
  const inputOTPContext = React.useContext(OTPInputContext)
  const { char, hasFakeCaret, isActive } = inputOTPContext?.slots[index] ?? {}

  return (
    <div
      data-slot='input-otp-slot'
      data-active={isActive}
      className={cn(
        'relative flex h-10 w-10 items-center justify-center border-y border-r border-input bg-surface-strong font-mono text-[18px] shadow-xs transition-all outline-none first:rounded-l-[7px] first:border-l last:rounded-r-[7px] aria-invalid:border-destructive data-[active=true]:z-10 data-[active=true]:border-ring data-[active=true]:ring-[3px] data-[active=true]:ring-ring/50 data-[active=true]:aria-invalid:border-destructive data-[active=true]:aria-invalid:ring-destructive/20 dark:bg-input-fill/30 dark:data-[active=true]:aria-invalid:ring-destructive/40',
        className
      )}
      {...props}
    >
      {char}
      {hasFakeCaret && (
        <div className='pointer-events-none absolute inset-0 flex items-center justify-center'>
          <div className='h-5 w-px animate-caret-blink bg-foreground duration-1000' />
        </div>
      )}
    </div>
  )
}

function InputOTPSeparator({
  className,
  ...props
}: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot='input-otp-separator'
      role='separator'
      className={cn('flex items-center px-1', className)}
      {...props}
    >
      {/* "Split groups with a short navy dash, never a vertical line."
          (cinatra#3189, leg 2). The separator used to render a bare lucide
          MinusIcon, which draws its 2px rule inside a 24x24 square viewBox: the
          glyph the eye reads is a dash, but the ELEMENT is a square, so the
          clause's own "short ... never a vertical line" contrast had nothing to
          measure, and nothing set the navy either -- the icon inherited
          whatever colour the surrounding text happened to carry. The dash is
          drawn here as its own element instead: 8px wide, 2px tall, in the ink
          token, so it is short and horizontal BY CONSTRUCTION and can never
          render as the vertical line the clause forbids. */}
      <div
        data-slot='input-otp-separator-dash'
        className='h-0.5 w-2 rounded-full bg-foreground/40'
      />
    </div>
  )
}

export { InputOTP, InputOTPGroup, InputOTPSlot, InputOTPSeparator }
