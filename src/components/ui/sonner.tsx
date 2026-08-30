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

          // THE CLOSE CONTROL SITS ON THE RIGHT, beside the toast's action.
          // Sonner's left-to-right defaults anchor it at
          // `--toast-close-button-start: 0` with the end unset, which draws the
          // X outside the top-LEFT corner — away from the Copy action the
          // wrapper puts on the right, and away from where a reader reaches for
          // it. The wrapper owns the controls; this primitive owns their chrome,
          // so the placement is stated here once for every toast.
          //
          // LEFT-TO-RIGHT ONLY, DELIBERATELY. The three variables below are read
          // by the toast library as PHYSICAL left/right, and it sets them from
          // its own direction blocks; an inline value outrules both. The
          // application renders no direction attribute anywhere and declares
          // English, so no toast can reach the right-to-left block today. If a
          // right-to-left reading is ever added, these three lines must move out
          // of the inline style and become direction-keyed with the values
          // MIRRORED — the close control belongs beside the action on the inline
          // END, which is the physical left there. The suite beside this file
          // pins that statement so the limitation cannot travel unnoticed.
          '--toast-close-button-start': 'unset',
          '--toast-close-button-end': '0',
          '--toast-close-button-transform': 'translate(35%, -35%)',

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
