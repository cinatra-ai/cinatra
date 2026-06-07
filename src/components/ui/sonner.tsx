"use client"

import { useTheme } from 'next-themes'
import { Toaster as Sonner, type ToasterProps } from 'sonner'

type SonnerTheme = NonNullable<ToasterProps['theme']>

// next-themes is configured with the project palette name 'cinatra' (and 'dark').
// Sonner only knows 'light' | 'dark' | 'system' — passing 'cinatra' through emits
// data-sonner-theme="cinatra", which matches none of Sonner's bundled CSS rules
// and leaves --info-bg / --normal-bg undefined (transparent).
function resolveSonnerTheme(theme: string | undefined): SonnerTheme {
  if (theme === 'dark') return 'dark'
  if (theme === 'system') return 'system'
  return 'light'
}

export function Toaster({ ...props }: ToasterProps) {
  const { theme = 'system' } = useTheme()

  return (
    <Sonner
      theme={resolveSonnerTheme(theme)}
      className='toaster group [&_div[data-content]]:w-full'
      style={
        {
          // Five toast variants use the popover surface with status-coloured
          // text, borders, and icons. The CSS vars below route Sonner's built-in
          // variant slots to design tokens so palette changes cascade through
          // automatically. Success, warning, and info currently map to
          // sea-green, mustard, and indigo respectively.
          //
          // Copy and Close controls are injected by the `cinatraToast(...)`
          // wrapper through Sonner `action` and `cancel` slots; this primitive
          // owns the CSS chrome only.

          // Default toast — popover surface, foreground text.
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',

          // Info — indigo text on popover surface.
          '--info-bg': 'var(--popover)',
          '--info-text': 'var(--info)',
          '--info-border': 'var(--info)',

          // Error — brand red text on popover surface.
          '--error-bg': 'var(--popover)',
          '--error-text': 'var(--destructive)',
          '--error-border': 'var(--destructive)',

          // Success — sea-green text on popover surface.
          '--success-bg': 'var(--popover)',
          '--success-text': 'var(--success)',
          '--success-border': 'var(--success)',

          // Warning — mustard text on popover surface.
          '--warning-bg': 'var(--popover)',
          '--warning-text': 'var(--warning)',
          '--warning-border': 'var(--warning)',
        } as React.CSSProperties
      }
      {...props}
    />
  )
}
