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

// The typed toasts' glyphs, as the components drawing (Toast / Sonner) draws
// them: a 14px stroked mark in the toast's own status colour, never the
// library's filled discs. Success is the check, warning the triangle and error
// the cross. Info has no drawn glyph there, so it keeps the library's own. The
// default toast's glyph is added by the toast wrapper
// (packages/sdk-ui/src/toast.ts), because the library keeps no slot for an
// untyped toast's icon (cinatra#3189).
function TypeGlyph({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox='0 0 24 24'
      width={14}
      height={14}
      fill='none'
      stroke='currentColor'
      strokeWidth={2.4}
      strokeLinecap='round'
      strokeLinejoin='round'
      aria-hidden='true'
      data-toast-glyph=''
    >
      {children}
    </svg>
  )
}

const TYPE_ICONS: NonNullable<ToasterProps['icons']> = {
  success: <TypeGlyph><path d='M20 6 9 17l-5-5' /></TypeGlyph>,
  warning: (
    <TypeGlyph>
      <path d='M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z' />
      <path d='M12 9v4' />
      <path d='M12 17h.01' />
    </TypeGlyph>
  ),
  error: <TypeGlyph><path d='M18 6 6 18' /><path d='m6 6 12 12' /></TypeGlyph>,
}

export function Toaster({ ...props }: ToasterProps) {
  const { theme = 'system' } = useTheme()

  return (
    <Sonner
      theme={resolveSonnerTheme(theme)}
      className='toaster group [&_div[data-content]]:w-full'
      icons={TYPE_ICONS}
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

          // WHERE COPY AND CLOSE ARE DRAWN IS A RULE, NOT A VARIABLE.
          // The drawing puts Copy and Close together on the right, inside the
          // toast. The toast library pins its close control outside a corner
          // with position: absolute and a transform, and the custom properties
          // it exposes only choose WHICH corner — a badge on the left corner
          // and a badge on the right corner are the same drawing, and the right
          // one measured overlapping the application header's own notification
          // badge. The placement therefore lives in src/app/globals.css, where a
          // rule can answer the library's own; this component keeps the toast's
          // colours, which is all a custom property can carry.

          // Default toast — popover surface, ink text and the ink border:
          // the drawn default has `border: 1px solid var(--line-strong)`, the
          // same ink as its text, so its border matches its text as every
          // variant's does (cinatra#3189).
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--line-strong)',

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
